/* Backup & Contingência Pro — espelhado do Afiliadoteste */
(function (global) {
  "use strict";

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return [...(root || document).querySelectorAll(sel)]; }

  const CFG_KEY = "bk_pro_cfg_v1";
  const TABS = ["grupos", "cadastrar", "listagem", "garimpo", "recompra", "similar", "config"];

  const state = {
    wired: false,
    tab: "grupos",
    filter: "todos",
    backups: [],
    grupos: [],
    stats: null,
    listVisible: 30,
    lookupProduto: null,
    lookupHistorico: null,
    grupoExpandido: null,
    grupoReservasExpanded: {},
    reservaDetailOpen: {},
    criterio: "comissao",
    buscaGrupo: "",
    filtroNicho: "todas",
    refreshingGrupoId: null,
    listPreset: null,
    roboCache: {},
    varrendo: false,
    garimpoAba: "portfolio",
    garimpo: { jaVendo: [], descoberta: [], data: null },
    recompra: { produtos: [], data: null },
  };

  function loadCfg() {
    try {
      return {
        defaultGrupos: true,
        confirmVarrer: true,
        showKpi: true,
        ...(JSON.parse(localStorage.getItem(CFG_KEY) || "{}")),
      };
    } catch (_) {
      return { defaultGrupos: true, confirmVarrer: true, showKpi: true };
    }
  }

  function saveCfg(cfg) {
    localStorage.setItem(CFG_KEY, JSON.stringify(cfg));
  }

  function escapeHtml(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function fmt(n) {
    if (n == null || Number.isNaN(Number(n))) return "—";
    return Number(n).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
  }

  function fmtNum(n) {
    if (n == null || Number.isNaN(Number(n))) return "—";
    return Number(n).toLocaleString("pt-BR");
  }

  function formatTempoAtras(date) {
    if (!date) return "—";
    const d = date instanceof Date ? date : new Date(date);
    if (Number.isNaN(d.getTime())) return "—";
    const min = Math.floor((Date.now() - d.getTime()) / 60000);
    if (min < 1) return "agora";
    if (min < 60) return `há ${min} min`;
    const h = Math.floor(min / 60);
    if (h < 24) return `há ${h}h`;
    return `há ${Math.floor(h / 24)}d`;
  }

  function formatPeriodoComissao(periodoFim) {
    if (!periodoFim) return null;
    const agora = Math.floor(Date.now() / 1000);
    const diff = Number(periodoFim) - agora;
    if (diff < 0) return { texto: "ENCERRADO", critico: true };
    const dias = Math.floor(diff / 86400);
    if (dias < 7) return { texto: `Termina em ${dias} dia(s)`, critico: true };
    if (dias < 30) return { texto: `Termina em ${dias} dias`, critico: false };
    return { texto: `Válido por ${dias} dias`, critico: false };
  }

  function comissaoBRL(p) {
    return (Number(p?.preco || 0) * Number(p?.comissao_pct || 0)) / 100;
  }

  function categoriaProduto(p) {
    if (!p) return "Geral";
    return p.categoria || p.category || p.loja || "Geral";
  }

  function analisarInsights(principal, backups) {
    if (!principal || !backups?.length) return [];
    const insights = [];
    const pCom = comissaoBRL(principal);
    if (Number(principal.comissao_pct || 0) === 0 || principal.status_api === "produto_nao_encontrado") {
      insights.push({
        tipo: "critico",
        titulo: "Tráfego em perigo — fora do afiliado",
        mensagem: "O produto principal não retorna comissão. Substitua pelo backup agora.",
      });
    }
    let melhor = null;
    let maior = 0;
    for (const b of backups) {
      const d = comissaoBRL(b) - pCom;
      if (d > maior) { maior = d; melhor = b; }
    }
    if (melhor && maior > 0.5) {
      insights.push({
        tipo: "lucro",
        titulo: "Oportunidade de maior margem",
        mensagem: `O backup "${melhor.apelido || (melhor.nome || "").slice(0, 25)}" rende ${fmt(maior)} a mais por venda.`,
        backupId: melhor.itemId,
      });
    }
    return insights;
  }

  function veredito(produto, historico) {
    const pct = Number(produto.comissao_pct || 0);
    const comR = comissaoBRL(produto);
    if (pct === 0) {
      return { nivel: "ruim", texto: "Não compensa — comissão 0%", detalhes: "Produto saiu do programa de afiliados." };
    }
    if (comR < 1) {
      return { nivel: "ruim", texto: `Comissão muito baixa — apenas ${fmt(comR)}`, detalhes: "Não compensa investir tráfego pago." };
    }
    if (historico?.ja_vendeu && Number(historico.comissao_total_minha) > 50) {
      return { nivel: "bom", texto: `Histórico positivo — você já ganhou ${fmt(historico.comissao_total_minha)}`, detalhes: `Vendeu ${fmtNum(historico.vendas_minhas)} vezes.` };
    }
    if (comR >= 3) {
      return { nivel: "bom", texto: `Comissão decente — ${fmt(comR)} por venda`, detalhes: "Vale testar com pequeno orçamento." };
    }
    return { nivel: "atencao", texto: `Comissão moderada — ${fmt(comR)}`, detalhes: "Avaliar CPC do nicho antes de promover." };
  }

  async function api(path, opts = {}) {
    // Prefer app.js shared client (Bearer + 401 handling)
    if (typeof global.api === "function") return global.api(path, opts);
    const headers = { "Content-Type": "application/json", ...(opts.headers || {}) };
    const token = localStorage.getItem("metricly_access_token") || "";
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(path, { ...opts, headers, credentials: "include" });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.success === false) throw new Error(json.error || res.statusText || `HTTP ${res.status}`);
    return json;
  }

  function updateTabLabels() {
    const g = state.grupos.length;
    const b = state.backups.length;
    const r = (state.recompra.produtos || []).length;
    const setCount = (id, n) => {
      const el = $(`#backup-tabs [data-tab-count="${id}"]`);
      if (el) el.textContent = String(n);
    };
    setCount("grupos", g);
    setCount("listagem", b);
    setCount("recompra", r);
  }

  function setTab(tab) {
    state.tab = TABS.includes(tab) ? tab : "grupos";
    TABS.forEach((id) => {
      $(`#backup-tab-${id}`)?.classList.toggle("hidden", id !== state.tab);
    });
    $$("#backup-tabs [data-backup-tab]").forEach((btn) => {
      btn.classList.toggle("is-active", btn.dataset.backupTab === state.tab);
    });
    updateTabLabels();
    if (state.tab === "grupos") renderGrupos();
    if (state.tab === "listagem") renderListagem();
    if (state.tab === "similar") renderSimilarSetup();
    if (state.tab === "garimpo") renderGarimpo();
    if (state.tab === "recompra") renderRecompra();
    if (state.tab === "config") renderConfig();
  }

  function setKpi(key, strong, em) {
    const el = document.querySelector(`#backup-root [data-k="${key}"]`);
    if (!el) return;
    const s = el.querySelector("strong");
    const e = el.querySelector("em");
    if (s) s.textContent = strong;
    if (e && em != null) e.textContent = em;
  }

  const GARIMPO_KEY = "afilia:backup_garimpo_settings";
  const GARIMPO_DEFAULT = { precoToleranciaAcimaPct: 15, precoToleranciaAbaixoPct: 25 };

  function readGarimpoSettings() {
    try {
      const parsed = JSON.parse(localStorage.getItem(GARIMPO_KEY) || "{}");
      const clamp = (v, fb) => {
        const n = Number(v);
        return Number.isFinite(n) ? Math.min(100, Math.max(0, Math.round(n))) : fb;
      };
      return {
        precoToleranciaAcimaPct: clamp(parsed.precoToleranciaAcimaPct, 15),
        precoToleranciaAbaixoPct: clamp(parsed.precoToleranciaAbaixoPct, 25),
      };
    } catch {
      return { ...GARIMPO_DEFAULT };
    }
  }

  function writeGarimpoSettings(settings) {
    const next = readGarimpoSettings();
    if (settings.precoToleranciaAcimaPct != null) next.precoToleranciaAcimaPct = settings.precoToleranciaAcimaPct;
    if (settings.precoToleranciaAbaixoPct != null) next.precoToleranciaAbaixoPct = settings.precoToleranciaAbaixoPct;
    const clamp = (v, fb) => {
      const n = Number(v);
      return Number.isFinite(n) ? Math.min(100, Math.max(0, Math.round(n))) : fb;
    };
    const saved = {
      precoToleranciaAcimaPct: clamp(next.precoToleranciaAcimaPct, 15),
      precoToleranciaAbaixoPct: clamp(next.precoToleranciaAbaixoPct, 25),
    };
    localStorage.setItem(GARIMPO_KEY, JSON.stringify(saved));
    return saved;
  }

  function faixaGarimpo(preco, settings) {
    const base = Number(String(preco || "").replace(/\./g, "").replace(",", ".")) || Number(preco) || 0;
    if (!(base > 0)) return null;
    const s = settings || readGarimpoSettings();
    return {
      min: base * (1 - s.precoToleranciaAbaixoPct / 100),
      max: base * (1 + s.precoToleranciaAcimaPct / 100),
    };
  }

  function isSinalCritico(b) {
    const preco = Number(b.preco || 0);
    const pct = Number(b.comissao_pct || 0);
    if (b.status_api === "produto_nao_encontrado") return true;
    if (pct === 0 && b.status_api === "ok") return true;
    if (preco > 0 && pct > 0 && (preco * pct) / 100 < 1) return true;
    if (Number(b.rating || 0) > 0 && Number(b.rating) < 4) return true;
    if (Number(b.vendas_shopee || 0) === 0 && b.status_api === "ok") return true;
    return (b.alertas || []).some((a) => a?.tipo === "preco_subiu");
  }

  function tempoAtrasMs(ms) {
    if (ms == null || !Number.isFinite(ms)) return "—";
    const min = Math.floor(ms / 60000);
    if (min < 1) return "agora";
    if (min < 60) return `há ${min} min`;
    const h = Math.floor(min / 60);
    if (h < 24) return `há ${h}h`;
    return `há ${Math.floor(h / 24)}d`;
  }

  async function refreshStats() {
    const grid = $("#backup-kpi-grid");
    if (grid) grid.classList.remove("is-hidden");
    if (!state.backups.length) {
      try { await loadBackups(); } catch (_) {}
    }
    if (!state.grupos.length) {
      try { await loadGrupos(); } catch (_) {}
    }
    const backups = state.backups || [];
    const grupos = state.grupos || [];
    const total = backups.length;
    const emGrupo = backups.filter((b) => b.grupoId).length;
    const livres = total - emGrupo;
    const okApi = backups.filter((b) => b.status_api === "ok").length;
    const foraApi = backups.filter((b) => b.status_api === "produto_nao_encontrado").length;
    const sinais = backups.filter(isSinalCritico).length;
    const comFaixa = backups.filter((b) => Number(b.precoMin) > 0 && Number(b.precoMax) > 0 && Number(b.precoMin) !== Number(b.precoMax)).length;
    const coms = backups.map(comissaoBRL).filter((v) => v > 0);
    const media = coms.length ? coms.reduce((a, b) => a + b, 0) / coms.length : 0;
    const topo = coms.length ? Math.max(...coms) : 0;
    let antigo = null;
    let recente = null;
    for (const b of backups) {
      const t = b.ultima_verificacao ? Date.parse(b.ultima_verificacao) : 0;
      if (!t) continue;
      if (antigo == null || t < antigo) antigo = t;
      if (recente == null || t > recente) recente = t;
    }
    const byId = Object.fromEntries(backups.map((b) => [String(b.itemId), b]));
    let rotacoes = 0;
    let melhorDiff = 0;
    let melhorGrupo = "";
    for (const g of grupos) {
      const principal = byId[String(g.principalItemId || "")];
      if (!principal) continue;
      const reservas = (g.backupItemIds || []).map((id) => byId[String(id)]).filter((b) => b && b.status_api === "ok");
      if (!reservas.length) continue;
      const melhor = reservas.reduce((a, b) => (comissaoBRL(b) > comissaoBRL(a) ? b : a));
      const diff = comissaoBRL(melhor) - comissaoBRL(principal);
      if (diff > 0.05) {
        rotacoes += 1;
        if (diff > melhorDiff) {
          melhorDiff = diff;
          melhorGrupo = g.nome || "";
        }
      }
    }
    const lojaCount = {};
    for (const b of backups) {
      const k = b.loja || "—";
      lojaCount[k] = (lojaCount[k] || 0) + 1;
    }
    const topLojas = Object.entries(lojaCount).sort((a, b) => b[1] - a[1]);
    const pct = total ? Math.round((okApi / total) * 100) : 0;
    const idadeAntigo = antigo ? Date.now() - antigo : null;
    const idadeNovo = recente ? Date.now() - recente : null;
    setKpi("backups", String(total), `${emGrupo} em grupo · ${livres} livres`);
    setKpi("cobertura", String(okApi), `${pct}% retornam no afiliado`);
    setKpi("fora", String(foraApi), foraApi ? "revisar link" : "nenhum");
    setKpi("sinais", String(sinais), sinais ? "clique para ver" : "tudo saudável");
    setKpi("scan", tempoAtrasMs(idadeAntigo), idadeNovo != null ? `novo ${tempoAtrasMs(idadeNovo)}` : "—");
    setKpi("comissao", fmt(media), topo > 0 ? `topo ${fmt(topo)}` : "—");
    setKpi("rotacao", String(rotacoes), rotacoes ? `${melhorGrupo}: backup rende mais` : "principal é o melhor");
    setKpi("variantes", String(comFaixa), comFaixa ? `${total ? Math.round((comFaixa / total) * 100) : 0}% dos itens` : "preço único");
    setKpi("loja", topLojas[0] ? String(topLojas[0][0]).slice(0, 18) : "—", topLojas[0] ? `${topLojas[0][1]} itens` : "—");
    const foot = $("#backup-kpi-foot");
    if (foot) {
      const semReserva = grupos.filter((g) => !(g.backupItemIds || []).length).length;
      foot.textContent = grupos.length
        ? `${grupos.length} grupo(s) · ${grupos.filter((g) => g.principalItemId).length} com principal${semReserva ? ` · ${semReserva} sem reservas` : ""}`
        : "";
    }
    const live = $("#backup-live-status");
    if (live) {
      live.innerHTML = recente
        ? `<span class="bk-dot"></span>Última atualização ${escapeHtml(formatTempoAtras(new Date(recente).toISOString()))}`
        : `<span class="bk-dot"></span>Aguardando primeira varredura`;
    }
    const scanStrong = $("#backup-scan-info strong");
    if (scanStrong && recente) scanStrong.textContent = new Date(recente).toISOString();
    state.topLoja = topLojas[0] ? topLojas[0][0] : "";
  }

  async function loadBackups() {
    const r = await api("/api/backup");
    state.backups = r.items || [];
    updateTabLabels();
    return state.backups;
  }

  async function loadGrupos() {
    const r = await api("/api/backup/grupos");
    state.grupos = r.grupos || [];
    updateTabLabels();
    return state.grupos;
  }

  function produtoCardLookup(produto, historico, jaSalvo) {
    const v = veredito(produto, historico);
    const tone = v.nivel === "bom" ? "ok" : v.nivel === "atencao" ? "warn" : "bad";
    const comR = comissaoBRL(produto);
    const periodo = formatPeriodoComissao(produto.periodoFim);
    return `<article class="bk-card">
      <div class="bk-card-top">
        ${produto.imagem ? `<img src="${escapeHtml(produto.imagem)}" alt="" class="bk-thumb" />` : ""}
        <div class="bk-card-main">
          <div class="bk-title">${escapeHtml(produto.nome || "Produto")}</div>
          <div class="bk-meta"><i class="fa-solid fa-store"></i> ${escapeHtml(produto.loja || "—")}</div>
          <div class="bk-meta">★ ${Number(produto.rating || 0).toFixed(1)} · ${fmtNum(produto.vendas_shopee)} vendas Shopee</div>
          <div class="bk-stats">
            <div><span>Preço</span><b>${fmt(produto.preco)}</b></div>
            <div><span>Comissão</span><b>${Number(produto.comissao_pct || 0)}% (${fmt(comR)})</b></div>
          </div>
        </div>
      </div>
      ${periodo ? `<div class="bk-period ${periodo.critico ? "is-crit" : ""}">⏳ ${escapeHtml(periodo.texto)}</div>` : ""}
      ${historico?.ja_vendeu
        ? `<div class="bk-hist">Sua performance: ${fmtNum(historico.vendas_minhas)} vendas · ${fmt(historico.comissao_total_minha)} comissão · ${fmt(historico.gmv_total_meu)} GMV</div>`
        : `<div class="bk-hist is-muted">Você nunca vendeu esse produto antes.</div>`}
      <div class="bk-verdict is-${tone}"><b>${escapeHtml(v.texto)}</b><div>${escapeHtml(v.detalhes)}</div></div>
      ${jaSalvo
        ? `<div class="bk-saved">Já está nos seus backups.</div>`
        : `<div class="bk-save-row">
            <input type="text" id="backup-apelido" class="search" placeholder="Apelido (opcional)" />
            <button type="button" class="btn brand sm" id="btn-backup-save"><i class="fa-solid fa-floppy-disk"></i> Salvar</button>
          </div>`}
    </article>`;
  }

  function listItemHtml(b) {
    const periodo = formatPeriodoComissao(b.periodoFim);
    const comR = comissaoBRL(b);
    const alertas = b.alertas || [];
    const critico = alertas.some((a) => a.nivel === "critico");
    const status = critico
      ? `<span class="bk-badge is-danger">Fora do afiliado</span>`
      : alertas.length
        ? `<span class="bk-badge is-warn">${alertas.length} alerta${alertas.length !== 1 ? "s" : ""}</span>`
        : `<span class="bk-badge is-ok">Ativo</span>`;
    const papel = b.marcadoPrincipal ? "Principal" : (b.grupoId ? "Reserva" : "Backup livre");
    return `<tr data-item="${escapeHtml(b.itemId)}">
      <td>
        <div class="bk-product-cell">
          ${b.imagem ? `<img src="${escapeHtml(b.imagem)}" alt="" class="bk-mini-thumb" />` : `<div class="bk-mini-thumb"><i class="fa-solid fa-box"></i></div>`}
          <div>
            <b>${escapeHtml(b.apelido || b.nome || "Produto")}</b>
            <div class="bk-row-sub">${escapeHtml(papel)}${b.apelido ? ` · ${escapeHtml(b.nome || "")}` : ""}</div>
          </div>
        </div>
      </td>
      <td>${escapeHtml(b.loja || "—")}</td>
      <td>${fmt(b.preco)}</td>
      <td><b class="bk-com-pct">${Number(b.comissao_pct || 0)}%</b> · ${fmt(comR)}</td>
      <td>${status}</td>
      <td>${escapeHtml(formatTempoAtras(b.ultima_verificacao))}${periodo ? `<div class="bk-row-sub ${periodo.critico ? "is-crit" : ""}">${escapeHtml(periodo.texto)}</div>` : ""}</td>
      <td class="bk-row-acts">
        <button type="button" class="bk-icon-btn" data-act="refresh" data-id="${escapeHtml(b.itemId)}" title="Atualizar"><i class="fa-solid fa-rotate"></i></button>
        <button type="button" class="bk-icon-btn" data-act="copy" data-link="${escapeHtml(b.linkAfiliado || b.linkProduto || "")}" title="Copiar link"><i class="fa-solid fa-copy"></i></button>
        <button type="button" class="bk-icon-btn" data-act="star" data-id="${escapeHtml(b.itemId)}" data-on="${b.marcadoPrincipal ? "1" : "0"}" title="${b.marcadoPrincipal ? "Desmarcar" : "Marcar"} principal"><i class="fa-solid fa-star"></i></button>
        <button type="button" class="bk-icon-btn danger" data-act="del" data-id="${escapeHtml(b.itemId)}" data-nome="${escapeHtml(b.apelido || b.nome || "")}" title="Remover"><i class="fa-solid fa-trash"></i></button>
      </td>
    </tr>`;
  }

  async function renderListagem() {
    const listEl = $("#backup-list");
    const meta = $("#backup-list-meta");
    if (!listEl) return;
    listEl.innerHTML = `<div class="bk-empty">Carregando…</div>`;
    try { await loadBackups(); } catch (err) {
      listEl.innerHTML = `<div class="bk-error">${escapeHtml(err.message)}</div>`;
      return;
    }
    const q = ($("#backup-search")?.value || "").trim().toLowerCase();
    let items = state.backups;
    if (q) {
      items = items.filter((b) =>
        String(b.nome || "").toLowerCase().includes(q)
        || String(b.apelido || "").toLowerCase().includes(q)
      );
    }
    const filtro = state.filter;
    const preset = state.listPreset;
    const allCount = items.length;
    const alertCount = items.filter((b) => (b.alertas || []).length > 0).length;
    const princCount = items.filter((b) => b.marcadoPrincipal).length;
    $$("#backup-filters [data-backup-filter]").forEach((btn) => {
      const id = btn.dataset.backupFilter;
      const n = id === "alertas" ? alertCount : id === "principais" ? princCount : allCount;
      btn.textContent = id === "alertas" ? `Com alertas (${n})` : id === "principais" ? `Principais (${n})` : `Todos (${n})`;
      btn.classList.toggle("is-active", id === filtro && !preset);
    });
    if (filtro === "alertas") items = items.filter((b) => (b.alertas || []).length > 0);
    if (filtro === "principais") items = items.filter((b) => b.marcadoPrincipal);
    if (preset === "ok") items = items.filter((b) => b.status_api === "ok");
    if (preset === "fora") items = items.filter((b) => b.status_api === "produto_nao_encontrado");
    if (preset === "critico") items = items.filter(isSinalCritico);
    if (preset === "faixa") items = items.filter((b) => Number(b.precoMin) > 0 && Number(b.precoMax) > 0 && Number(b.precoMin) !== Number(b.precoMax));
    if (preset === "comissao") items = [...items].sort((a, b) => comissaoBRL(b) - comissaoBRL(a));
    if (preset === "esquecidos") {
      items = [...items].sort((a, b) => Date.parse(a.ultima_verificacao || 0) - Date.parse(b.ultima_verificacao || 0));
    }
    if (meta) meta.textContent = `${items.length} produto(s)${preset ? " · filtro do resumo" : ""}`;
    if (!state.backups.length) {
      listEl.innerHTML = `<div class="bk-empty"><i class="fa-solid fa-box-archive"></i><div>Nenhum produto cadastrado ainda</div><p>Vá em Adicionar para incluir seu primeiro backup.</p></div>`;
      return;
    }
    const shown = items.slice(0, state.listVisible);
    listEl.innerHTML = `<table class="bk-table"><thead><tr>
      <th>Produto</th><th>Loja</th><th>Preço</th><th>Comissão</th><th>Status</th><th>Atualização</th><th></th>
    </tr></thead><tbody>${shown.map(listItemHtml).join("")}</tbody></table>`
      + (items.length > state.listVisible
        ? `<div class="text-center pt-3"><button type="button" class="btn ghost sm" id="btn-backup-more">Carregar mais (${items.length - state.listVisible})</button></div>`
        : "");
    $("#btn-backup-more")?.addEventListener("click", () => {
      state.listVisible += 30;
      renderListagem();
    });
  }

  function isMobileBk() {
    return window.matchMedia("(max-width: 767px)").matches;
  }

  function produtoStatusLabel(p) {
    const alerts = p?.alertas || [];
    if (alerts.some((a) => a.nivel === "critico")) return { cls: "is-danger", text: "Fora da API" };
    if (alerts.length) return { cls: "is-warn", text: "Atenção" };
    return { cls: "is-ok", text: "Estável" };
  }

  function starsHtml(rating) {
    const raw = Number(rating || 0);
    const n = Math.max(0, Math.min(5, Math.round(raw)));
    if (!raw) return "";
    return `<div class="bk-stars" aria-label="${raw.toFixed(1)} de 5">${"★".repeat(n)}${"☆".repeat(5 - n)} <span>${raw.toFixed(1)}</span></div>`;
  }

  function produtoTile(p, badge, isPrincipal, grupoId, sugestao) {
    if (!p) return "";
    const comR = comissaoBRL(p);
    return `<div class="bk-tile ${isPrincipal ? "is-main" : ""}">
      <div class="bk-tile-badge ${sugestao ? "is-sug" : ""}">${escapeHtml(badge)}</div>
      ${p.imagem ? `<img src="${escapeHtml(p.imagem)}" alt="" loading="lazy" />` : `<div class="bk-tile-ph"><i class="fa-solid fa-box"></i></div>`}
      <div class="bk-tile-body">
        <div class="bk-tile-name">${escapeHtml(p.apelido || p.nome || "")}</div>
        <div class="bk-tile-price">${fmt(p.preco)}</div>
        <div><span class="bk-tile-com">${Number(p.comissao_pct || 0)}% comissão</span>
          ${comR > 0 ? `<span class="bk-tile-brl"> +${fmt(comR)}</span>` : ""}</div>
        ${p.vendas_shopee ? `<div class="bk-meta">${fmtNum(p.vendas_shopee)} vendidos</div>` : ""}
        ${starsHtml(p.rating)}
        <div class="bk-tile-acts">
          <button type="button" data-act="copy-tile" data-link="${escapeHtml(p.linkAfiliado || p.linkProduto || "")}">Obter link</button>
          ${!isPrincipal ? `<button type="button" class="del" data-act="remove-from-group" data-gid="${escapeHtml(grupoId || "")}" data-id="${escapeHtml(p.itemId)}" title="Remover"><i class="fa-solid fa-trash"></i></button>` : ""}
        </div>
        ${isPrincipal ? `<button type="button" class="bk-btn-pause" data-act="swap" data-gid="${escapeHtml(grupoId || "")}">Pausar e trocar</button>` : ""}
      </div>
    </div>`;
  }

  function reservaCompactHtml(p, grupoId, sugestao) {
    if (!p) return "";
    const key = `${grupoId}:${p.itemId}`;
    const open = Boolean(state.reservaDetailOpen[key]);
    const st = produtoStatusLabel(p);
    const comR = comissaoBRL(p);
    const pct = Number(p.comissao_pct || 0);
    return `<article class="bk-reserva-row${sugestao ? " is-sug" : ""}${open ? " is-open" : ""}">
      <button type="button" class="bk-reserva-hit" data-act="toggle-reserva" data-gid="${escapeHtml(grupoId)}" data-id="${escapeHtml(p.itemId)}" aria-expanded="${open ? "true" : "false"}">
        <div class="bk-reserva-thumb">
          ${p.imagem
            ? `<img src="${escapeHtml(p.imagem)}" alt="" width="48" height="48" loading="lazy" />`
            : `<span class="bk-reserva-ph"><i class="fa-solid fa-box" aria-hidden="true"></i></span>`}
        </div>
        <div class="bk-reserva-meta min-w-0">
          <div class="bk-reserva-name">${escapeHtml(p.apelido || p.nome || "")}</div>
          <div class="bk-reserva-loja">${escapeHtml(p.loja || "Shopee")}${sugestao ? " · sugerido" : ""}</div>
          <div class="bk-reserva-nums">${fmt(p.preco)} · ${pct}% comissão${comR > 0 ? ` · +${fmt(comR)}` : ""}</div>
          <span class="bk-reserva-st ${st.cls}">${escapeHtml(st.text)}</span>
        </div>
        <i class="fa-solid fa-chevron-${open ? "down" : "right"} bk-reserva-chev" aria-hidden="true"></i>
      </button>
      ${open ? `<div class="bk-reserva-detail">
        ${p.vendas_shopee ? `<div class="bk-meta">${fmtNum(p.vendas_shopee)} vendidos</div>` : ""}
        <div class="bk-reserva-acts">
          <button type="button" class="bk-btn-ghost" data-act="copy-tile" data-link="${escapeHtml(p.linkAfiliado || p.linkProduto || "")}">Obter link</button>
          <button type="button" class="bk-btn-ghost" data-act="swap" data-gid="${escapeHtml(grupoId)}" data-id="${escapeHtml(p.itemId)}">Trocar principal</button>
          <button type="button" class="bk-btn-ghost is-danger" data-act="remove-from-group" data-gid="${escapeHtml(grupoId)}" data-id="${escapeHtml(p.itemId)}">Remover</button>
        </div>
      </div>` : ""}
    </article>`;
  }

  function grupoTilesHtml(g, principal, sorted, sugestao) {
    const tiles = [
      principal ? produtoTile(principal, "Principal", true, g.docId, false) : "",
      ...sorted.map((p, i) => produtoTile(
        p,
        `Backup ${i + 1}${sugestao && p.itemId === sugestao.itemId ? " · sugerido" : ""}`,
        false,
        g.docId,
        sugestao && p.itemId === sugestao.itemId,
      )),
      `<button type="button" class="bk-add-tile" data-act="add-to-group" data-gid="${escapeHtml(g.docId)}"><i class="fa-solid fa-plus"></i><span>Adicionar backup</span></button>`,
    ].join("");
    return `<div class="bk-tiles">${tiles}</div>`;
  }

  function grupoCardHtml(g) {
    const principal = g.produtos?.[g.principalItemId];
    const backups = (g.backupItemIds || []).map((id) => g.produtos?.[id]).filter(Boolean);
    const open = state.grupoExpandido === g.docId;
    const insights = analisarInsights(principal, backups);
    const sorted = [...backups].sort((a, b) => {
      if (state.criterio === "rating") return Number(b.rating || 0) - Number(a.rating || 0);
      if (state.criterio === "vendas") return Number(b.vendas_shopee || 0) - Number(a.vendas_shopee || 0);
      return comissaoBRL(b) - comissaoBRL(a);
    });
    let sugestao = null;
    if (principal && sorted.length) {
      const melhor = sorted[0];
      if (state.criterio === "comissao" && comissaoBRL(melhor) > comissaoBRL(principal)) {
        sugestao = melhor;
      }
    }
    const niche = categoriaProduto(principal);
    const refreshing = state.refreshingGrupoId === g.docId;
    const crit = [principal, ...backups].filter(Boolean).some((p) =>
      (p.alertas || []).some((a) => a.nivel === "critico")
    );
    const badge = crit
      ? `<span class="bk-badge is-danger">Fora da API</span>`
      : insights.length
        ? `<span class="bk-badge is-warn">${insights.length} alerta${insights.length !== 1 ? "s" : ""}</span>`
        : `<span class="bk-badge is-ok">Estável</span>`;

    return `<article class="bk-gcard" data-gid="${escapeHtml(g.docId)}">
      <div class="bk-gcard-row">
        <div class="bk-gcard-main" data-act="toggle-group" data-gid="${escapeHtml(g.docId)}" role="button" tabindex="0">
          <div class="bk-gthumb">
            ${principal?.imagem
              ? `<img src="${escapeHtml(principal.imagem)}" alt="" />`
              : `<div class="bk-gthumb-ph"><i class="fa-solid fa-box"></i></div>`}
            <span class="bk-niche">${escapeHtml(String(niche).slice(0, 18))}</span>
          </div>
          <div class="min-w-0">
            <h4 class="bk-gname"><i class="fa-solid fa-bullseye"></i><span>${escapeHtml(g.nome)}</span></h4>
            <div class="bk-glink">
              Link ativo: <b>${escapeHtml(principal ? (principal.apelido || String(principal.nome || "").slice(0, 42)) : "—")}</b>
              <span class="bk-reservas-chip">${backups.length} reserva(s)</span>
            </div>
            <div class="bk-gfin">
              <span class="bk-metric">Lucro <b class="is-money">${fmt(g.lucro_historico || 0)}</b></span>
              <span class="bk-metric">GMV <b class="is-gmv">${fmt(g.gmv_historico || 0)}</b></span>
              <span class="bk-metric">Reservas <b>${backups.length}</b></span>
            </div>
          </div>
        </div>
        <div class="bk-gactions">
          ${badge}
          <button type="button" class="bk-btn-vinc" data-act="add-to-group" data-gid="${escapeHtml(g.docId)}">+ Vincular backup</button>
          <button type="button" class="bk-icon-btn" data-act="refresh-group" data-gid="${escapeHtml(g.docId)}" title="${refreshing ? "Atualizando" : "Atualizar"}" ${refreshing ? "disabled" : ""}><i class="fa-solid fa-rotate${refreshing ? " fa-spin" : ""}"></i></button>
          <button type="button" class="bk-icon-btn danger" data-act="del-group" data-gid="${escapeHtml(g.docId)}" data-nome="${escapeHtml(g.nome)}" title="Remover grupo"><i class="fa-solid fa-trash"></i></button>
          <button type="button" class="bk-icon-btn" data-act="toggle-group" data-gid="${escapeHtml(g.docId)}" aria-label="Expandir"><i class="fa-solid fa-chevron-${open ? "down" : "right"}"></i></button>
        </div>
      </div>
      ${open ? `<div class="bk-gbody">
        ${principal ? `<div class="bk-robo" id="bk-robo-${escapeHtml(g.docId)}">
          <div class="bk-robo-head"><span><i class="fa-solid fa-bolt"></i> Robô de Garimpo — ofertas semelhantes</span>
            <button type="button" class="bk-icon-btn" data-act="robo" data-gid="${escapeHtml(g.docId)}" title="Buscar de novo"><i class="fa-solid fa-rotate"></i></button>
          </div>
          <div class="bk-robo-body">Buscando ofertas semelhantes na mesma faixa de preço…</div>
        </div>` : ""}
        ${insights.length ? `<div class="bk-advisor">
          <div class="bk-advisor-title"><i class="fa-solid fa-lightbulb"></i> Contingência Advisor</div>
          ${insights.map((ins) => `<div class="bk-insight">
            <div><b>${escapeHtml(ins.titulo)}</b><p>${escapeHtml(ins.mensagem)}</p></div>
            ${ins.backupId ? `<button type="button" class="bk-btn-rotate" data-act="rotate" data-gid="${escapeHtml(g.docId)}" data-id="${escapeHtml(ins.backupId)}">Rotacionar agora</button>` : ""}
          </div>`).join("")}
        </div>` : ""}
        ${sugestao ? `<div class="bk-sugestao">
          <div class="bk-advisor-title"><i class="fa-solid fa-lightbulb"></i> Sugestão</div>
          <div class="bk-insight">
            <div><b>Trocar por ${escapeHtml(sugestao.apelido || sugestao.nome || "")}</b>
            <p>Motivo: comissão ${fmt(comissaoBRL(sugestao))} contra ${fmt(comissaoBRL(principal))} do principal.</p></div>
            <button type="button" class="bk-btn-troca" data-act="swap" data-gid="${escapeHtml(g.docId)}" data-id="${escapeHtml(sugestao.itemId)}">Trocar agora</button>
          </div>
        </div>` : ""}
        ${backups.length ? `<div class="bk-sort-row">
          <span>Ordenar por:</span>
          ${[["comissao", "Comissão"], ["rating", "Rating"], ["vendas", "Vendas"]].map(([id, lab]) =>
            `<button type="button" class="bk-chip ${state.criterio === id ? "is-active" : ""}" data-act="criterio" data-c="${id}">${lab}</button>`
          ).join("")}
        </div>` : ""}
        ${grupoTilesHtml(g, principal, sorted, sugestao)}
        ${(g.historico || []).length ? `<div class="bk-hist-block"><div class="bk-meta font-semibold mb-1">Histórico de trocas (${g.historico.length})</div>
          ${[...g.historico].reverse().slice(0, 8).map((h) =>
            `<div class="bk-hist is-muted">${escapeHtml(new Date(h.data).toLocaleString("pt-BR"))} · ${escapeHtml(h.motivo || "")}</div>`
          ).join("")}</div>` : ""}
      </div>` : ""}
    </article>`;
  }

  function gruposFiltrados() {
    let result = [...state.grupos];
    const termo = state.buscaGrupo.trim().toLowerCase();
    if (termo) {
      result = result.filter((g) => {
        const principal = g.produtos?.[g.principalItemId];
        return (g.nome || "").toLowerCase().includes(termo)
          || (principal?.nome || "").toLowerCase().includes(termo)
          || (principal?.apelido || "").toLowerCase().includes(termo)
          || (principal?.loja || "").toLowerCase().includes(termo);
      });
    }
    if (state.filtroNicho !== "todas") {
      result = result.filter((g) => {
        const principal = g.produtos?.[g.principalItemId];
        return principal && categoriaProduto(principal) === state.filtroNicho;
      });
    }
    return result;
  }

  function syncNichoSelect() {
    const sel = $("#backup-grupo-nicho");
    if (!sel) return;
    const set = new Set();
    state.grupos.forEach((g) => {
      const p = g.produtos?.[g.principalItemId];
      if (p) set.add(categoriaProduto(p));
    });
    const cur = state.filtroNicho;
    sel.innerHTML = `<option value="todas">Todos os nichos</option>`
      + [...set].map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join("");
    sel.value = [...set].includes(cur) || cur === "todas" ? cur : "todas";
    state.filtroNicho = sel.value;
  }

  async function renderGrupos() {
    const box = $("#backup-grupos-list");
    if (!box) return;
    if (!state.grupos.length) {
      box.innerHTML = `<div class="bk-empty">Carregando grupos…</div>`;
      try {
        await loadGrupos();
        if (!state.backups.length) await loadBackups().catch(() => {});
      } catch (err) {
        box.innerHTML = `<div class="bk-error">${escapeHtml(err.message)}</div>`;
        return;
      }
    }
    syncNichoSelect();
    const list = gruposFiltrados();
    const meta = $("#backup-grupos-meta");
    if (meta) meta.textContent = `${list.length} grupo${list.length === 1 ? "" : "s"} · ordenados por prioridade`;
    if (!state.grupos.length) {
      box.innerHTML = `<div class="bk-empty"><i class="fa-solid fa-bullseye"></i><div>Nenhum grupo encontrado</div><p>Crie um grupo para comparar o principal com reservas.</p></div>`;
      return;
    }
    if (!list.length) {
      box.innerHTML = `<div class="bk-empty"><i class="fa-solid fa-filter"></i><div>Nenhum grupo neste filtro</div><p>Ajuste a busca ou o nicho.</p></div>`;
      return;
    }
    box.innerHTML = list.map(grupoCardHtml).join("");
    const open = list.find((g) => g.docId === state.grupoExpandido);
    if (open) loadRobo(open, false);
  }

  async function loadRobo(grupo, force) {
    const box = $(`#bk-robo-${grupo.docId} .bk-robo-body`);
    if (!box) return;
    const principal = grupo.produtos?.[grupo.principalItemId];
    if (!principal) return;
    const cacheKey = `${grupo.docId}:${principal.itemId}:${readGarimpoSettings().precoToleranciaAcimaPct}:${readGarimpoSettings().precoToleranciaAbaixoPct}`;
    if (!force && state.roboCache[cacheKey]) {
      box.innerHTML = state.roboCache[cacheKey];
      return;
    }
    box.textContent = "Buscando ofertas semelhantes…";
    try {
      const exclude = [principal.itemId, ...(grupo.backupItemIds || [])];
      const r = await api("/api/backup/garimpo-contextual", {
        method: "POST",
        body: JSON.stringify({
          nome: principal.nome,
          apelido: principal.apelido || "",
          shopId: principal.shopId || "",
          preco: principal.preco,
          excludeItemIds: exclude,
          ...readGarimpoSettings(),
        }),
      });
      const ofertas = r.ofertas || [];
      const html = ofertas.length
        ? `<p class="bk-meta">Termo “${escapeHtml(r.termoUsado || "")}” · ${ofertas.length} oferta(s)</p>`
          + ofertas.map((p) => {
            const mesma = principal.shopId && String(p.shopId || "") === String(principal.shopId);
            return `<div class="bk-robo-item">
            ${p.imagem ? `<img src="${escapeHtml(p.imagem)}" alt="" />` : `<div class="bk-thumb-ph sm"><i class="fa-solid fa-box"></i></div>`}
            <div class="min-w-0" style="flex:1">
              <div class="bk-robo-badges">
                <span class="bk-mini-badge ${mesma ? "is-same" : "is-other"}">${mesma ? "Mesma loja" : "Outra loja"}</span>
                <span class="bk-mini-badge is-com">${Number(p.comissao_pct || 0).toFixed(1)}% comissão</span>
              </div>
              <b>${escapeHtml(String(p.nome || "").slice(0, 70))}</b>
              <div class="bk-meta">${escapeHtml(p.loja || "")} · ${fmt(p.preco)}${p.vendas || p.vendas_shopee ? ` · ${fmtNum(p.vendas || p.vendas_shopee)} vendidos` : ""}</div>
            </div>
            <button type="button" class="bk-btn-add-nesta" data-act="robo-save" data-gid="${escapeHtml(grupo.docId)}" data-item="${escapeHtml(p.itemId)}">Adicionar nesta</button>
          </div>`;
          }).join("")
        : `<div class="bk-meta">Nenhuma oferta na faixa de preço. Ajuste em Configurações.</div>`;
      state.roboCache[cacheKey] = html;
      state.roboOfertas = state.roboOfertas || {};
      for (const p of ofertas) state.roboOfertas[String(p.itemId)] = p;
      box.innerHTML = html;
    } catch (err) {
      box.innerHTML = `<div class="bk-error">${escapeHtml(err.message)}</div>`;
    }
  }

  async function renderSimilarSetup() {
    const sel = $("#backup-similar-select");
    const box = $("#backup-similar-results");
    if (!sel) return;
    try { if (!state.backups.length) await loadBackups(); } catch (_) {}
    if (!state.backups.length) {
      sel.innerHTML = `<option value="">Cadastre produtos primeiro</option>`;
      if (box) box.innerHTML = `<div class="bk-empty">Você precisa ter backups pra buscar similares.</div>`;
      return;
    }
    sel.innerHTML = `<option value="">— Selecione —</option>`
      + state.backups.map((b) => `<option value="${escapeHtml(b.itemId)}">${escapeHtml(b.apelido || b.nome)} (${escapeHtml(b.loja || "")})</option>`).join("");
    if (box) box.innerHTML = "";
  }

  async function buscarSimilares(itemId) {
    const box = $("#backup-similar-results");
    const b = state.backups.find((x) => x.itemId === itemId);
    if (!b || !box) return;
    box.innerHTML = `<div class="bk-empty">Consultando productOfferV2 da loja…</div>`;
    try {
      const r = await api("/api/backup/similares", {
        method: "POST",
        body: JSON.stringify({ loja: b.loja, shopId: b.shopId || null, excluirItemId: b.itemId }),
      });
      const items = r.items || [];
      if (!items.length) {
        box.innerHTML = `<div class="bk-empty">Nenhum similar encontrado para "${escapeHtml(b.loja || "loja")}".</div>`;
        return;
      }
      box.innerHTML = `<div class="text-sm text-slate-600 mb-2">${items.length} ofertas · loja <b>${escapeHtml(b.loja || "")}</b></div>`
        + items.map((s) => `<div class="bk-mine-card">
            <div class="min-w-0 flex gap-3 items-center">
              ${s.imagem ? `<img src="${escapeHtml(s.imagem)}" alt="" class="bk-thumb sm" />` : ""}
              <div class="min-w-0">
                <div class="bk-title truncate">${escapeHtml(s.nome)}</div>
                <div class="bk-meta">${s.preco ? fmt(s.preco) + " · " : ""}${Number(s.comissao_pct || 0) ? Number(s.comissao_pct).toFixed(1) + "% · " : ""}${fmt(s.comissao_total)} · ${fmtNum(s.vendas)} vendas${s.fonte ? " · " + escapeHtml(s.fonte) : ""}</div>
              </div>
            </div>
            <div class="flex gap-2 shrink-0">
              ${s.link ? `<a class="bk-act" href="${escapeHtml(s.link)}" target="_blank" rel="noopener">Ver</a>` : ""}
              ${s.shopId ? `<button type="button" class="bk-act" data-act="similar-save" data-json="${escapeHtml(JSON.stringify({
                itemId: s.itemId,
                shopId: s.shopId,
                nome: s.nome,
                preco: s.preco,
                comissao_pct: s.comissao_pct,
                vendas_shopee: s.vendas,
                imagem: s.imagem,
                rating: s.rating,
                loja: s.loja,
                linkProduto: s.link || "",
                linkAfiliado: s.link || "",
              }))}">Salvar</button>` : ""}
            </div>
          </div>`).join("");
    } catch (err) {
      box.innerHTML = `<div class="bk-error">${escapeHtml(err.message)}</div>`;
    }
  }

  function mineCardHtml(p, mode) {
    const foto = p.imagem
      ? `<img src="${escapeHtml(p.imagem)}" alt="" class="bk-thumb sm" loading="lazy" />`
      : `<div class="bk-thumb sm bk-thumb-ph" aria-hidden="true"><i class="fa-solid fa-image"></i></div>`;
    return `<div class="bk-mine-card" data-id="${escapeHtml(p.itemId)}">
      <div class="bk-mine-main">
        ${foto}
        <div class="min-w-0">
          <div class="bk-title truncate">${escapeHtml(p.nome || "Produto")}</div>
          <div class="bk-meta">${escapeHtml(p.shop_name || p.loja || "—")} · ${fmtNum(p.vendas)} ${p.fonte === "api" ? "vendas Shopee" : "pedidos"}</div>
          <div class="bk-line">${p.preco ? fmt(p.preco) + " · " : ""}${Number(p.comissao_pct || 0) ? Number(p.comissao_pct).toFixed(1) + "% · " : ""}${fmt(p.minha_comissao_historica || p.comissao_total || 0)}${p.gmv_total ? " · GMV " + fmt(p.gmv_total) : ""}</div>
        </div>
      </div>
      <div class="flex gap-2 shrink-0">
        <button type="button" class="bk-act" data-act="mine-save" data-mode="${escapeHtml(mode)}" data-id="${escapeHtml(p.itemId)}">Salvar backup</button>
      </div>
    </div>`;
  }

  async function renderGarimpo() {
    const box = $("#backup-garimpo-list");
    const meta = $("#backup-garimpo-meta");
    if (!box) return;
    if (!state.garimpo.data) {
      box.innerHTML = `<div class="bk-empty">Carregando garimpo…</div>`;
      try {
        const r = await api("/api/backup/garimpo");
        state.garimpo = {
          jaVendo: r.jaVendo || [],
          descoberta: r.descoberta || [],
          data: r.data,
        };
      } catch (err) {
        box.innerHTML = `<div class="bk-error">${escapeHtml(err.message)}</div>`;
        return;
      }
    }
    $$("#backup-garimpo-subtabs [data-garimpo-aba]").forEach((btn) => {
      btn.classList.toggle("is-active", btn.dataset.garimpoAba === state.garimpoAba);
    });
    const q = ($("#backup-garimpo-search")?.value || "").trim().toLowerCase();
    let lista = state.garimpoAba === "descoberta" ? state.garimpo.descoberta : state.garimpo.jaVendo;
    if (q) {
      lista = lista.filter((p) =>
        String(p.nome || "").toLowerCase().includes(q)
        || String(p.shop_name || p.loja || "").toLowerCase().includes(q)
      );
    }
    if (meta) {
      meta.textContent = state.garimpo.data
        ? `Snapshot ${state.garimpo.data} · ${lista.length} produto(s) · fonte: histórico de vendas`
        : "—";
    }
    if (!lista.length) {
      box.innerHTML = `<div class="bk-empty"><i class="fa-solid fa-gem"></i><div>Nada no garimpo ainda</div><p>Produtos com comissão histórica que ainda não estão nos backups aparecem aqui.</p></div>`;
      return;
    }
    box.innerHTML = lista.map((p) => mineCardHtml(p, "garimpo")).join("");
  }

  async function renderRecompra() {
    const box = $("#backup-recompra-list");
    const meta = $("#backup-recompra-meta");
    if (!box) return;
    if (!state.recompra.data) {
      box.innerHTML = `<div class="bk-empty">Carregando radar…</div>`;
      try {
        const r = await api("/api/backup/recompra");
        state.recompra = { produtos: r.produtos || [], data: r.data };
      } catch (err) {
        box.innerHTML = `<div class="bk-error">${escapeHtml(err.message)}</div>`;
        return;
      }
    }
    const q = ($("#backup-recompra-search")?.value || "").trim().toLowerCase();
    let lista = state.recompra.produtos;
    if (q) {
      lista = lista.filter((p) =>
        String(p.nome || "").toLowerCase().includes(q)
        || String(p.shop_name || p.loja || "").toLowerCase().includes(q)
      );
    }
    if (meta) meta.textContent = `${lista.length} candidato(s) a recompra (já vendidos, fora do backup)`;
    if (!lista.length) {
      box.innerHTML = `<div class="bk-empty"><i class="fa-solid fa-rotate"></i><div>Radar sem candidatos</div><p>Quando houver produtos com recompra histórica fora do backup, eles aparecem aqui.</p></div>`;
      return;
    }
    box.innerHTML = lista.map((p) => mineCardHtml(p, "recompra")).join("");
    updateTabLabels();
  }

  function renderConfig() {
    const s = readGarimpoSettings();
    const acima = $("#bk-gar-acima");
    const abaixo = $("#bk-gar-abaixo");
    const acimaN = $("#bk-gar-acima-n");
    const abaixoN = $("#bk-gar-abaixo-n");
    if (acima) acima.value = s.precoToleranciaAcimaPct;
    if (abaixo) abaixo.value = s.precoToleranciaAbaixoPct;
    if (acimaN) acimaN.value = s.precoToleranciaAcimaPct;
    if (abaixoN) abaixoN.value = s.precoToleranciaAbaixoPct;
    paintFaixaGarimpo();
  }

  function paintFaixaGarimpo() {
    const raw = $("#bk-gar-exemplo")?.value || "99.90";
    const n = Number(String(raw).replace(/\./g, "").replace(",", ".")) || Number(raw) || 0;
    const faixa = faixaGarimpo(n, {
      precoToleranciaAcimaPct: Number($("#bk-gar-acima")?.value || 15),
      precoToleranciaAbaixoPct: Number($("#bk-gar-abaixo")?.value || 25),
    });
    const el = $("#bk-gar-faixa");
    if (!el) return;
    el.innerHTML = faixa
      ? `Garimpo aceita ofertas entre <b>${fmt(faixa.min)}</b> e <b>${fmt(faixa.max)}</b>`
      : "Informe um preço válido para ver a faixa.";
  }

  function openModalCriarGrupo() {
    const livres = state.backups.filter((b) => !b.grupoId);
    const html = `<div class="bk-modal-backdrop" id="bk-modal">
      <div class="bk-modal">
        <div class="bk-modal-head"><h3>Criar grupo de backup</h3><button type="button" data-close>✕</button></div>
        <label class="bk-label">Nome do grupo</label>
        <input type="text" id="bk-g-nome" class="search w-full" placeholder="Ex: Wide Jeans" />
        <label class="bk-label mt-3">Produto principal</label>
        <select id="bk-g-principal" class="search w-full">
          <option value="">— Selecione —</option>
          ${livres.map((b) => `<option value="${escapeHtml(b.itemId)}">${escapeHtml(b.apelido || b.nome)} — ${escapeHtml(b.loja || "")}</option>`).join("")}
        </select>
        <p class="bk-meta mt-2">${livres.length ? "" : "Nenhum produto livre. Cadastre na aba Cadastrar link."}</p>
        <div class="bk-modal-actions">
          <button type="button" class="btn ghost sm" data-close>Cancelar</button>
          <button type="button" class="btn brand sm" id="bk-g-criar">Criar grupo</button>
        </div>
        <p class="form-status" id="bk-g-status"></p>
      </div>
    </div>`;
    document.body.insertAdjacentHTML("beforeend", html);
    const modal = $("#bk-modal");
    modal.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", () => modal.remove()));
    $("#bk-g-criar")?.addEventListener("click", async () => {
      const status = $("#bk-g-status");
      try {
        await api("/api/backup/grupos", {
          method: "POST",
          body: JSON.stringify({
            nome: $("#bk-g-nome")?.value || "",
            principalItemId: $("#bk-g-principal")?.value || "",
          }),
        });
        modal.remove();
        state.grupos = [];
        await loadBackups();
        await renderGrupos();
        await refreshStats();
      } catch (err) {
        if (status) { status.className = "form-status err"; status.textContent = err.message; }
      }
    });
  }

  function openModalAddToGroup(grupoId) {
    const livres = state.backups.filter((b) => !b.grupoId);
    const html = `<div class="bk-modal-backdrop" id="bk-modal">
      <div class="bk-modal">
        <div class="bk-modal-head"><h3>Vincular backup</h3><button type="button" data-close>✕</button></div>
        <label class="bk-label">Produto já cadastrado (livre)</label>
        <select id="bk-add-item" class="search w-full">
          <option value="">— Selecione —</option>
          ${livres.map((b) => `<option value="${escapeHtml(b.itemId)}">${escapeHtml(b.apelido || b.nome)} — ${escapeHtml(b.loja || "")}</option>`).join("")}
        </select>
        <p class="bk-meta mt-2">Ou cadastre um novo link na aba “Cadastrar link” e vincule depois.</p>
        <div class="bk-modal-actions">
          <button type="button" class="btn ghost sm" data-close>Cancelar</button>
          <button type="button" class="btn brand sm" id="bk-add-ok">Vincular</button>
        </div>
        <p class="form-status" id="bk-add-status"></p>
      </div>
    </div>`;
    document.body.insertAdjacentHTML("beforeend", html);
    const modal = $("#bk-modal");
    modal.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", () => modal.remove()));
    $("#bk-add-ok")?.addEventListener("click", async () => {
      const status = $("#bk-add-status");
      try {
        await api("/api/backup/grupos/add", {
          method: "POST",
          body: JSON.stringify({ grupoId, itemId: $("#bk-add-item")?.value }),
        });
        modal.remove();
        state.grupos = [];
        await loadBackups();
        await renderGrupos();
        await refreshStats();
      } catch (err) {
        if (status) { status.className = "form-status err"; status.textContent = err.message; }
      }
    });
  }

  function openModalSwap(grupoId, preselect) {
    const g = state.grupos.find((x) => x.docId === grupoId);
    if (!g) return;
    const backups = (g.backupItemIds || []).map((id) => g.produtos?.[id]).filter(Boolean);
    if (!backups.length) {
      alert("Cadastre ao menos um backup no grupo para trocar o principal.");
      return;
    }
    const html = `<div class="bk-modal-backdrop" id="bk-modal">
      <div class="bk-modal">
        <div class="bk-modal-head"><h3>Trocar principal</h3><button type="button" data-close>✕</button></div>
        <select id="bk-swap-item" class="search w-full">
          ${backups.map((b) => `<option value="${escapeHtml(b.itemId)}" ${preselect && preselect === b.itemId ? "selected" : ""}>${escapeHtml(b.apelido || b.nome)} — ${fmt(comissaoBRL(b))}</option>`).join("")}
        </select>
        <label class="bk-label mt-3">Motivo</label>
        <input type="text" id="bk-swap-motivo" class="search w-full" placeholder="Ex: comissão maior" />
        <div class="bk-modal-actions">
          <button type="button" class="btn ghost sm" data-close>Cancelar</button>
          <button type="button" class="btn brand sm" id="bk-swap-ok">Trocar</button>
        </div>
        <p class="form-status" id="bk-swap-status"></p>
      </div>
    </div>`;
    document.body.insertAdjacentHTML("beforeend", html);
    const modal = $("#bk-modal");
    modal.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", () => modal.remove()));
    $("#bk-swap-ok")?.addEventListener("click", async () => {
      const status = $("#bk-swap-status");
      try {
        await api("/api/backup/grupos/swap", {
          method: "POST",
          body: JSON.stringify({
            grupoId,
            novoPrincipalItemId: $("#bk-swap-item")?.value,
            motivo: $("#bk-swap-motivo")?.value || "",
          }),
        });
        modal.remove();
        state.grupos = [];
        await renderGrupos();
        await refreshStats();
      } catch (err) {
        if (status) { status.className = "form-status err"; status.textContent = err.message; }
      }
    });
  }

  async function varrerTodas() {
    const cfg = loadCfg();
    const btns = $$(".js-backup-varrer");
    const labelFor = () => "Varrer todas as ofertas";
    try {
      if (!state.backups.length) await loadBackups();
    } catch (err) {
      alert(err.message);
      return;
    }
    if (!state.backups.length) {
      alert("Nenhum backup cadastrado.");
      return;
    }
    if (cfg.confirmVarrer) {
      const ok = confirm(`Consultar a API Shopee para ${state.backups.length} produto(s)? Pode levar alguns minutos.`);
      if (!ok) return;
    }
    state.varrendo = true;
    btns.forEach((btn) => {
      btn.disabled = true;
      btn.classList.add("is-spin");
      const span = btn.querySelector("span");
      if (span) span.textContent = "Varrendo…";
    });
    try {
      const r = await api("/api/backup/refresh-all", {
        method: "POST",
        body: JSON.stringify({}),
      });
      alert(`Varredura concluída: ${r.sucesso}/${r.total} atualizados.`);
      state.grupos = [];
      state.garimpo.data = null;
      state.recompra.data = null;
      await loadBackups();
      await refreshStats();
      if (state.tab === "grupos") await renderGrupos();
      if (state.tab === "listagem") await renderListagem();
    } catch (err) {
      alert(err.message || String(err));
    } finally {
      state.varrendo = false;
      btns.forEach((btn) => {
        btn.disabled = false;
        btn.classList.remove("is-spin");
        const span = btn.querySelector("span");
        if (span) span.textContent = labelFor(btn);
      });
    }
  }

  async function salvarMineComoBackup(itemId) {
    const pool = [
      ...(state.garimpo.jaVendo || []),
      ...(state.garimpo.descoberta || []),
      ...(state.recompra.produtos || []),
    ];
    const p = pool.find((x) => String(x.itemId) === String(itemId));
    if (!p) return;
    try {
      if (p.shopId && p.fonte === "api") {
        await api("/api/backup", {
          method: "POST",
          body: JSON.stringify({
            produto: {
              itemId: p.itemId,
              shopId: p.shopId,
              nome: p.nome,
              preco: p.preco || 0,
              comissao_pct: p.comissao_pct || 0,
              vendas_shopee: p.vendas || 0,
              imagem: p.imagem || "",
              rating: 0,
              loja: p.shop_name || p.loja || "",
              linkProduto: p.link_produto || "",
              linkAfiliado: p.link_afiliado || "",
            },
          }),
        });
      } else {
        const urlHint = prompt(
          "Cole o link Shopee completo do produto para buscar preço/comissão na API:",
          p.link_produto || "",
        );
        if (!urlHint || !urlHint.trim()) return;
        const res = await api("/api/backup/lookup", { method: "POST", body: JSON.stringify({ url: urlHint.trim() }) });
        await api("/api/backup", {
          method: "POST",
          body: JSON.stringify({ produto: res.produto, apelido: "" }),
        });
      }
      alert("Salvo no backup.");
      state.garimpo.data = null;
      state.recompra.data = null;
      await loadBackups();
      await refreshStats();
      if (state.tab === "garimpo") await renderGarimpo();
      if (state.tab === "recompra") await renderRecompra();
    } catch (err) {
      alert(err.message || String(err));
    }
  }

  function wire() {
    if (state.wired) return;
    state.wired = true;

    const mqBk = window.matchMedia("(max-width: 767px)");
    const onBkMq = () => {
      if (state.tab === "grupos") renderGrupos();
    };
    if (mqBk.addEventListener) mqBk.addEventListener("change", onBkMq);
    else if (mqBk.addListener) mqBk.addListener(onBkMq);

    $$("#backup-tabs [data-backup-tab]").forEach((btn) => {
      btn.addEventListener("click", () => setTab(btn.dataset.backupTab));
    });

    $$("#backup-filters [data-backup-filter]").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.filter = btn.dataset.backupFilter;
        state.listPreset = null;
        state.listVisible = 30;
        renderListagem();
      });
    });

    $("#backup-root")?.addEventListener("click", (e) => {
      const card = e.target.closest("#backup-kpi-grid [data-k], #backup-kpi-row2 [data-k]");
      if (!card) return;
      const k = card.dataset.k;
      if (k === "rotacao") {
        setTab("grupos");
        return;
      }
      const preset = {
        backups: null,
        cobertura: "ok",
        fora: "fora",
        sinais: "critico",
        scan: "esquecidos",
        comissao: "comissao",
        variantes: "faixa",
        loja: null,
      }[k];
      state.listPreset = preset || null;
      state.filter = "todos";
      state.listVisible = 30;
      if (k === "loja" && state.topLoja) {
        const input = $("#backup-search");
        if (input) input.value = state.topLoja;
      }
      setTab("listagem");
    });

    const syncGar = (which) => {
      const range = $(which === "acima" ? "#bk-gar-acima" : "#bk-gar-abaixo");
      const num = $(which === "acima" ? "#bk-gar-acima-n" : "#bk-gar-abaixo-n");
      const val = Number((document.activeElement === num ? num : range)?.value || 0);
      if (range) range.value = val;
      if (num) num.value = val;
      writeGarimpoSettings({
        precoToleranciaAcimaPct: Number($("#bk-gar-acima")?.value || 15),
        precoToleranciaAbaixoPct: Number($("#bk-gar-abaixo")?.value || 25),
      });
      state.roboCache = {};
      paintFaixaGarimpo();
      const st = $("#backup-cfg-status");
      if (st) { st.className = "form-status ok"; st.textContent = "Faixa do garimpo salva neste navegador."; }
    };
    ["acima", "abaixo"].forEach((which) => {
      $(which === "acima" ? "#bk-gar-acima" : "#bk-gar-abaixo")?.addEventListener("input", () => syncGar(which));
      $(which === "acima" ? "#bk-gar-acima-n" : "#bk-gar-abaixo-n")?.addEventListener("input", () => syncGar(which));
    });
    $("#bk-gar-exemplo")?.addEventListener("input", paintFaixaGarimpo);
    $("#btn-backup-cfg-reset")?.addEventListener("click", () => {
      localStorage.removeItem(GARIMPO_KEY);
      state.roboCache = {};
      renderConfig();
      const st = $("#backup-cfg-status");
      if (st) { st.className = "form-status ok"; st.textContent = "Configurações do garimpo restauradas."; }
    });

    $("#backup-search")?.addEventListener("input", () => {
      state.listVisible = 30;
      renderListagem();
    });

    $("#backup-grupo-search")?.addEventListener("input", (e) => {
      state.buscaGrupo = e.target.value || "";
      renderGrupos();
    });
    $("#backup-grupo-nicho")?.addEventListener("change", (e) => {
      state.filtroNicho = e.target.value || "todas";
      renderGrupos();
    });

    $$(".js-backup-varrer").forEach((btn) => btn.addEventListener("click", () => varrerTodas()));

    $("#btn-backup-lookup")?.addEventListener("click", async () => {
      const status = $("#backup-lookup-status");
      const box = $("#backup-lookup-result");
      const url = ($("#backup-url")?.value || "").trim();
      if (!url) {
        if (status) { status.className = "form-status err"; status.textContent = "Cole um link Shopee"; }
        return;
      }
      if (status) { status.className = "form-status"; status.textContent = "Buscando na API Shopee (productOfferV2)…"; }
      if (box) box.innerHTML = "";
      try {
        const res = await api("/api/backup/lookup", { method: "POST", body: JSON.stringify({ url }) });
        state.lookupProduto = res.produto;
        state.lookupHistorico = res.historico;
        if (box) {
          box.innerHTML = produtoCardLookup(res.produto, res.historico, res.jaSalvoComoBackup);
          $("#btn-backup-save")?.addEventListener("click", async () => {
            try {
              await api("/api/backup", {
                method: "POST",
                body: JSON.stringify({
                  produto: state.lookupProduto,
                  apelido: $("#backup-apelido")?.value || "",
                }),
              });
              if (status) { status.className = "form-status ok"; status.textContent = "Salvo no backup."; }
              box.innerHTML = produtoCardLookup(state.lookupProduto, state.lookupHistorico, true);
              await loadBackups();
              await refreshStats();
            } catch (err) {
              if (status) { status.className = "form-status err"; status.textContent = err.message; }
            }
          });
        }
        if (status) { status.className = "form-status ok"; status.textContent = "Produto encontrado na API."; }
      } catch (err) {
        if (status) { status.className = "form-status err"; status.textContent = err.message || String(err); }
      }
    });

    $("#btn-backup-search")?.addEventListener("click", async () => {
      const box = $("#backup-search-results");
      const kw = ($("#backup-keyword")?.value || "").trim();
      if (!box) return;
      if (!kw) {
        box.innerHTML = `<div class="bk-error">Digite um termo para buscar.</div>`;
        return;
      }
      box.innerHTML = `<div class="bk-empty">Buscando productOfferV2…</div>`;
      try {
        const r = await api("/api/backup/search", {
          method: "POST",
          body: JSON.stringify({ keyword: kw, limit: 20 }),
        });
        const items = r.items || [];
        if (!items.length) {
          box.innerHTML = `<div class="bk-empty">Nenhuma oferta para "${escapeHtml(kw)}".</div>`;
          return;
        }
        box.innerHTML = items.map((p) => `<div class="bk-mine-card">
          <div class="min-w-0 flex gap-3 items-center">
            ${p.imagem ? `<img src="${escapeHtml(p.imagem)}" alt="" class="bk-thumb sm" />` : ""}
            <div class="min-w-0">
              <div class="bk-title truncate">${escapeHtml(p.nome)}</div>
              <div class="bk-meta">${escapeHtml(p.loja || "—")} · ${fmt(p.preco)} · ${Number(p.comissao_pct || 0)}%</div>
            </div>
          </div>
          <button type="button" class="bk-act" data-act="search-save" data-json="${escapeHtml(JSON.stringify(p))}">Salvar</button>
        </div>`).join("");
      } catch (err) {
        box.innerHTML = `<div class="bk-error">${escapeHtml(err.message)}</div>`;
      }
    });

    $("#backup-search-results")?.addEventListener("click", async (e) => {
      const btn = e.target.closest("[data-act=search-save]");
      if (!btn) return;
      try {
        const produto = JSON.parse(btn.dataset.json || "{}");
        await api("/api/backup", { method: "POST", body: JSON.stringify({ produto }) });
        btn.textContent = "Salvo";
        btn.disabled = true;
        await loadBackups();
        await refreshStats();
      } catch (err) {
        alert(err.message || String(err));
      }
    });

    $("#backup-similar-results")?.addEventListener("click", async (e) => {
      const btn = e.target.closest("[data-act=similar-save]");
      if (!btn) return;
      try {
        const produto = JSON.parse(btn.dataset.json || "{}");
        await api("/api/backup", { method: "POST", body: JSON.stringify({ produto }) });
        btn.textContent = "Salvo";
        btn.disabled = true;
        await loadBackups();
        await refreshStats();
      } catch (err) {
        alert(err.message || String(err));
      }
    });

    $("#backup-list")?.addEventListener("click", async (e) => {
      const btn = e.target.closest("[data-act]");
      if (!btn) return;
      const act = btn.dataset.act;
      try {
        if (act === "refresh") {
          btn.disabled = true;
          await api("/api/backup/refresh", { method: "POST", body: JSON.stringify({ itemId: btn.dataset.id }) });
          await renderListagem();
          await refreshStats();
        } else if (act === "copy") {
          await navigator.clipboard.writeText(btn.dataset.link || "");
          alert("Link copiado!");
        } else if (act === "star") {
          await api("/api/backup/meta", {
            method: "POST",
            body: JSON.stringify({ itemId: btn.dataset.id, marcadoPrincipal: btn.dataset.on !== "1" }),
          });
          await renderListagem();
        } else if (act === "del") {
          if (!confirm(`Remover "${btn.dataset.nome}" dos backups?`)) return;
          await api("/api/backup/delete", { method: "POST", body: JSON.stringify({ itemId: btn.dataset.id }) });
          state.grupos = [];
          await renderListagem();
          await refreshStats();
        }
      } catch (err) {
        alert(err.message || String(err));
      }
    });

    $("#backup-similar-select")?.addEventListener("change", (e) => {
      if (e.target.value) buscarSimilares(e.target.value);
    });

    $("#btn-backup-criar-grupo")?.addEventListener("click", async () => {
      if (!state.backups.length) await loadBackups().catch(() => {});
      openModalCriarGrupo();
    });

    $("#backup-grupos-list")?.addEventListener("click", async (e) => {
      const btn = e.target.closest("[data-act]");
      if (!btn) return;
      const act = btn.dataset.act;
      try {
        if (act === "toggle-group") {
          state.grupoExpandido = state.grupoExpandido === btn.dataset.gid ? null : btn.dataset.gid;
          await renderGrupos();
        } else if (act === "expand-reservas") {
          state.grupoReservasExpanded[btn.dataset.gid] = true;
          await renderGrupos();
        } else if (act === "collapse-reservas") {
          state.grupoReservasExpanded[btn.dataset.gid] = false;
          await renderGrupos();
        } else if (act === "toggle-reserva") {
          const key = `${btn.dataset.gid}:${btn.dataset.id}`;
          state.reservaDetailOpen[key] = !state.reservaDetailOpen[key];
          await renderGrupos();
        } else if (act === "criterio") {
          state.criterio = btn.dataset.c;
          await renderGrupos();
        } else if (act === "add-to-group") {
          if (!state.backups.length) await loadBackups();
          openModalAddToGroup(btn.dataset.gid);
        } else if (act === "swap" || act === "rotate") {
          openModalSwap(btn.dataset.gid, btn.dataset.id || "");
        } else if (act === "copy-tile") {
          await navigator.clipboard.writeText(btn.dataset.link || "");
          alert("Link copiado!");
        } else if (act === "refresh-group") {
          state.refreshingGrupoId = btn.dataset.gid;
          await renderGrupos();
          try {
            await api("/api/backup/grupos/refresh", {
              method: "POST",
              body: JSON.stringify({ grupoId: btn.dataset.gid }),
            });
            state.grupos = [];
            await renderGrupos();
            await refreshStats();
          } finally {
            state.refreshingGrupoId = null;
            await renderGrupos();
          }
        } else if (act === "remove-from-group") {
          if (!confirm("Remover este backup do grupo?")) return;
          await api("/api/backup/grupos/remove-item", {
            method: "POST",
            body: JSON.stringify({ grupoId: btn.dataset.gid, itemId: btn.dataset.id }),
          });
          state.grupos = [];
          await loadBackups();
          await renderGrupos();
          await refreshStats();
        } else if (act === "robo") {
          const g = state.grupos.find((x) => x.docId === btn.dataset.gid);
          if (g) await loadRobo(g, true);
        } else if (act === "robo-save") {
          const produto = (state.roboOfertas || {})[String(btn.dataset.item || "")];
          if (!produto) return;
          const saved = await api("/api/backup", { method: "POST", body: JSON.stringify({ produto }) });
          await api("/api/backup/grupos/add", {
            method: "POST",
            body: JSON.stringify({ grupoId: btn.dataset.gid, itemId: produto.itemId }),
          });
          btn.textContent = "Vinculado";
          btn.disabled = true;
          state.grupos = [];
          state.roboCache = {};
          await loadBackups();
          await renderGrupos();
          await refreshStats();
          void saved;
        } else if (act === "del-group") {
          if (!confirm(`Remover o grupo "${btn.dataset.nome}"? Os produtos não serão deletados.`)) return;
          await api("/api/backup/grupos/delete", { method: "POST", body: JSON.stringify({ grupoId: btn.dataset.gid }) });
          state.grupos = [];
          await loadBackups();
          await renderGrupos();
          await refreshStats();
        }
      } catch (err) {
        alert(err.message || String(err));
      }
    });

    $$("#backup-garimpo-subtabs [data-garimpo-aba]").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.garimpoAba = btn.dataset.garimpoAba;
        renderGarimpo();
      });
    });
    $("#backup-garimpo-search")?.addEventListener("input", () => renderGarimpo());
    $("#backup-recompra-search")?.addEventListener("input", () => renderRecompra());

    $("#backup-garimpo-list")?.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-act=mine-save]");
      if (btn) salvarMineComoBackup(btn.dataset.id);
    });
    $("#backup-recompra-list")?.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-act=mine-save]");
      if (btn) salvarMineComoBackup(btn.dataset.id);
    });
  }

  async function mount() {
    wire();
    const cfg = loadCfg();
    const startTab = cfg.defaultGrupos ? "grupos" : (state.tab || "grupos");
    try {
      await Promise.all([loadBackups().catch(() => []), refreshStats()]);
    } catch (_) {}
    setTab(startTab);
  }

  global.BackupUI = { mount, setTab };
})(window);
