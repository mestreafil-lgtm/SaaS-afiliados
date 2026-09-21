"use strict";

const { normalizeSubId } = require("./normalizeSubId");
const { getSupabase } = require("./supabase");
const { requireUserId } = require("./auth");
const { fetchWithTimeout } = require("./httpUtil");
const { shopeeEndDate, brtSubtractDays } = require("./brtDates");

function maskToken(token) {
  const s = String(token || "");
  if (s.length <= 10) return s ? "••••••••" : "";
  return `${s.slice(0, 6)}…${s.slice(-4)}`;
}

function parseAccountIds(raw) {
  const ids = String(raw || "")
    .split(/[\s,;]+/)
    .flatMap((part) => {
      const digits = String(part || "").replace(/^act_/i, "").replace(/\D/g, "");
      // Meta ad account IDs; evita IDs "dobrados" tipo 123123 concatenados
      if (!digits || digits.length < 5) return [];
      if (digits.length % 2 === 0) {
        const half = digits.length / 2;
        const a = digits.slice(0, half);
        const b = digits.slice(half);
        if (a === b && a.length >= 5) return [a];
      }
      return [digits];
    })
    .filter(Boolean);
  return [...new Set(ids)];
}

function actId(id) {
  const d = String(id || "").replace(/^act_/i, "");
  return `act_${d}`;
}

async function loadMetaCredentials(userId = requireUserId()) {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("meta_credentials")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (data && (data.access_token || data.ad_account_ids)) {
    return {
      accessToken: String(data.access_token || "").trim(),
      adAccountIds: String(data.ad_account_ids || "").trim(),
      apiVersion: String(data.api_version || "v19.0").trim() || "v19.0",
      lastSyncAt: data.last_sync_at || null,
      lastSyncMeta: data.last_sync_meta || {},
    };
  }
  return {
    accessToken: "",
    adAccountIds: "",
    apiVersion: "v19.0",
    lastSyncAt: null,
    lastSyncMeta: {},
  };
}

async function saveMetaCredentials({ accessToken, adAccountIds, apiVersion }, userId = requireUserId()) {
  const prev = await loadMetaCredentials(userId);
  const next = {
    accessToken: accessToken != null && String(accessToken).trim()
      ? String(accessToken).trim()
      : prev.accessToken,
    adAccountIds: adAccountIds != null
      ? String(adAccountIds).trim()
      : prev.adAccountIds,
    apiVersion: (apiVersion && String(apiVersion).trim()) || prev.apiVersion || "v19.0",
  };
  if (!next.accessToken) throw new Error("META_ACCESS_TOKEN é obrigatório");

  // Se não informou contas, ou informou IDs sem acesso, resolve pelas contas do token
  const resolved = await resolveSyncAccountIds(next.accessToken, next.adAccountIds, next.apiVersion);
  if (!resolved.accountIds.length) {
    throw new Error("Informe ao menos um META_AD_ACCOUNT_ID acessível (ads_read) ou use um token com contas");
  }
  next.adAccountIds = resolved.accountIds.join(",");

  const supabase = getSupabase();
  const { error } = await supabase.from("meta_credentials").upsert({
    user_id: userId,
    access_token: next.accessToken,
    ad_account_ids: next.adAccountIds,
    api_version: next.apiVersion,
    updated_at: new Date().toISOString(),
  });
  if (error) throw new Error(error.message);

  return metaCredentialsPublic(userId);
}

async function metaCredentialsPublic(userId = requireUserId()) {
  const c = await loadMetaCredentials(userId);
  const ids = parseAccountIds(c.adAccountIds);
  return {
    configured: Boolean(c.accessToken && ids.length),
    tokenMasked: c.accessToken ? maskToken(c.accessToken) : "",
    adAccountIds: c.adAccountIds || "",
    accountsCount: ids.length,
    apiVersion: c.apiVersion || "v19.0",
    lastSyncAt: c.lastSyncAt,
    lastSyncMeta: c.lastSyncMeta || {},
  };
}

async function listAccessibleAdAccounts(token, apiVersion = "v19.0") {
  const ver = String(apiVersion || "v19.0").trim() || "v19.0";
  const out = [];
  let url = `https://graph.facebook.com/${ver}/me/adaccounts?fields=account_id,id,name,account_status&limit=100&access_token=${encodeURIComponent(token)}`;
  let pages = 0;
  while (url && pages < 10) {
    pages += 1;
    const res = await fetchWithTimeout(url, {}, 15000);
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.error) {
      throw new Error(json.error?.message || "Falha ao listar ad accounts do token");
    }
    for (const a of json.data || []) {
      const id = String(a.account_id || "").replace(/\D/g, "") || String(a.id || "").replace(/\D/g, "");
      if (id) out.push({ id, name: a.name || "", status: a.account_status });
    }
    url = json.paging?.next || null;
  }
  return out;
}

/** Intersecta IDs configurados com contas que o token realmente acessa. */
async function resolveSyncAccountIds(token, configuredRaw, apiVersion) {
  const configured = parseAccountIds(configuredRaw);
  let accessible = [];
  try {
    accessible = await listAccessibleAdAccounts(token, apiVersion);
  } catch (e) {
    // Sem listagem, tenta as configuradas (comportamento antigo)
    return { accountIds: configured, accessible: [], warning: e.message };
  }
  const accessSet = new Set(accessible.map((a) => a.id));
  const intersection = configured.filter((id) => accessSet.has(id));
  if (intersection.length) {
    const skipped = configured.filter((id) => !accessSet.has(id));
    return {
      accountIds: intersection,
      accessible,
      warning: skipped.length
        ? `Contas sem permissão no token ignoradas: ${skipped.join(", ")}`
        : null,
    };
  }
  // Nenhuma configurada é acessível → usa todas as do token
  const fallback = accessible.map((a) => a.id);
  return {
    accountIds: fallback,
    accessible,
    warning: configured.length
      ? `Nenhuma conta configurada é acessível; usando ${fallback.length} conta(s) do token`
      : null,
  };
}

async function metaFetchAll(url) {
  const out = [];
  let next = url;
  let pages = 0;
  while (next && pages < 200) {
    pages += 1;
    let res;
    let json = {};
    try {
      res = await fetchWithTimeout(next, {}, 15000);
      json = await res.json().catch(() => ({}));
    } catch (e) {
      throw new Error(`Meta fetch falhou: ${e.message || e}`);
    }
    if (!res.ok || json.error) {
      const code = json.error?.code;
      const msg = json.error?.message || JSON.stringify(json).slice(0, 200);
      // Rate limit / transient
      if ((code === 4 || code === 17 || code === 32 || /rate limit|too many/i.test(msg)) && pages < 200) {
        await new Promise((r) => setTimeout(r, 2000 * Math.min(pages, 5)));
        continue;
      }
      throw new Error(msg);
    }
    const data = Array.isArray(json.data) ? json.data : [];
    out.push(...data);
    next = json.paging?.next || null;
  }
  return out;
}

function rangeDaysBack(daysBack) {
  const days = Math.max(1, Math.min(90, Number(daysBack) || 7));
  const until = shopeeEndDate();
  const since = brtSubtractDays(days - 1, until);
  return { since, until, days };
}

async function testMetaCredentials() {
  const c = await loadMetaCredentials();
  return testMetaCredentialsPair(c);
}

/** Valida token + contas Meta sem sessão. */
async function testMetaCredentialsPair({ accessToken, adAccountIds, apiVersion } = {}) {
  const token = String(accessToken || "").trim();
  if (!token) throw new Error("Informe o META_ACCESS_TOKEN");
  const ver = String(apiVersion || "v19.0").trim() || "v19.0";
  if (!/^v\d+\.\d+$/.test(ver)) throw new Error("META_API_VERSION inválida (ex: v19.0)");

  const url = `https://graph.facebook.com/${ver}/me?fields=id,name&access_token=${encodeURIComponent(token)}`;
  const res = await fetchWithTimeout(url, {}, 15000);
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) {
    throw new Error(`Meta: ${json.error?.message || "token inválido ou sem permissão"}`);
  }

  const resolved = await resolveSyncAccountIds(token, adAccountIds, ver);
  const accounts = resolved.accountIds;
  if (!accounts.length) {
    throw new Error("Token OK, mas nenhuma ad account acessível (ads_read). Verifique permissões no Business Manager.");
  }

  let sampleSpend = null;
  let warning = resolved.warning || null;
  const params = new URLSearchParams({
    access_token: token,
    fields: "spend",
    date_preset: "yesterday",
    level: "account",
  });
  try {
    const insights = await metaFetchAll(
      `https://graph.facebook.com/${ver}/${actId(accounts[0])}/insights?${params}`,
    );
    sampleSpend = insights[0]?.spend ?? null;
  } catch (e) {
    warning = [warning, `Token OK, mas insights da conta ${accounts[0]}: ${e.message}`].filter(Boolean).join(" · ");
  }

  return {
    ok: true,
    user: { id: json.id, name: json.name },
    accounts: accounts.length,
    accountIds: accounts,
    accessibleAccounts: resolved.accessible,
    sampleSpend,
    warning,
  };
}

function resolveSyncRange({ daysBack, since, until } = {}) {
  if (since && until) {
    const s = String(since).slice(0, 10);
    const u = String(until).slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(s) && /^\d{4}-\d{2}-\d{2}$/.test(u) && s <= u) {
      const a = new Date(`${s}T15:00:00Z`).getTime();
      const b = new Date(`${u}T15:00:00Z`).getTime();
      const days = Math.max(1, Math.round((b - a) / 86400000) + 1);
      return { since: s, until: u, days: Math.min(90, days) };
    }
  }
  return rangeDaysBack(daysBack != null ? daysBack : 30);
}

function parseMetaInt(v) {
  const n = parseInt(String(v ?? "").replace(/[^\d]/g, ""), 10);
  return Number.isFinite(n) ? n : 0;
}

function rowCliquesAll(row) {
  // Meta "Clicks (all)" — fallback para link se a API zerar `clicks`
  const clicks = parseMetaInt(row.clicks);
  const link = parseMetaInt(row.inline_link_clicks);
  return clicks > 0 ? clicks : link;
}

function rowCliquesLink(row) {
  // Meta "Link clicks" = inline_link_clicks (coluna do Gerenciador)
  return parseMetaInt(row.inline_link_clicks);
}

/** SubID: anúncio → conjunto → campanha (muitas contas só colocam o SubID na campanha). */
function resolveSubIdFromMetaRow(row) {
  return (
    normalizeSubId(row?.ad_name || "")
    || normalizeSubId(row?.adset_name || "")
    || normalizeSubId(row?.campaign_name || "")
  );
}

async function fetchAdInsightsDaily({ token, apiVersion, accountId, since, until, withReach }) {
  // Campos alinhados ao runMetaDailySync do Afiliadoteste (+ inline_link_clicks como fallback)
  const fieldList = [
    "ad_id", "ad_name", "adset_name", "campaign_name",
    "spend", "impressions", "clicks", "inline_link_clicks", "ctr", "cpc",
    "date_start", "date_stop",
  ];
  if (withReach) fieldList.splice(8, 0, "reach");
  const params = new URLSearchParams({
    access_token: token,
    level: "ad",
    fields: fieldList.join(","),
    time_increment: "1",
    time_range: JSON.stringify({ since, until }),
    limit: "500",
  });
  const url = `https://graph.facebook.com/${apiVersion}/${actId(accountId)}/insights?${params}`;
  return metaFetchAll(url);
}

async function syncMetaDaily({ daysBack = 7, since, until } = {}, userId = requireUserId()) {
  const c = await loadMetaCredentials(userId);
  const token = c.accessToken;
  const apiVersion = c.apiVersion || "v19.0";
  if (!token) throw new Error("META_ACCESS_TOKEN não configurado");

  const resolved = await resolveSyncAccountIds(token, c.adAccountIds, apiVersion);
  const accountIds = resolved.accountIds;
  if (!accountIds.length) {
    throw new Error("META: nenhuma ad account acessível com ads_read neste token");
  }

  const range = resolveSyncRange({ daysBack, since, until });
  const { since: sinceDate, until: untilDate, days } = range;

  const rowsOut = [];
  const errors = [];
  const started = Date.now();
  if (resolved.warning) errors.push(resolved.warning);

  for (const accountId of accountIds) {
    let rows = [];
    try {
      try {
        rows = await fetchAdInsightsDaily({
          token, apiVersion, accountId, since: sinceDate, until: untilDate, withReach: true,
        });
      } catch (eReach) {
        // Alcance diário por anúncio às vezes quebra o insights — tenta sem reach
        rows = await fetchAdInsightsDaily({
          token, apiVersion, accountId, since: sinceDate, until: untilDate, withReach: false,
        });
        errors.push(`Conta ${accountId}: alcance indisponível no breakdown diário (${eReach.message || eReach})`);
      }
      for (const row of rows) {
        const adId = String(row.ad_id || "").trim();
        const date = String(row.date_start || "").trim();
        if (!adId || !date) continue;
        const impressoes = parseMetaInt(row.impressions);
        const cliques = rowCliquesAll(row);
        const cliques_link = rowCliquesLink(row);
        const gasto = Math.round((parseFloat(row.spend || 0) || 0) * 100) / 100;
        rowsOut.push({
          user_id: userId,
          ad_id: adId,
          data: date,
          ad_name: String(row.ad_name || ""),
          subid: resolveSubIdFromMetaRow(row),
          adset_name: String(row.adset_name || ""),
          campaign_name: String(row.campaign_name || ""),
          gasto,
          impressoes,
          alcance: parseMetaInt(row.reach),
          cliques,
          cliques_link,
          ctr: impressoes > 0
            ? Math.round((cliques / impressoes) * 1000000) / 10000
            : Math.round((parseFloat(row.ctr || 0) || 0) * 10000) / 10000,
          cpc: cliques > 0
            ? Math.round((gasto / cliques) * 100) / 100
            : Math.round((parseFloat(row.cpc || 0) || 0) * 100) / 100,
          account_id: String(accountId),
          updated_at: new Date().toISOString(),
        });
      }
    } catch (e) {
      errors.push(`Conta ${accountId}: ${e.message || e}`);
    }
  }

  const supabase = getSupabase();
  let gravados = 0;
  for (let i = 0; i < rowsOut.length; i += 200) {
    let chunk = rowsOut.slice(i, i + 200);
    let { error } = await supabase
      .from("meta_ads_daily")
      .upsert(chunk, { onConflict: "user_id,ad_id,data" });
    if (error && /cliques_link/i.test(error.message || "")) {
      chunk = chunk.map(({ cliques_link, ...rest }) => rest);
      ({ error } = await supabase
        .from("meta_ads_daily")
        .upsert(chunk, { onConflict: "user_id,ad_id,data" }));
      if (!error) console.warn("[meta] coluna cliques_link ausente — rode ensureDb / setup:db");
    }
    if (error) throw new Error(`meta_ads_daily: ${error.message}`);
    gravados += chunk.length;
  }

  const sumGasto = rowsOut.reduce((a, r) => a + Number(r.gasto || 0), 0);
  const sumCliques = rowsOut.reduce((a, r) => a + Number(r.cliques || 0), 0);
  const sumCliquesLink = rowsOut.reduce((a, r) => a + Number(r.cliques_link || 0), 0);
  const sumImpressoes = rowsOut.reduce((a, r) => a + Number(r.impressoes || 0), 0);
  if (sumGasto > 0 && sumCliques === 0 && sumImpressoes === 0) {
    errors.push(
      "API retornou gasto sem cliques/impressões — confira permissão ads_read no token ou sincronize de novo."
    );
  }
  if (!gravados && errors.length) {
    throw new Error(`Meta sync sem dados: ${errors.join(" · ")}`);
  }

  let classificados = { total: 0, classificados: 0 };
  try {
    classificados = await applyMetaSyncOps(userId);
  } catch (e) {
    errors.push(`Classificação canal="meta": ${e.message || e}`);
  }

  let statusSync = { total: 0, ativas: 0, desativadas: 0, atualizados: 0 };
  try {
    statusSync = await syncMetaAdStatuses({
      token,
      apiVersion,
      accountIds,
      userId,
    });
  } catch (e) {
    errors.push(`Sync status Meta: ${e.message || e}`);
  }

  const meta = {
    range: { since: sinceDate, until: untilDate, daysBack: days },
    contasUsadas: accountIds,
    linhas: rowsOut.length,
    gravados,
    totais: {
      gasto: Math.round(sumGasto * 100) / 100,
      cliques: sumCliques,
      cliques_link: sumCliquesLink,
      impressoes: sumImpressoes,
    },
    classificados,
    statusSync,
    erros: errors,
    elapsedMs: Date.now() - started,
  };

  // Persiste só contas acessíveis (evita re-tentar IDs sem permissão)
  const idsToStore = accountIds.join(",");
  await supabase.from("meta_credentials").upsert({
    user_id: userId,
    access_token: token,
    ad_account_ids: idsToStore || c.adAccountIds,
    api_version: apiVersion,
    last_sync_at: new Date().toISOString(),
    last_sync_meta: meta,
    updated_at: new Date().toISOString(),
  });

  return meta;
}

/**
 * Canal Meta não é mais auto-atribuído no sync — só pela UI de indefinidos.
 * Mantido como no-op p/ callers (import/sync) não quebrarem.
 */
async function applyMetaSyncOps(_userId = requireUserId()) {
  return { total: 0, classificados: 0 };
}

/** Lista anúncios da conta com status de entrega (effective_status). */
async function fetchAccountAdsStatus({ token, apiVersion, accountId }) {
  const params = new URLSearchParams({
    access_token: token,
    fields: "id,name,effective_status,status",
    limit: "500",
  });
  const url = `https://graph.facebook.com/${apiVersion}/${actId(accountId)}/ads?${params}`;
  return metaFetchAll(url);
}

/**
 * ACTIVE / em revisão → ativa. Pausado, arquivado, reprovado, etc. → desativada.
 */
function statusFromMetaEffective(raw) {
  const s = String(raw || "").trim().toUpperCase();
  if (!s) return null;
  const activeish = new Set([
    "ACTIVE",
    "PENDING_REVIEW",
    "PREAPPROVED",
    "PENDING_BILLING_INFO",
    "IN_PROCESS",
  ]);
  if (activeish.has(s)) return "ativa";
  return "desativada";
}

/**
 * Sincroniza status Ativa/Desativada em subid_ops a partir do effective_status da Meta.
 * Só grava quando a API devolve o anúncio (certeza). Não sobrescreve alteração manual do cliente.
 */
async function syncMetaAdStatuses({ token, apiVersion, accountIds, userId = requireUserId() }) {
  const bySub = new Map(); // subid lower → { subid, hasActive }

  for (const accountId of accountIds || []) {
    const ads = await fetchAccountAdsStatus({ token, apiVersion, accountId });
    for (const ad of ads || []) {
      const subid = normalizeSubId(ad.name || "");
      if (!subid) continue;
      const key = subid.toLowerCase();
      const mapped = statusFromMetaEffective(ad.effective_status || ad.status);
      if (!mapped) continue;
      const prev = bySub.get(key) || { subid, hasActive: false };
      if (mapped === "ativa") prev.hasActive = true;
      bySub.set(key, prev);
    }
  }

  if (!bySub.size) {
    return { total: 0, ativas: 0, desativadas: 0, atualizados: 0, preservadosManual: 0 };
  }

  const { loadSubidOps, upsertSubidOpsMany, isManualStatusLocked } = require("./subidOps");
  const prevMap = await loadSubidOps(userId);
  const toUpsert = [];
  let ativas = 0;
  let desativadas = 0;
  let preservadosManual = 0;

  for (const { subid, hasActive } of bySub.values()) {
    const status = hasActive ? "ativa" : "desativada";
    if (status === "ativa") ativas += 1;
    else desativadas += 1;

    const key = subid.toLowerCase();
    const hasOps = Object.prototype.hasOwnProperty.call(prevMap, key);
    const prev = hasOps ? prevMap[key] : {};
    if (isManualStatusLocked(prev)) {
      preservadosManual += 1;
      continue;
    }
    // Só atualiza status de quem JÁ é Meta — não cria/promove canal
    if (!hasOps || prev.canal !== "meta") continue;

    toUpsert.push({
      subid,
      status,
      status_source: "meta",
    });
  }

  if (toUpsert.length) await upsertSubidOpsMany(toUpsert, userId);

  return {
    total: bySub.size,
    ativas,
    desativadas,
    atualizados: toUpsert.length,
    preservadosManual,
  };
}

async function loadMetaSpendByDay(startDate, endDate, userId = requireUserId()) {
  const supabase = getSupabase();
  const pageSize = 1000;
  const maxPages = 20;
  const all = [];
  const colsWithLink = "data, subid, gasto, campaign_name, ad_name, ad_id, cliques, cliques_link, impressoes, alcance";
  const colsNoLink = "data, subid, gasto, campaign_name, ad_name, ad_id, cliques, impressoes, alcance";
  let selectCols = colsWithLink;
  for (let page = 0; page < maxPages; page++) {
    const from = page * pageSize;
    let { data, error } = await supabase
      .from("meta_ads_daily")
      .select(selectCols)
      .eq("user_id", userId)
      .gte("data", startDate)
      .lte("data", endDate)
      .range(from, from + pageSize - 1);
    if (error && /cliques_link/i.test(error.message || "") && selectCols === colsWithLink) {
      selectCols = colsNoLink;
      ({ data, error } = await supabase
        .from("meta_ads_daily")
        .select(selectCols)
        .eq("user_id", userId)
        .gte("data", startDate)
        .lte("data", endDate)
        .range(from, from + pageSize - 1));
    }
    if (error) throw new Error(error.message);
    if (!data || !data.length) break;
    all.push(...data);
    if (data.length < pageSize) break;
  }
  return all;
}

async function loadCampaigns(startDate, endDate, userId = requireUserId()) {
  const rows = await loadMetaSpendByDay(startDate, endDate, userId);
  const byCamp = {};
  for (const r of rows) {
    const key = r.campaign_name || "(sem campanha)";
    if (!byCamp[key]) byCamp[key] = { campaign: key, gasto: 0, ads: 0, cliques: 0, cliques_link: 0, impressoes: 0 };
    byCamp[key].gasto += Number(r.gasto || 0);
    byCamp[key].ads += 1;
    byCamp[key].cliques += Number(r.cliques || 0);
    byCamp[key].cliques_link += Number(r.cliques_link || 0);
    byCamp[key].impressoes += Number(r.impressoes || 0);
  }
  return Object.values(byCamp)
    .map((c) => ({ ...c, gasto: Math.round(c.gasto * 100) / 100 }))
    .sort((a, b) => b.gasto - a.gasto);
}

module.exports = {
  loadMetaCredentials,
  saveMetaCredentials,
  metaCredentialsPublic,
  testMetaCredentials,
  testMetaCredentialsPair,
  syncMetaDaily,
  applyMetaSyncOps,
  syncMetaAdStatuses,
  statusFromMetaEffective,
  loadMetaSpendByDay,
  loadCampaigns,
  parseAccountIds,
  maskToken,
};
