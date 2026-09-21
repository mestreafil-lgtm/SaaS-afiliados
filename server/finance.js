"use strict";

const { getSupabase } = require("./supabase");
const { loadMetaSpendByDay } = require("./meta");
const { loadPinSpendByDay } = require("./pinterest");
const { requireUserId } = require("./auth");
const { loadSettings } = require("./store");
const { loadSubidOps, applyOpsToSubIds, inferCanal, persistInferredOps } = require("./subidOps");
const { loadShopeeClicksByDay } = require("./shopeeClicks");

function round2(n) {
  return Math.round(Number(n || 0) * 100) / 100;
}

// Abatimento no padrão da Shopee = (cliques_shopee / cliques_ads) × 100.
// No Meta, cliques_ads = cliques no link (inline_link_clicks), não "todos os cliques".
// No dashboard Geral, o numerador é só Shopee de SubIDs Meta+Pin (orgânico não entra).
// Valores > 100% são válidos. Sem clamp.
// Se cliques_ads = 0, retorna null (divisão indefinida — UI mostra "—").
// "% Comissão" (participação da comissão no faturamento) = com/fat × 100.
function commAbatPct(fat, com) {
  const f = Number(fat || 0);
  const c = Number(com || 0);
  if (!(f > 0)) return null;
  return round2((c / f) * 100);
}
function clickAbatPct(shopee, ads) {
  const s = Number(shopee || 0);
  const a = Number(ads || 0);
  if (!(a > 0)) return null;
  return round2((s / a) * 100);
}

function sumSpend(rows) {
  const byDay = {};
  const bySub = {};
  const bySubDay = {};
  const clicksByDay = {};
  const clicksBySub = {};
  const clicksBySubDay = {};
  const linkClicksByDay = {};
  const linkClicksBySub = {};
  const linkClicksBySubDay = {};
  const impressoesBySub = {};
  const alcanceBySub = {};
  const spendClicksBySub = {}; // for weighted CPC
  for (const r of rows || []) {
    const day = r.data;
    const sub = String(r.subid || "").trim().toLowerCase() || "semsubid";
    const g = Number(r.gasto || 0);
    const clicks = Number(r.cliques || 0);
    const linkClicks = Number(r.cliques_link || 0);
    const impressoes = Number(r.impressoes || 0);
    const alcance = Number(r.alcance || 0);
    if (day) {
      byDay[day] = (byDay[day] || 0) + g;
      clicksByDay[day] = (clicksByDay[day] || 0) + clicks;
      linkClicksByDay[day] = (linkClicksByDay[day] || 0) + linkClicks;
      const sk = `${sub}|${day}`;
      bySubDay[sk] = (bySubDay[sk] || 0) + g;
      clicksBySubDay[sk] = (clicksBySubDay[sk] || 0) + clicks;
      linkClicksBySubDay[sk] = (linkClicksBySubDay[sk] || 0) + linkClicks;
    }
    bySub[sub] = (bySub[sub] || 0) + g;
    clicksBySub[sub] = (clicksBySub[sub] || 0) + clicks;
    linkClicksBySub[sub] = (linkClicksBySub[sub] || 0) + linkClicks;
    impressoesBySub[sub] = (impressoesBySub[sub] || 0) + impressoes;
    alcanceBySub[sub] = (alcanceBySub[sub] || 0) + alcance;
    if (!spendClicksBySub[sub]) spendClicksBySub[sub] = { spend: 0, clicks: 0, impressoes: 0 };
    spendClicksBySub[sub].spend += g;
    spendClicksBySub[sub].clicks += clicks;
    spendClicksBySub[sub].impressoes += impressoes;
  }
  return {
    byDay,
    bySub,
    bySubDay,
    clicksByDay,
    clicksBySub,
    clicksBySubDay,
    linkClicksByDay,
    linkClicksBySub,
    linkClicksBySubDay,
    impressoesBySub,
    alcanceBySub,
    spendClicksBySub,
  };
}

/**
 * Mesma lógica do painel de referência:
 * investMetaT = invMeta * (1 + metaTax%)
 * investTotal = investMetaT + invPin   ← este é o invest exibido e o denominador do ROI
 * comissaoLiquida = comissao * (1 - govTax%)
 * lucro = comissaoLiquida - investTotal
 * roi = lucro / investTotal  (em %)
 */
function calcLucroRoi(comissao, invMetaRaw, invPinRaw, tax) {
  const gov = Number(tax?.taxRate || 0) / 100;
  const metaTax = Number(tax?.metaTaxRate != null ? tax.metaTaxRate : 12) / 100;
  const invMeta = Number(invMetaRaw || 0);
  const invPin = Number(invPinRaw || 0);
  const invMetaTaxed = invMeta * (1 + metaTax);
  const invForRoi = invMetaTaxed + invPin;
  const comissaoLiq = Number(comissao || 0) * (1 - gov);
  const lucro = round2(comissaoLiq - invForRoi);
  const roi = invForRoi > 0 ? round2((lucro / invForRoi) * 100) : null;
  return {
    inv_meta: round2(invMeta),
    inv_pin: round2(invPin),
    inv_meta_taxed: round2(invMetaTaxed),
    inv_total_bruto: round2(invMeta + invPin),
    // investTotal do referência = Meta com imposto + Pin bruto
    inv_total: round2(invForRoi),
    comissao_liquida: round2(comissaoLiq),
    lucro,
    roi,
  };
}

function reconcileSubIdsToPeriod(subIds, start, end, tax) {
  if (!start || !end) return subIds || [];
  return (subIds || []).map((sub) => {
    const allDaily = sub.daily || [];
    const days = allDaily.filter((d) => d.data >= start && d.data <= end);

    if (!days.length) {
      const invM = Number(sub.inv_meta || 0);
      const invP = Number(sub.inv_pin || 0);
      if (invM > 0 || invP > 0) {
        const fin = calcLucroRoi(0, invM, invP, tax);
        const clM = Number(sub.cliques_meta || 0);
        const clML = Number(sub.cliques_meta_link || 0);
        const clP = Number(sub.cliques_pin || 0);
        return {
          ...sub,
          faturamento: 0,
          comissao: 0,
          pedidos: 0,
          concluidos: 0,
          pendentes: 0,
          cancelados: 0,
          unpaid: 0,
          cliques_shopee: 0,
          cliques_meta: clM,
          cliques_meta_link: clML,
          cliques_pin: clP,
          cliques_ads: clML + clP,
          abatimento: null,
          abatimento_cliques: null,
          ...fin,
        };
      }
      return {
        ...sub,
        faturamento: 0,
        comissao: 0,
        pedidos: 0,
        concluidos: 0,
        pendentes: 0,
        cancelados: 0,
        unpaid: 0,
        lucro: 0,
        roi: null,
        abatimento: null,
        cliques_shopee: 0,
      };
    }

    const agg = {
      faturamento: 0,
      comissao: 0,
      pedidos: 0,
      concluidos: 0,
      pendentes: 0,
      cancelados: 0,
      unpaid: 0,
      inv_meta: 0,
      inv_pin: 0,
      cliques_meta: 0,
      cliques_meta_link: 0,
      cliques_pin: 0,
      cliques_shopee: 0,
    };
    for (const d of days) {
      agg.faturamento += Number(d.faturamento || 0);
      agg.comissao += Number(d.comissao || 0);
      agg.pedidos += Number(d.pedidos || 0);
      agg.concluidos += Number(d.concluidos || 0);
      agg.pendentes += Number(d.pendentes || 0);
      agg.cancelados += Number(d.cancelados || 0);
      agg.unpaid += Number(d.unpaid || 0);
      agg.inv_meta += Number(d.inv_meta || 0);
      agg.inv_pin += Number(d.inv_pin || 0);
      agg.cliques_meta += Number(d.cliques_meta || 0);
      agg.cliques_meta_link += Number(d.cliques_meta_link || 0);
      agg.cliques_pin += Number(d.cliques_pin || 0);
      agg.cliques_shopee += Number(d.cliques_shopee || 0);
    }

    let cliquesShopee = agg.cliques_shopee;
    // Não usar pedidos como clique. Sem relatório de cliques (CSV), fica 0.

    const fin = calcLucroRoi(agg.comissao, agg.inv_meta, agg.inv_pin, tax);
    const fat = round2(agg.faturamento);
    const com = round2(agg.comissao);
    // Meta no denominador = cliques no link (não "todos")
    const clAds = agg.cliques_meta_link + agg.cliques_pin;
    const abatimentoCliques = clAds > 0 ? clickAbatPct(cliquesShopee, clAds) : null;

    return {
      ...sub,
      faturamento: fat,
      comissao: com,
      pedidos: agg.pedidos,
      concluidos: agg.concluidos,
      pendentes: agg.pendentes,
      cancelados: agg.cancelados,
      unpaid: agg.unpaid,
      inv_meta: fin.inv_meta,
      inv_pin: fin.inv_pin,
      inv_meta_taxed: fin.inv_meta_taxed,
      inv_total: fin.inv_total,
      lucro: fin.lucro,
      roi: fin.roi,
      cliques_meta: agg.cliques_meta,
      cliques_meta_link: agg.cliques_meta_link,
      cliques_pin: agg.cliques_pin,
      cliques_ads: clAds,
      cliques_shopee: cliquesShopee,
      abatimento: commAbatPct(fat, com),
      abatimento_cliques: abatimentoCliques,
    };
  });
}

/**
 * Cruza comissão Shopee (daily/subid já no dash) com gasto Meta+Pin.
 * Atualiza colunas inv_* / lucro / roi no Supabase e devolve kpis enriquecidos.
 */
async function enrichDashboardWithAds(dash, userId = requireUserId(), { persistSubIds = true, persistDaily = true } = {}) {
  const start = dash.range?.startDate;
  const end = dash.range?.endDate;
  if (!start || !end) return dash;

  const [taxRes, metaRes, pinRes, opsRes, clickRes] = await Promise.all([
    loadSettings(userId).catch((e) => { console.warn("[finance] settings:", e.message); return null; }),
    loadMetaSpendByDay(start, end, userId).catch((e) => { console.warn("[finance] meta:", e.message); return []; }),
    loadPinSpendByDay(start, end, userId).catch((e) => { console.warn("[finance] pin:", e.message); return []; }),
    loadSubidOps(userId),
    loadShopeeClicksByDay(start, end, userId).catch((e) => { console.warn("[finance] cliques:", e.message); return []; }),
  ]);
  const tax = taxRes || { taxRate: 11.7, metaTaxRate: 12 };
  const metaRows = metaRes || [];
  const pinRows = pinRes || [];
  const opsMap = opsRes || {};
  const clickRows = clickRes || [];

  const meta = sumSpend(metaRows);
  const pin = sumSpend(pinRows);

  /** Canal do SubID p/ abatimento: ops manual (exceto indefinido) → gasto Meta/Pin. */
  function canalForClickSub(sub) {
    const op = opsMap[sub];
    const fromOps = op?.canal || null;
    // Orgânico nunca entra no abatimento do Geral — mesmo com gasto residual.
    if (fromOps === "organico") return "organico";
    if (fromOps === "meta" || fromOps === "pinterest") return fromOps;
    // indefinido / vazio: classifica pelo gasto no período
    return inferCanal(sub, meta.bySub[sub] || 0, pin.bySub[sub] || 0);
  }

  const clicksBySubDay = {};
  const clicksBySub = {};
  const clicksShopeeByDay = {};
  // Só Meta e Pinterest — orgânico NUNCA entra no abatimento do dashboard principal.
  const clicksShopeePaidByDay = {};
  const clicksShopeeMetaByDay = {};
  const clicksShopeePinByDay = {};
  let clicksShopeePaidTotal = 0;
  let clicksShopeeMetaTotal = 0;
  let clicksShopeePinTotal = 0;
  const clickSubDays = new Map();
  for (const r of clickRows) {
    const sub = String(r.subid || "").trim().toLowerCase();
    const day = r.data;
    const n = Number(r.cliques || 0);
    if (!sub || !day || !(n > 0)) continue;
    const sk = `${sub}|${day}`;
    clicksBySubDay[sk] = (clicksBySubDay[sk] || 0) + n;
    clicksBySub[sub] = (clicksBySub[sub] || 0) + n;
    clicksShopeeByDay[day] = (clicksShopeeByDay[day] || 0) + n;
    const canal = canalForClickSub(sub);
    if (canal === "meta") {
      clicksShopeeMetaByDay[day] = (clicksShopeeMetaByDay[day] || 0) + n;
      clicksShopeeMetaTotal += n;
      clicksShopeePaidByDay[day] = (clicksShopeePaidByDay[day] || 0) + n;
      clicksShopeePaidTotal += n;
    } else if (canal === "pinterest") {
      clicksShopeePinByDay[day] = (clicksShopeePinByDay[day] || 0) + n;
      clicksShopeePinTotal += n;
      clicksShopeePaidByDay[day] = (clicksShopeePaidByDay[day] || 0) + n;
      clicksShopeePaidTotal += n;
    }
    if (!clickSubDays.has(sub)) clickSubDays.set(sub, new Set());
    clickSubDays.get(sub).add(day);
  }

  // Índice sub → Set<dias com gasto> para juntar dias-Ads aos dias-Shopee
  const metaSubDays = new Map();
  const pinSubDays = new Map();
  for (const k of Object.keys(meta.bySubDay || {})) {
    const [sub, day] = k.split("|");
    if (!sub || !day) continue;
    if (!metaSubDays.has(sub)) metaSubDays.set(sub, new Set());
    metaSubDays.get(sub).add(day);
  }
  for (const k of Object.keys(pin.bySubDay || {})) {
    const [sub, day] = k.split("|");
    if (!sub || !day) continue;
    if (!pinSubDays.has(sub)) pinSubDays.set(sub, new Set());
    pinSubDays.get(sub).add(day);
  }

  function blankShopeeDay(day) {
    return {
      data: day,
      faturamento: 0,
      comissao: 0,
      pedidos: 0,
      concluidos: 0,
      pendentes: 0,
      cancelados: 0,
      unpaid: 0,
      cliques_shopee: 0,
    };
  }

  function buildSubDaily(subKey, shopeeDaily) {
    const byDay = new Map();
    for (const d of shopeeDaily || []) {
      if (d && d.data) byDay.set(d.data, { ...d });
    }
    for (const day of metaSubDays.get(subKey) || []) {
      if (!byDay.has(day)) byDay.set(day, blankShopeeDay(day));
    }
    for (const day of pinSubDays.get(subKey) || []) {
      if (!byDay.has(day)) byDay.set(day, blankShopeeDay(day));
    }
    for (const day of clickSubDays.get(subKey) || []) {
      if (!byDay.has(day)) byDay.set(day, blankShopeeDay(day));
    }
    return [...byDay.values()]
      .sort((a, b) => String(a.data).localeCompare(String(b.data)))
      .map((d) => {
        const sk = `${subKey}|${d.data}`;
        const dFin = calcLucroRoi(d.comissao, meta.bySubDay[sk] || 0, pin.bySubDay[sk] || 0, tax);
        const cliM = meta.clicksBySubDay?.[sk] || 0;
        const cliML = meta.linkClicksBySubDay?.[sk] || 0;
        const cliP = pin.clicksBySubDay?.[sk] || 0;
        const cliS = clicksBySubDay[sk] || 0;
        return { ...d, ...dFin, cliques_meta: cliM, cliques_meta_link: cliML, cliques_pin: cliP, cliques_shopee: cliS };
      });
  }

  // União dos dias: pedidos validados dos SubIDs ∪ Meta ∪ Pin
  const allDaysSet = new Set();
  const shopeeDailyByDay = new Map();
  for (const s of dash.subIds || []) {
    for (const d of s.daily || []) {
      const day = d && d.data;
      if (!day) continue;
      allDaysSet.add(day);
      const cur = shopeeDailyByDay.get(day) || blankShopeeDay(day);
      cur.faturamento += Number(d.faturamento || 0);
      cur.comissao += Number(d.comissao || 0);
      cur.pedidos += Number(d.pedidos || 0);
      cur.concluidos += Number(d.concluidos || 0);
      cur.pendentes += Number(d.pendentes || 0);
      cur.cancelados += Number(d.cancelados || 0);
      cur.unpaid += Number(d.unpaid || 0);
      shopeeDailyByDay.set(day, cur);
    }
  }
  for (const day of Object.keys(meta.byDay || {})) allDaysSet.add(day);
  for (const day of Object.keys(pin.byDay || {})) allDaysSet.add(day);
  for (const day of Object.keys(clicksShopeeByDay)) allDaysSet.add(day);

  const daily = [...allDaysSet]
    .sort()
    .map((day) => {
      const src = shopeeDailyByDay.get(day) || blankShopeeDay(day);
      const invMeta = meta.byDay[day] || 0;
      const invPin = pin.byDay[day] || 0;
      const fin = calcLucroRoi(src.comissao, invMeta, invPin, tax);
      const fat = Number(src.faturamento || 0);
      const com = Number(src.comissao || 0);
      const abatimento = commAbatPct(fat, com);
      const cliques_meta = meta.clicksByDay?.[day] || 0;
      const cliques_meta_link = meta.linkClicksByDay?.[day] || 0;
      const cliques_pin = pin.clicksByDay?.[day] || 0;
      const cliques_shopee = clicksShopeeByDay[day] || 0;
      const cliques_shopee_meta = clicksShopeeMetaByDay[day] || 0;
      const cliques_shopee_pin = clicksShopeePinByDay[day] || 0;
      const cliques_shopee_pago = clicksShopeePaidByDay[day] || 0;
      const cliques_ads = cliques_meta_link + cliques_pin;
      // Dashboard principal: abatimento separado Meta e Pin — orgânico não aparece
      const abatimento_cliques_meta = clickAbatPct(cliques_shopee_meta, cliques_meta_link);
      const abatimento_cliques_pin = clickAbatPct(cliques_shopee_pin, cliques_pin);
      const abatimento_cliques = clickAbatPct(cliques_shopee_pago, cliques_ads);
      return {
        ...src,
        ...fin,
        abatimento,
        abatimento_cliques,
        abatimento_cliques_meta,
        abatimento_cliques_pin,
        cliques_meta,
        cliques_meta_link,
        cliques_pin,
        cliques_shopee,
        cliques_shopee_meta,
        cliques_shopee_pin,
        cliques_ads,
      };
    });

  const subIds = (dash.subIds || []).map((r) => {
    const key = String(r.subid || "").trim().toLowerCase();
    const invMeta = meta.bySub[key] || 0;
    const invPin = pin.bySub[key] || 0;
    const fin = calcLucroRoi(r.comissao, invMeta, invPin, tax);
    const dailyRows = buildSubDaily(key, r.daily);
    // Canal definitivo vem só de applyOpsToSubIds (subid_ops) — não inferir aqui
    const canal = null;
    // Status operacional: só subid_ops (global) — enrich não repassa snapshot antigo.
    const status = null;
    const cliquesMeta = meta.clicksBySub[key] || 0;
    const cliquesMetaLink = meta.linkClicksBySub?.[key] || 0;
    const cliquesPin = pin.clicksBySub[key] || 0;
    const cliquesAds = cliquesMetaLink + cliquesPin;
    const cliquesShopee = clicksBySub[key] || 0;
    const impressoes = meta.impressoesBySub[key] || 0;
    const alcance = meta.alcanceBySub[key] || 0;
    const metaAgg = meta.spendClicksBySub[key] || { spend: 0, clicks: 0, impressoes: 0 };
    const cpc = metaAgg.clicks > 0 ? round2(metaAgg.spend / metaAgg.clicks) : null;
    const ctr = metaAgg.impressoes > 0 ? round2((metaAgg.clicks / metaAgg.impressoes) * 100) : null;
    const abatimentoCliques = cliquesShopee != null && cliquesAds > 0
      ? clickAbatPct(cliquesShopee, cliquesAds)
      : null;
    return {
      ...r,
      ...fin,
      daily: dailyRows,
      canal,
      status,
      cliques_meta: cliquesMeta,
      cliques_meta_link: cliquesMetaLink,
      cliques_pin: cliquesPin,
      cliques_ads: cliquesAds,
      cliques_shopee: cliquesShopee,
      abatimento_cliques: abatimentoCliques,
      impressoes,
      alcance,
      cpc_meta: cpc,
      ctr_meta: ctr,
    };
  });

  const invMeta = round2(daily.reduce((a, d) => a + Number(d.inv_meta || 0), 0));
  const invPin = round2(daily.reduce((a, d) => a + Number(d.inv_pin || 0), 0));
  const comissao = Number(dash.kpis?.comissao || 0);
  const kpisFin = calcLucroRoi(comissao, invMeta, invPin, tax);
  const fat = Number(dash.kpis?.faturamento || 0);
  const abatimento = fat > 0 ? commAbatPct(fat, comissao) : Number(dash.kpis?.abatimento || 0);

  // Totais de mídia a partir das linhas brutas (não só SubIDs com venda Shopee)
  const cliquesMetaTotal = metaRows.reduce((a, r) => a + Number(r.cliques || 0), 0);
  const cliquesMetaLinkTotal = metaRows.reduce((a, r) => a + Number(r.cliques_link || 0), 0);
  const impressoesTotal = metaRows.reduce((a, r) => a + Number(r.impressoes || 0), 0);
  const alcanceTotal = metaRows.reduce((a, r) => a + Number(r.alcance || 0), 0);
  const cliquesPinTotal = pinRows.reduce((a, r) => a + Number(r.cliques || 0), 0);
  const cliquesShopeeTotal = subIds.reduce((a, r) => a + Number(r.cliques_shopee || 0), 0);
  // Abatimento Geral = Shopee de SubIDs Meta+Pin ÷ ads (exclui orgânico do numerador)
  const cliquesAdsTotal = cliquesMetaLinkTotal + cliquesPinTotal;
  const cpcMeta = cliquesMetaTotal > 0 ? round2(invMeta / cliquesMetaTotal) : null;
  const ctrMeta = impressoesTotal > 0 ? round2((cliquesMetaTotal / impressoesTotal) * 100) : null;
  let abatimentoCliquesKpi = null;
  const abatimentoCliquesMetaKpi = clickAbatPct(clicksShopeeMetaTotal, cliquesMetaLinkTotal);
  const abatimentoCliquesPinKpi = clickAbatPct(clicksShopeePinTotal, cliquesPinTotal);
  if (cliquesAdsTotal > 0) {
    abatimentoCliquesKpi = clickAbatPct(clicksShopeePaidTotal, cliquesAdsTotal);
  } else if (cliquesMetaLinkTotal > 0) {
    abatimentoCliquesKpi = clickAbatPct(clicksShopeePaidTotal, cliquesMetaLinkTotal);
  }

  const kpis = {
    ...(dash.kpis || {}),
    ...kpisFin,
    abatimento,
    taxRate: Number(tax.taxRate || 0),
    metaTaxRate: Number(tax.metaTaxRate != null ? tax.metaTaxRate : 12),
    cliques_meta: cliquesMetaTotal,
    cliques_meta_link: cliquesMetaLinkTotal,
    cliques_pin: cliquesPinTotal,
    cliques_ads: cliquesAdsTotal,
    cliques_shopee: cliquesShopeeTotal,
    cliques_shopee_pago: clicksShopeePaidTotal,
    cliques_shopee_meta: clicksShopeeMetaTotal,
    cliques_shopee_pin: clicksShopeePinTotal,
    impressoes: impressoesTotal,
    alcance: alcanceTotal,
    cpc_meta: cpcMeta,
    ctr_meta: ctrMeta,
    abatimento_cliques: abatimentoCliquesKpi,
    abatimento_cliques_meta: abatimentoCliquesMetaKpi,
    abatimento_cliques_pin: abatimentoCliquesPinKpi,
  };

  // Inclui SubIDs só com gasto Meta/Pin (sem venda Shopee no período) para não perder cliques
  const seenSubs = new Set(subIds.map((r) => String(r.subid || "").trim().toLowerCase()));
  const orphanSubs = [];
  for (const [sub, spend] of Object.entries(meta.bySub)) {
    if (!sub || seenSubs.has(sub) || !(spend > 0)) continue;
    const fin = calcLucroRoi(0, spend, pin.bySub[sub] || 0, tax);
    const cliquesMeta = meta.clicksBySub[sub] || 0;
    const cliquesMetaLink = meta.linkClicksBySub?.[sub] || 0;
    const cliquesPin = pin.clicksBySub[sub] || 0;
    const impressoes = meta.impressoesBySub[sub] || 0;
    const alcance = meta.alcanceBySub[sub] || 0;
    const metaAgg = meta.spendClicksBySub[sub] || { spend: 0, clicks: 0, impressoes: 0 };
    orphanSubs.push({
      subid: sub,
      faturamento: 0,
      comissao: 0,
      pedidos: 0,
      concluidos: 0,
      pendentes: 0,
      cancelados: 0,
      unpaid: 0,
      itens: 0,
      abatimento: null,
      cliques_shopee: 0,
      cliques_meta: cliquesMeta,
      cliques_meta_link: cliquesMetaLink,
      cliques_pin: cliquesPin,
      cliques_ads: cliquesMetaLink + cliquesPin,
      impressoes,
      alcance,
      cpc_meta: metaAgg.clicks > 0 ? round2(metaAgg.spend / metaAgg.clicks) : null,
      ctr_meta: metaAgg.impressoes > 0 ? round2((metaAgg.clicks / metaAgg.impressoes) * 100) : null,
      abatimento_cliques: null,
      canal: inferCanal(sub, spend, pin.bySub[sub] || 0),
      status: null,
      daily: buildSubDaily(sub, []),
      ...fin,
    });
    seenSubs.add(sub);
  }
  for (const [sub, spend] of Object.entries(pin.bySub)) {
    if (!sub || sub === "semsubid" || seenSubs.has(sub)) continue;
    const fin = calcLucroRoi(0, 0, spend, tax);
    const cliquesPin = pin.clicksBySub[sub] || 0;
    orphanSubs.push({
      subid: sub,
      faturamento: 0,
      comissao: 0,
      pedidos: 0,
      concluidos: 0,
      pendentes: 0,
      cancelados: 0,
      unpaid: 0,
      itens: 0,
      abatimento: null,
      cliques_shopee: 0,
      cliques_meta: 0,
      cliques_pin: cliquesPin,
      cliques_ads: cliquesPin,
      impressoes: 0,
      alcance: 0,
      cpc_meta: null,
      ctr_meta: null,
      abatimento_cliques: null,
      canal: "pinterest",
      status: null,
      daily: buildSubDaily(sub, []),
      ...fin,
    });
    seenSubs.add(sub);
  }

  const subIdsAll = reconcileSubIdsToPeriod(
    orphanSubs.length ? subIds.concat(orphanSubs) : subIds,
    start,
    end,
    tax,
  );
  kpis.faturamento = round2(subIdsAll.reduce((a, r) => a + Number(r.faturamento || 0), 0));
  kpis.comissao = round2(subIdsAll.reduce((a, r) => a + Number(r.comissao || 0), 0));
  kpis.concluidos = subIdsAll.reduce((a, r) => a + Number(r.concluidos || 0), 0);
  kpis.pendentes = subIdsAll.reduce((a, r) => a + Number(r.pendentes || 0), 0);
  kpis.cancelados = subIdsAll.reduce((a, r) => a + Number(r.cancelados || 0), 0);
  kpis.unpaid = subIdsAll.reduce((a, r) => a + Number(r.unpaid || 0), 0);
  kpis.pedidos = kpis.concluidos + kpis.pendentes;
  kpis.cliques_shopee = subIdsAll.reduce((a, r) => a + Number(r.cliques_shopee || 0), 0);
  const kpisAligned = calcLucroRoi(kpis.comissao, kpis.inv_meta, kpis.inv_pin, tax);
  Object.assign(kpis, kpisAligned);
  kpis.abatimento = commAbatPct(kpis.faturamento, kpis.comissao) ?? 0;
  // Mantém abatimento com numerador só de canais pagos (já calculado acima)
  if (Number(kpis.cliques_ads || 0) > 0) {
    kpis.abatimento_cliques = clickAbatPct(clicksShopeePaidTotal, kpis.cliques_ads);
  } else if (Number(kpis.cliques_meta_link || 0) > 0) {
    kpis.abatimento_cliques = clickAbatPct(clicksShopeePaidTotal, kpis.cliques_meta_link);
  } else {
    kpis.abatimento_cliques = null;
  }
  kpis.abatimento_cliques_meta = clickAbatPct(clicksShopeeMetaTotal, kpis.cliques_meta_link);
  kpis.abatimento_cliques_pin = clickAbatPct(clicksShopeePinTotal, kpis.cliques_pin);
  kpis.cliques_shopee_meta = clicksShopeeMetaTotal;
  kpis.cliques_shopee_pin = clicksShopeePinTotal;

  try {
    const supabase = getSupabase();
    const now = new Date().toISOString();
    if (persistDaily && daily.length) {
      await supabase.from("daily_metrics").upsert(
        daily.map((d) => ({
          user_id: userId,
          data: d.data,
          faturamento: d.faturamento || 0,
          comissao: d.comissao || 0,
          pedidos: d.pedidos || 0,
          concluidos: d.concluidos || 0,
          pendentes: d.pendentes || 0,
          cancelados: d.cancelados || 0,
          unpaid: d.unpaid || 0,
          inv_meta: d.inv_meta,
          inv_pin: d.inv_pin,
          inv_total: d.inv_total,
          lucro: d.lucro,
          roi: d.roi,
          updated_at: now,
        })),
        { onConflict: "user_id,data" }
      );
    }
    if (persistSubIds && subIdsAll.length) {
      const rows = subIdsAll.map((r) => ({
        user_id: userId,
        subid: r.subid,
        faturamento: r.faturamento || 0,
        comissao: r.comissao || 0,
        pedidos: r.pedidos || 0,
        concluidos: r.concluidos || 0,
        pendentes: r.pendentes || 0,
        cancelados: r.cancelados || 0,
        unpaid: r.unpaid || 0,
        cliques_shopee: r.cliques_shopee != null ? Number(r.cliques_shopee) : 0,
        inv_meta: r.inv_meta,
        inv_pin: r.inv_pin,
        inv_total: r.inv_total,
        lucro: r.lucro,
        roi: r.roi != null ? r.roi : 0,
        updated_at: now,
      }));
      for (let i = 0; i < rows.length; i += 200) {
        let chunk = rows.slice(i, i + 200);
        let { error } = await supabase.from("subid_metrics").upsert(chunk, {
          onConflict: "user_id,subid",
        });
        if (error && /unpaid/i.test(error.message || "")) {
          chunk = chunk.map(({ unpaid, ...rest }) => rest);
          ({ error } = await supabase.from("subid_metrics").upsert(chunk, {
            onConflict: "user_id,subid",
          }));
        }
        if (error && /cliques_shopee/i.test(error.message || "")) {
          chunk = chunk.map(({ cliques_shopee, ...rest }) => rest);
          ({ error } = await supabase.from("subid_metrics").upsert(chunk, {
            onConflict: "user_id,subid",
          }));
        }
        if (error) throw error;
      }
    }
  } catch (e) {
    console.warn("[finance] persist:", e.message);
  }

  const subIdsWithOps = applyOpsToSubIds(subIdsAll, opsMap);
  if (persistDaily || persistSubIds) {
    persistInferredOps(subIdsWithOps, userId).catch((e) => {
      console.warn("[finance] persist indefinidos:", e.message);
    });
  }

  return {
    ...dash,
    daily,
    subIds: subIdsWithOps,
    kpis,
    tax,
  };
}

module.exports = { enrichDashboardWithAds, sumSpend, calcLucroRoi, reconcileSubIdsToPeriod };
