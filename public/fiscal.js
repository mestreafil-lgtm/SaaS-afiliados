(() => {
  "use strict";

  const TOKEN_KEY = "metricly_access_token";
  const REFRESH_KEY = "metricly_refresh_token";
  const EXPIRES_KEY = "metricly_expires_at";
  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];
  const state = { loaded: false, loading: false, data: null, file: null, encoded: null, preview: null, mapping: null, filters: { page: 1, status: "", competence: "", search: "" } };

  const money = (cents) => (Number(cents || 0) / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
  const statusLabels = { pending: "Com pendência", ready: "Pronta", approved: "Aprovada", submitting: "Enviando", homologating: "Enviando (teste)", authorized: "Autorizada", homologated: "Homologada (teste)", rejected: "Rejeitada", uncertain: "Conciliação", cancelled: "Cancelada" };
  const mappingLabels = { name: "Nome / razão social", document: "CPF/CNPJ", value: "Valor da comissão", competence: "Competência", email: "E-mail", country: "País", originalAddress: "Endereço completo", zip: "CEP", street: "Logradouro", number: "Número", district: "Bairro", city: "Cidade", state: "UF", municipalityCode: "Código IBGE do município", shopId: "ID da loja" };

  async function renewSession() {
    const refresh = localStorage.getItem(REFRESH_KEY);
    if (!refresh) return false;
    try {
      const res = await fetch("/api/auth/refresh", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ refresh_token: refresh }) });
      const json = await res.json();
      if (!res.ok || !json.access_token) return false;
      localStorage.setItem(TOKEN_KEY, json.access_token);
      if (json.refresh_token) localStorage.setItem(REFRESH_KEY, json.refresh_token);
      if (json.expires_at) localStorage.setItem(EXPIRES_KEY, String(json.expires_at));
      return true;
    } catch (_) { return false; }
  }

  async function rawFetch(path, options = {}, retry = true) {
    const token = localStorage.getItem(TOKEN_KEY);
    const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(path, { ...options, headers });
    if (res.status === 401 && retry && await renewSession()) return rawFetch(path, options, false);
    return res;
  }

  async function api(path, options = {}) {
    const res = await rawFetch(path, options);
    let json = {};
    try { json = await res.json(); } catch (_) { /* vazio */ }
    if (!res.ok || json.success === false) {
      const err = new Error(json.error || `Erro HTTP ${res.status}`);
      err.code = json.code || "REQUEST_ERROR";
      throw err;
    }
    return json;
  }

  // Downloads autenticados (XML, PDF, CSV) sem expor o token na URL.
  async function download(path, filename, options = {}) {
    const res = await rawFetch(path, options);
    if (!res.ok) {
      let message = "Não foi possível baixar o arquivo.";
      try { message = (await res.json()).error || message; } catch (_) { /* binário */ }
      throw new Error(message);
    }
    const url = URL.createObjectURL(await res.blob());
    const anchor = document.createElement("a");
    anchor.href = url; anchor.download = filename; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function setStatus(element, message, type = "") {
    if (!element) return;
    element.textContent = message || "";
    element.classList.toggle("is-error", type === "error");
    element.classList.toggle("is-ok", type === "ok");
  }

  function escapeHtml(value) {
    const div = document.createElement("div");
    div.textContent = String(value ?? "");
    return div.innerHTML;
  }

  function setTab(tab) {
    $$("[data-fiscal-tab]").forEach((button) => button.classList.toggle("is-active", button.dataset.fiscalTab === tab));
    $$("[data-fiscal-panel]").forEach((panel) => panel.classList.toggle("hidden", panel.dataset.fiscalPanel !== tab));
  }

  // Mostra só os campos que fazem sentido para o regime e o modo escolhidos.
  function syncProfileVisibility() {
    const form = $("#fiscal-profile-form");
    if (!form) return;
    const regime = form.elements.taxRegime.value;
    const isSimples = regime === "Simples Nacional";
    const isNonOptant = ["Lucro Presumido", "Lucro Real", "Outro não optante"].includes(regime);
    form.querySelectorAll('[data-fiscal-only="simples"]').forEach((node) => {
      node.classList.toggle("hidden", !isSimples);
      if (node.tagName === "OPTION") node.disabled = !isSimples;
    });
    form.querySelectorAll('[data-fiscal-only="nao-optante"]').forEach((node) => node.classList.toggle("hidden", !isNonOptant));
    if (!isSimples && form.elements.totalsMode.value === "simple_rate") form.elements.totalsMode.value = "not_informed";
    const totals = form.elements.totalsMode.value;
    form.querySelectorAll("[data-fiscal-totals]").forEach((node) => node.classList.toggle("hidden", node.dataset.fiscalTotals !== totals));
  }

  function fillProfile(profile = {}) {
    const form = $("#fiscal-profile-form");
    if (!form) return;
    for (const [key, value] of Object.entries(profile)) {
      const input = form.elements.namedItem(key);
      if (!input || typeof value === "object") continue;
      if (input.type === "checkbox") input.checked = Boolean(value);
      else input.value = value ?? "";
    }
    syncProfileVisibility();
    setServiceCode(profile.serviceCode || "");
    setMunicipality(profile.municipalityCode || "");
  }

  // Município por UF e cidade (lista oficial do IBGE servida como JSON estático).
  let municipalitiesPromise = null;
  function municipalities() {
    municipalitiesPromise ||= fetch("/fiscal-municipios.json").then((res) => {
      if (!res.ok) throw new Error("Não foi possível carregar a lista de municípios.");
      return res.json();
    }).catch((err) => { municipalitiesPromise = null; throw err; });
    return municipalitiesPromise;
  }

  let ufOptionsPromise = null;
  function fillUfOptions() {
    ufOptionsPromise ||= municipalities().then((data) => {
      const select = $("#fiscal-uf");
      if (select && select.options.length <= 1) select.insertAdjacentHTML("beforeend", Object.keys(data).sort().map((uf) => `<option value="${uf}">${uf}</option>`).join(""));
    }).catch((err) => { ufOptionsPromise = null; throw err; });
    return ufOptionsPromise;
  }

  async function fillCityOptions(uf, selectedCode = "") {
    const select = $("#fiscal-city");
    if (!select) return;
    const data = await municipalities();
    const cities = data[uf] || [];
    select.disabled = !cities.length;
    select.innerHTML = cities.length
      ? `<option value="">Escolha o município</option>${cities.map(([code, name]) => `<option value="${code}" ${code === selectedCode ? "selected" : ""}>${escapeHtml(name)}</option>`).join("")}`
      : '<option value="">Escolha a UF primeiro</option>';
    updateCityCode();
  }

  function updateCityCode() {
    const form = $("#fiscal-profile-form");
    const code = $("#fiscal-city")?.value || "";
    if (form) form.elements.municipalityCode.value = code;
    const hint = $("#fiscal-city-code");
    if (hint) hint.textContent = code ? `Código IBGE: ${code}` : "";
  }

  async function setMunicipality(code) {
    try {
      await fillUfOptions();
      const data = await municipalities();
      const uf = Object.keys(data).find((key) => data[key].some(([item]) => item === code)) || "";
      $("#fiscal-uf").value = uf;
      await fillCityOptions(uf, code);
    } catch (err) { setStatus($("#fiscal-profile-status"), err.message, "error"); }
  }

  function setServiceCode(code) {
    const preset = $("#fiscal-service-preset");
    const form = $("#fiscal-profile-form");
    if (!preset || !form) return;
    const known = [...preset.options].some((option) => option.value === code && code);
    preset.value = known ? code : (code ? "other" : "");
    $("#fiscal-service-other").value = known ? "" : code;
    syncServiceCode();
  }

  function syncServiceCode() {
    const preset = $("#fiscal-service-preset");
    const form = $("#fiscal-profile-form");
    const other = preset.value === "other";
    $("#fiscal-service-other-wrap")?.classList.toggle("hidden", !other);
    form.elements.serviceCode.value = other ? ($("#fiscal-service-other").value || "").replace(/\D/g, "") : preset.value;
  }

  async function lookupCnpj() {
    const form = $("#fiscal-profile-form");
    const status = $("#fiscal-cnpj-status");
    const cnpj = String(form.elements.cnpj.value || "").replace(/\D/g, "");
    if (cnpj.length !== 14) return setStatus(status, "Digite os 14 números do CNPJ.", "error");
    setStatus(status, "Buscando dados do CNPJ…");
    try {
      const { company } = await api(`/api/fiscal/cnpj/${cnpj}`);
      if (company.legalName) form.elements.legalName.value = company.legalName;
      if (company.tradeName && !form.elements.tradeName.value) form.elements.tradeName.value = company.tradeName;
      if (company.municipalityCode) await setMunicipality(company.municipalityCode);
      if (company.taxRegime) { form.elements.taxRegime.value = company.taxRegime; syncProfileVisibility(); }
      form.elements.accountantConfirmed.checked = false;
      setStatus(status, `${company.legalName || "Empresa encontrada"}${company.city ? ` · ${company.city}/${company.state}` : ""}${company.taxRegime ? ` · ${company.taxRegime}` : " · regime não informado na Receita, escolha abaixo"}. Confira e salve.`, "ok");
    } catch (err) { setStatus(status, err.message, "error"); }
  }

  function renderProfile() {
    const data = state.data || {};
    if (!state.profileFilled) { fillProfile(data.profile || {}); state.profileFilled = true; }
    const chip = $("#fiscal-profile-chip");
    const issues = data.profileIssues || [];
    if (chip) {
      chip.textContent = issues.length ? `${issues.length} pendência${issues.length > 1 ? "s" : ""}` : "Cadastro válido";
      chip.classList.toggle("is-ok", !issues.length);
    }
    const list = $("#fiscal-production-issues");
    if (list) {
      const all = data.productionIssues || [];
      list.innerHTML = all.length ? `<li><strong>Antes de emitir em produção:</strong></li>${all.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}` : "";
      list.classList.toggle("hidden", !all.length);
    }
    const check = data.profile?.municipalCheck;
    if (check) setStatus($("#fiscal-municipality-status"), `Última consulta (${check.environment === "production" ? "produção" : "produção restrita"}): ${new Date(check.checkedAt).toLocaleString("pt-BR")} · ${check.ok ? "município respondeu" : "consulta sem confirmação"}.`, check.ok ? "ok" : "error");
    const production = $("#fiscal-production-chip");
    if (production) {
      production.innerHTML = data.productionEnabled
        ? '<i class="fa-solid fa-triangle-exclamation"></i> Emissão real habilitada'
        : (data.restrictedEnabled ? '<i class="fa-solid fa-flask"></i> Só produção restrita (teste)' : '<i class="fa-solid fa-lock"></i> Emissão real bloqueada');
      production.classList.toggle("is-live", Boolean(data.productionEnabled));
      production.classList.toggle("is-safe", !data.productionEnabled);
    }
  }

  function renderKpis() {
    const counts = state.data?.counts || {};
    for (const key of ["ready", "pending", "approved", "authorized", "uncertain"]) {
      const element = $(`[data-fiscal-kpi="${key}"]`);
      if (element) element.textContent = String(Number(counts[key] || 0) + (key === "uncertain" ? Number(counts.submitting || 0) + Number(counts.homologating || 0) : 0));
    }
  }

  function rowActions(draft) {
    const actions = [];
    const button = (action, label) => actions.push(`<button type="button" data-fiscal-action="${action}" data-id="${draft.id}">${label}</button>`);
    if (["pending", "ready", "approved", "rejected"].includes(draft.status)) button("edit", "Corrigir");
    if (draft.status === "ready") button("approve", "Aprovar");
    if (["ready", "approved"].includes(draft.status)) button("preview", "Ver XML");
    if (draft.status === "approved") button("emit", "Transmitir");
    if (["uncertain", "submitting", "homologating"].includes(draft.status)) button("reconcile", "Conciliar");
    if (["authorized", "homologated"].includes(draft.status)) { button("xml", "XML"); button("danfse", "DANFSe"); button("cancel", "Cancelar"); }
    if (draft.status === "cancelled") { button("xml", "XML"); button("cancel-xml", "XML do cancelamento"); }
    if (["homologated", "rejected"].includes(draft.status)) button("reopen", "Voltar para aprovada");
    button("events", "Histórico");
    return actions.join("");
  }

  function renderNotes() {
    const drafts = state.data?.drafts || [];
    const pagination = state.data?.pagination || { page: 1, pages: 1, total: drafts.length };
    $("#fiscal-notes-empty")?.classList.toggle("hidden", drafts.length > 0);
    $("#fiscal-notes-wrap")?.classList.toggle("hidden", drafts.length === 0);
    const body = $("#fiscal-notes-body");
    if (body) {
      body.innerHTML = drafts.map((draft) => {
        const recipient = draft.recipient || {};
        const issues = [...(draft.issues || []), ...(draft.emissionIssues || []), ...(draft.errorMessage ? [draft.errorMessage] : [])];
        const foreign = recipient.country && recipient.country !== "BR";
        return `<tr>
          <td><div class="fiscal-client"><strong>${escapeHtml(recipient.name || "Loja sem nome")}</strong><span>${foreign ? `${escapeHtml(recipient.country)} · NIF ` : ""}${escapeHtml(recipient.document || "Documento pendente")}</span>${draft.accessKey ? `<span class="fiscal-key">Chave ${escapeHtml(draft.accessKey)}</span>` : ""}${issues.length ? `<div class="fiscal-issue">${escapeHtml(issues[0])}${issues.length > 1 ? ` · +${issues.length - 1}` : ""}</div>` : ""}</div></td>
          <td>${escapeHtml(draft.competence || "—")}${recipient.serviceDate ? `<br><small>${escapeHtml(recipient.serviceDate)}</small>` : ""}</td>
          <td><strong>${money(draft.amountCents)}</strong></td>
          <td><span class="fiscal-state ${escapeHtml(draft.status)}">${escapeHtml(statusLabels[draft.status] || draft.status)}</span></td>
          <td><div class="fiscal-row-actions">${rowActions(draft)}</div></td>
        </tr>`;
      }).join("");
    }
    const pager = $("#fiscal-pagination");
    if (pager) {
      pager.classList.toggle("hidden", pagination.pages <= 1 && pagination.page <= 1);
      $("#fiscal-page-label").textContent = `Página ${pagination.page} de ${pagination.pages} · ${pagination.total} nota${pagination.total === 1 ? "" : "s"}`;
      $("#fiscal-page-prev").disabled = pagination.page <= 1;
      $("#fiscal-page-next").disabled = pagination.page >= pagination.pages;
    }
  }

  function render() {
    renderProfile();
    renderKpis();
    renderNotes();
  }

  async function load(force = false) {
    if (state.loading || (state.loaded && !force)) return;
    state.loading = true;
    try {
      const params = new URLSearchParams({ page: String(state.filters.page), pageSize: "100" });
      for (const key of ["status", "competence", "search"]) if (state.filters[key]) params.set(key, state.filters[key]);
      state.data = await api(`/api/fiscal/state?${params}`);
      state.loaded = true;
      render();
    } catch (err) {
      setStatus($("#fiscal-notes-status"), err.message, "error");
    } finally { state.loading = false; }
  }

  function readFileBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error("Não foi possível ler o arquivo."));
      reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
      reader.readAsDataURL(file);
    });
  }

  function mappingPayload() {
    const mapping = { ...(state.mapping || {}) };
    $$("#fiscal-mapping select[data-field]").forEach((select) => { mapping[select.dataset.field] = select.value; });
    return mapping;
  }

  function renderMapping(preview) {
    const host = $("#fiscal-mapping");
    if (!host) return;
    if (!preview.needsMapping) { host.classList.add("hidden"); host.innerHTML = ""; return; }
    const fields = ["name", "document", "value", "competence", "email", "country", "originalAddress", "zip", "street", "number", "district", "city", "state", "municipalityCode", "shopId"];
    host.innerHTML = `<h3>Confirme as colunas do relatório</h3><div class="fiscal-mapping-grid">${fields.map((field) => {
      const options = ['<option value="">Não informado</option>', ...(field === "document" ? ['<option value="__shopee_documents__">Documentos Shopee (automático)</option>'] : []), ...preview.headers.map((header) => `<option value="${escapeHtml(header)}" ${preview.mapping?.[field] === header ? "selected" : ""}>${escapeHtml(header)}</option>`)].join("");
      return `<label>${escapeHtml(mappingLabels[field])}${["name", "document", "value", "competence"].includes(field) ? " *" : ""}<select data-field="${field}">${options}</select></label>`;
    }).join("")}</div>`;
    host.classList.remove("hidden");
  }

  function renderPreview(preview) {
    const host = $("#fiscal-preview");
    if (!host) return;
    if (preview.needsMapping) { host.classList.add("hidden"); return; }
    host.innerHTML = `<div class="fiscal-preview-grid"><div><span>Linhas lidas</span><strong>${preview.rows}</strong></div><div><span>Notas agrupadas</span><strong>${preview.ready + preview.pending}</strong></div><div><span>Prontas</span><strong>${preview.ready}</strong></div><div><span>Com pendências</span><strong>${preview.pending}</strong></div><div><span>Lojas do exterior</span><strong>${preview.foreign || 0}</strong></div><div><span>Total de comissão</span><strong>${money(preview.totalCents)}</strong></div><div><span>Duplicadas ignoradas</span><strong>${preview.duplicates}</strong></div><div><span>Data da prestação</span><strong>${escapeHtml(preview.serviceDate || "Regra do perfil")}</strong></div></div>`;
    host.classList.remove("hidden");
  }

  function importPayload() {
    return { filename: state.file.name, content: state.encoded, mapping: mappingPayload(), serviceDate: $("#fiscal-service-date")?.value || "" };
  }

  async function previewFile() {
    if (!state.file) return;
    const button = $("#fiscal-preview-btn");
    button.disabled = true;
    setStatus($("#fiscal-import-status"), "Lendo e conferindo o relatório…");
    try {
      state.encoded ||= await readFileBase64(state.file);
      const result = await api("/api/fiscal/import/preview", { method: "POST", body: JSON.stringify(importPayload()) });
      state.preview = result.preview;
      state.mapping = result.preview.mapping || state.mapping;
      renderMapping(result.preview);
      renderPreview(result.preview);
      $("#fiscal-import-btn").disabled = Boolean(result.preview.needsMapping);
      setStatus($("#fiscal-import-status"), result.preview.needsMapping ? "Selecione as colunas obrigatórias e confira novamente." : "Arquivo conferido. Revise o resumo antes de importar.", result.preview.needsMapping ? "" : "ok");
    } catch (err) {
      setStatus($("#fiscal-import-status"), err.message, "error");
    } finally { button.disabled = false; }
  }

  async function commitFile() {
    if (!state.file || !state.encoded || !state.preview || state.preview.needsMapping) return;
    const button = $("#fiscal-import-btn");
    button.disabled = true;
    setStatus($("#fiscal-import-status"), "Criando as prévias fiscais…");
    try {
      const result = await api("/api/fiscal/import", { method: "POST", body: JSON.stringify(importPayload()) });
      setStatus($("#fiscal-import-status"), `Relatório importado: ${result.draftsCreated} prévias criadas.`, "ok");
      state.filters.page = 1;
      await load(true);
      setTab("notes");
    } catch (err) {
      setStatus($("#fiscal-import-status"), err.message, "error");
      button.disabled = false;
    }
  }

  const findDraft = (id) => state.data?.drafts?.find((item) => item.id === id);

  function syncEditVisibility() {
    const form = $("#fiscal-edit-form");
    const foreign = String(form.elements.country.value || "BR").toUpperCase() !== "BR";
    form.querySelectorAll('[data-fiscal-edit="br"]').forEach((node) => node.classList.toggle("hidden", foreign));
    form.querySelectorAll('[data-fiscal-edit="foreign"]').forEach((node) => node.classList.toggle("hidden", !foreign));
  }

  function openEdit(id) {
    const draft = findDraft(id);
    const dialog = $("#fiscal-edit-dialog");
    const form = $("#fiscal-edit-form");
    if (!draft || !dialog || !form) return;
    const recipient = draft.recipient || {};
    const values = { ...recipient, draftId: id, country: recipient.country || "BR", competence: draft.competence, amount: (draft.amountCents / 100).toFixed(2).replace(".", ",") };
    for (const element of form.elements) if (element.name && element.name in values) element.value = values[element.name] ?? "";
    for (const element of form.elements) if (element.name && !(element.name in values) && element.type !== "hidden") element.value = "";
    syncEditVisibility();
    setStatus($("#fiscal-edit-status"), "");
    dialog.showModal();
  }

  async function saveEdit(event) {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.currentTarget));
    const amountCents = Math.round(Number(String(data.amount).replace(/\./g, "").replace(",", ".")) * 100);
    const recipient = {};
    for (const key of ["name", "document", "email", "country", "serviceDate", "street", "number", "district", "city", "zip", "state", "municipalityCode", "postalCode", "stateProvince", "foreignAmount", "resultCountry"]) recipient[key] = data[key] ?? "";
    recipient.country = String(recipient.country || "BR").toUpperCase();
    recipient.foreignAmount = String(recipient.foreignAmount || "").replace(/\./g, "").replace(",", ".");
    try {
      await api(`/api/fiscal/drafts/${data.draftId}`, { method: "POST", body: JSON.stringify({ recipient, competence: data.competence, amountCents }) });
      $("#fiscal-edit-dialog").close();
      await load(true);
    } catch (err) { setStatus($("#fiscal-edit-status"), err.message, "error"); }
  }

  async function certificatePayload() {
    const file = $("#fiscal-cert-file")?.files?.[0];
    const password = $("#fiscal-cert-password")?.value || "";
    if (!file) throw new Error("Selecione o certificado PFX/P12 na aba Configuração fiscal.");
    return { filename: file.name, content: await readFileBase64(file), password };
  }

  const environment = () => ($("#fiscal-environment")?.value === "production" ? "production" : "restricted");

  function confirmTransmission(count = 1) {
    const env = environment();
    if (env === "production" && !state.data?.productionEnabled) throw new Error("A emissão em produção está bloqueada no servidor. Use a produção restrita para testar.");
    if (env === "restricted" && !state.data?.restrictedEnabled) throw new Error("A produção restrita está desligada no servidor (FISCAL_RESTRICTED_ENABLED).");
    const word = env === "production" ? "EMITIR" : "HOMOLOGAR";
    const what = env === "production" ? `${count > 1 ? `até ${count} NFS-e reais` : "uma NFS-e real"}` : `${count > 1 ? `até ${count} notas` : "uma nota"} de teste na produção restrita`;
    const typed = window.prompt(`Esta ação transmite ${what}. Digite ${word} para continuar:`);
    if (typed !== word) return null;
    return { confirmation: typed, environment: env };
  }

  async function runAction(action, id) {
    const status = $("#fiscal-notes-status");
    try {
      if (action === "edit") return openEdit(id);
      if (action === "approve") { await api(`/api/fiscal/drafts/${id}/approve`, { method: "POST", body: "{}" }); return load(true); }
      if (action === "preview") {
        const { preview } = await api(`/api/fiscal/drafts/${id}/preview-xml`, { method: "POST", body: "{}" });
        const win = window.open("", "_blank");
        if (win) {
          win.opener = null;
          const verdict = preview.xsd?.valid === true ? "Estrutura válida no XSD oficial 1.01 (sem assinatura)." : (preview.xsd?.valid === false ? `XSD oficial: ${preview.xsd.error}` : `XSD não conferido: ${preview.xsd?.error || "indisponível"}`);
          win.document.write(`<title>Prévia DPS</title><p style="font:13px sans-serif;padding:0 20px">${escapeHtml(verdict)}</p><pre style="white-space:pre-wrap;word-break:break-word;font:12px/1.5 monospace;padding:20px">${escapeHtml(preview.xml)}</pre>`);
          win.document.close();
        }
        return;
      }
      if (action === "emit") {
        const confirmation = confirmTransmission();
        if (!confirmation) return;
        setStatus(status, "Transmitindo…");
        const result = await api(`/api/fiscal/drafts/${id}/emit`, { method: "POST", body: JSON.stringify({ ...confirmation, certificate: await certificatePayload() }) });
        setStatus(status, result.draft.status === "authorized" ? "NFS-e autorizada. O XML oficial já está disponível." : "Nota de teste homologada na produção restrita.", "ok");
        return load(true);
      }
      if (action === "reconcile") {
        setStatus(status, "Consultando a DPS na Sefin…");
        const result = await api(`/api/fiscal/drafts/${id}/reconcile`, { method: "POST", body: JSON.stringify({ certificate: await certificatePayload() }) });
        setStatus(status, result.outcome === "authorized" ? "A nota existe e foi conciliada como autorizada." : "A DPS não foi gerada; a prévia voltou para aprovada.", "ok");
        return load(true);
      }
      if (action === "cancel") {
        const reasonCode = window.prompt("Motivo do cancelamento: 1 = erro na emissão, 2 = serviço não prestado, 9 = outros");
        if (!reasonCode) return;
        const reason = window.prompt("Descreva o motivo (15 a 255 caracteres):");
        if (!reason) return;
        const confirmation = window.prompt("O cancelamento é registrado como evento na NFS-e e não pode ser desfeito. Digite CANCELAR:");
        if (confirmation !== "CANCELAR") return;
        await api(`/api/fiscal/drafts/${id}/cancel`, { method: "POST", body: JSON.stringify({ reasonCode, reason, confirmation, certificate: await certificatePayload() }) });
        setStatus(status, "Cancelamento registrado.", "ok");
        return load(true);
      }
      if (action === "reopen") { await api(`/api/fiscal/drafts/${id}/reopen`, { method: "POST", body: "{}" }); return load(true); }
      if (action === "xml") return download(`/api/fiscal/drafts/${id}/xml`, `NFSe-${id}.xml`);
      if (action === "cancel-xml") return download(`/api/fiscal/drafts/${id}/cancel-xml`, `Cancelamento-${id}.xml`);
      if (action === "danfse") return download(`/api/fiscal/drafts/${id}/danfse`, `DANFSe-${id}.pdf`, { method: "POST", body: JSON.stringify({ certificate: await certificatePayload() }) });
      if (action === "events") {
        const { events } = await api(`/api/fiscal/drafts/${id}/events`);
        window.alert(events.length ? events.map((item) => `${new Date(item.createdAt).toLocaleString("pt-BR")} · ${item.action}${item.details?.code ? ` (${item.details.code})` : ""}${item.details?.message ? ` – ${item.details.message}` : ""}`).join("\n") : "Sem eventos registrados para esta nota.");
      }
    } catch (err) {
      setStatus(status, err.message, "error");
      if (["emit", "reconcile", "cancel"].includes(action)) await load(true);
    }
  }

  async function approveBatch() {
    const status = $("#fiscal-notes-status");
    setStatus(status, "Aprovando as prévias prontas…");
    try {
      const body = state.filters.competence ? { competence: state.filters.competence } : {};
      const result = await api("/api/fiscal/drafts/approve-batch", { method: "POST", body: JSON.stringify(body) });
      setStatus(status, `${result.approved} aprovada(s).${result.skipped.length ? ` ${result.skipped.length} ficaram de fora: ${result.skipped[0].reason}` : ""}`, "ok");
      await load(true);
    } catch (err) { setStatus(status, err.message, "error"); }
  }

  async function emitBatch() {
    const status = $("#fiscal-notes-status");
    try {
      const confirmation = confirmTransmission(20);
      if (!confirmation) return;
      setStatus(status, "Transmitindo uma nota por vez…");
      const result = await api("/api/fiscal/drafts/emit-batch", { method: "POST", body: JSON.stringify({ ...confirmation, limit: 20, certificate: await certificatePayload() }) });
      const ok = result.results.filter((item) => ["authorized", "homologated"].includes(item.status)).length;
      const failed = result.results.filter((item) => item.status === "error");
      setStatus(status, `${ok} transmitida(s) com sucesso, ${failed.length} com erro${failed.length ? ` (${failed[0].error})` : ""}. Restam ${result.remainingApproved} aprovada(s).`, failed.length ? "error" : "ok");
    } catch (err) { setStatus(status, err.message, "error"); }
    await load(true);
  }

  async function exportMonth() {
    const competence = state.filters.competence || window.prompt("Competência para exportar (AAAA-MM):");
    if (!competence) return;
    try { await download(`/api/fiscal/export?competence=${encodeURIComponent(competence)}`, `NFSe-${competence}.csv`); }
    catch (err) { setStatus($("#fiscal-notes-status"), err.message, "error"); }
  }

  async function testCertificate() {
    const status = $("#fiscal-cert-status");
    setStatus(status, "Validando certificado localmente…");
    try {
      const result = await api("/api/fiscal/certificate/test", { method: "POST", body: JSON.stringify(await certificatePayload()) });
      const info = result.certificate;
      const expiry = new Date(info.validUntil).toLocaleDateString("pt-BR");
      const chain = info.chainVerified ? "cadeia ICP-Brasil conferida" : "cadeia não conferida no servidor (configure FISCAL_ICP_ROOTS_PEM)";
      setStatus(status, `Certificado do CNPJ ${info.cnpj || "—"} válido até ${expiry}; ${chain}. A revogação é conferida pela API oficial na conexão.`, info.chainVerified ? "ok" : "");
    } catch (err) { setStatus(status, err.message, "error"); }
  }

  async function checkMunicipality() {
    const status = $("#fiscal-municipality-status");
    setStatus(status, "Consultando convênio, serviço e retenções do município…");
    try {
      const env = $("#fiscal-municipality-env")?.value === "production" ? "production" : "restricted";
      const { result } = await api("/api/fiscal/municipality/check", { method: "POST", body: JSON.stringify({ environment: env, certificate: await certificatePayload() }) });
      const parts = Object.entries(result.summary).map(([key, value]) => `${key}: HTTP ${value.status}`).join(" · ");
      setStatus(status, `${result.ok ? "Município respondeu" : "Consulta sem confirmação"} (${parts}). Revise o retorno com o contador.`, result.ok ? "ok" : "error");
      state.loaded = false;
      await load(true);
    } catch (err) { setStatus(status, err.message, "error"); }
  }

  async function saveProfile(event) {
    event.preventDefault();
    const form = event.currentTarget;
    syncServiceCode();
    const raw = Object.fromEntries(new FormData(form));
    raw.accountantConfirmed = form.elements.accountantConfirmed.checked;
    setStatus($("#fiscal-profile-status"), "Salvando…");
    try {
      const result = await api("/api/fiscal/profile", { method: "POST", body: JSON.stringify(raw) });
      state.profileFilled = false;
      setStatus($("#fiscal-profile-status"), result.issues.length ? `Salvo. Ainda falta: ${result.issues[0]}` : "Configuração salva e validada.", result.issues.length ? "" : "ok");
      await load(true);
    } catch (err) { setStatus($("#fiscal-profile-status"), err.message, "error"); }
  }

  function applyFilters() {
    state.filters = {
      page: 1,
      status: $("#fiscal-filter-status")?.value || "",
      competence: $("#fiscal-filter-competence")?.value || "",
      search: ($("#fiscal-filter-search")?.value || "").trim(),
    };
    load(true);
  }

  function wire() {
    $$("[data-fiscal-tab]").forEach((button) => button.addEventListener("click", () => setTab(button.dataset.fiscalTab)));
    $("#fiscal-refresh")?.addEventListener("click", () => load(true));
    $("#fiscal-pick-file")?.addEventListener("click", () => $("#fiscal-file")?.click());
    $("#fiscal-file")?.addEventListener("change", (event) => {
      state.file = event.target.files?.[0] || null; state.encoded = null; state.preview = null; state.mapping = null;
      $("#fiscal-file-name").textContent = state.file ? `${state.file.name} · ${(state.file.size / 1024 / 1024).toFixed(2)} MB` : "Nenhum arquivo selecionado";
      $("#fiscal-preview-btn").disabled = !state.file; $("#fiscal-import-btn").disabled = true;
      $("#fiscal-preview")?.classList.add("hidden"); $("#fiscal-mapping")?.classList.add("hidden");
    });
    $("#fiscal-service-date")?.addEventListener("change", () => { $("#fiscal-import-btn").disabled = true; });
    const drop = $("#fiscal-dropzone");
    ["dragenter", "dragover"].forEach((name) => drop?.addEventListener(name, (event) => { event.preventDefault(); drop.classList.add("is-drag"); }));
    ["dragleave", "drop"].forEach((name) => drop?.addEventListener(name, (event) => { event.preventDefault(); drop.classList.remove("is-drag"); }));
    drop?.addEventListener("drop", (event) => { const file = event.dataTransfer?.files?.[0]; if (!file) return; const transfer = new DataTransfer(); transfer.items.add(file); $("#fiscal-file").files = transfer.files; $("#fiscal-file").dispatchEvent(new Event("change")); });
    $("#fiscal-preview-btn")?.addEventListener("click", previewFile);
    $("#fiscal-import-btn")?.addEventListener("click", commitFile);
    $("#fiscal-mapping")?.addEventListener("change", () => { $("#fiscal-import-btn").disabled = true; });
    const profileForm = $("#fiscal-profile-form");
    profileForm?.addEventListener("submit", saveProfile);
    profileForm?.addEventListener("change", (event) => {
      if (["taxRegime", "totalsMode"].includes(event.target.name)) syncProfileVisibility();
      // Qualquer mudança fiscal pede nova confirmação do contador.
      if (event.target.name !== "accountantConfirmed" && profileForm.elements.accountantConfirmed.checked) {
        profileForm.elements.accountantConfirmed.checked = false;
        setStatus($("#fiscal-profile-status"), "A configuração mudou: confirme de novo com o contador antes de salvar.");
      }
    });
    $("#fiscal-cnpj-lookup")?.addEventListener("click", lookupCnpj);
    $("#fiscal-uf")?.addEventListener("change", (event) => fillCityOptions(event.target.value));
    $("#fiscal-city")?.addEventListener("change", updateCityCode);
    $("#fiscal-service-preset")?.addEventListener("change", syncServiceCode);
    $("#fiscal-service-other")?.addEventListener("input", syncServiceCode);
    $('[data-fiscal-tab="settings"]')?.addEventListener("click", () => fillUfOptions().catch(() => {}));
    $("#fiscal-cert-test")?.addEventListener("click", testCertificate);
    $("#fiscal-municipality-check")?.addEventListener("click", checkMunicipality);
    $("#fiscal-edit-form")?.addEventListener("submit", saveEdit);
    $("#fiscal-edit-form")?.elements.country?.addEventListener("input", syncEditVisibility);
    $("#fiscal-edit-cancel")?.addEventListener("click", () => $("#fiscal-edit-dialog")?.close());
    $("#fiscal-edit-x")?.addEventListener("click", () => $("#fiscal-edit-dialog")?.close());
    $("#fiscal-notes-body")?.addEventListener("click", (event) => {
      const target = event.target.closest("[data-fiscal-action]");
      if (target) runAction(target.dataset.fiscalAction, target.dataset.id);
    });
    ["#fiscal-filter-status", "#fiscal-filter-competence"].forEach((selector) => $(selector)?.addEventListener("change", applyFilters));
    let searchTimer = null;
    $("#fiscal-filter-search")?.addEventListener("input", () => { clearTimeout(searchTimer); searchTimer = setTimeout(applyFilters, 400); });
    $("#fiscal-page-prev")?.addEventListener("click", () => { state.filters.page = Math.max(1, state.filters.page - 1); load(true); });
    $("#fiscal-page-next")?.addEventListener("click", () => { state.filters.page += 1; load(true); });
    $("#fiscal-approve-batch")?.addEventListener("click", approveBatch);
    $("#fiscal-emit-batch")?.addEventListener("click", emitBatch);
    $("#fiscal-export")?.addEventListener("click", exportMonth);
  }

  document.addEventListener("DOMContentLoaded", wire);
  window.FiscalModule = { load, refresh: () => load(true) };
})();
