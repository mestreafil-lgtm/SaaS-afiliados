"use strict";

const { getSupabase } = require("./supabase");
const { requireUserId } = require("./auth");
const {
  loadDashboardFromDb,
  loadProducts,
  loadOrders,
  loadSettings,
  maskSecret,
  attachMtdKpis,
} = require("./store");
const { enrichDashboardWithAds } = require("./finance");
const { loadCampaigns } = require("./meta");
const { loadSubidOps } = require("./subidOps");
const { fetchWithTimeout } = require("./httpUtil");
const { shopeeEndDate, brtFirstDayOfMonth } = require("./brtDates");

const DEFAULT_MODEL = process.env.CLAUDE_MODEL?.trim() || "claude-sonnet-4-6";
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

/** Preços oficiais aproximados Claude Sonnet (USD / 1M tokens). Ajuste se mudar o modelo. */
const MODEL_RATES = {
  default: { inputPerMTok: 3, outputPerMTok: 15, label: "Sonnet" },
  "claude-sonnet-4-6": { inputPerMTok: 3, outputPerMTok: 15, label: "Sonnet 4.6" },
  "claude-sonnet-4-20250514": { inputPerMTok: 3, outputPerMTok: 15, label: "Sonnet 4" },
  "claude-3-5-sonnet-latest": { inputPerMTok: 3, outputPerMTok: 15, label: "Sonnet 3.5" },
  "claude-3-5-sonnet-20241022": { inputPerMTok: 3, outputPerMTok: 15, label: "Sonnet 3.5" },
  "claude-3-haiku-20240307": { inputPerMTok: 0.25, outputPerMTok: 1.25, label: "Haiku" },
  "claude-haiku-4-5-20251001": { inputPerMTok: 1, outputPerMTok: 5, label: "Haiku 4.5" },
};

function looksMasked(value) {
  const s = String(value || "");
  return !s || /[•…]/.test(s) || /^x+$/i.test(s);
}

function ratesForModel(model) {
  return MODEL_RATES[model] || MODEL_RATES.default;
}

function estimateCostUsd(usage, model) {
  const rates = ratesForModel(model);
  const input = Number(usage?.input_tokens || 0);
  const output = Number(usage?.output_tokens || 0);
  const cacheRead = Number(usage?.cache_read_input_tokens || 0);
  const cacheCreate = Number(usage?.cache_creation_input_tokens || 0);
  const inputUsd = (input / 1e6) * rates.inputPerMTok;
  const outputUsd = (output / 1e6) * rates.outputPerMTok;
  // cache read ~10% do input (Anthropic); create ~1.25x — aproximação
  const cacheUsd =
    (cacheRead / 1e6) * rates.inputPerMTok * 0.1 +
    (cacheCreate / 1e6) * rates.inputPerMTok * 1.25;
  const totalUsd = inputUsd + outputUsd + cacheUsd;
  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens: input + output,
    cacheReadTokens: cacheRead,
    cacheCreateTokens: cacheCreate,
    inputUsd: round4(inputUsd),
    outputUsd: round4(outputUsd),
    cacheUsd: round4(cacheUsd),
    totalUsd: round4(totalUsd),
    rates,
    modelLabel: rates.label,
  };
}

function round4(n) {
  return Math.round(Number(n || 0) * 10000) / 10000;
}

function round2(n) {
  return Math.round(Number(n || 0) * 100) / 100;
}

async function loadClaudeCredentials(userId = requireUserId()) {
  const envKey = String(process.env.CLAUDE_API_KEY || process.env.ANTHROPIC_API_KEY || "").trim();
  const envModel = String(process.env.CLAUDE_MODEL || "").trim() || DEFAULT_MODEL;

  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("app_settings")
    .select("claude_api_key, claude_model")
    .eq("user_id", userId)
    .maybeSingle();
  if (error && /claude_api_key|claude_model/i.test(error.message || "")) {
    return { apiKey: envKey, model: envModel };
  }
  if (error) throw new Error(error.message);
  const dbKey = String(data?.claude_api_key || "").trim();
  const dbModel = String(data?.claude_model || "").trim();
  return {
    apiKey: dbKey || envKey,
    model: dbModel || envModel || DEFAULT_MODEL,
  };
}

async function saveClaudeCredentials({ apiKey, model }, userId = requireUserId()) {
  const prev = await loadClaudeCredentials(userId);
  const nextKey = looksMasked(apiKey) ? prev.apiKey : String(apiKey || "").trim();
  if (!nextKey) throw new Error("Cole a API key da Anthropic (Claude)");

  const nextModel = (model && String(model).trim()) || prev.model || DEFAULT_MODEL;
  const supabase = getSupabase();
  const now = new Date().toISOString();

  const { data: existing } = await supabase
    .from("app_settings")
    .select("user_id")
    .eq("user_id", userId)
    .maybeSingle();

  let error;
  if (existing?.user_id) {
    ({ error } = await supabase
      .from("app_settings")
      .update({
        claude_api_key: nextKey,
        claude_model: nextModel,
        updated_at: now,
      })
      .eq("user_id", userId));
  } else {
    const settings = await loadSettings(userId);
    ({ error } = await supabase.from("app_settings").insert({
      user_id: userId,
      meta_base: settings.metaBase,
      tax_rate: settings.taxRate,
      meta_tax_rate: settings.metaTaxRate,
      meta_dias: settings.metaDias,
      meta_bonus_100: settings.metaBonus100,
      meta_bonus_125: settings.metaBonus125,
      meta_bonus_150: settings.metaBonus150,
      team_name: settings.teamName,
      team_plan: settings.teamPlan,
      claude_api_key: nextKey,
      claude_model: nextModel,
      updated_at: now,
    }));
    if (error && /(meta_tax_rate|meta_dias|meta_bonus_)/i.test(error.message || "")) {
      ({ error } = await supabase.from("app_settings").insert({
        user_id: userId,
        meta_base: settings.metaBase,
        tax_rate: settings.taxRate,
        team_name: settings.teamName,
        team_plan: settings.teamPlan,
        claude_api_key: nextKey,
        claude_model: nextModel,
        updated_at: now,
      }));
    }
  }

  if (error && /claude_api_key|claude_model/i.test(error.message || "")) {
    throw new Error(
      "Coluna Claude ainda não existe no Supabase. Rode npm run setup:db e tente de novo."
    );
  }
  if (error) throw new Error(error.message);
  return claudeCredentialsPublic(userId);
}

async function claudeCredentialsPublic(userId = requireUserId()) {
  const c = await loadClaudeCredentials(userId);
  const rates = ratesForModel(c.model || DEFAULT_MODEL);
  return {
    configured: Boolean(c.apiKey),
    apiKeyMasked: c.apiKey ? maskSecret(c.apiKey) : "",
    model: c.model || DEFAULT_MODEL,
    pricing: {
      inputPerMTokUsd: rates.inputPerMTok,
      outputPerMTokUsd: rates.outputPerMTok,
      label: rates.label,
    },
  };
}

function pickSubSummary(s) {
  return {
    subid: s.subid,
    canal: s.canal || "indefinido",
    status: s.status || null,
    faturamento: round2(s.faturamento),
    comissao: round2(s.comissao),
    pedidos: Number(s.pedidos || 0),
    invest: round2(s.inv_total),
    investMeta: round2(s.inv_meta),
    investPin: round2(s.inv_pin),
    lucro: round2(s.lucro),
    roi: s.roi != null && Number.isFinite(Number(s.roi)) ? Number(s.roi) : null,
    cliquesMeta: s.cliques_meta != null ? Number(s.cliques_meta) : null,
    cliquesPin: s.cliques_pin != null ? Number(s.cliques_pin) : null,
    cliquesShopee: s.cliques_shopee != null ? Number(s.cliques_shopee) : null,
    cpcMeta: s.cpc_meta != null ? Number(s.cpc_meta) : null,
    ctrMeta: s.ctr_meta != null ? Number(s.ctr_meta) : null,
  };
}

async function safeSelect(table, build) {
  try {
    const supabase = getSupabase();
    let q = supabase.from(table).select("*");
    q = build(q);
    const { data, error } = await q;
    if (error) throw error;
    return data || [];
  } catch (e) {
    console.warn(`[claude] ${table}:`, e.message || e);
    return [];
  }
}

async function countRows(table, userId, extra) {
  try {
    const supabase = getSupabase();
    let q = supabase.from(table).select("*", { count: "exact", head: true }).eq("user_id", userId);
    if (extra) q = extra(q);
    const { count, error } = await q;
    if (error) throw error;
    return Number(count || 0);
  } catch (_) {
    return 0;
  }
}

function aggregateOrders(orders) {
  const byStatus = {};
  const bySub = {};
  for (const o of orders || []) {
    const st = String(o.status || "outro");
    if (!byStatus[st]) byStatus[st] = { status: st, qtd: 0, faturamento: 0, comissao: 0 };
    byStatus[st].qtd += 1;
    byStatus[st].faturamento += Number(o.faturamento || 0);
    byStatus[st].comissao += Number(o.comissao || 0);

    const sub = String(o.subid || "organico");
    if (!bySub[sub]) bySub[sub] = { subid: sub, qtd: 0, faturamento: 0, comissao: 0 };
    bySub[sub].qtd += 1;
    bySub[sub].faturamento += Number(o.faturamento || 0);
    bySub[sub].comissao += Number(o.comissao || 0);
  }
  const roundAgg = (arr) =>
    arr.map((r) => ({
      ...r,
      faturamento: round2(r.faturamento),
      comissao: round2(r.comissao),
    }));
  return {
    total: (orders || []).length,
    porStatus: roundAgg(Object.values(byStatus).sort((a, b) => b.qtd - a.qtd)),
    porSubIdTop: roundAgg(Object.values(bySub).sort((a, b) => b.comissao - a.comissao).slice(0, 40)),
  };
}

function aggregateMetaAds(rows) {
  const byCamp = {};
  const byAdset = {};
  let gasto = 0;
  let cliques = 0;
  let impressoes = 0;
  for (const r of rows || []) {
    const g = Number(r.gasto || 0);
    const c = Number(r.cliques || 0);
    const i = Number(r.impressoes || 0);
    gasto += g;
    cliques += c;
    impressoes += i;
    const camp = r.campaign_name || "(sem campanha)";
    if (!byCamp[camp]) byCamp[camp] = { campaign: camp, gasto: 0, cliques: 0, impressoes: 0, ads: 0 };
    byCamp[camp].gasto += g;
    byCamp[camp].cliques += c;
    byCamp[camp].impressoes += i;
    byCamp[camp].ads += 1;

    const adset = r.adset_name || "(sem adset)";
    const key = `${camp}||${adset}`;
    if (!byAdset[key]) byAdset[key] = { campaign: camp, adset, gasto: 0, cliques: 0, impressoes: 0 };
    byAdset[key].gasto += g;
    byAdset[key].cliques += c;
    byAdset[key].impressoes += i;
  }
  const fmt = (arr, lim) =>
    arr
      .map((x) => ({
        ...x,
        gasto: round2(x.gasto),
      }))
      .sort((a, b) => b.gasto - a.gasto)
      .slice(0, lim);
  return {
    totais: { gasto: round2(gasto), cliques, impressoes, linhas: (rows || []).length },
    porCampanha: fmt(Object.values(byCamp), 60),
    porAdset: fmt(Object.values(byAdset), 40),
  };
}

function aggregatePin(rows) {
  const bySub = {};
  let gasto = 0;
  let cliques = 0;
  for (const r of rows || []) {
    const g = Number(r.gasto || 0);
    const c = Number(r.cliques || 0);
    gasto += g;
    cliques += c;
    const sub = String(r.subid || "semsubid");
    if (!bySub[sub]) bySub[sub] = { subid: sub, gasto: 0, cliques: 0 };
    bySub[sub].gasto += g;
    bySub[sub].cliques += c;
  }
  return {
    totais: { gasto: round2(gasto), cliques, linhas: (rows || []).length },
    porSubId: Object.values(bySub)
      .map((x) => ({ ...x, gasto: round2(x.gasto) }))
      .sort((a, b) => b.gasto - a.gasto)
      .slice(0, 40),
  };
}

async function buildAnalyticsContext(startDate, endDate, userId = requireUserId()) {
  let dash = await loadDashboardFromDb(startDate, endDate, userId);
  if (dash) {
    try {
      dash = await enrichDashboardWithAds(dash, userId, { persistSubIds: false });
    } catch (e) {
      console.warn("[claude] enrich:", e.message || e);
    }
    try {
      dash = await attachMtdKpis(dash, userId);
    } catch (_) { /* keep */ }
  }

  const settings = await loadSettings(userId);
  const opsMap = await loadSubidOps(userId);

  const [
    products,
    orders,
    metaRows,
    pinRows,
    backups,
    backupGrupos,
    syncRuns,
    counts,
  ] = await Promise.all([
    loadProducts({ limit: 80 }, userId).catch(() => []),
    loadOrders({ startDate, endDate, limit: 400, columns: "subid, data, status, faturamento, comissao" }, userId).catch(() => []),
    safeSelect("meta_ads_daily", (q) =>
      q.eq("user_id", userId).gte("data", startDate).lte("data", endDate).limit(400)
    ),
    safeSelect("pinterest_ads_daily", (q) =>
      q.eq("user_id", userId).gte("data", startDate).lte("data", endDate).limit(400)
    ),
    safeSelect("product_backups", (q) => q.eq("user_id", userId).limit(150)),
    safeSelect("product_backup_grupos", (q) => q.eq("user_id", userId).limit(80)),
    safeSelect("sync_runs", (q) =>
      q.eq("user_id", userId).order("synced_at", { ascending: false }).limit(8)
    ),
    Promise.all([
      countRows("daily_metrics", userId),
      countRows("subid_metrics", userId),
      countRows("orders", userId),
      countRows("products", userId),
      countRows("meta_ads_daily", userId),
      countRows("pinterest_ads_daily", userId),
      countRows("product_backups", userId),
      countRows("subid_ops", userId),
    ]).then(([daily, subids, ordersC, productsC, meta, pin, backupsC, ops]) => ({
      daily_metrics: daily,
      subid_metrics: subids,
      orders: ordersC,
      products: productsC,
      meta_ads_daily: meta,
      pinterest_ads_daily: pin,
      product_backups: backupsC,
      subid_ops: ops,
    })),
  ]);

  let campaigns = [];
  try {
    campaigns = await loadCampaigns(startDate, endDate, userId);
  } catch (_) { /* keep */ }

  // Aplica canal/status das ops em todos os SubIDs
  const subs = (dash?.subIds || []).map((s) => {
    const op = opsMap[String(s.subid || "").toLowerCase()] || {};
    return pickSubSummary({
      ...s,
      canal: s.canal || op.canal || null,
      status: s.status || op.status || null,
    });
  });

  const withInvest = subs.filter((s) => Number(s.invest) > 0 && s.roi != null);
  const worstRoi = [...withInvest].sort((a, b) => (a.roi ?? 0) - (b.roi ?? 0)).slice(0, 25);
  const bestRoi = [...withInvest].sort((a, b) => (b.roi ?? 0) - (a.roi ?? 0)).slice(0, 20);
  const zeroRoiSpend = subs
    .filter((s) => Number(s.invest) > 0 && (s.roi == null || s.roi <= 0 || Number(s.pedidos) === 0))
    .sort((a, b) => b.invest - a.invest)
    .slice(0, 25);

  const daily = (dash?.daily || []).map((d) => ({
    data: d.data,
    faturamento: round2(d.faturamento),
    comissao: round2(d.comissao),
    invest: round2(d.inv_total),
    investMeta: round2(d.inv_meta),
    investPin: round2(d.inv_pin),
    lucro: round2(d.lucro),
    roi: d.roi != null ? Number(d.roi) : null,
    pedidos: Number(d.pedidos || 0),
    cancelados: Number(d.cancelados || 0),
  }));

  const metaBase = Number(settings.metaBase || 0);
  const fatMtd = Number(dash?.kpis?.faturamentoMtd ?? dash?.kpis?.faturamento ?? 0);
  const metaPct = metaBase > 0 ? Math.round((fatMtd / metaBase) * 10000) / 100 : null;

  const ordersAgg = aggregateOrders(orders);
  const metaAgg = aggregateMetaAds(metaRows);
  const pinAgg = aggregatePin(pinRows);

  const opsList = Object.entries(opsMap).map(([subid, v]) => ({
    subid,
    canal: v.canal,
    status: v.status,
    produto: v.produto,
  }));

  const context = {
    periodo: { inicio: startDate, fim: endDate },
    equipe: { nome: settings.teamName, plano: settings.teamPlan },
    impostos: { comissaoPct: settings.taxRate, metaInvestPct: settings.metaTaxRate },
    metas: {
      meta100: metaBase,
      faturamentoMtd: fatMtd,
      progressoPct: metaPct,
      bonusPct: {
        meta100: settings.metaBonus100,
        meta125: settings.metaBonus125,
        meta150: settings.metaBonus150,
      },
    },
    kpisPeriodo: dash?.kpis || null,
    tendenciaDiaria: daily,
    // TODOS os SubIDs do snapshot (banco do usuário)
    todosSubIds: subs.length > 80
      ? [...worstRoi, ...bestRoi, ...zeroRoiSpend]
        .filter((s, i, arr) => arr.findIndex((x) => x.subid === s.subid) === i)
        .slice(0, 80)
      : subs,
    destaques: {
      piorRoi: worstRoi,
      melhorRoi: bestRoi,
      gastoSemRetorno: zeroRoiSpend,
    },
    campanhasMetaPorGasto: (campaigns || []).slice(0, 40),
    metaAdsAgregado: metaAgg,
    pinterestAgregado: pinAgg,
    pedidosResumo: ordersAgg,
    todosProdutos: (products || []).map((p) => ({
      nome: p.item_name || p.nome || p.name || null,
      itemId: p.item_id || p.itemId || null,
      loja: p.shop_name || p.loja || null,
      faturamento: round2(p.faturamento),
      comissao: round2(p.comissao),
      pedidos: Number(p.pedidos || 0),
      qty: Number(p.qty || 0),
    })),
    classificacaoSubIds: opsList.slice(0, 80),
    backups: {
      produtos: (backups || []).map((b) => ({
        itemId: b.item_id,
        nome: b.nome || b.apelido || null,
        loja: b.loja || null,
        comissaoPct: Number(b.comissao_pct || 0),
        statusApi: b.status_api || null,
        marcadoPrincipal: Boolean(b.marcado_principal),
      })),
      grupos: (backupGrupos || []).map((g) => ({
        nome: g.nome,
        principal: g.principal_item_id,
        backups: Array.isArray(g.backup_item_ids) ? g.backup_item_ids.length : 0,
      })),
    },
    ultimosSyncs: (syncRuns || []).map((r) => ({
      inicio: r.start_date,
      fim: r.end_date,
      nodes: r.nodes,
      syncedAt: r.synced_at,
    })),
    sincronizadoEm: dash?.syncedAt || null,
    coberturaBanco: {
      contagensTotaisNoSupabase: counts,
      noContextoDestaMsg: {
        subIds: subs.length,
        dias: daily.length,
        produtos: (products || []).length,
        pedidosPeriodo: ordersAgg.total,
        linhasMetaAds: metaAgg.totais.linhas,
        linhasPinterest: pinAgg.totais.linhas,
        campanhas: (campaigns || []).length,
        backups: (backups || []).length,
        opsSubIds: opsList.length,
      },
    },
    totalSubIds: subs.length,
  };

  const json = JSON.stringify(context);
  context._meta = {
    chars: json.length,
    approxTokens: Math.ceil(json.length / 4),
  };

  return context;
}

function systemPrompt(context) {
  const { _meta, ...payload } = context;
  return `Você é o analista de performance do painel Metricly (afiliados Shopee + Meta Ads + Pinterest + Backup).
Responda sempre em português do Brasil, de forma direta, útil e acionável.
Você recebeu um dump analítico do Supabase do usuário (métricas, TODOS os SubIDs, produtos, pedidos agregados, Meta Ads, Pinterest, backups e classificação de canais).
Use APENAS esses dados. Se algo não estiver no JSON, diga o que falta sincronizar.
ROI = lucro / investimento × 100. Lucro já considera impostos configurados.
Foque em SubIDs/campanhas com ROI ruim, escala de vencedores, gasto sem venda e progresso de meta.
Quando citar números, use R$ e % no formato brasileiro.
Não invente campanhas ou SubIDs ausentes no contexto.
Tamanho aproximado do contexto: ${_meta?.approxTokens || "?"} tokens de dados.

CONTEXTO_JSON:
${JSON.stringify(payload)}`;
}

async function callAnthropic({ apiKey, model, system, messages }) {
  const res = await fetchWithTimeout(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: model || DEFAULT_MODEL,
      max_tokens: 2500,
      system,
      messages,
    }),
  }, 20000);
  const raw = await res.text();
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`Claude respondeu inválido (${res.status})`);
  }
  if (!res.ok) {
    const msg = data?.error?.message || data?.message || raw.slice(0, 200);
    throw new Error(`Claude API: ${msg}`);
  }
  const text = (data.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
  if (!text) throw new Error("Claude não retornou texto");
  return {
    reply: text,
    model: data.model || model,
    usage: data.usage || null,
  };
}

async function testClaudeCredentials(userId = requireUserId()) {
  const c = await loadClaudeCredentials(userId);
  if (!c.apiKey) throw new Error("Configure a API key do Claude em Configurações → Conexões");
  const out = await callAnthropic({
    apiKey: c.apiKey,
    model: c.model,
    system: "Responda só com a palavra OK.",
    messages: [{ role: "user", content: "ping" }],
  });
  const cost = estimateCostUsd(out.usage, out.model || c.model);
  return { ok: true, model: out.model, preview: out.reply.slice(0, 80), usage: out.usage, cost };
}

async function chatClaude({ message, history, startDate, endDate }, userId = requireUserId()) {
  const text = String(message || "").trim();
  if (!text) throw new Error("Digite uma pergunta");
  if (text.length > 4000) throw new Error("Mensagem muito longa");

  const c = await loadClaudeCredentials(userId);
  if (!c.apiKey) {
    throw new Error("Configure a API key do Claude em Configurações → Conexões");
  }

  const start = startDate || defaultMonthStart();
  const end = endDate || todayISO();
  const context = await buildAnalyticsContext(start, end, userId);

  const prior = Array.isArray(history) ? history : [];
  const messages = [];
  for (const m of prior.slice(-10)) {
    const role = m.role === "assistant" ? "assistant" : "user";
    const content = String(m.content || "").trim();
    if (!content) continue;
    messages.push({ role, content: content.slice(0, 4000) });
  }
  messages.push({ role: "user", content: text });

  const system = systemPrompt(context);
  const out = await callAnthropic({
    apiKey: c.apiKey,
    model: c.model,
    system,
    messages,
  });

  const cost = estimateCostUsd(out.usage, out.model || c.model);
  const cobertura = context.coberturaBanco?.noContextoDestaMsg || {};

  return {
    reply: out.reply,
    model: out.model,
    usage: out.usage,
    cost,
    period: { startDate: start, endDate: end },
    contextMeta: {
      totalSubIds: context.totalSubIds,
      hasKpis: Boolean(context.kpisPeriodo),
      campaigns: (context.campanhasMetaPorGasto || []).length,
      products: cobertura.produtos || 0,
      orders: cobertura.pedidosPeriodo || 0,
      metaAdsRows: cobertura.linhasMetaAds || 0,
      pinRows: cobertura.linhasPinterest || 0,
      backups: cobertura.backups || 0,
      days: cobertura.dias || 0,
      contextChars: context._meta?.chars || 0,
      contextApproxTokens: context._meta?.approxTokens || 0,
      banco: context.coberturaBanco?.contagensTotaisNoSupabase || {},
    },
  };
}

function todayISO() {
  return shopeeEndDate();
}

function defaultMonthStart() {
  return brtFirstDayOfMonth();
}

/**
 * Compara visualmente o produto principal com derivadas candidatas (fotos por URL).
 * Usa Haiku por padrão (custo baixo). Retorna [{ itemId, nota (0-10), motivo }].
 */
async function compararDerivadasComIA({ principal, candidatos, model = "claude-haiku-5-5" } = {}, userId = requireUserId()) {
  const cred = await loadClaudeCredentials(userId);
  if (!cred.apiKey) throw new Error("Configure a chave da API Claude em Configurações para usar a comparação com IA.");
  const lista = (candidatos || []).filter((c) => c.imagem && c.itemId).slice(0, 12);
  if (!principal?.imagem || !lista.length) return [];

  const content = [
    {
      type: "text",
      text: "A primeira foto é o PRODUTO PRINCIPAL. As fotos seguintes são CANDIDATOS, cada uma precedida pelo seu itemId. "
        + "Para cada candidato, dê uma nota de 0 a 10 de semelhança de PEÇA (modelagem, cintura, tecido e estilo), ignorando cor e fundo. "
        + "Responda somente JSON no formato [{\"itemId\":\"...\",\"nota\":0,\"motivo\":\"frase curta\"}].",
    },
    { type: "text", text: "PRINCIPAL" },
    { type: "image", source: { type: "url", url: principal.imagem } },
  ];
  for (const c of lista) {
    content.push({ type: "text", text: `CANDIDATO itemId=${c.itemId}` });
    content.push({ type: "image", source: { type: "url", url: c.imagem } });
  }

  const out = await callAnthropic({
    apiKey: cred.apiKey,
    model,
    system: "Você compara fotos de produtos de moda para um afiliado. Responda apenas JSON válido.",
    messages: [{ role: "user", content }],
  });
  const ini = out.reply.indexOf("[");
  const fim = out.reply.lastIndexOf("]");
  if (ini < 0 || fim < ini) throw new Error("A IA não devolveu uma lista válida.");
  const parsed = JSON.parse(out.reply.slice(ini, fim + 1));
  return parsed
    .filter((x) => x && x.itemId)
    .map((x) => ({
      itemId: String(x.itemId),
      nota: Math.max(0, Math.min(10, Number(x.nota) || 0)),
      motivo: String(x.motivo || "").slice(0, 160),
    }));
}

module.exports = {
  loadClaudeCredentials,
  saveClaudeCredentials,
  claudeCredentialsPublic,
  testClaudeCredentials,
  chatClaude,
  buildAnalyticsContext,
  estimateCostUsd,
  compararDerivadasComIA,
  DEFAULT_MODEL,
};
