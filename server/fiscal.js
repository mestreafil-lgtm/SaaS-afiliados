"use strict";

const crypto = require("crypto");
const https = require("https");
const zlib = require("zlib");
const forge = require("node-forge");
const municipalityIbge = require("municipios-ibge");
const { unzipSync, strFromU8 } = require("fflate");
const { DOMParser } = require("@xmldom/xmldom");
const { SignedXml } = require("xml-crypto");
const { validateXML } = require("xmllint-wasm");
const { getSupabaseAdmin, requireUserId } = require("./auth");

const MAX_IMPORT_BYTES = 25 * 1024 * 1024;
const MAX_CERT_BYTES = 2 * 1024 * 1024;
const NFSE_NS = "http://www.sped.fazenda.gov.br/nfse";
const DS_NS = "http://www.w3.org/2000/09/xmldsig#";
const C14N = "http://www.w3.org/TR/2001/REC-xml-c14n-20010315";
const OFFICIAL_ENDPOINTS = {
  restricted: {
    sefin: { hostname: "sefin.producaorestrita.nfse.gov.br", base: "/API/SefinNacional" },
    adn: { hostname: "adn.producaorestrita.nfse.gov.br", base: "" },
    tpAmb: "2",
  },
  production: {
    sefin: { hostname: "sefin.nfse.gov.br", base: "/SefinNacional" },
    adn: { hostname: "adn.nfse.gov.br", base: "" },
    tpAmb: "1",
  },
};
// opSimpNac do leiaute 1.01: 1 = não optante, 2 = MEI, 3 = ME/EPP optante.
const TAX_REGIMES = {
  MEI: 2,
  "Simples Nacional": 3,
  "Lucro Presumido": 1,
  "Lucro Real": 1,
  "Outro não optante": 1,
};
const DRAFT_STATUSES = ["pending", "ready", "approved", "submitting", "homologating", "authorized", "homologated", "rejected", "uncertain", "cancelled"];
const MUNICIPAL_CHECK_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const OFFICIAL_XSD_URL = "https://www.gov.br/nfse/pt-br/biblioteca/documentacao-tecnica/documentacao-atual/nfse-esquemas_xsd-v1-01-20260209.zip";
let officialSchemasPromise = null;

const FIELD_ALIASES = {
  name: ["razao social do vendedor", "razao social", "nome do vendedor", "nome da loja", "seller name", "shop name", "nome"],
  document: ["cpf cnpj", "cnpj cpf", "cnpj", "cpf", "documento", "tax id", "identificacao fiscal"],
  value: ["comissao total do vendedor", "comissao extra", "comissao do vendedor", "seller commission", "valor da nota", "valor"],
  competence: ["mes de conclusao", "mes de competencia", "competencia", "mes"],
  shopId: ["shop id", "id da loja", "id loja", "seller id"],
  email: ["e mail", "email", "email do vendedor"],
  country: ["pais do vendedor", "pais", "country", "codigo do pais"],
  originalAddress: ["endereco do vendedor", "endereco original"],
  zip: ["cep", "postal code"],
  street: ["logradouro", "endereco", "address"],
  number: ["numero", "numero endereco"],
  district: ["bairro"],
  city: ["municipio", "cidade", "city"],
  state: ["uf", "estado", "state"],
  municipalityCode: ["codigo ibge", "codigo do municipio", "municipio ibge", "ibge"],
};

const REQUIRED_MAPPING = ["name", "value", "competence"];
const PROFILE_FIELDS = [
  "legalName", "tradeName", "cnpj", "municipalRegistration", "municipalityCode",
  "taxRegime", "simpleOption", "simpleAssessmentRegime", "specialTaxRegime",
  "serviceCode", "municipalServiceCode", "nbsCode", "descriptionTemplate", "series",
  "issTaxation", "issRetention", "issRate", "totalsMode", "approximateTaxPct",
  "approximateFederalPct", "approximateStatePct", "approximateMunicipalPct",
  "pisCofinsCst", "pisRate", "cofinsRate", "pisCofinsRetention",
  "irrfRetentionPct", "csllRetentionPct", "cpRetentionPct",
  "competenceRule", "ibscbsStatus", "accountantConfirmed",
  "foreignServiceMode", "foreignRelationship", "foreignCurrency", "foreignSupportProvider",
  "foreignSupportRecipient", "foreignTemporaryGoods", "foreignShareMdic", "foreignIssTaxation",
];

function simpleOptionFor(taxRegime) {
  return TAX_REGIMES[taxRegime] || 3;
}

function optionalPct(value) {
  if (value === "" || value == null) return null;
  const number = Number(String(value).replace(",", "."));
  return Number.isFinite(number) ? Math.max(0, Math.min(100, number)) : null;
}

function pctText(value) {
  return value == null ? "" : String(value);
}

function fiscalError(message, code = "FISCAL_ERROR", status = 400) {
  const err = new Error(message);
  err.code = code;
  err.status = status;
  return err;
}

function normalize(value) {
  return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function onlyDigits(value) {
  return String(value || "").replace(/\D/g, "");
}

function validDocument(value) {
  const document = onlyDigits(value);
  if (![11, 14].includes(document.length) || /^(\d)\1+$/.test(document)) return false;
  const weights = document.length === 11
    ? [[10, 9, 8, 7, 6, 5, 4, 3, 2], [11, 10, 9, 8, 7, 6, 5, 4, 3, 2]]
    : [[5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2], [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]];
  return weights.every((list, index) => {
    const count = document.length - 2 + index;
    const sum = list.reduce((total, weight, i) => total + Number(document[i]) * weight, 0);
    const remainder = sum % 11;
    const digit = remainder < 2 ? 0 : 11 - remainder;
    return Number(document[count]) === digit;
  });
}

function parseMoneyToCents(value) {
  let raw = String(value ?? "").replace(/R\$/gi, "").replace(/\s/g, "");
  if (raw.includes(",")) raw = raw.replace(/\./g, "").replace(",", ".");
  const number = Number(raw);
  if (!Number.isFinite(number) || Math.abs(number) > 9_999_999_999.99) {
    throw fiscalError("Valor inválido. Use, por exemplo, 123,45.", "INVALID_AMOUNT");
  }
  return Math.round(number * 100);
}

function normalizeCompetence(value) {
  const text = String(value || "").trim();
  const months = { jan: 1, feb: 2, fev: 2, mar: 3, apr: 4, abr: 4, may: 5, mai: 5, jun: 6, jul: 7, aug: 8, ago: 8, sep: 9, set: 9, oct: 10, out: 10, nov: 11, dec: 12, dez: 12 };
  let match = text.match(/^([A-Za-zÀ-ÿ]{3})\s+(\d{4})$/);
  if (match && months[normalize(match[1])]) return `${match[2]}-${String(months[normalize(match[1])]).padStart(2, "0")}`;
  match = text.match(/^(\d{4})[-/](\d{1,2})$/);
  if (match) return `${match[1]}-${String(Number(match[2])).padStart(2, "0")}`;
  match = text.match(/^(\d{1,2})[/.\-](\d{4})$/);
  if (match) return `${match[2]}-${String(Number(match[1])).padStart(2, "0")}`;
  return text;
}

function splitCsv(text, delimiter) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === '"') {
      if (quoted && text[i + 1] === '"') { cell += '"'; i += 1; }
      else quoted = !quoted;
    } else if (char === delimiter && !quoted) {
      row.push(cell); cell = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && text[i + 1] === "\n") i += 1;
      row.push(cell); cell = "";
      if (row.some((item) => String(item).trim())) rows.push(row);
      row = [];
    } else {
      cell += char;
    }
  }
  row.push(cell);
  if (row.some((item) => String(item).trim())) rows.push(row);
  return rows;
}

function detectDelimiter(text) {
  const sample = String(text).slice(0, 12000);
  const candidates = [";", ",", "\t"];
  let best = ";";
  let bestScore = -1;
  for (const candidate of candidates) {
    const lines = sample.split(/\r?\n/).slice(0, 8);
    const counts = lines.map((line) => splitCsv(line, candidate)[0]?.length || 0);
    const score = counts.filter((count) => count >= 3).length * 100 + Math.max(...counts, 0);
    if (score > bestScore) { best = candidate; bestScore = score; }
  }
  return best;
}

function childElements(node, name) {
  const result = [];
  for (let child = node?.firstChild; child; child = child.nextSibling) {
    if (child.nodeType === 1 && (!name || child.localName === name)) result.push(child);
  }
  return result;
}

function descendants(node, name) {
  const result = [];
  const visit = (current) => {
    for (const child of childElements(current)) {
      if (child.localName === name) result.push(child);
      visit(child);
    }
  };
  visit(node);
  return result;
}

function xlsxRows(buffer) {
  let files;
  try { files = unzipSync(new Uint8Array(buffer)); }
  catch (_) { throw fiscalError("Planilha XLSX inválida.", "INVALID_XLSX"); }
  const total = Object.values(files).reduce((sum, bytes) => sum + bytes.length, 0);
  if (total > 80 * 1024 * 1024) throw fiscalError("A planilha descompactada excede 80 MB.", "XLSX_TOO_LARGE");
  const parser = new DOMParser();
  const xml = (name) => {
    if (!files[name]) throw fiscalError("Planilha XLSX incompleta.", "INVALID_XLSX");
    return parser.parseFromString(strFromU8(files[name]), "text/xml");
  };
  const shared = files["xl/sharedStrings.xml"]
    ? descendants(xml("xl/sharedStrings.xml"), "si").map((node) => descendants(node, "t").map((t) => t.textContent || "").join(""))
    : [];
  const workbook = xml("xl/workbook.xml");
  const firstSheet = descendants(workbook, "sheet")[0];
  if (!firstSheet) throw fiscalError("A planilha não tem abas.", "INVALID_XLSX");
  const relId = firstSheet.getAttribute("r:id") || firstSheet.getAttribute("id");
  const rels = xml("xl/_rels/workbook.xml.rels");
  const relation = descendants(rels, "Relationship").find((node) => node.getAttribute("Id") === relId);
  if (!relation) throw fiscalError("Não foi possível ler a primeira aba.", "INVALID_XLSX");
  let target = relation.getAttribute("Target").replace(/^\//, "");
  if (!target.startsWith("xl/")) target = `xl/${target.replace(/^\.\//, "")}`;
  const sheet = xml(target);
  return descendants(sheet, "row").map((row) => {
    const values = new Map();
    let max = 0;
    for (const cell of childElements(row, "c")) {
      const letters = (cell.getAttribute("r") || "A1").replace(/[^A-Z]/gi, "").toUpperCase();
      let index = 0;
      for (const letter of letters) index = index * 26 + letter.charCodeAt(0) - 64;
      if (index > 256) throw fiscalError("A planilha excede 256 colunas.", "XLSX_TOO_WIDE");
      const valueNode = childElements(cell, "v")[0];
      const inline = descendants(cell, "t").map((node) => node.textContent || "").join("");
      let value = valueNode?.textContent || inline || "";
      if (cell.getAttribute("t") === "s" && value !== "") value = shared[Number(value)] ?? "";
      values.set(Math.max(index - 1, 0), value);
      max = Math.max(max, index);
    }
    return Array.from({ length: max }, (_, i) => String(values.get(i) ?? ""));
  }).filter((row) => row.some((value) => value.trim()));
}

function decodeImport(payload) {
  let buffer;
  try { buffer = Buffer.from(String(payload.content || ""), "base64"); }
  catch (_) { throw fiscalError("O arquivo não foi recebido corretamente.", "INVALID_FILE"); }
  if (!buffer.length || buffer.length > MAX_IMPORT_BYTES) throw fiscalError("Use um arquivo de até 25 MB.", "FILE_TOO_LARGE");
  const filename = String(payload.filename || "").split(/[\\/]/).pop().slice(0, 180);
  let rows;
  if (/\.xlsx$/i.test(filename)) rows = xlsxRows(buffer);
  else if (/\.csv$/i.test(filename)) {
    let text = buffer.toString("utf8").replace(/^\uFEFF/, "");
    if (text.includes("�")) text = new TextDecoder("windows-1252").decode(buffer);
    rows = splitCsv(text, detectDelimiter(text));
  } else throw fiscalError("Escolha o relatório fiscal da Shopee em CSV ou XLSX.", "UNSUPPORTED_FILE");
  if (rows.length > 50001) throw fiscalError("O arquivo excede 50 mil linhas.", "TOO_MANY_ROWS");
  const headerIndex = rows.slice(0, 20).findIndex((row) => row.filter((value) => String(value).trim()).length >= 3);
  if (headerIndex < 0) throw fiscalError("Não encontramos um cabeçalho com pelo menos três colunas.", "HEADER_NOT_FOUND");
  const headers = rows[headerIndex].map((value) => String(value).trim());
  if (new Set(headers).size !== headers.length) throw fiscalError("Há títulos de coluna repetidos.", "DUPLICATE_HEADERS");
  const records = rows.slice(headerIndex + 1).map((row, index) => ({
    line: headerIndex + index + 2,
    values: Object.fromEntries(headers.map((header, i) => [header, String(row[i] ?? "").trim()])),
  })).filter((record) => Object.values(record.values).some(Boolean));
  if (!records.length) throw fiscalError("O arquivo não contém linhas de dados.", "EMPTY_FILE");
  return { buffer, filename, headers, records };
}

function inferMapping(headers) {
  const mapping = {};
  for (const [field, aliases] of Object.entries(FIELD_ALIASES)) {
    const found = headers.filter((header) => aliases.includes(normalize(header)));
    if (found.length === 1) mapping[field] = found[0];
  }
  const normalized = Object.fromEntries(headers.map((header) => [normalize(header), header]));
  if (normalized["cnpj do vendedor"] && normalized["cpf do vendedor"] && normalized["identificacao fiscal estrangeira"]) {
    mapping.document = "__shopee_documents__";
    mapping.name = normalized["razao social do vendedor"] || normalized["nome da loja"];
  }
  return mapping;
}

function splitShopeeAddress(data) {
  if (data.country !== "BR" || !data.originalAddress) return;
  const parts = data.originalAddress.split(",");
  if (parts.length < 3) return;
  const tail = parts.slice(-2).map((item) => item.trim());
  const cityState = tail[0].split(/\s+-\s+/);
  const zip = onlyDigits(tail[1]);
  if (cityState.length < 2 || zip.length !== 8) return;
  const stateNames = { acre: "AC", alagoas: "AL", amapa: "AP", amazonas: "AM", bahia: "BA", ceara: "CE", "distrito federal": "DF", "espirito santo": "ES", goias: "GO", maranhao: "MA", "mato grosso": "MT", "mato grosso do sul": "MS", "minas gerais": "MG", para: "PA", paraiba: "PB", parana: "PR", pernambuco: "PE", piaui: "PI", "rio de janeiro": "RJ", "rio grande do norte": "RN", "rio grande do sul": "RS", rondonia: "RO", roraima: "RR", "santa catarina": "SC", "sao paulo": "SP", sergipe: "SE", tocantins: "TO" };
  const stateSource = cityState.pop() || "";
  const state = stateNames[normalize(stateSource)] || String(stateSource).toUpperCase();
  const prefix = parts.slice(0, -2).join(",").split(",").map((item) => item.trim());
  data.city ||= cityState.join(" - ").trim();
  data.state ||= state;
  data.zip ||= zip;
  data.street ||= prefix[0] || "";
  data.number ||= prefix[1] || "";
  if (!data.district && prefix[2]) {
    data.district = prefix[2].replace(/^.*?\s*-\s*/, "").trim();
  }
  data.municipalityCode ||= municipalityIbge(data.state, data.city)
    || (data.state === "SP" && normalize(data.city) === "mogi mirim" ? "3530805" : "");
}

function isRealDate(value) {
  const date = new Date(`${value}T12:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function validateRecipient(data, cents) {
  const issues = [];
  const warnings = [];
  if (!data.name) issues.push("Informe nome ou razão social.");
  if (data.country === "BR") {
    data.document = onlyDigits(data.document);
    if (!validDocument(data.document)) issues.push("CPF/CNPJ inválido ou ausente.");
    if (onlyDigits(data.zip).length !== 8) issues.push("Informe um CEP com 8 dígitos.");
    if (!/^(AC|AL|AP|AM|BA|CE|DF|ES|GO|MA|MT|MS|MG|PA|PB|PR|PE|PI|RJ|RN|RS|RO|RR|SC|SP|SE|TO)$/.test(data.state)) issues.push("Informe uma UF válida.");
    if (!/^\d{7}$/.test(onlyDigits(data.municipalityCode))) issues.push("Informe o código IBGE do município da loja.");
  } else {
    data.document = String(data.document || "").trim();
    if (!/^[A-Z0-9.\-/]{1,40}$/i.test(data.document)) issues.push("Informe a identificação fiscal estrangeira.");
    if (!/^[A-Z]{2}$/.test(data.country) || data.country === "BR") issues.push("Informe o país estrangeiro no padrão ISO2.");
    if (!data.postalCode && !data.zip) issues.push("Informe o código postal estrangeiro.");
    if (!data.stateProvince && !data.state) issues.push("Informe o estado, província ou região.");
  }
  if (!data.street) issues.push("Informe o logradouro.");
  if (!data.number) issues.push("Informe o número do endereço.");
  if (!data.district) issues.push("Informe o bairro.");
  if (!data.city) issues.push("Informe a cidade.");
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(data.competence)) issues.push("Competência inválida.");
  else if (data.serviceDate && (!/^\d{4}-\d{2}-\d{2}$/.test(data.serviceDate) || data.serviceDate.slice(0, 7) !== data.competence || !isRealDate(data.serviceDate))) {
    issues.push("A data da prestação precisa ser uma data válida dentro do mês da competência.");
  }
  if (!Number.isInteger(cents) || cents <= 0) issues.push("O valor precisa ser maior que zero.");
  if (!data.email) warnings.push("E-mail ausente; entrega automática ficará pendente.");
  else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) warnings.push("Confira o e-mail antes da entrega.");
  return { issues: [...new Set(issues)], warnings: [...new Set(warnings)] };
}

function prepareImport(payload) {
  const parsed = decodeImport(payload);
  const inferred = inferMapping(parsed.headers);
  const mapping = { ...inferred, ...(payload.mapping || {}) };
  const needsMapping = REQUIRED_MAPPING.some((field) => !mapping[field]) || !mapping.document;
  if (needsMapping) {
    return {
      needsMapping: true,
      filename: parsed.filename,
      headers: parsed.headers,
      mapping,
      rows: parsed.records.length,
      examples: parsed.records.slice(0, 3),
    };
  }
  for (const [field, header] of Object.entries(mapping)) {
    if (header && header !== "__shopee_documents__" && !parsed.headers.includes(header)) {
      throw fiscalError(`A coluna escolhida para ${field} não existe.`, "INVALID_MAPPING");
    }
  }
  const serviceDate = String(payload.serviceDate || "").trim();
  if (serviceDate && (!/^\d{4}-\d{2}-\d{2}$/.test(serviceDate) || !isRealDate(serviceDate))) {
    throw fiscalError("Informe a data da prestação no formato AAAA-MM-DD.", "INVALID_SERVICE_DATE");
  }
  const groups = new Map();
  const seen = new Set();
  let duplicates = 0;
  for (const record of parsed.records) {
    const signature = parsed.headers.map((header) => record.values[header] || "").join("\u001f");
    if (seen.has(signature)) { duplicates += 1; continue; }
    seen.add(signature);
    const data = {};
    for (const field of Object.keys(FIELD_ALIASES)) data[field] = String(record.values[mapping[field]] || "").trim();
    if (mapping.document === "__shopee_documents__") {
      const normalized = Object.fromEntries(Object.entries(record.values).map(([key, value]) => [normalize(key), value]));
      const country = String(data.country || "BR").toUpperCase();
      const candidates = country === "BR" || !country
        ? [normalized["cnpj do vendedor"], normalized["cpf do vendedor"]]
        : [normalized["identificacao fiscal estrangeira"]];
      data.document = candidates.find(Boolean) || "";
      data.name ||= normalized["razao social do vendedor"] || normalized["nome da loja"] || "";
    }
    data.country = ["", "BRASIL", "BRAZIL", "BRA", "1058"].includes(String(data.country).toUpperCase()) ? "BR" : String(data.country).toUpperCase();
    data.state = String(data.state || "").toUpperCase();
    data.competence = normalizeCompetence(data.competence);
    if (serviceDate) data.serviceDate = serviceDate;
    splitShopeeAddress(data);
    let cents = 0;
    let amountError = null;
    try { cents = parseMoneyToCents(data.value); }
    catch (err) { amountError = err.message; }
    const validation = validateRecipient(data, cents);
    if (amountError) validation.issues.push(amountError);
    const key = `${data.country}|${data.document || `line-${record.line}`}|${data.competence}`;
    if (!groups.has(key)) groups.set(key, { recipient: data, amountCents: 0, sourceLines: [], issues: [], warnings: [] });
    const group = groups.get(key);
    group.amountCents += cents;
    group.sourceLines.push(record.line);
    group.issues = [...new Set([...group.issues, ...validation.issues])];
    group.warnings = [...new Set([...group.warnings, ...validation.warnings])];
    if (["name", "email", "street", "city"].some((field) => group.recipient[field] !== data[field])) {
      group.issues = [...new Set([...group.issues, "Há dados diferentes para o mesmo documento nessa competência."])];
    }
  }
  const drafts = [...groups.values()];
  return {
    needsMapping: false,
    filename: parsed.filename,
    digest: crypto.createHash("sha256").update(parsed.buffer).digest("hex"),
    headers: parsed.headers,
    mapping,
    serviceDate: serviceDate || null,
    rows: parsed.records.length,
    duplicates,
    totalCents: drafts.reduce((sum, draft) => sum + draft.amountCents, 0),
    ready: drafts.filter((draft) => !draft.issues.length).length,
    pending: drafts.filter((draft) => draft.issues.length).length,
    foreign: drafts.filter((draft) => draft.recipient.country !== "BR").length,
    drafts,
  };
}

function publicProfile(row) {
  if (!row) return null;
  const taxRegime = TAX_REGIMES[row.tax_regime] ? row.tax_regime : "Simples Nacional";
  const foreign = row.foreign_defaults || {};
  return {
    legalName: row.legal_name || "",
    tradeName: row.trade_name || "",
    cnpj: row.cnpj || "",
    municipalRegistration: row.municipal_registration || "",
    municipalityCode: row.municipality_code || "",
    taxRegime,
    simpleOption: simpleOptionFor(taxRegime),
    simpleAssessmentRegime: Number(row.simple_assessment_regime || 1),
    specialTaxRegime: Number(row.special_tax_regime || 0),
    serviceCode: row.service_code || "",
    municipalServiceCode: row.municipal_service_code || "",
    nbsCode: row.nbs_code || "",
    descriptionTemplate: row.description_template || "Serviços de divulgação de produtos como afiliado Shopee, referentes a {mes}/{ano}.",
    series: row.series || "49999",
    nextDpsNumber: Number(row.next_dps_number || 1),
    nextTestDpsNumber: Number(row.next_test_dps_number || 1),
    issTaxation: Number(row.iss_taxation || 1),
    issRetention: Number(row.iss_retention || (row.iss_withheld ? 2 : 1)),
    issWithheld: Number(row.iss_retention || (row.iss_withheld ? 2 : 1)) === 2,
    issRate: pctText(row.iss_rate),
    totalsMode: row.totals_mode || "not_informed",
    approximateTaxPct: pctText(row.approximate_tax_pct),
    approximateFederalPct: pctText(row.approximate_federal_pct),
    approximateStatePct: pctText(row.approximate_state_pct),
    approximateMunicipalPct: pctText(row.approximate_municipal_pct),
    pisCofinsCst: row.pis_cofins_cst || "",
    pisRate: pctText(row.pis_rate),
    cofinsRate: pctText(row.cofins_rate),
    pisCofinsRetention: row.pis_cofins_retention == null ? "" : String(row.pis_cofins_retention),
    irrfRetentionPct: pctText(row.irrf_retention_pct),
    csllRetentionPct: pctText(row.csll_retention_pct),
    cpRetentionPct: pctText(row.cp_retention_pct),
    competenceRule: ["last_day", "per_import"].includes(row.competence_rule) ? row.competence_rule : "",
    foreignDefaults: foreign,
    ...Object.fromEntries(FOREIGN_FIELDS.map((key) => [key, foreign[key] == null ? "" : String(foreign[key])])),
    ibscbsStatus: row.ibscbs_status || "pending",
    accountantConfirmed: Boolean(row.accountant_confirmed_at),
    accountantConfirmedAt: row.accountant_confirmed_at || null,
    municipalCheck: row.municipal_params_checked_at ? {
      checkedAt: row.municipal_params_checked_at,
      environment: row.municipal_params?.environment || null,
      ok: Boolean(row.municipal_params?.ok),
      summary: row.municipal_params?.summary || null,
    } : null,
    updatedAt: row.updated_at || null,
  };
}

function validPct(value) {
  return value === "" || value == null || (Number(value) >= 0 && Number(value) <= 100);
}

function validateProfile(profile, { production = false } = {}) {
  const issues = [];
  if (!profile.legalName) issues.push("Informe a razão social da sua empresa de afiliado.");
  if (!validDocument(profile.cnpj) || onlyDigits(profile.cnpj).length !== 14) issues.push("Informe um CNPJ válido.");
  if (!/^\d{7}$/.test(onlyDigits(profile.municipalityCode))) issues.push("Informe o código IBGE do município da sua empresa de afiliado.");
  if (!/^\d{6}$/.test(onlyDigits(profile.serviceCode))) issues.push("Informe o código nacional do serviço com 6 dígitos.");
  if (profile.nbsCode && !/^\d{9}$/.test(onlyDigits(profile.nbsCode))) issues.push("O código NBS deve ter 9 dígitos.");
  if (!TAX_REGIMES[profile.taxRegime]) issues.push("Escolha o regime tributário: MEI, Simples Nacional (ME/EPP), Lucro Presumido, Lucro Real ou outro não optante.");
  const simpleOption = simpleOptionFor(profile.taxRegime);
  if (simpleOption === 3 && ![1, 2, 3].includes(Number(profile.simpleAssessmentRegime))) issues.push("Informe o regime de apuração do Simples Nacional.");
  if (![0, 1, 2, 3, 4, 5, 6, 9].includes(Number(profile.specialTaxRegime))) issues.push("Informe um regime especial de tributação válido.");
  if (![1, 2, 3, 4].includes(Number(profile.issTaxation))) issues.push("Informe a tributação do ISSQN.");
  if (![1, 2, 3].includes(Number(profile.issRetention))) issues.push("Informe o tipo de retenção do ISSQN.");
  if (!validPct(profile.issRate)) issues.push("A alíquota do ISS deve ficar entre 0 e 100%.");
  if (!["not_informed", "simple_rate", "percent"].includes(profile.totalsMode)) issues.push("Informe como os tributos aproximados serão declarados.");
  if (profile.totalsMode === "simple_rate" && simpleOption !== 3) issues.push("O percentual aproximado do Simples só pode ser usado por ME/EPP optante.");
  if (profile.totalsMode === "simple_rate" && !(Number(profile.approximateTaxPct) > 0 && Number(profile.approximateTaxPct) <= 100)) issues.push("Informe o percentual aproximado dos tributos do Simples.");
  if (profile.totalsMode === "percent" && ["approximateFederalPct", "approximateStatePct", "approximateMunicipalPct"].some((key) => profile[key] === "" || profile[key] == null || !validPct(profile[key]))) {
    issues.push("Informe os percentuais aproximados federal, estadual e municipal (0 a 100%).");
  }
  // PIS/COFINS próprios só existem fora do Simples; no Simples eles vão no DAS.
  if (profile.pisCofinsCst && simpleOption !== 1) issues.push("PIS/COFINS por CST só se aplica a empresa não optante do Simples.");
  if (profile.pisCofinsCst && !/^(0[0-9]|49|5[0-6]|6[0-7]|7[0-5]|98|99)$/.test(profile.pisCofinsCst)) issues.push("Informe um CST de PIS/COFINS válido.");
  if (["pisRate", "cofinsRate", "irrfRetentionPct", "csllRetentionPct", "cpRetentionPct"].some((key) => !validPct(profile[key]))) issues.push("Os percentuais de PIS, COFINS e retenções devem ficar entre 0 e 100%.");
  if ((profile.pisRate || profile.cofinsRate) && !profile.pisCofinsCst) issues.push("Informe o CST de PIS/COFINS para usar as alíquotas.");
  if (profile.pisCofinsRetention !== "" && profile.pisCofinsRetention != null && !/^[0-9]$/.test(String(profile.pisCofinsRetention))) issues.push("Informe um tipo de retenção de PIS/COFINS válido.");
  if (!["last_day", "per_import"].includes(profile.competenceRule)) issues.push("Defina com o contador como a data de competência será informada (último dia do mês ou data informada na importação).");
  if (!profile.descriptionTemplate) issues.push("Informe a descrição do serviço.");
  if (!/^[1-9]\d{0,4}$/.test(String(profile.series || "")) || Number(profile.series) > 49999) issues.push("Informe uma série DPS entre 1 e 49999.");
  if (production && !profile.accountantConfirmed) issues.push("A configuração precisa ser confirmada pelo contador.");
  if (production) {
    const check = profile.municipalCheck;
    const fresh = check?.checkedAt && Date.now() - new Date(check.checkedAt).getTime() < MUNICIPAL_CHECK_MAX_AGE_MS;
    if (!check?.ok || !fresh || check.environment !== "production") issues.push("Consulte os parâmetros do município em produção (há menos de 30 dias) antes de emitir.");
  }
  if (production && profile.ibscbsStatus !== "not_applicable") {
    issues.push(profile.ibscbsStatus === "configured"
      ? "O caso exige campos IBS/CBS adicionais e permanece bloqueado nesta versão."
      : "Defina com o contador o tratamento de IBS/CBS antes de emitir.");
  }
  return issues;
}

async function getProfile(userId = requireUserId()) {
  const sb = getSupabaseAdmin();
  const { data, error } = await sb.from("fiscal_profiles").select("*").eq("user_id", userId).maybeSingle();
  if (error && error.code !== "PGRST116") throw error;
  return publicProfile(data);
}

async function saveProfile(input, userId = requireUserId()) {
  const clean = {};
  for (const field of PROFILE_FIELDS) clean[field] = input[field];
  const foreignDefaults = {};
  for (const key of FOREIGN_FIELDS) {
    const value = String(clean[key] ?? "").trim();
    if (/^\d{1,3}$/.test(value)) foreignDefaults[key] = value;
  }
  const row = {
    user_id: userId,
    legal_name: String(clean.legalName || "").trim().slice(0, 180),
    trade_name: String(clean.tradeName || "").trim().slice(0, 180),
    cnpj: onlyDigits(clean.cnpj).slice(0, 14),
    municipal_registration: String(clean.municipalRegistration || "").trim().slice(0, 40),
    municipality_code: onlyDigits(clean.municipalityCode).slice(0, 7),
    tax_regime: TAX_REGIMES[clean.taxRegime] ? clean.taxRegime : "Simples Nacional",
    simple_option: simpleOptionFor(TAX_REGIMES[clean.taxRegime] ? clean.taxRegime : "Simples Nacional"),
    simple_assessment_regime: [1, 2, 3].includes(Number(clean.simpleAssessmentRegime)) ? Number(clean.simpleAssessmentRegime) : 1,
    special_tax_regime: [0, 1, 2, 3, 4, 5, 6, 9].includes(Number(clean.specialTaxRegime)) ? Number(clean.specialTaxRegime) : 0,
    service_code: onlyDigits(clean.serviceCode).slice(0, 6),
    municipal_service_code: String(clean.municipalServiceCode || "").trim().slice(0, 20),
    nbs_code: onlyDigits(clean.nbsCode).slice(0, 9),
    description_template: String(clean.descriptionTemplate || "").trim().slice(0, 1000),
    series: String(clean.series || "49999").replace(/\D/g, "").slice(0, 5) || "49999",
    iss_withheld: Number(clean.issRetention) === 2,
    iss_taxation: [1, 2, 3, 4].includes(Number(clean.issTaxation)) ? Number(clean.issTaxation) : 1,
    iss_retention: [1, 2, 3].includes(Number(clean.issRetention)) ? Number(clean.issRetention) : 1,
    iss_rate: optionalPct(clean.issRate),
    totals_mode: ["not_informed", "simple_rate", "percent"].includes(clean.totalsMode) ? clean.totalsMode : "not_informed",
    approximate_tax_pct: optionalPct(clean.approximateTaxPct),
    approximate_federal_pct: optionalPct(clean.approximateFederalPct),
    approximate_state_pct: optionalPct(clean.approximateStatePct),
    approximate_municipal_pct: optionalPct(clean.approximateMunicipalPct),
    pis_cofins_cst: /^\d{2}$/.test(String(clean.pisCofinsCst || "")) ? String(clean.pisCofinsCst) : "",
    pis_rate: optionalPct(clean.pisRate),
    cofins_rate: optionalPct(clean.cofinsRate),
    pis_cofins_retention: /^[0-9]$/.test(String(clean.pisCofinsRetention ?? "")) ? Number(clean.pisCofinsRetention) : null,
    irrf_retention_pct: optionalPct(clean.irrfRetentionPct),
    csll_retention_pct: optionalPct(clean.csllRetentionPct),
    cp_retention_pct: optionalPct(clean.cpRetentionPct),
    competence_rule: ["last_day", "per_import"].includes(clean.competenceRule) ? clean.competenceRule : "",
    foreign_defaults: foreignDefaults,
    ibscbs_status: ["pending", "not_applicable", "configured"].includes(clean.ibscbsStatus) ? clean.ibscbsStatus : "pending",
    updated_at: new Date().toISOString(),
  };
  const sb = getSupabaseAdmin();
  const { data: previous, error: previousError } = await sb.from("fiscal_profiles").select("*").eq("user_id", userId).maybeSingle();
  if (previousError && previousError.code !== "PGRST116") throw previousError;
  // Qualquer mudança fiscal relevante invalida a confirmação anterior do contador.
  const ignored = ["user_id", "updated_at", "legal_name", "trade_name", "description_template"];
  const changed = !previous || Object.keys(row).filter((key) => !ignored.includes(key))
    .some((key) => JSON.stringify(previous[key] ?? null) !== JSON.stringify(row[key] ?? null));
  row.accountant_confirmed_at = clean.accountantConfirmed
    ? (!changed && previous?.accountant_confirmed_at ? previous.accountant_confirmed_at : new Date().toISOString())
    : null;
  if (previous && ["cnpj", "municipality_code", "service_code"].some((key) => previous[key] !== row[key])) {
    row.municipal_params = null;
    row.municipal_params_checked_at = null;
  }
  const { data, error } = await sb.from("fiscal_profiles").upsert(row, { onConflict: "user_id" }).select("*").single();
  if (error) throw error;
  const profile = publicProfile(data);
  await logEvent(userId, null, "profile_saved", { changed, accountantConfirmed: Boolean(row.accountant_confirmed_at) });
  return { profile, issues: validateProfile(profile) };
}

async function logEvent(userId, draftId, action, details = {}) {
  try {
    await getSupabaseAdmin().from("fiscal_events").insert({
      id: crypto.randomUUID(), user_id: userId, draft_id: draftId || null,
      action: String(action).slice(0, 60), details, created_at: new Date().toISOString(),
    });
  } catch (_) { /* a auditoria não derruba a operação principal */ }
}

const FOREIGN_FIELDS = ["foreignServiceMode", "foreignRelationship", "foreignCurrency", "foreignSupportProvider", "foreignSupportRecipient", "foreignTemporaryGoods", "foreignShareMdic", "foreignIssTaxation"];
const BRL_BACEN_CODE = "790";

function money2(value) {
  return (Math.round(Number(value) * 100) / 100).toFixed(2);
}

// Termos de comércio exterior: o que o contador definiu no perfil vale para
// todos os tomadores estrangeiros, e a prévia pode sobrescrever caso a caso.
function foreignTerms(profile, recipient, cents) {
  const defaults = profile?.foreignDefaults || {};
  const pick = (key) => (recipient[key] !== undefined && recipient[key] !== "" ? recipient[key] : defaults[key]);
  const terms = Object.fromEntries(FOREIGN_FIELDS.map((key) => [key, pick(key) ?? ""]));
  terms.resultCountry = String(recipient.resultCountry || recipient.country || "").toUpperCase();
  terms.foreignAmount = recipient.foreignAmount !== undefined && recipient.foreignAmount !== ""
    ? Number(recipient.foreignAmount)
    : (String(terms.foreignCurrency) === BRL_BACEN_CODE ? cents / 100 : NaN);
  const issues = [];
  if (!["0", "1", "2", "3", "4"].includes(String(terms.foreignServiceMode))) issues.push("Defina o modo de prestação para tomador estrangeiro (comércio exterior).");
  if (!["0", "1", "2", "3", "4", "5", "6", "9"].includes(String(terms.foreignRelationship))) issues.push("Defina o vínculo entre as partes para tomador estrangeiro.");
  if (!/^\d{3}$/.test(String(terms.foreignCurrency))) issues.push("Defina a moeda do contrato pelo código BACEN de 3 dígitos (ex.: 790 para real).");
  if (!(terms.foreignAmount > 0)) issues.push("Informe o valor do serviço na moeda estrangeira.");
  if (!/^0[0-8]$/.test(String(terms.foreignSupportProvider))) issues.push("Defina o mecanismo de apoio ao prestador (comércio exterior).");
  if (!/^\d{2}$/.test(String(terms.foreignSupportRecipient))) issues.push("Defina o mecanismo de apoio ao tomador (comércio exterior).");
  if (!["0", "1", "2", "3"].includes(String(terms.foreignTemporaryGoods))) issues.push("Defina o vínculo com movimentação temporária de bens.");
  if (!["0", "1"].includes(String(terms.foreignShareMdic))) issues.push("Defina se os dados serão compartilhados com o MDIC.");
  if (!["1", "3"].includes(String(terms.foreignIssTaxation))) issues.push("Defina com o contador se o serviço ao exterior é tributável ou exportação.");
  if (String(terms.foreignIssTaxation) === "3" && !/^[A-Z]{2}$/.test(terms.resultCountry)) issues.push("Informe o país onde o resultado do serviço se verifica.");
  return { terms, issues };
}

// Problemas que dependem do perfil e não só do cliente (data e exterior).
function draftEmissionIssues(profile, draft) {
  const recipient = draft.recipient || {};
  const issues = [];
  if (profile?.competenceRule === "per_import" && !recipient.serviceDate) issues.push("Informe a data da prestação desta nota (regra de competência por importação).");
  if (recipient.country && recipient.country !== "BR") issues.push(...foreignTerms(profile, recipient, Number(draft.amount_cents ?? draft.amountCents)).issues);
  return issues;
}

function federalTaxesXml(profile, cents) {
  const base = cents / 100;
  const parts = [];
  const filled = (value) => value !== "" && value != null;
  if (profile.pisCofinsCst) {
    const hasRates = filled(profile.pisRate) && filled(profile.cofinsRate);
    const rates = hasRates
      ? `<vBCPisCofins>${money2(base)}</vBCPisCofins><pAliqPis>${Number(profile.pisRate).toFixed(2)}</pAliqPis><pAliqCofins>${Number(profile.cofinsRate).toFixed(2)}</pAliqCofins><vPis>${money2(base * Number(profile.pisRate) / 100)}</vPis><vCofins>${money2(base * Number(profile.cofinsRate) / 100)}</vCofins>`
      : "";
    const retention = filled(profile.pisCofinsRetention) ? `<tpRetPisCofins>${Number(profile.pisCofinsRetention)}</tpRetPisCofins>` : "";
    parts.push(`<piscofins><CST>${profile.pisCofinsCst}</CST>${rates}${retention}</piscofins>`);
  }
  const withheld = (tag, pct) => {
    if (!filled(pct) || !(Number(pct) > 0)) return;
    parts.push(`<${tag}>${money2(base * Number(pct) / 100)}</${tag}>`);
  };
  withheld("vRetCP", profile.cpRetentionPct);
  withheld("vRetIRRF", profile.irrfRetentionPct);
  withheld("vRetCSLL", profile.csllRetentionPct);
  return parts.length ? `<tribFed>${parts.join("")}</tribFed>` : "";
}

function totalsXml(profile) {
  if (profile.totalsMode === "simple_rate") return `<totTrib><pTotTribSN>${Number(profile.approximateTaxPct).toFixed(2)}</pTotTribSN></totTrib>`;
  if (profile.totalsMode === "percent") {
    return `<totTrib><pTotTrib><pTotTribFed>${Number(profile.approximateFederalPct).toFixed(2)}</pTotTribFed><pTotTribEst>${Number(profile.approximateStatePct).toFixed(2)}</pTotTribEst><pTotTribMun>${Number(profile.approximateMunicipalPct).toFixed(2)}</pTotTribMun></pTotTrib></totTrib>`;
  }
  // indTotTrib=0: não informar valores estimados (Decreto 8.264/2014). O grupo
  // totTrib é obrigatório no XSD e nunca pode ficar vazio.
  return "<totTrib><indTotTrib>0</indTotTrib></totTrib>";
}

function buildDpsXml(profile, draft, { environment = "2", series, number } = {}) {
  const productionIssues = validateProfile(profile || {}, { production: environment === "1" });
  if (productionIssues.length) throw fiscalError(productionIssues[0], "PROFILE_INCOMPLETE");
  const recipient = draft.recipient || {};
  const cents = Number(draft.amount_cents);
  const validation = validateRecipient(recipient, cents);
  if (validation.issues.length) throw fiscalError(validation.issues[0], "DRAFT_HAS_ISSUES");
  const emissionIssues = draftEmissionIssues(profile, draft);
  if (emissionIssues.length) throw fiscalError(emissionIssues[0], "DRAFT_HAS_ISSUES");
  const isForeign = recipient.country !== "BR";
  const cleanCnpj = onlyDigits(profile.cnpj);
  const cleanSeries = String(series || profile.series || "49999");
  const dpsNumber = Number(number || 1);
  if (!Number.isSafeInteger(dpsNumber) || dpsNumber < 1 || dpsNumber > 999999999999999) throw fiscalError("Número da DPS inválido.", "INVALID_DPS_NUMBER");
  const dpsId = `DPS${onlyDigits(profile.municipalityCode)}2${cleanCnpj}${cleanSeries.padStart(5, "0")}${String(dpsNumber).padStart(15, "0")}`;
  const amount = money2(cents / 100);
  const description = renderDescription(profile.descriptionTemplate, draft.competence);
  let serviceDate = recipient.serviceDate;
  if (!serviceDate) {
    if (profile.competenceRule !== "last_day") throw fiscalError("Informe a data da prestação do serviço.", "SERVICE_DATE_REQUIRED");
    serviceDate = lastDayOfMonth(draft.competence);
  }
  if (serviceDate > saoPauloIso().slice(0, 10)) throw fiscalError("A data de competência não pode ser futura. Emita depois do fim do período ou informe a data da prestação.", "INVALID_COMPETENCE_DATE");
  const simpleOption = simpleOptionFor(profile.taxRegime);
  // regApTribSN só existe para ME/EPP (opSimpNac=3); MEI e não optante não o informam.
  const regime = `<regTrib><opSimpNac>${simpleOption}</opSimpNac>${simpleOption === 3 ? `<regApTribSN>${Number(profile.simpleAssessmentRegime || 1)}</regApTribSN>` : ""}<regEspTrib>${Number(profile.specialTaxRegime || 0)}</regEspTrib></regTrib>`;
  const recipientDocument = isForeign ? String(recipient.document || "").trim() : onlyDigits(recipient.document);
  const documentTag = isForeign ? "NIF" : (recipientDocument.length === 14 ? "CNPJ" : "CPF");
  const address = isForeign
    ? `<endExt><cPais>${escapeXml(recipient.country)}</cPais><cEndPost>${escapeXml(recipient.postalCode || recipient.zip)}</cEndPost><xCidade>${escapeXml(recipient.city)}</xCidade><xEstProvReg>${escapeXml(recipient.stateProvince || recipient.state)}</xEstProvReg></endExt>`
    : `<endNac><cMun>${onlyDigits(recipient.municipalityCode)}</cMun><CEP>${onlyDigits(recipient.zip)}</CEP></endNac>`;
  const recipientXml = `<toma><${documentTag}>${escapeXml(recipientDocument)}</${documentTag}><xNome>${escapeXml(recipient.name)}</xNome><end>${address}<xLgr>${escapeXml(recipient.street)}</xLgr><nro>${escapeXml(recipient.number)}</nro>${recipient.complement ? `<xCpl>${escapeXml(recipient.complement)}</xCpl>` : ""}<xBairro>${escapeXml(recipient.district)}</xBairro></end>${recipient.email ? `<email>${escapeXml(recipient.email)}</email>` : ""}</toma>`;
  // O afiliado presta o serviço no Brasil; só muda se a prévia disser outro país.
  const serviceLocation = recipient.serviceCountry && recipient.serviceCountry !== "BR"
    ? `<cPaisPrestacao>${escapeXml(recipient.serviceCountry)}</cPaisPrestacao>`
    : `<cLocPrestacao>${onlyDigits(profile.municipalityCode)}</cLocPrestacao>`;
  const serviceCode = `<cServ><cTribNac>${onlyDigits(profile.serviceCode)}</cTribNac>${profile.municipalServiceCode ? `<cTribMun>${escapeXml(profile.municipalServiceCode)}</cTribMun>` : ""}<xDescServ>${escapeXml(description)}</xDescServ>${profile.nbsCode ? `<cNBS>${onlyDigits(profile.nbsCode)}</cNBS>` : ""}</cServ>`;
  let commerce = "";
  let issTaxation = Number(recipient.issTaxation || profile.issTaxation || 1);
  let resultCountry = "";
  if (isForeign) {
    const { terms } = foreignTerms(profile, recipient, cents);
    commerce = `<comExt><mdPrestacao>${Number(terms.foreignServiceMode)}</mdPrestacao><vincPrest>${Number(terms.foreignRelationship)}</vincPrest><tpMoeda>${escapeXml(terms.foreignCurrency)}</tpMoeda><vServMoeda>${money2(terms.foreignAmount)}</vServMoeda><mecAFComexP>${escapeXml(terms.foreignSupportProvider)}</mecAFComexP><mecAFComexT>${escapeXml(terms.foreignSupportRecipient)}</mecAFComexT><movTempBens>${Number(terms.foreignTemporaryGoods)}</movTempBens><mdic>${Number(terms.foreignShareMdic)}</mdic></comExt>`;
    issTaxation = Number(recipient.issTaxation || terms.foreignIssTaxation);
    if (issTaxation === 3) resultCountry = terms.resultCountry;
  }
  const issRetention = Number(recipient.issRetention || profile.issRetention || 1);
  const issRate = issTaxation === 1 && profile.issRate !== "" && profile.issRate != null ? `<pAliq>${Number(profile.issRate).toFixed(2)}</pAliq>` : "";
  const tribMun = `<tribMun><tribISSQN>${issTaxation}</tribISSQN>${resultCountry ? `<cPaisResult>${escapeXml(resultCountry)}</cPaisResult>` : ""}<tpRetISSQN>${issRetention}</tpRetISSQN>${issRate}</tribMun>`;
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<DPS xmlns="${NFSE_NS}" versao="1.01"><infDPS Id="${dpsId}"><tpAmb>${environment}</tpAmb><dhEmi>${saoPauloIso()}</dhEmi><verAplic>Shoplytics_1.0</verAplic><serie>${escapeXml(cleanSeries)}</serie><nDPS>${dpsNumber}</nDPS><dCompet>${serviceDate}</dCompet><tpEmit>1</tpEmit><cLocEmi>${onlyDigits(profile.municipalityCode)}</cLocEmi><prest><CNPJ>${cleanCnpj}</CNPJ>${profile.municipalRegistration ? `<IM>${escapeXml(profile.municipalRegistration)}</IM>` : ""}${regime}</prest>${recipientXml}<serv><locPrest>${serviceLocation}</locPrest>${serviceCode}${commerce}</serv><valores><vServPrest><vServ>${amount}</vServ></vServPrest><trib>${tribMun}${federalTaxesXml(profile, cents)}${totalsXml(profile)}</trib></valores></infDPS></DPS>`;
  return { xml, dpsId, description, amount };
}

async function persistPreparedImport(preview, userId) {
  const sb = getSupabaseAdmin();
  const { data: existing } = await sb.from("fiscal_imports").select("id").eq("user_id", userId).eq("digest", preview.digest).maybeSingle();
  if (existing?.id) throw fiscalError("Este arquivo já foi importado.", "DUPLICATE_IMPORT", 409);
  const importId = crypto.randomUUID();
  const importRow = {
    id: importId, user_id: userId, filename: preview.filename, digest: preview.digest,
    mapping: preview.mapping, row_count: preview.rows, duplicate_rows: preview.duplicates,
    draft_count: preview.drafts.length, total_cents: preview.totalCents,
  };
  const { error: importError } = await sb.from("fiscal_imports").insert(importRow);
  if (importError) throw importError;
  const rows = preview.drafts.map((draft) => ({
    id: crypto.randomUUID(), user_id: userId, import_id: importId,
    recipient: draft.recipient, competence: draft.recipient.competence,
    recipient_document: String(draft.recipient.document || ""),
    amount_cents: draft.amountCents, status: draft.issues.length ? "pending" : "ready",
    issues: draft.issues, warnings: draft.warnings, source_lines: draft.sourceLines,
  }));
  try {
    for (let i = 0; i < rows.length; i += 200) {
      const { error } = await sb.from("fiscal_drafts").insert(rows.slice(i, i + 200));
      if (error) throw error;
    }
  } catch (err) {
    await sb.from("fiscal_imports").delete().eq("user_id", userId).eq("id", importId);
    if (err.code === "23505") {
      throw fiscalError("Já existe uma prévia para este cliente e competência. Concilie a nota existente antes de importar novamente.", "DUPLICATE_FISCAL_DRAFT", 409);
    }
    throw err;
  }
  await logEvent(userId, null, "import_created", { importId, filename: preview.filename, drafts: rows.length, totalCents: preview.totalCents, serviceDate: preview.serviceDate });
  return { importId, summary: { ...preview, drafts: undefined }, draftsCreated: rows.length };
}

async function commitImport(payload, userId = requireUserId()) {
  const preview = prepareImport(payload);
  if (preview.needsMapping) throw fiscalError("Confirme o mapeamento das colunas antes de importar.", "MAPPING_REQUIRED");
  return persistPreparedImport(preview, userId);
}

function publicDraft(row) {
  return {
    id: row.id, importId: row.import_id, recipient: row.recipient || {}, competence: row.competence,
    amountCents: Number(row.amount_cents || 0), status: row.status, issues: row.issues || [],
    warnings: row.warnings || [], sourceLines: row.source_lines || [], version: Number(row.version || 1),
    dpsSeries: row.dps_series || null, dpsNumber: row.dps_number == null ? null : Number(row.dps_number),
    dpsId: row.dps_id || null, environment: row.environment || null,
    accessKey: row.access_key || null, errorMessage: row.error_message || null,
    createdAt: row.created_at, updatedAt: row.updated_at, authorizedAt: row.authorized_at || null,
    cancelledAt: row.cancelled_at || null,
  };
}

const DRAFT_COLUMNS = "id,import_id,recipient,competence,amount_cents,status,issues,warnings,source_lines,version,dps_series,dps_number,dps_id,environment,access_key,error_message,created_at,updated_at,authorized_at,cancelled_at";

async function getState(options = {}, userId = requireUserId()) {
  const sb = getSupabaseAdmin();
  const page = Math.max(1, Number(options.page) || 1);
  const pageSize = Math.max(20, Math.min(500, Number(options.pageSize) || 100));
  const status = DRAFT_STATUSES.includes(options.status) ? options.status : "";
  const search = String(options.search || "").trim().slice(0, 60);
  const applyFilters = (query) => {
    let next = query.eq("user_id", userId);
    if (status) next = next.eq("status", status);
    if (/^\d{4}-\d{2}$/.test(String(options.competence || ""))) next = next.eq("competence", options.competence);
    if (search) next = next.ilike("recipient_document", `%${onlyDigits(search) || search.replace(/[%_]/g, "")}%`);
    return next;
  };
  const draftsQuery = applyFilters(sb.from("fiscal_drafts").select(DRAFT_COLUMNS, { count: "exact" }))
    .order("created_at", { ascending: false }).order("id", { ascending: true })
    .range((page - 1) * pageSize, page * pageSize - 1);
  const countFor = (value) => sb.from("fiscal_drafts").select("id", { count: "exact", head: true }).eq("user_id", userId).eq("status", value);
  const [profileResult, importsResult, draftsResult, ...statusResults] = await Promise.all([
    sb.from("fiscal_profiles").select("*").eq("user_id", userId).maybeSingle(),
    sb.from("fiscal_imports").select("id,filename,row_count,duplicate_rows,draft_count,total_cents,created_at").eq("user_id", userId).order("created_at", { ascending: false }).limit(20),
    draftsQuery,
    ...DRAFT_STATUSES.map(countFor),
  ]);
  if (profileResult.error && profileResult.error.code !== "PGRST116") throw profileResult.error;
  if (importsResult.error) throw importsResult.error;
  if (draftsResult.error) throw draftsResult.error;
  const profile = publicProfile(profileResult.data);
  const counts = Object.fromEntries(DRAFT_STATUSES.map((key, index) => [key, Number(statusResults[index]?.count || 0)]));
  const total = Number(draftsResult.count || 0);
  return {
    profile,
    profileIssues: validateProfile(profile || {}),
    productionIssues: validateProfile(profile || {}, { production: true }),
    productionEnabled: process.env.FISCAL_PRODUCTION_ENABLED === "1",
    restrictedEnabled: process.env.FISCAL_RESTRICTED_ENABLED === "1",
    layoutVersion: process.env.FISCAL_LAYOUT_VERSION || "1.01",
    counts,
    pagination: { page, pageSize, total, pages: Math.max(1, Math.ceil(total / pageSize)), status },
    imports: (importsResult.data || []).map((row) => ({ id: row.id, filename: row.filename, rowCount: row.row_count, duplicateRows: row.duplicate_rows, draftCount: row.draft_count, totalCents: Number(row.total_cents || 0), createdAt: row.created_at })),
    drafts: (draftsResult.data || []).map((row) => {
      const draft = publicDraft(row);
      if (["ready", "approved"].includes(draft.status) && profile) draft.emissionIssues = draftEmissionIssues(profile, row);
      return draft;
    }),
  };
}

const EDITABLE_RECIPIENT_FIELDS = ["name", "document", "email", "country", "zip", "postalCode", "street", "number", "complement", "district", "city", "state", "stateProvince", "municipalityCode", "serviceDate", "resultCountry", "foreignAmount", ...FOREIGN_FIELDS];

async function updateDraft(id, input, userId = requireUserId()) {
  const sb = getSupabaseAdmin();
  const current = await getDraftInternal(id, userId);
  if (!["pending", "ready", "approved", "rejected"].includes(current.status)) throw fiscalError("Esta nota não pode mais ser alterada.", "DRAFT_LOCKED", 409);
  const changes = {};
  for (const key of EDITABLE_RECIPIENT_FIELDS) {
    if (input.recipient && Object.prototype.hasOwnProperty.call(input.recipient, key)) changes[key] = String(input.recipient[key] ?? "").trim().slice(0, 300);
  }
  const recipient = { ...(current.recipient || {}), ...changes };
  recipient.country = String(recipient.country || "BR").toUpperCase();
  recipient.state = String(recipient.state || "").toUpperCase();
  recipient.document = recipient.country === "BR" ? onlyDigits(recipient.document) : String(recipient.document || "").trim();
  if (recipient.country === "BR") recipient.zip = onlyDigits(recipient.zip);
  recipient.municipalityCode = onlyDigits(recipient.municipalityCode);
  recipient.competence = normalizeCompetence(input.competence || recipient.competence || current.competence);
  if (!recipient.serviceDate) delete recipient.serviceDate;
  const amountCents = input.amountCents == null ? Number(current.amount_cents) : Math.round(Number(input.amountCents));
  const validation = validateRecipient(recipient, amountCents);
  const row = {
    recipient, recipient_document: String(recipient.document || ""), competence: recipient.competence, amount_cents: amountCents,
    issues: validation.issues, warnings: validation.warnings,
    status: validation.issues.length ? "pending" : "ready", error_message: null,
    version: Number(current.version || 1) + 1, updated_at: new Date().toISOString(),
  };
  // Concorrência otimista: só grava se ninguém alterou a prévia desde a leitura.
  const { data, error: updateError } = await sb.from("fiscal_drafts").update(row).eq("user_id", userId).eq("id", id)
    .eq("version", Number(current.version || 1)).in("status", ["pending", "ready", "approved", "rejected"]).select("*");
  if (updateError?.code === "23505") throw fiscalError("Já existe uma prévia para este cliente e competência.", "DUPLICATE_FISCAL_DRAFT", 409);
  if (updateError) throw updateError;
  if (!data?.length) throw fiscalError("A prévia foi alterada por outro processo. Atualize a lista.", "DRAFT_CONFLICT", 409);
  await logEvent(userId, id, "draft_updated", { fields: Object.keys(changes), amountChanged: amountCents !== Number(current.amount_cents), previousStatus: current.status });
  return publicDraft(data[0]);
}

async function approveDraft(id, userId = requireUserId(), profile = null) {
  const sb = getSupabaseAdmin();
  profile ||= await getProfile(userId);
  const profileIssues = validateProfile(profile || {});
  if (profileIssues.length) throw fiscalError(`Complete a configuração fiscal: ${profileIssues[0]}`, "PROFILE_INCOMPLETE");
  const current = await getDraftInternal(id, userId);
  if ((current.issues || []).length) throw fiscalError("Corrija as pendências antes de aprovar.", "DRAFT_HAS_ISSUES");
  const emissionIssues = draftEmissionIssues(profile, current);
  if (emissionIssues.length) throw fiscalError(emissionIssues[0], "DRAFT_HAS_ISSUES");
  if (current.status === "approved") return publicDraft(current);
  if (current.status !== "ready") throw fiscalError("Esta prévia não pode ser aprovada neste estado.", "INVALID_STATUS", 409);
  const now = new Date().toISOString();
  const { data, error: updateError } = await sb.from("fiscal_drafts").update({ status: "approved", approved_at: now, updated_at: now })
    .eq("user_id", userId).eq("id", id).eq("status", "ready").eq("version", Number(current.version || 1)).select("*");
  if (updateError) throw updateError;
  if (!data?.length) throw fiscalError("A prévia mudou durante a aprovação. Atualize a lista.", "DRAFT_CONFLICT", 409);
  await logEvent(userId, id, "draft_approved", { version: current.version });
  return publicDraft(data[0]);
}

// Aprovação em lote: percorre as prévias prontas (ou as ids informadas) e
// aprova só as que passam nas mesmas regras da aprovação individual.
async function approveBatch(input = {}, userId = requireUserId()) {
  const sb = getSupabaseAdmin();
  const profile = await getProfile(userId);
  const profileIssues = validateProfile(profile || {});
  if (profileIssues.length) throw fiscalError(`Complete a configuração fiscal: ${profileIssues[0]}`, "PROFILE_INCOMPLETE");
  const ids = Array.isArray(input.ids) ? input.ids.filter((id) => /^[0-9a-f-]{36}$/i.test(String(id))).slice(0, 1000) : null;
  let query = sb.from("fiscal_drafts").select("*").eq("user_id", userId).eq("status", "ready");
  if (ids) query = query.in("id", ids);
  if (/^\d{4}-\d{2}$/.test(String(input.competence || ""))) query = query.eq("competence", input.competence);
  const { data, error } = await query.limit(1000);
  if (error) throw error;
  const result = { approved: 0, skipped: [] };
  for (const row of data || []) {
    const issues = [...(row.issues || []), ...draftEmissionIssues(profile, row)];
    if (issues.length) { result.skipped.push({ id: row.id, reason: issues[0] }); continue; }
    const now = new Date().toISOString();
    const { data: updated, error: updateError } = await sb.from("fiscal_drafts").update({ status: "approved", approved_at: now, updated_at: now })
      .eq("user_id", userId).eq("id", row.id).eq("status", "ready").eq("version", Number(row.version || 1)).select("id");
    if (updateError || !updated?.length) { result.skipped.push({ id: row.id, reason: "A prévia mudou durante a aprovação." }); continue; }
    result.approved += 1;
  }
  await logEvent(userId, null, "batch_approved", { approved: result.approved, skipped: result.skipped.length });
  return result;
}

function escapeXml(value) {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function saoPauloIso(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).formatToParts(date);
  const item = (type) => parts.find((part) => part.type === type)?.value;
  const hour = item("hour") === "24" ? "00" : item("hour");
  return `${item("year")}-${item("month")}-${item("day")}T${hour}:${item("minute")}:${item("second")}-03:00`;
}

function lastDayOfMonth(competence) {
  const [year, month] = competence.split("-").map(Number);
  return `${competence}-${String(new Date(Date.UTC(year, month, 0)).getUTCDate()).padStart(2, "0")}`;
}

function renderDescription(template, competence) {
  const [year, month] = competence.split("-");
  return String(template || "").replace(/\{mes\}/g, month).replace(/\{ano\}/g, year);
}

// OIDs ICP-Brasil gravados como otherName no subjectAltName do certificado.
const ICP_OIDS = {
  personData: "2.16.76.1.3.1",       // PF: nascimento(8) + CPF(11) + ...
  responsibleName: "2.16.76.1.3.2",  // PJ: nome do responsável
  cnpj: "2.16.76.1.3.3",             // PJ: CNPJ(14)
  responsibleData: "2.16.76.1.3.4",  // PJ: nascimento(8) + CPF do responsável(11) + ...
};
const CLIENT_AUTH_OID = "1.3.6.1.5.5.7.3.2";

function icpIdentifiers(certificate) {
  const result = { cnpj: "", cpf: "", responsibleCpf: "", responsibleName: "", oids: [] };
  const extension = certificate.extensions.find((item) => item.id === "2.5.29.17");
  if (!extension?.value) return result;
  let san;
  try { san = forge.asn1.fromDer(extension.value); } catch (_) { return result; }
  for (const general of san.value || []) {
    if (general.tagClass !== forge.asn1.Class.CONTEXT_SPECIFIC || general.type !== 0 || !Array.isArray(general.value)) continue;
    const [oidNode, wrapped] = general.value;
    if (!oidNode || oidNode.type !== forge.asn1.Type.OID) continue;
    const oid = forge.asn1.derToOid(oidNode.value);
    const inner = Array.isArray(wrapped?.value) ? wrapped.value[0] : wrapped;
    const text = typeof inner?.value === "string" ? inner.value : "";
    result.oids.push(oid);
    if (oid === ICP_OIDS.cnpj) result.cnpj = onlyDigits(text).slice(0, 14);
    if (oid === ICP_OIDS.personData) result.cpf = onlyDigits(text.slice(8, 19));
    if (oid === ICP_OIDS.responsibleData) result.responsibleCpf = onlyDigits(text.slice(8, 19));
    if (oid === ICP_OIDS.responsibleName) result.responsibleName = text.trim();
  }
  return result;
}

let trustedRootsCache = null;
// ACs ICP-Brasil confiáveis: FISCAL_ICP_ROOTS_PEM (PEM ou caminho) ou, por
// padrão, o pacote oficial do ITI versionado em certs/icp-brasil.pem.
const BUNDLED_ICP_PEM = require("path").join(__dirname, "..", "certs", "icp-brasil.pem");
function trustedRoots() {
  if (trustedRootsCache) return trustedRootsCache;
  const source = String(process.env.FISCAL_ICP_ROOTS_PEM || "").trim() || BUNDLED_ICP_PEM;
  let pem = source;
  if (!source.includes("-----BEGIN")) {
    const file = require("path").isAbsolute(source) ? source : require("path").join(__dirname, "..", source);
    try { pem = require("fs").readFileSync(file, "utf8"); }
    catch (_) { return null; }
  }
  const blocks = pem.match(/-----BEGIN CERTIFICATE-----[sS]+?-----END CERTIFICATE-----/g) || [];
  trustedRootsCache = blocks.flatMap((block) => { try { return [forge.pki.certificateFromPem(block)]; } catch (_) { return []; } });
  return trustedRootsCache.length ? trustedRootsCache : null;
}

function readCertificate(input, expectedCnpj = "", options = {}) {
  let pfx;
  try { pfx = Buffer.from(String(input.content || ""), "base64"); }
  catch (_) { throw fiscalError("Não foi possível ler o certificado.", "INVALID_CERTIFICATE"); }
  if (!pfx.length || pfx.length > MAX_CERT_BYTES) throw fiscalError("Escolha um certificado PFX/P12 de até 2 MB.", "CERTIFICATE_TOO_LARGE");
  const password = String(input.password || "");
  if (password.length > 1024 || /[\r\n\0]/.test(password)) throw fiscalError("A senha contém caracteres não aceitos.", "INVALID_CERTIFICATE_PASSWORD");
  let store;
  try {
    store = forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(pfx.toString("binary")), false, password);
  } catch (_) {
    throw fiscalError("Não foi possível abrir o certificado. Confira o arquivo e a senha.", "INVALID_CERTIFICATE");
  }
  const bags = (type) => store.getBags({ bagType: type })[type] || [];
  const keys = [...bags(forge.pki.oids.pkcs8ShroudedKeyBag), ...bags(forge.pki.oids.keyBag)].map((bag) => bag.key).filter(Boolean);
  const certificates = bags(forge.pki.oids.certBag).map((bag) => bag.cert).filter(Boolean);
  if (!keys.length || !certificates.length) throw fiscalError("O arquivo não contém certificado e chave privada.", "INVALID_CERTIFICATE");
  if (keys.some((key) => !key.n)) throw fiscalError("É necessário um certificado A1 com chave RSA.", "UNSUPPORTED_CERTIFICATE");
  // Escolhe o certificado cuja chave pública corresponde à chave privada; os
  // demais do PFX são tratados como cadeia intermediária.
  let certificate = null;
  let privateKey = null;
  for (const key of keys) {
    certificate = certificates.find((cert) => cert.publicKey?.n && cert.publicKey.n.equals(key.n));
    if (certificate) { privateKey = key; break; }
  }
  if (!certificate) throw fiscalError("A chave privada não corresponde a nenhum certificado do arquivo.", "CERTIFICATE_KEY_MISMATCH");
  const intermediates = certificates.filter((cert) => cert !== certificate);
  const now = options.now || new Date();
  if (!(certificate.validity.notBefore <= now && now < certificate.validity.notAfter)) throw fiscalError("O certificado está fora do período de validade.", "CERTIFICATE_EXPIRED");
  const keyUsage = certificate.getExtension("keyUsage");
  if (!keyUsage?.digitalSignature) throw fiscalError("O certificado não permite assinatura digital.", "CERTIFICATE_KEY_USAGE");
  const extKeyUsage = certificate.getExtension("extKeyUsage");
  if (extKeyUsage && !extKeyUsage.clientAuth && !extKeyUsage[CLIENT_AUTH_OID]) throw fiscalError("O certificado não permite autenticação de cliente (mTLS).", "CERTIFICATE_KEY_USAGE");
  if (certificate.isIssuer(certificate)) throw fiscalError("Use um certificado ICP-Brasil emitido por autoridade certificadora, não autoassinado.", "CERTIFICATE_NOT_ICP_BRASIL");
  const icp = icpIdentifiers(certificate);
  if (!icp.cnpj && !icp.cpf) throw fiscalError("O certificado não tem os identificadores ICP-Brasil de CNPJ/CPF.", "CERTIFICATE_NOT_ICP_BRASIL");
  const expected = onlyDigits(expectedCnpj);
  if (expected && icp.cnpj !== expected) throw fiscalError("O certificado não pertence ao CNPJ cadastrado (OID ICP-Brasil 2.16.76.1.3.3).", "CERTIFICATE_CNPJ_MISMATCH");
  // Normaliza via PEM: o índice de emissores do forge usa o hash do DER.
  const roots = (options.trustedRoots || trustedRoots())?.map((cert) => forge.pki.certificateFromPem(forge.pki.certificateToPem(cert))) || null;
  let chainVerified = false;
  if (roots) {
    try {
      const caStore = forge.pki.createCaStore(roots);
      // Intermediárias do PFX entram só como elos da cadeia, nunca como raiz.
      // (no forge, a.isIssuer(b) significa "b emitiu a").
      const chain = [certificate];
      let current = certificate;
      for (let i = 0; i < 6 && !roots.some((root) => current.isIssuer(root)); i += 1) {
        const issuer = intermediates.find((cert) => current.isIssuer(cert) && !chain.includes(cert));
        if (!issuer) break;
        chain.push(issuer);
        current = issuer;
      }
      forge.pki.verifyCertificateChain(caStore, chain, { validityCheckDate: now });
      chainVerified = true;
    } catch (_) {
      throw fiscalError("A cadeia do certificado não termina em uma raiz ICP-Brasil confiável.", "CERTIFICATE_CHAIN_INVALID");
    }
  }
  const subject = certificate.subject.attributes.map((attr) => `${attr.shortName || attr.name}=${attr.value}`).join(", ");
  return {
    pfx, password, certificate,
    certPem: forge.pki.certificateToPem(certificate),
    keyPem: forge.pki.privateKeyToPem(privateKey),
    info: {
      subject, cnpj: icp.cnpj || null, cpf: icp.cpf || null, responsibleCpf: icp.responsibleCpf || null,
      serialNumber: certificate.serialNumber,
      validFrom: certificate.validity.notBefore.toISOString(), validUntil: certificate.validity.notAfter.toISOString(),
      matchesCnpj: expected ? icp.cnpj === expected : null,
      chainVerified,
      // A LCR/OCSP não é consultada localmente; a revogação é barrada pela API
      // oficial na conexão mTLS.
      revocationChecked: false,
    },
  };
}

function signXml(xml, identity, { referenceTag, rootTag }) {
  const signer = new SignedXml({
    privateKey: identity.keyPem,
    publicCert: identity.certPem,
    canonicalizationAlgorithm: C14N,
    signatureAlgorithm: `${DS_NS}rsa-sha1`,
  });
  signer.addReference({
    xpath: `//*[local-name()='${referenceTag}']`,
    transforms: [`${DS_NS}enveloped-signature`, C14N],
    digestAlgorithm: `${DS_NS}sha1`,
  });
  signer.computeSignature(xml, { location: { reference: `/*[local-name()='${rootTag}']`, action: "append" }, prefix: "" });
  const signed = signer.getSignedXml();
  const document = new DOMParser().parseFromString(signed, "text/xml");
  const signature = childElements(document.documentElement, "Signature")[0];
  if (!signature) throw fiscalError("A assinatura XML não foi criada.", "SIGNATURE_FAILED");
  const verifier = new SignedXml({ publicCert: identity.certPem });
  verifier.loadSignature(signature);
  if (!verifier.checkSignature(signed)) throw fiscalError("A assinatura XML não passou na conferência local.", "SIGNATURE_FAILED");
  return signed;
}

function signDpsXml(xml, identity) {
  return signXml(xml, identity, { referenceTag: "infDPS", rootTag: "DPS" });
}

function downloadHttps(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(fiscalError("Muitos redirecionamentos ao obter o XSD oficial.", "XSD_DOWNLOAD_FAILED", 503));
    const request = https.get(url, { headers: { "User-Agent": "Shoplytics-NFSe/1.0", Accept: "application/zip" }, timeout: 20000 }, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        return resolve(downloadHttps(new URL(response.headers.location, url).toString(), redirects + 1));
      }
      if (response.statusCode !== 200) {
        response.resume();
        return reject(fiscalError(`Não foi possível obter o XSD oficial (HTTP ${response.statusCode}).`, "XSD_DOWNLOAD_FAILED", 503));
      }
      const chunks = [];
      let size = 0;
      response.on("data", (chunk) => {
        size += chunk.length;
        if (size > 5 * 1024 * 1024) request.destroy(fiscalError("O pacote oficial de XSD excedeu o limite esperado.", "XSD_DOWNLOAD_FAILED", 503));
        else chunks.push(chunk);
      });
      response.on("end", () => resolve(Buffer.concat(chunks)));
    });
    request.on("timeout", () => request.destroy(fiscalError("Tempo esgotado ao obter o XSD oficial.", "XSD_DOWNLOAD_FAILED", 503)));
    request.on("error", reject);
  });
}

async function officialSchemas() {
  if (!officialSchemasPromise) {
    // FISCAL_XSD_PATH permite usar o pacote oficial já baixado (testes e
    // servidores sem saída para gov.br).
    const load = process.env.FISCAL_XSD_PATH
      ? Promise.resolve(require("fs").readFileSync(process.env.FISCAL_XSD_PATH))
      : downloadHttps(process.env.FISCAL_XSD_URL || OFFICIAL_XSD_URL);
    officialSchemasPromise = load.then((archive) => {
      const files = unzipSync(new Uint8Array(archive));
      const prefix = "Schemas/1.01/";
      const read = (name) => {
        const entry = files[`${prefix}${name}`];
        if (!entry) throw fiscalError(`O pacote oficial não contém ${name}.`, "XSD_PACKAGE_INVALID", 503);
        let contents = strFromU8(entry);
        // libxml2 não aceita âncoras ^$ em xs:pattern; o padrão equivalente é mantido.
        if (name === "tiposSimples_v1.01.xsd") contents = contents.replace('value="^0{0,4}\\d{1,5}$"', 'value="[0-9]{1,5}"');
        return { fileName: name, contents };
      };
      const shared = [read("tiposComplexos_v1.01.xsd"), read("tiposSimples_v1.01.xsd"), read("xmldsig-core-schema.xsd")];
      return {
        dps: { main: read("DPS_v1.01.xsd"), dependencies: shared },
        event: { main: read("pedRegEvento_v1.01.xsd"), dependencies: [read("tiposEventos_v1.01.xsd"), ...shared] },
      };
    }).catch((error) => {
      officialSchemasPromise = null;
      throw error;
    });
  }
  return officialSchemasPromise;
}

async function validateXsd(xml, kind = "dps") {
  const schemas = (await officialSchemas())[kind];
  const result = await validateXML({
    xml: [{ fileName: `${kind}.xml`, contents: xml }],
    schema: [schemas.main],
    preload: schemas.dependencies,
    maxMemoryPages: 1024,
  });
  if (!result.valid) {
    const details = (result.errors || []).slice(0, 3).map((item) => item.message || item.rawMessage || String(item)).join(" | ");
    throw fiscalError(`O XML não passou no XSD oficial: ${details || "estrutura inválida"}`, kind === "dps" ? "DPS_XSD_INVALID" : "EVENT_XSD_INVALID");
  }
  return true;
}

function validateDpsXsd(xml) {
  return validateXsd(xml, "dps");
}

function resolveEnvironment(value) {
  return value === "production" ? "production" : "restricted";
}

function officialRequest({ method, path, identity, body = null, timeoutMs = 30000, environment = "restricted", service = "sefin", binary = false }) {
  return new Promise((resolve, reject) => {
    const endpoint = (OFFICIAL_ENDPOINTS[resolveEnvironment(environment)] || OFFICIAL_ENDPOINTS.restricted)[service];
    const encoded = body == null ? null : Buffer.from(JSON.stringify(body));
    const req = https.request({
      hostname: endpoint.hostname, port: 443, method, path: `${endpoint.base}${path}`,
      pfx: identity.pfx, passphrase: identity.password, minVersion: "TLSv1.2",
      rejectUnauthorized: true, timeout: timeoutMs,
      headers: { Accept: binary ? "application/pdf" : "application/json", ...(encoded ? { "Content-Type": "application/json", "Content-Length": encoded.length } : {}) },
    }, (res) => {
      const chunks = [];
      let size = 0;
      res.on("data", (chunk) => {
        size += chunk.length;
        if (size <= 10 * 1024 * 1024) chunks.push(chunk);
        else req.destroy(fiscalError("Resposta fiscal grande demais.", "FISCAL_RESPONSE_TOO_LARGE"));
      });
      res.on("end", () => {
        const buffer = Buffer.concat(chunks);
        const raw = buffer.toString("utf8");
        let json = null;
        if (!binary || !String(res.headers["content-type"] || "").includes("pdf")) {
          try { json = raw ? JSON.parse(raw) : null; } catch (_) { /* mantém o texto bruto */ }
        }
        resolve({ status: res.statusCode || 0, headers: res.headers, json, raw: raw.slice(0, 20000), buffer: binary ? buffer : null });
      });
    });
    req.on("timeout", () => req.destroy(fiscalError("A resposta da API fiscal ficou inconclusiva.", "FISCAL_TIMEOUT", 504)));
    req.on("error", reject);
    if (encoded) req.write(encoded);
    req.end();
  });
}

function apiMessage(response) {
  const json = response?.json || {};
  const list = json.erros || json.erro || json.mensagens || json.Erros;
  const first = Array.isArray(list) ? list[0] : list;
  const code = first?.codigo || first?.Codigo || json.codigo || "";
  const text = first?.descricao || first?.Descricao || first?.mensagem || json.mensagem || json.message || "";
  return { code: String(code || ""), text: String(text || `Resposta fiscal HTTP ${response?.status}`) };
}

function decodeGzipBase64(value) {
  const compressed = Buffer.from(String(value || ""), "base64");
  if (!compressed.length) throw fiscalError("A API não retornou o XML esperado.", "INVALID_FISCAL_RECEIPT");
  return zlib.gunzipSync(compressed, { maxOutputLength: 10 * 1024 * 1024 }).toString("utf8");
}

function childPath(node, ...names) {
  let current = node;
  for (const name of names) {
    current = childElements(current, name)[0];
    if (!current) return null;
  }
  return current;
}

function text(node) {
  return String(node?.textContent || "").trim();
}

// Confere o XML autorizado pela estrutura (caminhos do leiaute), e não por
// busca de texto: emitente, cliente, valor, ambiente, Id da DPS e assinatura da
// Sefin sobre infNFSe.
function validateAuthorizedXml(xml, profile, draft, receipt, { dpsId, environment } = {}) {
  const document = new DOMParser().parseFromString(xml, "text/xml");
  const root = document.documentElement;
  if (!root || root.localName !== "NFSe" || root.namespaceURI !== NFSE_NS) throw fiscalError("A API retornou um XML que não é uma NFS-e.", "INVALID_FISCAL_RECEIPT");
  const infNFSe = childPath(root, "infNFSe");
  const infDPS = childPath(infNFSe, "DPS", "infDPS");
  if (!infNFSe || !infDPS) throw fiscalError("O XML autorizado não segue o leiaute da NFS-e.", "INVALID_FISCAL_RECEIPT");
  if (text(childPath(infDPS, "prest", "CNPJ")) !== onlyDigits(profile.cnpj)) throw fiscalError("O XML autorizado não corresponde à sua empresa de afiliado.", "INVALID_FISCAL_RECEIPT");
  const recipient = draft.recipient || {};
  const isForeign = recipient.country && recipient.country !== "BR";
  const recipientDocument = isForeign ? String(recipient.document || "").trim() : onlyDigits(recipient.document);
  const toma = childPath(infDPS, "toma");
  const tomaDocument = text(childPath(toma, isForeign ? "NIF" : (recipientDocument.length === 14 ? "CNPJ" : "CPF")));
  if (tomaDocument !== recipientDocument) throw fiscalError("O XML autorizado não corresponde à loja que pagou a comissão.", "INVALID_FISCAL_RECEIPT");
  if (text(childPath(infDPS, "valores", "vServPrest", "vServ")) !== money2(Number(draft.amount_cents) / 100)) throw fiscalError("O XML autorizado não corresponde ao valor solicitado.", "INVALID_FISCAL_RECEIPT");
  if (dpsId && infDPS.getAttribute("Id") !== dpsId) throw fiscalError("O XML autorizado pertence a outra DPS.", "INVALID_FISCAL_RECEIPT");
  if (environment && text(childPath(infDPS, "tpAmb")) !== OFFICIAL_ENDPOINTS[resolveEnvironment(environment)].tpAmb) throw fiscalError("O XML autorizado é de outro ambiente.", "INVALID_FISCAL_RECEIPT");
  const infId = infNFSe.getAttribute("Id") || "";
  const signature = childElements(root, "Signature")[0];
  const reference = signature ? descendants(signature, "Reference")[0]?.getAttribute("URI") : "";
  const encodedCertificate = signature ? descendants(signature, "X509Certificate")[0]?.textContent?.replace(/\s/g, "") : "";
  if (!signature || !encodedCertificate || reference !== `#${infId}`) throw fiscalError("O XML autorizado não possui a assinatura da Sefin sobre a NFS-e.", "INVALID_FISCAL_RECEIPT");
  const publicCert = `-----BEGIN CERTIFICATE-----\n${encodedCertificate.match(/.{1,64}/g).join("\n")}\n-----END CERTIFICATE-----`;
  const verifier = new SignedXml({ publicCert });
  verifier.loadSignature(signature);
  if (!verifier.checkSignature(xml)) throw fiscalError("A assinatura do XML autorizado é inválida.", "INVALID_FISCAL_RECEIPT");
  const keyFromId = infId.replace(/^NFS/, "");
  const accessKey = String(receipt?.chaveAcesso || keyFromId).replace(/\D/g, "");
  if (!/^\d{50}$/.test(accessKey) || (keyFromId && keyFromId !== accessKey)) throw fiscalError("A API não retornou uma chave de acesso válida.", "INVALID_FISCAL_RECEIPT");
  return accessKey;
}

async function getDraftInternal(id, userId) {
  const { data, error } = await getSupabaseAdmin().from("fiscal_drafts").select("*").eq("user_id", userId).eq("id", id).single();
  if (error || !data) throw fiscalError("Prévia não encontrada.", "DRAFT_NOT_FOUND", 404);
  return data;
}

async function previewXml(id, userId = requireUserId()) {
  const profile = await getProfile(userId);
  const draft = await getDraftInternal(id, userId);
  const result = buildDpsXml(profile, draft, { environment: "2", series: profile.series, number: 1 });
  let xsd = { valid: null, error: null };
  try { await validateDpsXsd(result.xml); xsd = { valid: true, error: null }; }
  catch (err) { xsd = { valid: err.code === "DPS_XSD_INVALID" ? false : null, error: err.message }; }
  return { xml: result.xml, dpsId: result.dpsId, environment: "previa-local", signed: false, transmitted: false, xsd };
}

function environmentGate(environment, confirmation) {
  const isProduction = environment === "production";
  if (isProduction && process.env.FISCAL_PRODUCTION_ENABLED !== "1") throw fiscalError("A emissão real ainda está bloqueada no servidor.", "FISCAL_PRODUCTION_DISABLED", 503);
  if (!isProduction && process.env.FISCAL_RESTRICTED_ENABLED !== "1") throw fiscalError("A produção restrita (homologação) está bloqueada no servidor.", "FISCAL_RESTRICTED_DISABLED", 503);
  if (process.env.FISCAL_LAYOUT_VERSION !== "1.01") throw fiscalError("A versão fiscal configurada no servidor não foi homologada.", "FISCAL_LAYOUT_NOT_APPROVED", 503);
  const expected = isProduction ? "EMITIR" : "HOMOLOGAR";
  if (confirmation !== expected) throw fiscalError(`Digite ${expected} para confirmar a transmissão.`, "EMISSION_CONFIRMATION_REQUIRED");
}

async function loadIdentity(certificateInput, profile, environment) {
  const identity = readCertificate(certificateInput, profile.cnpj);
  if (environment === "production" && !identity.info.chainVerified) {
    throw fiscalError("Configure FISCAL_ICP_ROOTS_PEM com as raízes ICP-Brasil para validar a cadeia do certificado antes de emitir em produção.", "CERTIFICATE_CHAIN_UNVERIFIED", 503);
  }
  return identity;
}

// Reserva atômica por compare-and-swap no contador do perfil. Um número
// reservado e não usado vira lacuna, nunca duplicidade.
async function reserveDpsNumber(userId, environment) {
  const sb = getSupabaseAdmin();
  const column = environment === "production" ? "next_dps_number" : "next_test_dps_number";
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const { data: row, error } = await sb.from("fiscal_profiles").select(`${column},series`).eq("user_id", userId).single();
    if (error || !row) throw fiscalError("Perfil fiscal não encontrado.", "PROFILE_INCOMPLETE");
    const number = Number(row[column] || 1);
    const { data: updated, error: updateError } = await sb.from("fiscal_profiles")
      .update({ [column]: number + 1, updated_at: new Date().toISOString() })
      .eq("user_id", userId).eq(column, number).select(column);
    if (updateError) throw updateError;
    if (updated?.length) return { number, series: row.series || "49999" };
  }
  throw fiscalError("Não foi possível reservar a numeração da DPS. Tente novamente.", "DPS_NUMBER_CONFLICT", 409);
}

function isFinalReceipt(environment) {
  return environment === "production" ? "authorized" : "homologated";
}

async function markDraft(userId, id, fromStatuses, changes) {
  const { data, error } = await getSupabaseAdmin().from("fiscal_drafts")
    .update({ ...changes, updated_at: new Date().toISOString() })
    .eq("user_id", userId).eq("id", id).in("status", fromStatuses).select("*");
  if (error) throw error;
  return data?.[0] || null;
}

async function transmitDraft({ userId, profile, identity, draft, environment }) {
  if (draft.status !== "approved") throw fiscalError("A prévia precisa estar aprovada antes da emissão.", "DRAFT_NOT_APPROVED", 409);
  const isProduction = environment === "production";
  const inFlight = isProduction ? "submitting" : "homologating";
  const tpAmb = OFFICIAL_ENDPOINTS[environment].tpAmb;
  // Monta e valida antes de consumir numeração, para erros de cadastro não abrirem lacunas.
  buildDpsXml(profile, draft, { environment: tpAmb, series: profile.series, number: 1 });
  const { number, series } = await reserveDpsNumber(userId, environment);
  const built = buildDpsXml(profile, draft, { environment: tpAmb, series, number });
  const signedXml = signDpsXml(built.xml, identity);
  await validateDpsXsd(signedXml);
  const locked = await markDraft(userId, draft.id, ["approved"], {
    status: inFlight, environment, dps_series: series, dps_number: number, dps_id: built.dpsId,
    signed_xml: signedXml, submitted_at: new Date().toISOString(), error_message: null, error_code: null,
  });
  if (!locked) throw fiscalError("A nota já foi reservada por outro processo.", "DRAFT_CONFLICT", 409);
  await logEvent(userId, draft.id, "emission_started", { environment, dpsId: built.dpsId, number });
  try {
    const exists = await officialRequest({ method: "HEAD", path: `/dps/${encodeURIComponent(built.dpsId)}`, identity, environment });
    if (exists.status !== 404) {
      await markDraft(userId, draft.id, [inFlight], { status: "uncertain", error_message: `A consulta prévia não confirmou que a DPS está livre (HTTP ${exists.status}). Faça a conciliação.`, response_payload: { precheck: { status: exists.status } } });
      await logEvent(userId, draft.id, "emission_precheck_inconclusive", { status: exists.status });
      throw fiscalError("A existência da DPS ficou inconclusiva. A numeração foi bloqueada para conciliação.", "DPS_PRECHECK_INCONCLUSIVE", 409);
    }
    const payload = { dpsXmlGZipB64: zlib.gzipSync(Buffer.from(signedXml)).toString("base64") };
    const receipt = await officialRequest({ method: "POST", path: "/nfse", identity, body: payload, environment });
    if ([200, 201].includes(receipt.status) && receipt.json?.nfseXmlGZipB64) {
      const authorizedXml = decodeGzipBase64(receipt.json.nfseXmlGZipB64);
      const accessKey = validateAuthorizedXml(authorizedXml, profile, draft, receipt.json, { dpsId: built.dpsId, environment });
      const saved = await markDraft(userId, draft.id, [inFlight], {
        status: isFinalReceipt(environment), authorized_xml: authorizedXml, access_key: accessKey,
        response_payload: { ...receipt.json, nfseXmlGZipB64: undefined }, authorized_at: new Date().toISOString(),
      });
      await logEvent(userId, draft.id, "emission_authorized", { environment, accessKey, alerts: receipt.json.alertas || null });
      return saved ? publicDraft(saved) : publicDraft(await getDraftInternal(draft.id, userId));
    }
    const { code, text: message } = apiMessage(receipt);
    const rejected = receipt.status >= 400 && receipt.status < 500;
    await markDraft(userId, draft.id, [inFlight], {
      status: rejected ? "rejected" : "uncertain", error_message: `${code ? `${code}: ` : ""}${message}`.slice(0, 2000),
      error_code: code || `HTTP_${receipt.status}`, response_payload: receipt.json || { raw: receipt.raw },
    });
    await logEvent(userId, draft.id, rejected ? "emission_rejected" : "emission_uncertain", { status: receipt.status, code, message: message.slice(0, 500) });
    throw fiscalError(rejected ? `Emissão rejeitada: ${code ? `${code} – ` : ""}${message}` : "A emissão ficou inconclusiva e não será reenviada automaticamente.", rejected ? "FISCAL_REJECTED" : "FISCAL_UNCERTAIN", rejected ? 422 : 503);
  } catch (err) {
    if (["DPS_PRECHECK_INCONCLUSIVE", "FISCAL_REJECTED", "FISCAL_UNCERTAIN"].includes(err.code)) throw err;
    await markDraft(userId, draft.id, [inFlight], { status: "uncertain", error_message: String(err.message || err).slice(0, 2000), error_code: err.code || "TRANSPORT_ERROR" });
    await logEvent(userId, draft.id, "emission_uncertain", { error: String(err.message || err).slice(0, 500) });
    throw fiscalError("A transmissão ficou inconclusiva. Não tente emitir novamente; faça a conciliação desta DPS.", "FISCAL_UNCERTAIN", 503);
  }
}

async function emitDraft(id, certificateInput, confirmation, userId = requireUserId(), environment = "restricted") {
  environment = resolveEnvironment(environment);
  environmentGate(environment, confirmation);
  const profile = await getProfile(userId);
  const profileIssues = validateProfile(profile || {}, { production: environment === "production" });
  if (profileIssues.length) throw fiscalError(profileIssues[0], "PROFILE_INCOMPLETE");
  const identity = await loadIdentity(certificateInput, profile, environment);
  const draft = await getDraftInternal(id, userId);
  return transmitDraft({ userId, profile, identity, draft, environment });
}

// Emissão em lote: sequencial (concorrência 1), limitada por chamada, e para
// no primeiro resultado inconclusivo para não acumular DPS sem conciliação.
async function emitBatch(input, userId = requireUserId()) {
  const environment = resolveEnvironment(input.environment);
  environmentGate(environment, input.confirmation);
  const profile = await getProfile(userId);
  const profileIssues = validateProfile(profile || {}, { production: environment === "production" });
  if (profileIssues.length) throw fiscalError(profileIssues[0], "PROFILE_INCOMPLETE");
  const identity = await loadIdentity(input.certificate || {}, profile, environment);
  const limit = Math.max(1, Math.min(50, Number(input.limit) || 20));
  let query = getSupabaseAdmin().from("fiscal_drafts").select("*").eq("user_id", userId).eq("status", "approved").order("created_at", { ascending: true }).limit(limit);
  if (Array.isArray(input.ids)) query = query.in("id", input.ids.filter((value) => /^[0-9a-f-]{36}$/i.test(String(value))).slice(0, limit));
  const { data, error } = await query;
  if (error) throw error;
  const results = [];
  for (const draft of data || []) {
    try {
      const done = await transmitDraft({ userId, profile, identity, draft, environment });
      results.push({ id: draft.id, status: done.status, accessKey: done.accessKey });
    } catch (err) {
      results.push({ id: draft.id, status: "error", code: err.code, error: err.message });
      if (["FISCAL_UNCERTAIN", "DPS_PRECHECK_INCONCLUSIVE", "DPS_NUMBER_CONFLICT"].includes(err.code)) break;
    }
  }
  const remaining = await getSupabaseAdmin().from("fiscal_drafts").select("id", { count: "exact", head: true }).eq("user_id", userId).eq("status", "approved");
  return { processed: results.length, results, remainingApproved: Number(remaining.count || 0) };
}

async function fetchNfseXml(accessKey, identity, environment) {
  const response = await officialRequest({ method: "GET", path: `/nfse/${encodeURIComponent(accessKey)}`, identity, environment });
  if (response.status !== 200 || !response.json?.nfseXmlGZipB64) {
    const { code, text: message } = apiMessage(response);
    throw fiscalError(`Não foi possível consultar a NFS-e: ${code ? `${code} – ` : ""}${message}`, "NFSE_QUERY_FAILED", response.status >= 500 ? 503 : 422);
  }
  return decodeGzipBase64(response.json.nfseXmlGZipB64);
}

// Conciliação após timeout ou resposta inconclusiva: consulta a DPS pelo Id.
async function reconcileDraft(id, certificateInput, userId = requireUserId()) {
  const profile = await getProfile(userId);
  const draft = await getDraftInternal(id, userId);
  if (!["uncertain", "submitting", "homologating"].includes(draft.status) || !draft.dps_id) throw fiscalError("Só notas em conciliação podem ser conferidas.", "INVALID_STATUS", 409);
  if (draft.status !== "uncertain" && Date.now() - new Date(draft.submitted_at || 0).getTime() < 2 * 60 * 1000) {
    throw fiscalError("A transmissão ainda pode estar em andamento. Aguarde dois minutos e tente de novo.", "RECONCILE_TOO_EARLY", 409);
  }
  const environment = resolveEnvironment(draft.environment || (draft.status === "homologating" ? "restricted" : "production"));
  const identity = readCertificate(certificateInput, profile.cnpj);
  const lookup = await officialRequest({ method: "GET", path: `/dps/${encodeURIComponent(draft.dps_id)}`, identity, environment });
  if (lookup.status === 200 && lookup.json?.chaveAcesso) {
    const xml = await fetchNfseXml(String(lookup.json.chaveAcesso), identity, environment);
    const accessKey = validateAuthorizedXml(xml, profile, draft, lookup.json, { dpsId: draft.dps_id, environment });
    const saved = await markDraft(userId, id, ["uncertain", "submitting", "homologating"], {
      status: isFinalReceipt(environment), authorized_xml: xml, access_key: accessKey, authorized_at: new Date().toISOString(), error_message: null, error_code: null,
    });
    await logEvent(userId, id, "reconciled_authorized", { environment, accessKey });
    return { outcome: "authorized", draft: saved ? publicDraft(saved) : publicDraft(await getDraftInternal(id, userId)) };
  }
  if (lookup.status === 404) {
    const head = await officialRequest({ method: "HEAD", path: `/dps/${encodeURIComponent(draft.dps_id)}`, identity, environment });
    if (head.status === 404) {
      // A DPS não existe na Sefin: libera a prévia para nova emissão com outro número.
      const saved = await markDraft(userId, id, ["uncertain", "submitting", "homologating"], {
        status: "approved", dps_series: null, dps_number: null, dps_id: null, signed_xml: null, environment: null,
        error_message: `Conciliação: a DPS ${draft.dps_id} não foi gerada; a prévia voltou para aprovada.`, error_code: null,
      });
      await logEvent(userId, id, "reconciled_not_found", { environment, dpsId: draft.dps_id });
      return { outcome: "not_found", draft: saved ? publicDraft(saved) : publicDraft(await getDraftInternal(id, userId)) };
    }
  }
  const { code, text: message } = apiMessage(lookup);
  await logEvent(userId, id, "reconcile_inconclusive", { status: lookup.status, code });
  throw fiscalError(`A conciliação continua inconclusiva: ${message}`, "RECONCILE_INCONCLUSIVE", 503);
}

async function danfsePdf(id, certificateInput, userId = requireUserId()) {
  const profile = await getProfile(userId);
  const draft = await getDraftInternal(id, userId);
  if (!draft.access_key || !["authorized", "homologated", "cancelled"].includes(draft.status)) throw fiscalError("Esta nota não possui chave de acesso.", "XML_NOT_AVAILABLE", 404);
  const identity = readCertificate(certificateInput, profile.cnpj);
  const response = await officialRequest({ method: "GET", path: `/danfse/${encodeURIComponent(draft.access_key)}`, identity, environment: draft.environment, service: "adn", binary: true });
  if (response.status !== 200 || !response.buffer?.length || response.buffer.subarray(0, 4).toString() !== "%PDF") {
    const { text: message } = apiMessage(response);
    throw fiscalError(`Não foi possível obter o DANFSe: ${message}`, "DANFSE_FAILED", response.status >= 500 ? 503 : 422);
  }
  return response.buffer;
}

const CANCEL_REASONS = { 1: "Erro na Emissão", 2: "Serviço não Prestado", 9: "Outros" };

function buildCancelEventXml({ accessKey, cnpj, environment, reasonCode, reasonText }) {
  // XSD 1.01: "PRE" + chave(50) + tipo do evento(6) = PRE[0-9]{56}.
  const id = `PRE${accessKey}101101`;
  return `<?xml version="1.0" encoding="UTF-8"?>\n<pedRegEvento xmlns="${NFSE_NS}" versao="1.01"><infPedReg Id="${id}"><tpAmb>${OFFICIAL_ENDPOINTS[resolveEnvironment(environment)].tpAmb}</tpAmb><verAplic>Shoplytics_1.0</verAplic><dhEvento>${saoPauloIso()}</dhEvento><CNPJAutor>${onlyDigits(cnpj)}</CNPJAutor><chNFSe>${accessKey}</chNFSe><e101101><xDesc>Cancelamento de NFS-e</xDesc><cMotivo>${reasonCode}</cMotivo><xMotivo>${escapeXml(reasonText)}</xMotivo></e101101></infPedReg></pedRegEvento>`;
}

async function cancelDraft(id, input, userId = requireUserId()) {
  const draft = await getDraftInternal(id, userId);
  const environment = resolveEnvironment(draft.environment);
  if (!["authorized", "homologated"].includes(draft.status) || !draft.access_key) throw fiscalError("Só notas autorizadas podem ser canceladas.", "INVALID_STATUS", 409);
  if (input.confirmation !== "CANCELAR") throw fiscalError("Digite CANCELAR para confirmar o cancelamento.", "CANCEL_CONFIRMATION_REQUIRED");
  if (environment === "production" && process.env.FISCAL_PRODUCTION_ENABLED !== "1") throw fiscalError("Eventos em produção estão bloqueados no servidor.", "FISCAL_PRODUCTION_DISABLED", 503);
  const reasonCode = Number(input.reasonCode);
  const reasonText = String(input.reason || "").trim();
  if (!CANCEL_REASONS[reasonCode]) throw fiscalError("Escolha o motivo do cancelamento.", "INVALID_CANCEL_REASON");
  if (reasonText.length < 15 || reasonText.length > 255) throw fiscalError("Descreva o motivo com 15 a 255 caracteres.", "INVALID_CANCEL_REASON");
  const profile = await getProfile(userId);
  const identity = await loadIdentity(input.certificate || {}, profile, environment);
  const xml = buildCancelEventXml({ accessKey: draft.access_key, cnpj: profile.cnpj, environment, reasonCode, reasonText });
  const signed = signXml(xml, identity, { referenceTag: "infPedReg", rootTag: "pedRegEvento" });
  await validateXsd(signed, "event");
  await logEvent(userId, id, "cancel_requested", { environment, reasonCode });
  const response = await officialRequest({
    method: "POST", path: `/nfse/${encodeURIComponent(draft.access_key)}/eventos`, identity, environment,
    body: { pedidoRegistroEventoXmlGZipB64: zlib.gzipSync(Buffer.from(signed)).toString("base64") },
  });
  if (![200, 201].includes(response.status) || !response.json?.eventoXmlGZipB64) {
    const { code, text: message } = apiMessage(response);
    await logEvent(userId, id, "cancel_rejected", { status: response.status, code, message: message.slice(0, 500) });
    throw fiscalError(`Cancelamento não registrado: ${code ? `${code} – ` : ""}${message}`, "CANCEL_REJECTED", response.status >= 500 ? 503 : 422);
  }
  const eventXml = decodeGzipBase64(response.json.eventoXmlGZipB64);
  const document = new DOMParser().parseFromString(eventXml, "text/xml");
  const keyInEvent = text(descendants(document, "chNFSe")[0]);
  const typeOk = descendants(document, "e101101").length > 0;
  if (keyInEvent !== draft.access_key || !typeOk) throw fiscalError("O evento retornado não corresponde ao cancelamento desta nota.", "INVALID_EVENT_RECEIPT");
  const saved = await markDraft(userId, id, ["authorized", "homologated"], { status: "cancelled", cancelled_at: new Date().toISOString(), cancel_xml: eventXml });
  await logEvent(userId, id, "cancelled", { environment, reasonCode });
  return saved ? publicDraft(saved) : publicDraft(await getDraftInternal(id, userId));
}

// Consulta dos parâmetros municipais (convênio e serviço). O caminho exato
// difere entre a documentação do ADN e a da Sefin, então os candidatos são
// tentados em ordem e o que respondeu fica registrado.
const MUNICIPAL_PATHS = [
  { service: "adn", prefix: "/parametrizacao/parametros_municipais" },
  { service: "adn", prefix: "/parametrizacao" },
  { service: "sefin", prefix: "/parametros_municipais" },
];

async function municipalQuery(identity, environment, suffix) {
  const custom = process.env.FISCAL_PARAMS_PREFIX ? [{ service: process.env.FISCAL_PARAMS_SERVICE === "sefin" ? "sefin" : "adn", prefix: process.env.FISCAL_PARAMS_PREFIX }] : [];
  let last = null;
  for (const candidate of [...custom, ...MUNICIPAL_PATHS]) {
    const response = await officialRequest({ method: "GET", path: `${candidate.prefix}${suffix}`, identity, environment, service: candidate.service, timeoutMs: 20000 });
    last = { ...candidate, status: response.status, json: response.json };
    if (response.status !== 404 || response.json) return last;
  }
  return last;
}

function summarize(value, depth = 0) {
  if (value == null || typeof value !== "object") return typeof value === "string" ? value.slice(0, 200) : value;
  if (depth > 3) return "…";
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => summarize(item, depth + 1));
  return Object.fromEntries(Object.entries(value).slice(0, 40).map(([key, item]) => [key, summarize(item, depth + 1)]));
}

async function checkMunicipality(input, userId = requireUserId()) {
  const profile = await getProfile(userId);
  if (!profile) throw fiscalError("Salve a configuração fiscal antes da consulta.", "PROFILE_INCOMPLETE");
  const environment = resolveEnvironment(input.environment);
  const identity = readCertificate(input.certificate || {}, profile.cnpj);
  const city = onlyDigits(profile.municipalityCode);
  const service = onlyDigits(profile.serviceCode);
  if (!/^\d{7}$/.test(city) || !/^\d{6}$/.test(service)) throw fiscalError("Informe município e código de serviço antes da consulta.", "PROFILE_INCOMPLETE");
  const agreement = await municipalQuery(identity, environment, `/${city}/convenio`);
  const serviceParams = await municipalQuery(identity, environment, `/${city}/${service}`);
  const withholdings = await municipalQuery(identity, environment, `/${city}/${onlyDigits(profile.cnpj)}`);
  const ok = agreement?.status === 200 && serviceParams?.status === 200;
  const result = {
    environment, ok, checkedAt: new Date().toISOString(),
    summary: {
      convenio: { status: agreement?.status, endpoint: `${agreement?.service}${agreement?.prefix}`, data: summarize(agreement?.json) },
      servico: { status: serviceParams?.status, data: summarize(serviceParams?.json) },
      contribuinte: { status: withholdings?.status, data: summarize(withholdings?.json) },
    },
  };
  const { error } = await getSupabaseAdmin().from("fiscal_profiles").update({ municipal_params: result, municipal_params_checked_at: result.checkedAt }).eq("user_id", userId);
  if (error) throw error;
  await logEvent(userId, null, "municipality_checked", { environment, ok, statuses: [agreement?.status, serviceParams?.status, withholdings?.status] });
  return result;
}

async function draftXml(id, userId = requireUserId(), kind = "authorized") {
  const draft = await getDraftInternal(id, userId);
  const xml = kind === "cancel" ? draft.cancel_xml : draft.authorized_xml;
  if (!xml) throw fiscalError("Esta nota ainda não possui o XML solicitado.", "XML_NOT_AVAILABLE", 404);
  return xml;
}

async function reopenHomologated(id, userId = requireUserId()) {
  const saved = await markDraft(userId, id, ["homologated", "rejected"], {
    status: "approved", dps_series: null, dps_number: null, dps_id: null, signed_xml: null, environment: null,
    authorized_xml: null, access_key: null, authorized_at: null, error_message: null, error_code: null,
  });
  if (!saved) throw fiscalError("Só notas homologadas em teste ou rejeitadas podem voltar para aprovação.", "INVALID_STATUS", 409);
  await logEvent(userId, id, "reopened", {});
  return publicDraft(saved);
}

async function draftEvents(id, userId = requireUserId()) {
  const { data, error } = await getSupabaseAdmin().from("fiscal_events").select("action,details,created_at").eq("user_id", userId).eq("draft_id", id).order("created_at", { ascending: false }).limit(100);
  if (error) throw error;
  return (data || []).map((row) => ({ action: row.action, details: row.details, createdAt: row.created_at }));
}

function csvCell(value) {
  const textValue = String(value ?? "");
  return /[";\n\r]/.test(textValue) ? `"${textValue.replace(/"/g, '""')}"` : textValue;
}

// Exportação mensal para o contador (notas de produção e canceladas).
async function exportCompetence(competence, userId = requireUserId()) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(competence || ""))) throw fiscalError("Informe a competência no formato AAAA-MM.", "INVALID_COMPETENCE");
  const { data, error } = await getSupabaseAdmin().from("fiscal_drafts")
    .select("recipient,competence,amount_cents,status,dps_series,dps_number,access_key,authorized_at,cancelled_at,environment")
    .eq("user_id", userId).eq("competence", competence).eq("environment", "production").in("status", ["authorized", "cancelled"])
    .order("dps_number", { ascending: true }).limit(20000);
  if (error) throw error;
  const header = ["competencia", "situacao", "serie", "numero_dps", "chave_acesso", "data_autorizacao", "data_cancelamento", "pais", "documento_tomador", "nome_tomador", "valor"];
  const lines = (data || []).map((row) => [
    row.competence, row.status === "cancelled" ? "cancelada" : "autorizada", row.dps_series, row.dps_number, row.access_key,
    row.authorized_at, row.cancelled_at, row.recipient?.country, row.recipient?.document, row.recipient?.name,
    (Number(row.amount_cents) / 100).toFixed(2).replace(".", ","),
  ].map(csvCell).join(";"));
  return `﻿${header.join(";")}\n${lines.join("\n")}\n`;
}

async function handleFiscalRoute({ pathname, req, res, readBody, sendJson, sendText }) {
  if (!pathname.startsWith("/api/fiscal")) return false;
  try {
    const url = new URL(req.url, "http://localhost");
    if (pathname === "/api/fiscal/state" && req.method === "GET") {
      const query = Object.fromEntries(["page", "pageSize", "status", "competence", "search"].map((key) => [key, url.searchParams.get(key)]));
      sendJson(res, 200, { success: true, ...(await getState(query)) });
      return true;
    }
    if (pathname === "/api/fiscal/profile" && req.method === "POST") {
      sendJson(res, 200, { success: true, ...(await saveProfile(await readBody(req))) });
      return true;
    }
    if (pathname === "/api/fiscal/import/preview" && req.method === "POST") {
      const preview = prepareImport(await readBody(req));
      if (preview.drafts) preview.drafts = preview.drafts.slice(0, 50);
      sendJson(res, 200, { success: true, preview });
      return true;
    }
    if (pathname === "/api/fiscal/import" && req.method === "POST") {
      sendJson(res, 201, { success: true, ...(await commitImport(await readBody(req))) });
      return true;
    }
    if (pathname === "/api/fiscal/certificate/test" && req.method === "POST") {
      const body = await readBody(req);
      const profile = await getProfile();
      const identity = readCertificate(body, profile?.cnpj || "");
      sendJson(res, 200, { success: true, certificate: identity.info });
      return true;
    }
    if (pathname === "/api/fiscal/municipality/check" && req.method === "POST") {
      sendJson(res, 200, { success: true, result: await checkMunicipality(await readBody(req)) });
      return true;
    }
    if (pathname === "/api/fiscal/drafts/approve-batch" && req.method === "POST") {
      sendJson(res, 200, { success: true, ...(await approveBatch(await readBody(req))) });
      return true;
    }
    if (pathname === "/api/fiscal/drafts/emit-batch" && req.method === "POST") {
      sendJson(res, 200, { success: true, ...(await emitBatch(await readBody(req))) });
      return true;
    }
    if (pathname === "/api/fiscal/export" && req.method === "GET") {
      const competence = url.searchParams.get("competence");
      sendText(res, 200, await exportCompetence(competence), "text/csv; charset=utf-8", { "Content-Disposition": `attachment; filename=NFSe-${competence}.csv`, "Cache-Control": "no-store" });
      return true;
    }
    const draftMatch = pathname.match(/^\/api\/fiscal\/drafts\/([0-9a-f-]{36})(?:\/(approve|preview-xml|emit|xml|cancel-xml|reconcile|danfse|cancel|reopen|events))?$/i);
    if (draftMatch) {
      const [, id, action] = draftMatch;
      if (!action && req.method === "POST") {
        sendJson(res, 200, { success: true, draft: await updateDraft(id, await readBody(req)) });
        return true;
      }
      if (action === "approve" && req.method === "POST") {
        sendJson(res, 200, { success: true, draft: await approveDraft(id) });
        return true;
      }
      if (action === "preview-xml" && req.method === "POST") {
        sendJson(res, 200, { success: true, preview: await previewXml(id) });
        return true;
      }
      if (action === "emit" && req.method === "POST") {
        const body = await readBody(req);
        sendJson(res, 200, { success: true, draft: await emitDraft(id, body.certificate || {}, body.confirmation, undefined, body.environment) });
        return true;
      }
      if (action === "reconcile" && req.method === "POST") {
        const body = await readBody(req);
        sendJson(res, 200, { success: true, ...(await reconcileDraft(id, body.certificate || {})) });
        return true;
      }
      if (action === "cancel" && req.method === "POST") {
        sendJson(res, 200, { success: true, draft: await cancelDraft(id, await readBody(req)) });
        return true;
      }
      if (action === "reopen" && req.method === "POST") {
        sendJson(res, 200, { success: true, draft: await reopenHomologated(id) });
        return true;
      }
      if (action === "danfse" && req.method === "POST") {
        const body = await readBody(req);
        sendText(res, 200, await danfsePdf(id, body.certificate || {}), "application/pdf", { "Content-Disposition": `attachment; filename=DANFSe-${id}.pdf`, "Cache-Control": "no-store" });
        return true;
      }
      if (action === "events" && req.method === "GET") {
        sendJson(res, 200, { success: true, events: await draftEvents(id) });
        return true;
      }
      if ((action === "xml" || action === "cancel-xml") && req.method === "GET") {
        const kind = action === "xml" ? "authorized" : "cancel";
        sendText(res, 200, await draftXml(id, undefined, kind), "application/xml; charset=utf-8", { "Content-Disposition": `attachment; filename=${kind === "cancel" ? "Cancelamento" : "NFSe"}-${id}.xml`, "Cache-Control": "no-store" });
        return true;
      }
    }
    sendJson(res, 404, { success: false, error: "Rota fiscal não encontrada", code: "NOT_FOUND" });
    return true;
  } catch (err) {
    const status = err.status || (err.code === "23505" ? 409 : 400);
    sendJson(res, status, { success: false, error: err.message || String(err), code: err.code || "FISCAL_ERROR" });
    return true;
  }
}

module.exports = {
  handleFiscalRoute,
  prepareImport,
  validateProfile,
  validDocument,
  buildDpsXml,
  buildCancelEventXml,
  readCertificate,
  signDpsXml,
  signXml,
  validateXsd,
  validateDpsXsd,
  validateAuthorizedXml,
  publicProfile,
  draftEmissionIssues,
  icpIdentifiers,
};
