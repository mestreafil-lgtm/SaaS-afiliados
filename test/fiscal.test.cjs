"use strict";

// Testes do módulo fiscal. O XSD oficial é lido de FISCAL_XSD_PATH (zip do
// pacote gov.br) ou baixado; sem ele, as validações XSD são puladas com aviso.
const assert = require("assert");
const forge = require("node-forge");
const { zipSync, strToU8 } = require("fflate");
const fiscal = require("../server/fiscal");

function xlsxImport() {
  const files = {
    "xl/workbook.xml": strToU8('<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Dados" sheetId="1" r:id="rId1"/></sheets></workbook>'),
    "xl/_rels/workbook.xml.rels": strToU8('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>'),
    "xl/worksheets/sheet1.xml": strToU8('<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Nome</t></is></c><c r="B1" t="inlineStr"><is><t>CNPJ</t></is></c><c r="C1" t="inlineStr"><is><t>Valor</t></is></c><c r="D1" t="inlineStr"><is><t>Competencia</t></is></c><c r="E1" t="inlineStr"><is><t>CEP</t></is></c><c r="F1" t="inlineStr"><is><t>Logradouro</t></is></c><c r="G1" t="inlineStr"><is><t>Numero</t></is></c><c r="H1" t="inlineStr"><is><t>Bairro</t></is></c><c r="I1" t="inlineStr"><is><t>Cidade</t></is></c><c r="J1" t="inlineStr"><is><t>UF</t></is></c><c r="K1" t="inlineStr"><is><t>Codigo IBGE</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>Cliente</t></is></c><c r="B2" t="inlineStr"><is><t>11444777000161</t></is></c><c r="C2" t="inlineStr"><is><t>25,00</t></is></c><c r="D2" t="inlineStr"><is><t>10/2026</t></is></c><c r="E2" t="inlineStr"><is><t>01001000</t></is></c><c r="F2" t="inlineStr"><is><t>Rua A</t></is></c><c r="G2" t="inlineStr"><is><t>1</t></is></c><c r="H2" t="inlineStr"><is><t>Centro</t></is></c><c r="I2" t="inlineStr"><is><t>Sao Paulo</t></is></c><c r="J2" t="inlineStr"><is><t>SP</t></is></c><c r="K2" t="inlineStr"><is><t>3550308</t></is></c></row></sheetData></worksheet>'),
  };
  return fiscal.prepareImport({ filename: "teste.xlsx", content: Buffer.from(zipSync(files)).toString("base64"), serviceDate: "2026-10-15" });
}

function shopeeCsvImport() {
  const csv = [
    "Mês de conclusão,Nome da loja,ID da Loja,Comissão Total do Vendedor,CNPJ do Vendedor,CPF do Vendedor,Identificação Fiscal Estrangeira,Razão social do vendedor,Endereço do Vendedor,País do Vendedor,Inscrição Estadual,E-mail",
    'Oct 2026,Loja Exemplo,123,"R$25,00",11444777000161,,,Empresa Exemplo,"Rua Exemplo, 10,  - Centro, São Paulo - São Paulo, 01001000",BR,,fiscal@example.com',
    'Oct 2026,Loja China,456,"R$40,00",,,91310000MA1FL0000X,Shenzhen Example Ltd,"Room 1, Futian, Shenzhen",CN,,',
  ].join("\n");
  return fiscal.prepareImport({ filename: "relatorio-shopee.csv", content: Buffer.from(csv).toString("base64") });
}

// Cadeia de teste: raiz -> AC intermediária -> e-CNPJ A1 com OIDs ICP-Brasil.
function otherName(oid, value) {
  const { asn1 } = forge;
  return asn1.create(asn1.Class.CONTEXT_SPECIFIC, 0, true, [
    asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OID, false, asn1.oidToDer(oid).getBytes()),
    asn1.create(asn1.Class.CONTEXT_SPECIFIC, 0, true, [asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OCTETSTRING, false, value)]),
  ]);
}

function makeCert({ subject, issuer, issuerKey, keys, ca = false, extra = [], serial }) {
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = serial;
  cert.validity.notBefore = new Date(Date.now() - 60_000);
  cert.validity.notAfter = new Date(Date.now() + 86_400_000);
  cert.setSubject([{ name: "commonName", value: subject }]);
  cert.setIssuer([{ name: "commonName", value: issuer }]);
  cert.setExtensions([
    { name: "basicConstraints", cA: ca, critical: true },
    { name: "keyUsage", critical: true, ...(ca ? { keyCertSign: true, cRLSign: true } : { digitalSignature: true, nonRepudiation: true, keyEncipherment: true }) },
    ...(ca ? [] : [{ name: "extKeyUsage", clientAuth: true, emailProtection: true }]),
    ...extra,
  ]);
  cert.sign(issuerKey, forge.md.sha256.create());
  return cert;
}

const rootKeys = forge.pki.rsa.generateKeyPair(2048);
const root = makeCert({ subject: "Raiz Teste", issuer: "Raiz Teste", issuerKey: rootKeys.privateKey, keys: rootKeys, ca: true, serial: "01" });
const caKeys = forge.pki.rsa.generateKeyPair(2048);
const intermediate = makeCert({ subject: "AC Teste", issuer: "Raiz Teste", issuerKey: rootKeys.privateKey, keys: caKeys, ca: true, serial: "02" });

function pfxFor(cnpj, { selfSigned = false, withChain = true } = {}) {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const san = forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SEQUENCE, true, [
    otherName("2.16.76.1.3.4", "01011990123456789090000000000000000000000000000"),
    otherName("2.16.76.1.3.2", "RESPONSAVEL TESTE"),
    otherName("2.16.76.1.3.3", cnpj),
  ]);
  const leaf = makeCert({
    subject: `EMPRESA TESTE:${cnpj}`, issuer: selfSigned ? `EMPRESA TESTE:${cnpj}` : "AC Teste",
    issuerKey: selfSigned ? keys.privateKey : caKeys.privateKey, keys, serial: "03",
    extra: [{ id: "2.5.29.17", value: san }],
  });
  const chain = withChain ? [leaf, intermediate] : [leaf];
  const p12 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, chain, "senha", { algorithm: "3des" });
  return Buffer.from(forge.asn1.toDer(p12).getBytes(), "binary").toString("base64");
}

function expectError(fn, code) {
  try { fn(); } catch (err) { assert.equal(err.code, code, `esperava ${code}, veio ${err.code}: ${err.message}`); return; }
  assert.fail(`esperava erro ${code}`);
}

async function main() {
  // Importação
  const xlsx = xlsxImport();
  assert.equal(xlsx.drafts.length, 1);
  assert.equal(xlsx.totalCents, 2500);
  assert.deepEqual(xlsx.drafts[0].issues, []);
  assert.equal(xlsx.drafts[0].recipient.serviceDate, "2026-10-15");

  const csv = shopeeCsvImport();
  assert.equal(csv.needsMapping, false);
  assert.equal(csv.drafts.length, 2);
  assert.equal(csv.foreign, 1);
  assert.equal(csv.drafts[0].recipient.name, "Empresa Exemplo");
  assert.equal(csv.drafts[0].recipient.district, "Centro");
  assert.equal(csv.drafts[0].recipient.municipalityCode, "3550308");
  assert.deepEqual(csv.drafts[0].issues, []);

  // Certificado
  const cnpj = "11444777000161";
  const options = { trustedRoots: [root] };
  const identity = fiscal.readCertificate({ content: pfxFor(cnpj), password: "senha" }, cnpj, options);
  assert.equal(identity.info.cnpj, cnpj);
  assert.equal(identity.info.responsibleCpf, "12345678909");
  assert.equal(identity.info.chainVerified, true);
  expectError(() => fiscal.readCertificate({ content: pfxFor(cnpj), password: "senha" }, "11222333000181", options), "CERTIFICATE_CNPJ_MISMATCH");
  expectError(() => fiscal.readCertificate({ content: pfxFor(cnpj, { selfSigned: true }), password: "senha" }, cnpj, options), "CERTIFICATE_NOT_ICP_BRASIL");
  const otherKeys = forge.pki.rsa.generateKeyPair(2048);
  const otherRoot = makeCert({ subject: "Outra Raiz", issuer: "Outra Raiz", issuerKey: otherKeys.privateKey, keys: otherKeys, ca: true, serial: "09" });
  expectError(() => fiscal.readCertificate({ content: pfxFor(cnpj), password: "senha" }, cnpj, { trustedRoots: [otherRoot] }), "CERTIFICATE_CHAIN_INVALID");
  expectError(() => fiscal.readCertificate({ content: pfxFor(cnpj, { withChain: false }), password: "senha" }, cnpj, options), "CERTIFICATE_CHAIN_INVALID");
  expectError(() => fiscal.readCertificate({ content: pfxFor(cnpj), password: "errada" }, cnpj, options), "INVALID_CERTIFICATE");

  // Perfis por regime
  const base = {
    legalName: "Emitente", cnpj, municipalityCode: "3550308", serviceCode: "170601", nbsCode: "",
    descriptionTemplate: "Afiliado {mes}/{ano}", series: "49999", issTaxation: 1, issRetention: 1, specialTaxRegime: 0,
    totalsMode: "not_informed", competenceRule: "last_day", ibscbsStatus: "not_applicable", accountantConfirmed: true,
  };
  const profiles = {
    mei: { ...base, taxRegime: "MEI" },
    simples: { ...base, taxRegime: "Simples Nacional", simpleAssessmentRegime: 1, totalsMode: "simple_rate", approximateTaxPct: "6.00" },
    simplesIssFora: { ...base, taxRegime: "Simples Nacional", simpleAssessmentRegime: 2, issRate: "5" },
    presumido: { ...base, taxRegime: "Lucro Presumido", totalsMode: "percent", approximateFederalPct: "13.45", approximateStatePct: "0", approximateMunicipalPct: "5", pisCofinsCst: "01", pisRate: "0.65", cofinsRate: "3", irrfRetentionPct: "1.5", csllRetentionPct: "1", cpRetentionPct: "0" },
    real: { ...base, taxRegime: "Lucro Real", pisCofinsCst: "01", pisRate: "1.65", cofinsRate: "7.6", pisCofinsRetention: "1" },
  };
  for (const profile of Object.values(profiles)) assert.deepEqual(fiscal.validateProfile(profile), [], JSON.stringify(profile));
  assert(fiscal.validateProfile({ ...profiles.mei, totalsMode: "simple_rate", approximateTaxPct: "5" }).length > 0, "MEI não usa pTotTribSN");
  assert(fiscal.validateProfile({ ...profiles.simples, pisCofinsCst: "01" }).length > 0, "Simples não informa CST de PIS/COFINS");
  assert(fiscal.validateProfile({ ...base, taxRegime: "Simples Nacional", competenceRule: "" }).length > 0, "regra de competência obrigatória");

  const brDraft = { recipient: xlsx.drafts[0].recipient, competence: "2026-10", amount_cents: 2500 };
  const xmls = {};
  for (const [name, profile] of Object.entries(profiles)) {
    const built = fiscal.buildDpsXml(profile, brDraft, { environment: "2", number: 7 });
    assert(built.xml.includes("<vServ>25.00</vServ>"));
    assert(built.xml.includes("<dCompet>2026-10-15</dCompet>"), "usa a data informada na importação");
    assert(built.xml.includes("<totTrib>"), "totTrib sempre presente");
    xmls[name] = built.xml;
  }
  assert(!xmls.mei.includes("regApTribSN") && xmls.mei.includes("<opSimpNac>2</opSimpNac>"));
  assert(xmls.simples.includes("<opSimpNac>3</opSimpNac><regApTribSN>1</regApTribSN>") && xmls.simples.includes("<pTotTribSN>6.00</pTotTribSN>"));
  assert(xmls.simplesIssFora.includes("<regApTribSN>2</regApTribSN>") && xmls.simplesIssFora.includes("<pAliq>5.00</pAliq>"));
  assert(!xmls.presumido.includes("regApTribSN") && xmls.presumido.includes("<opSimpNac>1</opSimpNac>"));
  assert(xmls.presumido.includes("<vPis>0.16</vPis>") && xmls.presumido.includes("<vRetIRRF>0.38</vRetIRRF>") && !xmls.presumido.includes("vRetCP"));
  assert(xmls.real.includes("<tpRetPisCofins>1</tpRetPisCofins>") && xmls.real.includes("<indTotTrib>0</indTotTrib>"));

  // Sem data da prestação, a regra "último dia" é aplicada só se escolhida.
  const noDate = { ...brDraft, recipient: { ...brDraft.recipient, serviceDate: undefined } };
  assert(fiscal.buildDpsXml(profiles.mei, noDate, { number: 1 }).xml.includes("<dCompet>2026-10-31</dCompet>"));
  expectError(() => fiscal.buildDpsXml({ ...profiles.mei, competenceRule: "per_import" }, noDate, { number: 1 }), "DRAFT_HAS_ISSUES");

  // Tomador estrangeiro: termos de comércio exterior vêm do perfil.
  const foreignRecipient = { ...csv.drafts[1].recipient, postalCode: "518000", stateProvince: "Guangdong", city: "Shenzhen", street: "Futian Road", number: "1", district: "Futian" };
  const foreignDraft = { recipient: foreignRecipient, competence: "2026-10", amount_cents: 4000 };
  assert(fiscal.draftEmissionIssues(profiles.simples, foreignDraft).length > 0, "sem termos de exportação, fica pendente");
  const exportProfile = { ...profiles.simples, foreignDefaults: { foreignServiceMode: "1", foreignRelationship: "0", foreignCurrency: "790", foreignSupportProvider: "01", foreignSupportRecipient: "01", foreignTemporaryGoods: "1", foreignShareMdic: "0", foreignIssTaxation: "3" } };
  assert.deepEqual(fiscal.draftEmissionIssues(exportProfile, foreignDraft), []);
  const foreignXml = fiscal.buildDpsXml(exportProfile, foreignDraft, { number: 8 }).xml;
  assert(foreignXml.includes("<NIF>91310000MA1FL0000X</NIF>") && foreignXml.includes("<endExt><cPais>CN</cPais>"));
  assert(foreignXml.includes("<tribISSQN>3</tribISSQN><cPaisResult>CN</cPaisResult>") && foreignXml.includes("<vServMoeda>40.00</vServMoeda>"));
  assert(foreignXml.includes("<cLocPrestacao>3550308</cLocPrestacao>"), "o afiliado presta o serviço no Brasil");
  xmls.foreign = foreignXml;

  // Assinatura e XSD oficial
  const signed = fiscal.signDpsXml(xmls.simples, identity);
  assert(signed.includes("SignatureValue") && signed.includes("X509Certificate"));
  const cancelXml = fiscal.signXml(fiscal.buildCancelEventXml({ accessKey: "3".repeat(50), cnpj, environment: "restricted", reasonCode: 1, reasonText: "Erro na emissão da nota de teste" }), identity, { referenceTag: "infPedReg", rootTag: "pedRegEvento" });

  // XML autorizado: a assinatura conferida tem de ser a da Sefin sobre infNFSe,
  // não a nossa assinatura da DPS que vem embutida.
  const accessKey = "1".repeat(50);
  const dpsBody = signed.replace(/^<\?xml[^>]*>\s*/, "").replace(/^<DPS xmlns="[^"]+"/, "<DPS");
  const nfse = `<NFSe xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.01"><infNFSe Id="NFS${accessKey}"><xLocEmi>Sao Paulo</xLocEmi>${dpsBody}</infNFSe></NFSe>`;
  const sefin = fiscal.readCertificate({ content: pfxFor("00394460005887"), password: "senha" }, "", options);
  const authorized = fiscal.signXml(nfse, sefin, { referenceTag: "infNFSe", rootTag: "NFSe" });
  const draftForReceipt = { recipient: brDraft.recipient, amount_cents: 2500 };
  const dpsId = signed.match(/Id="(DPS\d+)"/)[1];
  assert.equal(fiscal.validateAuthorizedXml(authorized, profiles.simples, draftForReceipt, { chaveAcesso: accessKey }, { dpsId, environment: "restricted" }), accessKey);
  assert.throws(() => fiscal.validateAuthorizedXml(nfse, profiles.simples, draftForReceipt, {}, { dpsId }), /assinatura da Sefin/);
  assert.throws(() => fiscal.validateAuthorizedXml(authorized, profiles.simples, { ...draftForReceipt, amount_cents: 2600 }, {}, { dpsId }), /valor/);
  assert.throws(() => fiscal.validateAuthorizedXml(authorized, profiles.simples, draftForReceipt, {}, { dpsId, environment: "production" }), /ambiente/);
  assert.throws(() => fiscal.validateAuthorizedXml(authorized.replace("<vServ>25.00</vServ>", "<vServ>99.00</vServ>"), profiles.simples, { ...draftForReceipt, amount_cents: 9900 }, {}, { dpsId }), /assinatura/);

  let xsdChecked = false;
  try {
    for (const [name, xml] of Object.entries(xmls)) {
      await fiscal.validateDpsXsd(fiscal.signDpsXml(xml, identity)).catch((err) => { throw new Error(`${name}: ${err.message}`); });
    }
    await fiscal.validateXsd(cancelXml, "event");
    xsdChecked = true;
  } catch (err) {
    if (/XSD_DOWNLOAD|não foi possível obter|ENOTFOUND|ECONN/i.test(`${err.code} ${err.message}`)) console.warn(`Aviso: XSD oficial indisponível (${err.message}); validação XSD pulada.`);
    else throw err;
  }
  // Um XML com totTrib vazio precisa ser rejeitado pelo XSD (regressão do bug original).
  if (xsdChecked) {
    const broken = fiscal.signDpsXml(xmls.mei.replace("<totTrib><indTotTrib>0</indTotTrib></totTrib>", ""), identity);
    await assert.rejects(() => fiscal.validateDpsXsd(broken), (err) => err.code === "DPS_XSD_INVALID");
  }

  console.log(`Fiscal: importação, certificado ICP (OID/cadeia), 5 regimes, exterior, assinatura e cancelamento validados${xsdChecked ? " contra o XSD oficial 1.01" : " (sem XSD)"}.`);
}

main().catch((err) => { console.error(err); process.exit(1); });
