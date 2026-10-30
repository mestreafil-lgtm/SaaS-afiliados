"use strict";

const { getSupabase } = require("./supabase");
const { requireUserId, requestCached, invalidateRequestCache } = require("./auth");
const { brtTodayISO, brtFirstDayOfMonth, shopeeEndDate, brtSubtractDays } = require("./brtDates");
const { normalizeShopeeSubId } = require("./normalizeSubId");

function maskSecret(secret) {
  const s = String(secret || "");
  if (s.length <= 8) return "••••••••";
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
}

async function loadCredentials(userId = requireUserId()) {
  return requestCached(`loadCredentials:${userId}`, async () => {
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from("app_credentials")
      .select("app_id, secret, updated_at")
      .eq("user_id", userId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (data?.app_id && data?.secret) {
      return {
        appId: String(data.app_id).trim(),
        secret: String(data.secret).trim(),
        updatedAt: data.updated_at || null,
      };
    }
    return { appId: "", secret: "", updatedAt: null };
  });
}

async function resetAllSyncedData(userId = requireUserId()) {
  const supabase = getSupabase();
  const { error: rpcErr } = await supabase.rpc("reset_shopee_data_for_user", { p_user_id: userId });
  if (!rpcErr) return;
  await supabase.from("sync_runs").delete().eq("user_id", userId);
  await supabase.from("daily_metrics").delete().eq("user_id", userId);
  await supabase.from("subid_metrics").delete().eq("user_id", userId);
  await supabase.from("order_items").delete().eq("user_id", userId);
  await supabase.from("orders").delete().eq("user_id", userId);
  await supabase.from("products").delete().eq("user_id", userId);
}

async function saveCredentials({ appId, secret }, userId = requireUserId()) {
  const payload = {
    appId: String(appId || "").trim(),
    secret: String(secret || "").trim(),
  };
  if (!payload.appId || !payload.secret) {
    throw new Error("APP_ID e SECRET são obrigatórios");
  }

  const prev = await loadCredentials(userId);
  const appChanged = prev.appId && prev.appId !== payload.appId;

  const supabase = getSupabase();
  const { error } = await supabase.from("app_credentials").upsert({
    user_id: userId,
    app_id: payload.appId,
    secret: payload.secret,
    updated_at: new Date().toISOString(),
  });
  if (error) throw new Error(error.message);

  let reset = false;
  if (appChanged) {
    await resetAllSyncedData(userId);
    reset = true;
  }

  return {
    appId: payload.appId,
    secretMasked: maskSecret(payload.secret),
    updatedAt: new Date().toISOString(),
    configured: true,
    reset,
  };
}

async function credentialsPublic(userId = requireUserId()) {
  const c = await loadCredentials(userId);
  return {
    configured: Boolean(c.appId && c.secret),
    appId: c.appId || "",
    secretMasked: c.secret ? maskSecret(c.secret) : "",
    updatedAt: c.updatedAt,
  };
}

async function saveDashboardSnapshot(dash, userId = requireUserId(), { persistSubIds = true } = {}) {
  const supabase = getSupabase();
  const now = new Date().toISOString();

  const dailyRows = (dash.daily || []).map((d) => ({
    user_id: userId,
    data: d.data,
    faturamento: d.faturamento,
    comissao: d.comissao,
    pedidos: d.pedidos,
    concluidos: d.concluidos,
    pendentes: d.pendentes,
    cancelados: d.cancelados,
    unpaid: d.unpaid,
    inv_meta: d.inv_meta || 0,
    inv_pin: d.inv_pin || 0,
    inv_total: d.inv_total || 0,
    lucro: d.lucro != null ? d.lucro : d.comissao || 0,
    roi: d.roi != null ? d.roi : 0,
    updated_at: now,
  }));
  if (dailyRows.length) {
    const { error } = await supabase
      .from("daily_metrics")
      .upsert(dailyRows, { onConflict: "user_id,data" });
    if (error) throw new Error(`daily_metrics: ${error.message}`);
  }

  // Sync automático (janela curta) não pode apagar o snapshot de SubIDs do mês.
  if (persistSubIds) {
    const subRows = (dash.subIds || []).map((r) => ({
      user_id: userId,
      subid: r.subid,
      faturamento: r.faturamento,
      comissao: r.comissao,
      pedidos: r.pedidos,
      concluidos: r.concluidos,
      pendentes: r.pendentes,
      cancelados: r.cancelados,
      unpaid: r.unpaid || 0,
      itens: r.itens || 0,
      abatimento: r.abatimento || 0,
      cliques_shopee: r.cliques_shopee != null ? Number(r.cliques_shopee) : 0,
      inv_meta: r.inv_meta || 0,
      inv_pin: r.inv_pin || 0,
      inv_total: r.inv_total || 0,
      lucro: r.lucro != null ? r.lucro : r.comissao || 0,
      roi: r.roi != null ? r.roi : 0,
      updated_at: now,
    }));

    async function upsertSubChunks(rows) {
      for (let i = 0; i < rows.length; i += 200) {
        let chunk = rows.slice(i, i + 200);
        let { error } = await supabase.from("subid_metrics").upsert(chunk);
        if (error && /unpaid/i.test(error.message || "")) {
          chunk = chunk.map(({ unpaid, ...rest }) => rest);
          ({ error } = await supabase.from("subid_metrics").upsert(chunk));
        }
        if (error && /cliques_shopee/i.test(error.message || "")) {
          chunk = chunk.map(({ cliques_shopee, ...rest }) => rest);
          ({ error } = await supabase.from("subid_metrics").upsert(chunk));
          if (!error) {
            console.warn("[store] coluna cliques_shopee ausente — rode npm run setup:db");
          }
        }
        if (error) throw new Error(`subid_metrics: ${error.message}`);
      }
    }

    // Grava antes de apagar o snapshot antigo — evita tabela vazia se o upsert falhar.
    if (subRows.length) {
      await upsertSubChunks(subRows);
      const keep = new Set(subRows.map((r) => String(r.subid)));
      const { data: existing, error: listErr } = await supabase
        .from("subid_metrics")
        .select("subid")
        .eq("user_id", userId);
      if (listErr) throw new Error(`subid_metrics list: ${listErr.message}`);
      const stale = (existing || []).map((r) => r.subid).filter((id) => !keep.has(String(id)));
      for (let i = 0; i < stale.length; i += 200) {
        const chunk = stale.slice(i, i + 200);
        const { error } = await supabase
          .from("subid_metrics")
          .delete()
          .eq("user_id", userId)
          .in("subid", chunk);
        if (error) throw new Error(`subid_metrics prune: ${error.message}`);
      }
    }
  }

  const { error: runErr } = await supabase.from("sync_runs").insert({
    user_id: userId,
    start_date: dash.range?.startDate,
    end_date: dash.range?.endDate,
    nodes: dash.nodes || 0,
    pages: dash.pages || 0,
    kpis: dash.kpis || {},
    synced_at: dash.syncedAt || now,
  });
  if (runErr) throw new Error(`sync_runs: ${runErr.message}`);
}

async function persistOrdersAndProducts({ orders, orderItems, products }, userId = requireUserId()) {
  const supabase = getSupabase();
  const now = new Date().toISOString();

  function dedupeBy(rows, keyFn) {
    const map = new Map();
    for (const row of rows || []) {
      const k = keyFn(row);
      if (!k) continue;
      map.set(k, row);
    }
    return [...map.values()];
  }

  const ordersUnique = dedupeBy(orders, (o) => String(o.order_id || ""));
  const itemsUnique = dedupeBy(orderItems, (o) => String(o.id || `${o.order_id}_${o.item_id}`));
  const productsUnique = dedupeBy(products, (p) => String(p.item_id || ""));

  if (ordersUnique.length) {
    for (let i = 0; i < ordersUnique.length; i += 200) {
      const chunk = ordersUnique.slice(i, i + 200).map((o) => ({ ...o, user_id: userId, updated_at: now }));
      const { error } = await supabase.from("orders").upsert(chunk);
      if (error) throw new Error(`orders: ${error.message}`);
    }
  }
  if (itemsUnique.length) {
    for (let i = 0; i < itemsUnique.length; i += 200) {
      const chunk = itemsUnique.slice(i, i + 200).map((o) => ({ ...o, user_id: userId, updated_at: now }));
      const { error } = await supabase.from("order_items").upsert(chunk);
      if (error) throw new Error(`order_items: ${error.message}`);
    }
  }
  if (productsUnique.length) {
    for (let i = 0; i < productsUnique.length; i += 200) {
      const chunk = productsUnique.slice(i, i + 200).map((p) => ({ ...p, user_id: userId, updated_at: now }));
      const { error } = await supabase.from("products").upsert(chunk);
      if (error) throw new Error(`products: ${error.message}`);
    }
  }
}

async function pagedSelect(makeQuery, { pageSize = 1000, max = 5000 } = {}) {
  const all = [];
  // PostgREST/Supabase devolve no máximo ~1000 linhas por request.
  // pageSize > isso fazia parar no 1º lote (length < pageSize).
  const size = Math.min(1000, Math.max(1, Number(pageSize) || 1000));
  for (let from = 0; from < max; from += size) {
    const { data, error } = await makeQuery(from, from + size - 1);
    if (error) throw new Error(error.message);
    const rows = data || [];
    all.push(...rows);
    if (rows.length < size) break;
  }
  return all;
}

const SUBID_METRIC_COLS = [
  "subid", "faturamento", "comissao", "pedidos", "concluidos", "pendentes", "cancelados",
  "unpaid", "itens", "abatimento", "cliques_shopee", "inv_meta", "inv_pin", "inv_total",
  "lucro", "roi", "cliques_meta", "cliques_pin", "impressoes", "alcance", "ctr_meta",
  "cpc_meta", "abatimento_cliques",
].join(",");

async function loadDashboardFromDb(startDate, endDate, userId = requireUserId()) {
  const supabase = getSupabase();

  const dailyPromise = supabase
    .from("daily_metrics")
    .select("data, faturamento, comissao, pedidos, concluidos, pendentes, cancelados, unpaid, inv_meta, inv_pin, inv_total, lucro, roi")
    .eq("user_id", userId)
    .gte("data", startDate)
    .lte("data", endDate)
    .order("data", { ascending: true });

  const subIdsPromise = pagedSelect(
    (from, to) => supabase
      .from("subid_metrics")
      .select(SUBID_METRIC_COLS)
      .eq("user_id", userId)
      .order("comissao", { ascending: false })
      .range(from, to),
  ).catch(async (e) => {
    const fallback = await pagedSelect(
      (from, to) => supabase
        .from("subid_metrics")
        .select("*")
        .eq("user_id", userId)
        .order("comissao", { ascending: false })
        .range(from, to),
    );
    if (!String(e.message || "").includes("column")) console.warn("[store] subid cols:", e.message);
    return fallback;
  });

  const lastRunPromise = supabase
    .from("sync_runs")
    .select("*")
    .eq("user_id", userId)
    .order("synced_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const mtdPromise = loadFaturamentoMtd(userId).catch((e) => { console.warn("[store] mtd:", e.message); return null; });
  const avg7Promise = loadFaturamentoAvgDays(7, userId).catch((e) => { console.warn("[store] avg7:", e.message); return null; });

  const [dailyRes, subIds, lastRunRes, mtdRes, avg7Res] = await Promise.all([
    dailyPromise, subIdsPromise, lastRunPromise, mtdPromise, avg7Promise,
  ]);

  if (dailyRes?.error) throw new Error(dailyRes.error.message);
  const daily = dailyRes?.data || [];
  const lastRun = lastRunRes?.data || null;

  if ((!daily || !daily.length) && (!subIds || !subIds.length)) return null;

  const kpis = {
    faturamento: 0, comissao: 0, pedidos: 0, concluidos: 0, pendentes: 0,
    cancelados: 0, unpaid: 0, inv_meta: 0, inv_pin: 0, inv_total: 0, lucro: 0,
    roi: null, abatimento: 0, subIdsCount: (subIds || []).length,
  };
  for (const d of daily || []) {
    kpis.faturamento += Number(d.faturamento || 0);
    kpis.comissao += Number(d.comissao || 0);
    kpis.pedidos += Number(d.pedidos || 0);
    kpis.concluidos += Number(d.concluidos || 0);
    kpis.pendentes += Number(d.pendentes || 0);
    kpis.cancelados += Number(d.cancelados || 0);
    kpis.unpaid += Number(d.unpaid || 0);
    kpis.inv_meta += Number(d.inv_meta || 0);
    kpis.inv_pin += Number(d.inv_pin || 0);
    kpis.inv_total += Number(d.inv_total || 0);
    kpis.lucro += Number(d.lucro != null ? d.lucro : (d.comissao || 0) - (d.inv_total || 0));
  }
  kpis.faturamento = Math.round(kpis.faturamento * 100) / 100;
  kpis.comissao = Math.round(kpis.comissao * 100) / 100;
  kpis.inv_meta = Math.round(kpis.inv_meta * 100) / 100;
  kpis.inv_pin = Math.round(kpis.inv_pin * 100) / 100;
  kpis.inv_total = Math.round(kpis.inv_total * 100) / 100;
  kpis.lucro = Math.round(kpis.lucro * 100) / 100;
  // Recalcula ROI com a mesma base do invest exibido (já pode incluir taxa Meta)
  kpis.roi = kpis.inv_total > 0 ? Math.round((kpis.lucro / kpis.inv_total) * 10000) / 100 : null;
  kpis.pedidos = Number(kpis.concluidos || 0) + Number(kpis.pendentes || 0);
  kpis.abatimento = kpis.faturamento > 0
    ? Math.round((kpis.comissao / kpis.faturamento) * 10000) / 100
    : 0;

  kpis.faturamentoMtd = mtdRes != null ? mtdRes : kpis.faturamento;
  kpis.faturamentoAvg7 = avg7Res != null ? avg7Res : 0;

  return {
    range: { startDate, endDate },
    nodes: lastRun?.nodes || 0,
    pages: lastRun?.pages || 0,
    kpis,
    daily: (daily || []).map((d) => ({
      data: d.data,
      faturamento: Number(d.faturamento || 0),
      comissao: Number(d.comissao || 0),
      pedidos: Number(d.pedidos || 0),
      concluidos: Number(d.concluidos || 0),
      pendentes: Number(d.pendentes || 0),
      cancelados: Number(d.cancelados || 0),
      unpaid: Number(d.unpaid || 0),
      inv_meta: Number(d.inv_meta || 0),
      inv_pin: Number(d.inv_pin || 0),
      inv_total: Number(d.inv_total || 0),
      lucro: Number(d.lucro != null ? d.lucro : 0),
      roi: d.roi != null && Number(d.inv_total || 0) > 0 ? Number(d.roi) : null,
    })),
    subIds: (subIds || []).map((r) => {
      const inv = Number(r.inv_total || 0);
      const lucro = Number(r.lucro != null ? r.lucro : 0);
      let roi = r.roi != null ? Number(r.roi) : null;
      if (inv <= 0) roi = null;
      else if (roi == null || !Number.isFinite(roi)) roi = Math.round((lucro / inv) * 10000) / 100;
      return {
        subid: r.subid,
        faturamento: Number(r.faturamento || 0),
        comissao: Number(r.comissao || 0),
        pedidos: Number(r.pedidos || 0),
        concluidos: Number(r.concluidos || 0),
        pendentes: Number(r.pendentes || 0),
        cancelados: Number(r.cancelados || 0),
        unpaid: Number(r.unpaid || 0),
        itens: Number(r.itens || 0),
        abatimento: Number(r.abatimento || 0),
        cliques_shopee: r.cliques_shopee != null ? Number(r.cliques_shopee) : null,
        inv_meta: Number(r.inv_meta || 0),
        inv_pin: Number(r.inv_pin || 0),
        inv_total: inv,
        lucro,
        roi,
        cliques_meta: r.cliques_meta != null ? Number(r.cliques_meta) : undefined,
        cliques_pin: r.cliques_pin != null ? Number(r.cliques_pin) : undefined,
        cliques_shopee: r.cliques_shopee != null ? Number(r.cliques_shopee) : null,
        impressoes: r.impressoes != null ? Number(r.impressoes) : undefined,
        alcance: r.alcance != null ? Number(r.alcance) : undefined,
        ctr_meta: r.ctr_meta != null ? Number(r.ctr_meta) : undefined,
        cpc_meta: r.cpc_meta != null ? Number(r.cpc_meta) : undefined,
        abatimento_cliques: r.abatimento_cliques != null ? Number(r.abatimento_cliques) : undefined,
      };
    }),
    syncedAt: lastRun?.synced_at || null,
    fromDb: true,
  };
}

/** Carrega todos os pedidos do intervalo (páginas de 1000 — teto do PostgREST). */
async function loadMenuOrders(startDate, endDate, userId = requireUserId(), { max = 100000 } = {}) {
  const supabase = getSupabase();
  const cols = "subid, data, status, faturamento, comissao";
  return pagedSelect(
    (from, to) => supabase
      .from("orders")
      .select(cols)
      .eq("user_id", userId)
      .gte("data", startDate)
      .lte("data", endDate)
      .order("data", { ascending: true })
      .range(from, to),
    { pageSize: 1000, max },
  );
}

async function attachMenuPreviews(dash, startDate, endDate, userId = requireUserId(), { includePreviews = false, preloadedOrders = null } = {}) {
  if (!dash) return dash;
  try {
    const [orders, products] = await Promise.all([
      preloadedOrders != null
        ? Promise.resolve(preloadedOrders)
        : loadMenuOrders(startDate, endDate, userId),
      includePreviews ? loadProducts({ limit: 100 }, userId) : Promise.resolve([]),
    ]);
    if (includePreviews) {
      dash.ordersPreview = (orders || []).slice(0, 200);
      dash.productsPreview = products;
    }

    const bySubDay = {};
    for (const o of orders || []) {
      const sub = normalizeShopeeSubId(o.subid);
      const day = o.data;
      if (!day) continue;
      if (!bySubDay[sub]) bySubDay[sub] = {};
      if (!bySubDay[sub][day]) {
        bySubDay[sub][day] = {
          data: day,
          faturamento: 0,
          comissao: 0,
          pedidos: 0,
          concluidos: 0,
          pendentes: 0,
          cancelados: 0,
          unpaid: 0,
        };
      }
      const row = bySubDay[sub][day];
      const st = String(o.status || "");
      if (st === "cancelada") {
        row.cancelados += 1;
        continue;
      }
      if (st === "unpaid") {
        row.unpaid = (row.unpaid || 0) + 1;
        continue;
      }
      row.pedidos += 1;
      row.faturamento += Number(o.faturamento || 0);
      row.comissao += Number(o.comissao || 0);
      if (st === "concluida") row.concluidos += 1;
      else row.pendentes += 1;
    }

    const dailyFromMap = (key) => Object.values(bySubDay[key] || {})
      .map((d) => ({
        ...d,
        faturamento: Math.round(d.faturamento * 100) / 100,
        comissao: Math.round(d.comissao * 100) / 100,
      }))
      .sort((a, b) => String(a.data).localeCompare(String(b.data)));

    const seen = new Set();
    function rollupSubPeriod(dailyRows) {
      const agg = {
        faturamento: 0,
        comissao: 0,
        pedidos: 0,
        concluidos: 0,
        pendentes: 0,
        cancelados: 0,
        unpaid: 0,
      };
      for (const d of dailyRows || []) {
        agg.faturamento += Number(d.faturamento || 0);
        agg.comissao += Number(d.comissao || 0);
        agg.pedidos += Number(d.pedidos || 0);
        agg.concluidos += Number(d.concluidos || 0);
        agg.pendentes += Number(d.pendentes || 0);
        agg.cancelados += Number(d.cancelados || 0);
        agg.unpaid += Number(d.unpaid || 0);
      }
      return {
        faturamento: Math.round(agg.faturamento * 100) / 100,
        comissao: Math.round(agg.comissao * 100) / 100,
        pedidos: agg.pedidos,
        concluidos: agg.concluidos,
        pendentes: agg.pendentes,
        cancelados: agg.cancelados,
        unpaid: agg.unpaid,
      };
    }

    const merged = (dash.subIds || []).map((r) => {
      const key = normalizeShopeeSubId(r.subid);
      seen.add(key);
      const daily = dailyFromMap(key);
      return { ...r, subid: key, daily, ...rollupSubPeriod(daily) };
    });

    for (const key of Object.keys(bySubDay)) {
      if (seen.has(key)) continue;
      const daily = dailyFromMap(key);
      merged.push({
        subid: key,
        ...rollupSubPeriod(daily),
        daily,
      });
    }
    dash.subIds = merged;
  } catch (err) {
    console.warn("[store] attachMenuPreviews:", err.message || err);
    if (includePreviews) {
      dash.ordersPreview = dash.ordersPreview || [];
      dash.productsPreview = dash.productsPreview || [];
    }
  }
  return dash;
}

function channelDailyFromSubs(subIds, taxRate = 0, metaTaxRate = 12) {
  const gov = Number(taxRate || 0) / 100;
  const metaTax = Number(metaTaxRate != null ? metaTaxRate : 12) / 100;
  const buckets = { meta: new Map(), pinterest: new Map(), organico: new Map() };
  for (const s of subIds || []) {
    const ch = s.canal === "meta" || s.canal === "pinterest" || s.canal === "organico" ? s.canal : null;
    if (!ch) continue;
    const map = buckets[ch];
    for (const d of s.daily || []) {
      const key = String(d.data || "");
      if (!key) continue;
      let row = map.get(key);
      if (!row) {
        row = { data: key, faturamento: 0, comissao: 0, pedidos: 0, inv_meta: 0, inv_pin: 0 };
        map.set(key, row);
      }
      row.faturamento += Number(d.faturamento || 0);
      row.comissao += Number(d.comissao || 0);
      row.pedidos += Number(d.pedidos || 0);
      row.inv_meta += Number(d.inv_meta || 0);
      row.inv_pin += Number(d.inv_pin || 0);
    }
  }
  const finish = (map) => [...map.values()]
    .sort((a, b) => a.data.localeCompare(b.data))
    .map((r) => {
      const invTotal = r.inv_meta * (1 + metaTax) + r.inv_pin;
      const lucro = Math.round((r.comissao * (1 - gov) - invTotal) * 100) / 100;
      return {
        ...r,
        faturamento: Math.round(r.faturamento * 100) / 100,
        comissao: Math.round(r.comissao * 100) / 100,
        inv_meta: Math.round(r.inv_meta * 100) / 100,
        inv_pin: Math.round(r.inv_pin * 100) / 100,
        inv_total: Math.round(invTotal * 100) / 100,
        lucro,
        roi: invTotal > 0 ? Math.round((lucro / invTotal) * 10000) / 100 : null,
      };
    });
  return {
    meta: finish(buckets.meta),
    pinterest: finish(buckets.pinterest),
    organico: finish(buckets.organico),
  };
}

function channelKpisFromSubs(subIds, channel, taxRate = 0, metaTaxRate = 12) {
  const { calcLucroRoi } = require("./finance");
  const hasActivity = (r) => {
    const nz = (v) => Number(v || 0) > 0;
    if (nz(r.faturamento) || nz(r.comissao) || nz(r.pedidos)) return true;
    if (nz(r.cancelados) || nz(r.unpaid)) return true;
    if (nz(r.inv_meta) || nz(r.inv_pin)) return true;
    if (nz(r.cliques_meta) || nz(r.cliques_meta_link) || nz(r.cliques_pin)) return true;
    if (r.cliques_shopee != null && Number(r.cliques_shopee) > 0) return true;
    return false;
  };
  const canalOf = (s) => (s.canal === "meta" || s.canal === "pinterest" || s.canal === "organico" ? s.canal : "indefinido");
  const subs = (subIds || []).filter((s) => canalOf(s) === channel && hasActivity(s));
  let fat = 0;
  let com = 0;
  let invMeta = 0;
  let invPin = 0;
  let pedidos = 0;
  let cancelados = 0;
  let unpaid = 0;
  let cliquesMeta = 0;
  let cliquesMetaLink = 0;
  let cliquesPin = 0;
  let cliquesShopee = 0;
  let hasCliquesShopee = false;
  for (const r of subs) {
    fat += Number(r.faturamento || 0);
    com += Number(r.comissao || 0);
    invMeta += Number(r.inv_meta || 0);
    invPin += Number(r.inv_pin || 0);
    pedidos += Number(r.concluidos || 0) + Number(r.pendentes || 0);
    cancelados += Number(r.cancelados || 0);
    unpaid += Number(r.unpaid || 0);
    cliquesMeta += Number(r.cliques_meta || 0);
    cliquesMetaLink += Number(r.cliques_meta_link || 0);
    cliquesPin += Number(r.cliques_pin || 0);
    if (r.cliques_shopee != null) {
      hasCliquesShopee = true;
      cliquesShopee += Number(r.cliques_shopee || 0);
    }
  }
  const fin = calcLucroRoi(com, invMeta, invPin, { taxRate, metaTaxRate });
  const cliquesAds = channel === "meta"
    ? cliquesMetaLink
    : channel === "pinterest"
      ? cliquesPin
      : cliquesMetaLink + cliquesPin;
  // Agregado no padrão Shopee: soma bruta shopee/ads × 100. Sem clamp, > 100% é válido.
  // Meta: denominador = cliques no link.
  let abatimentoCliques = null;
  if (hasCliquesShopee && cliquesAds > 0) {
    abatimentoCliques = Math.round((cliquesShopee / cliquesAds) * 10000) / 100;
  }
  return {
    faturamento: Math.round(fat * 100) / 100,
    comissao: Math.round(com * 100) / 100,
    inv_meta: fin.inv_meta,
    inv_pin: fin.inv_pin,
    inv_meta_taxed: fin.inv_meta_taxed,
    inv_total: fin.inv_total,
    lucro: fin.lucro,
    roi: fin.roi,
    pedidos,
    cancelados,
    unpaid,
    cliques_meta: cliquesMeta,
    cliques_meta_link: cliquesMetaLink,
    cliques_pin: cliquesPin,
    cliques_ads: cliquesAds,
    cliques_shopee: hasCliquesShopee ? cliquesShopee : null,
    abatimento_cliques: abatimentoCliques,
    abatimento: fat > 0 ? Math.round((com / fat) * 10000) / 100 : null,
  };
}

function slimDashForClient(dash) {
  if (!dash) return dash;
  const taxRate = dash.tax?.taxRate ?? dash.kpis?.taxRate ?? 0;
  const metaTaxRate = dash.tax?.metaTaxRate ?? dash.kpis?.metaTaxRate ?? 12;
  const dailyByChannel = dash.dailyByChannel || channelDailyFromSubs(dash.subIds, taxRate, metaTaxRate);
  const channelKpis = {
    meta: channelKpisFromSubs(dash.subIds, "meta", taxRate, metaTaxRate),
    pinterest: channelKpisFromSubs(dash.subIds, "pinterest", taxRate, metaTaxRate),
    organico: channelKpisFromSubs(dash.subIds, "organico", taxRate, metaTaxRate),
    indefinido: channelKpisFromSubs(dash.subIds, "indefinido", taxRate, metaTaxRate),
  };
  const subIds = (dash.subIds || []).map((r) => {
    const { daily, ...rest } = r;
    return rest;
  });
  const out = { ...dash, subIds, dailyByChannel, channelKpis };
  delete out.ordersPreview;
  delete out.productsPreview;
  return out;
}

async function loadSubidDaily(subid, startDate, endDate, userId = requireUserId()) {
  const key = String(subid || "").trim().toLowerCase();
  if (!key) return [];

  const blankDay = (day) => ({
    data: day,
    faturamento: 0,
    comissao: 0,
    pedidos: 0,
    concluidos: 0,
    pendentes: 0,
    cancelados: 0,
    unpaid: 0,
    cliques_shopee: 0,
    cliques_meta_link: 0,
    cliques_pin: 0,
  });

  const byDay = new Map();

  const orders = await loadOrders({
    startDate,
    endDate,
    limit: 2000,
    columns: "subid, data, status, faturamento, comissao",
    subid: key,
  }, userId);
  for (const o of orders || []) {
    if (String(o.subid || "").toLowerCase() !== key) continue;
    const day = o.data;
    if (!day) continue;
    if (!byDay.has(day)) byDay.set(day, blankDay(day));
    const row = byDay.get(day);
    row.pedidos += 1;
    const st = String(o.status || "");
    if (st === "cancelada") { row.cancelados += 1; continue; }
    if (st === "unpaid") { row.unpaid += 1; continue; }
    row.faturamento += Number(o.faturamento || 0);
    row.comissao += Number(o.comissao || 0);
    if (st === "concluida") row.concluidos += 1;
    else row.pendentes += 1;
  }

  let clickRows = [];
  try {
    const { loadShopeeClicksByDay } = require("./shopeeClicks");
    clickRows = await loadShopeeClicksByDay(startDate, endDate, userId);
  } catch (_) { /* keep */ }
  for (const r of clickRows) {
    if (String(r.subid || "").toLowerCase() !== key) continue;
    const day = r.data;
    if (!day) continue;
    if (!byDay.has(day)) byDay.set(day, blankDay(day));
    byDay.get(day).cliques_shopee += Number(r.cliques || 0);
  }

  let metaRows = [];
  let pinRows = [];
  try {
    const { loadMetaSpendByDay } = require("./meta");
    metaRows = await loadMetaSpendByDay(startDate, endDate, userId);
  } catch (_) { /* keep */ }
  try {
    const { loadPinSpendByDay } = require("./pinterest");
    pinRows = await loadPinSpendByDay(startDate, endDate, userId);
  } catch (_) { /* keep */ }

  for (const r of metaRows) {
    if (String(r.subid || "").toLowerCase() !== key) continue;
    const day = r.data;
    if (!day) continue;
    if (!byDay.has(day)) byDay.set(day, blankDay(day));
    const row = byDay.get(day);
    row.cliques_meta_link += Number(r.cliques_link || 0);
  }
  for (const r of pinRows) {
    if (String(r.subid || "").toLowerCase() !== key) continue;
    const day = r.data;
    if (!day) continue;
    if (!byDay.has(day)) byDay.set(day, blankDay(day));
    byDay.get(day).cliques_pin += Number(r.cliques || 0);
  }

  let tax = { taxRate: 11.7, metaTaxRate: 12 };
  try { tax = await loadSettings(userId); } catch (_) { /* keep */ }
  const { calcLucroRoi } = require("./finance");

  return [...byDay.values()]
    .sort((a, b) => String(a.data).localeCompare(String(b.data)))
    .map((d) => {
      const invMeta = metaRows
        .filter((r) => String(r.subid || "").toLowerCase() === key && r.data === d.data)
        .reduce((a, r) => a + Number(r.gasto || 0), 0);
      const invPin = pinRows
        .filter((r) => String(r.subid || "").toLowerCase() === key && r.data === d.data)
        .reduce((a, r) => a + Number(r.gasto || 0), 0);
      const fin = calcLucroRoi(d.comissao, invMeta, invPin, tax);
      const cliquesAds = Number(d.cliques_meta_link || 0) + Number(d.cliques_pin || 0);
      const abatimento_cliques = cliquesAds > 0
        ? Math.round((Number(d.cliques_shopee || 0) / cliquesAds) * 10000) / 100
        : null;
      return {
        ...d,
        faturamento: Math.round(d.faturamento * 100) / 100,
        comissao: Math.round(d.comissao * 100) / 100,
        ...fin,
        abatimento_cliques,
      };
    });
}

function monthStartISO() {
  return brtFirstDayOfMonth();
}

function todayISO() {
  return brtTodayISO();
}

function daysAgoISO(n) {
  return brtSubtractDays(n, brtTodayISO());
}

async function loadFaturamentoMtd(userId = requireUserId()) {
  const end = shopeeEndDate();
  const start = brtFirstDayOfMonth(end);
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("daily_metrics")
    .select("data, faturamento")
    .eq("user_id", userId)
    .gte("data", start)
    .lte("data", end)
    .order("data", { ascending: true });
  if (error) throw new Error(error.message);
  const rows = data || [];
  const fat = rows.reduce((a, r) => a + Number(r.faturamento || 0), 0);
  return Math.round(fat * 100) / 100;
}

/** Média de faturamento dos últimos N dias do mês (calendário), independente do filtro do dashboard. */
async function loadFaturamentoAvgDays(n = 7, userId = requireUserId()) {
  const end = shopeeEndDate();
  const startMonth = monthStartISO();
  const startWindow = brtSubtractDays(Math.max(0, n - 1), end);
  const start = startWindow > startMonth ? startWindow : startMonth;
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("daily_metrics")
    .select("data, faturamento")
    .eq("user_id", userId)
    .gte("data", start)
    .lte("data", end)
    .order("data", { ascending: true });
  if (error) throw new Error(error.message);
  const rows = data || [];
  if (!rows.length) return 0;
  const sum = rows.reduce((a, r) => a + Number(r.faturamento || 0), 0);
  return Math.round((sum / rows.length) * 100) / 100;
}

async function attachMtdKpis(dash, userId = requireUserId()) {
  if (!dash?.kpis) return dash;
  if (dash.kpis.faturamentoMtd != null && dash.kpis.faturamentoAvg7 != null) return dash;
  try {
    const [mtd, avg7] = await Promise.all([
      loadFaturamentoMtd(userId),
      loadFaturamentoAvgDays(7, userId),
    ]);
    dash.kpis.faturamentoMtd = mtd;
    dash.kpis.faturamentoAvg7 = avg7;
  } catch (e) {
    console.warn("[store] attachMtdKpis:", e.message);
  }
  return dash;
}

async function loadOrders({ startDate, endDate, limit = 200, columns = "*", subid = null } = {}, userId = requireUserId()) {
  const supabase = getSupabase();
  let q = supabase.from("orders").select(columns).eq("user_id", userId).order("data", { ascending: false }).limit(limit);
  if (startDate) q = q.gte("data", startDate);
  if (endDate) q = q.lte("data", endDate);
  if (subid) q = q.eq("subid", subid);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return data || [];
}

async function loadProducts({ limit = 200 } = {}, userId = requireUserId()) {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("products")
    .select("*")
    .eq("user_id", userId)
    .order("comissao", { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);
  if (data?.length) return data;

  // Fallback: agrega order_items se a tabela products estiver vazia
  const { data: rows, error: iErr } = await supabase
    .from("order_items")
    .select("item_id,item_name,shop_name,qty,faturamento,comissao")
    .eq("user_id", userId)
    .limit(5000);
  if (iErr) throw new Error(iErr.message);
  const map = {};
  for (const r of rows || []) {
    const id = String(r.item_id || "unknown");
    if (!map[id]) {
      map[id] = {
        item_id: id,
        item_name: r.item_name || "",
        shop_name: r.shop_name || "",
        faturamento: 0,
        comissao: 0,
        pedidos: 0,
        qty: 0,
      };
    }
    map[id].faturamento += Number(r.faturamento || 0);
    map[id].comissao += Number(r.comissao || 0);
    map[id].qty += Number(r.qty || 0);
    map[id].pedidos += 1;
  }
  return Object.values(map)
    .map((p) => ({
      ...p,
      faturamento: Math.round(p.faturamento * 100) / 100,
      comissao: Math.round(p.comissao * 100) / 100,
    }))
    .sort((a, b) => b.comissao - a.comissao)
    .slice(0, limit);
}

async function loadSettings(userId = requireUserId()) {
  return requestCached(`loadSettings:${userId}`, async () => {
    const supabase = getSupabase();
    const { data } = await supabase.from("app_settings").select("*").eq("user_id", userId).maybeSingle();
    const taxRate = data?.tax_rate != null ? Number(data.tax_rate) : 11.7;
    const metaTaxRate = data?.meta_tax_rate != null ? Number(data.meta_tax_rate) : 12;
    const metaDias = data?.meta_dias != null && data.meta_dias !== ""
      ? Number(data.meta_dias)
      : null;
    return {
      metaBase: Number(data?.meta_base || 863959),
      metaDias: Number.isFinite(metaDias) && metaDias > 0 ? metaDias : null,
      metaBonus100: data?.meta_bonus_100 != null ? Number(data.meta_bonus_100) : 1,
      metaBonus125: data?.meta_bonus_125 != null ? Number(data.meta_bonus_125) : 2,
      metaBonus150: data?.meta_bonus_150 != null ? Number(data.meta_bonus_150) : 3,
      metaBonusNoLucro: Boolean(data?.meta_bonus_no_lucro),
      taxRate,
      metaTaxRate,
      teamName: data?.team_name || "Minha conta",
      teamPlan: data?.team_plan || "Shopee · Meta",
    };
  });
}

function settingsFromRow(userId, core, extras) {
  const data = { ...core, ...extras };
  const metaDias = data.meta_dias != null && data.meta_dias !== "" ? Number(data.meta_dias) : null;
  return {
    metaBase: Number(data.meta_base || 863959),
    metaDias: Number.isFinite(metaDias) && metaDias > 0 ? metaDias : null,
    metaBonus100: data.meta_bonus_100 != null ? Number(data.meta_bonus_100) : 1,
    metaBonus125: data.meta_bonus_125 != null ? Number(data.meta_bonus_125) : 2,
    metaBonus150: data.meta_bonus_150 != null ? Number(data.meta_bonus_150) : 3,
    metaBonusNoLucro: Boolean(data.meta_bonus_no_lucro),
    taxRate: data.tax_rate != null ? Number(data.tax_rate) : 11.7,
    metaTaxRate: data.meta_tax_rate != null ? Number(data.meta_tax_rate) : 12,
    teamName: data.team_name || "Minha conta",
    teamPlan: data.team_plan || "Shopee · Meta",
    userId,
  };
}

function clampPct(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(100, Math.max(0, Math.round(n * 100) / 100));
}

async function saveSettings(partial, userId = requireUserId()) {
  const prev = await loadSettings(userId);
  const core = {
    user_id: userId,
    meta_base: partial.metaBase != null ? Number(partial.metaBase) : prev.metaBase,
    tax_rate: partial.taxRate != null ? clampPct(partial.taxRate, prev.taxRate) : prev.taxRate,
    team_name: partial.teamName != null ? String(partial.teamName) : prev.teamName,
    team_plan: partial.teamPlan != null ? String(partial.teamPlan) : prev.teamPlan,
    updated_at: new Date().toISOString(),
  };
  const extras = {};
  if (partial.metaTaxRate != null) extras.meta_tax_rate = clampPct(partial.metaTaxRate, prev.metaTaxRate);
  if (partial.metaDias !== undefined) {
    extras.meta_dias = partial.metaDias == null || partial.metaDias === ""
      ? null
      : Number(partial.metaDias);
  }
  if (partial.metaBonus100 != null) extras.meta_bonus_100 = Number(partial.metaBonus100);
  if (partial.metaBonus125 != null) extras.meta_bonus_125 = Number(partial.metaBonus125);
  if (partial.metaBonus150 != null) extras.meta_bonus_150 = Number(partial.metaBonus150);
  if (partial.metaBonusNoLucro != null) extras.meta_bonus_no_lucro = Boolean(partial.metaBonusNoLucro);

  const supabase = getSupabase();
  const { ensureConfigSchema, upsertAppSettingsSql } = require("./ensureDb");

  let { error } = await supabase.from("app_settings").upsert(core);
  if (error) {
    await ensureConfigSchema();
    ({ error } = await supabase.from("app_settings").upsert(core));
  }
  if (error) {
    const viaPg = await upsertAppSettingsSql(core);
    if (!viaPg) throw new Error(error.message);
  }

  if (Object.keys(extras).length) {
    let extraErr = null;
    ({ error: extraErr } = await supabase.from("app_settings").update(extras).eq("user_id", userId));
    if (extraErr) {
      await ensureConfigSchema();
      ({ error: extraErr } = await supabase.from("app_settings").update(extras).eq("user_id", userId));
    }
    if (extraErr) {
      const viaPg = await upsertAppSettingsSql({ user_id: userId, ...extras, updated_at: core.updated_at });
      if (!viaPg) {
        console.warn("[settings] extras não gravadas via API:", extraErr.message);
      }
    }
  }

  invalidateRequestCache(`loadSettings:${userId}`);
  try {
    return await loadSettings(userId);
  } catch (_) {
    return settingsFromRow(userId, core, extras);
  }
}

module.exports = {
  loadCredentials,
  saveCredentials,
  credentialsPublic,
  saveDashboardSnapshot,
  persistOrdersAndProducts,
  loadDashboardFromDb,
  attachMenuPreviews,
  loadMenuOrders,
  slimDashForClient,
  loadSubidDaily,
  loadOrders,
  loadProducts,
  loadSettings,
  saveSettings,
  loadFaturamentoMtd,
  attachMtdKpis,
  resetAllSyncedData,
  maskSecret,
};
