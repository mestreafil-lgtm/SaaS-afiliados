"use strict";

/**
 * Notifica o usuário quando a comissão de ontem (BRT) chega.
 *
 * Dedup: nunca reenvia se a comissão não mexeu ou caiu (pedido cancelado etc.).
 * Reenvia quando a comissão SUBIU de forma significativa (≥ R$ 1,00 OU ≥ 5%)
 * e passou o rate limit de 20 min desde o último push, para acompanhar
 * pedidos pendentes que vão caindo durante a janela da manhã.
 */

const { getSupabaseAdmin, runWithUser } = require("./auth");
const { buildDashboard } = require("./metrics");
const { shopeeEndDate } = require("./brtDates");
const { sendToUser } = require("./pushNotify");
const { buildCommissionPush, getPushBaseUrl } = require("./pushPayload");

function fingerprint({ com, lucro, pedidos }) {
  return `${Number(com || 0).toFixed(2)}|${Number(lucro || 0).toFixed(2)}|${Number(pedidos || 0)}`;
}

function parseFp(fp) {
  const [com, lucro, pedidos] = String(fp || "0|0|0").split("|").map(Number);
  return {
    com: Number.isFinite(com) ? com : 0,
    lucro: Number.isFinite(lucro) ? lucro : 0,
    pedidos: Number.isFinite(pedidos) ? pedidos : 0,
  };
}

const RESEND_MIN_INTERVAL_MS = 20 * 60 * 1000; // 20 min entre reenvios no mesmo dia
const RESEND_MIN_ABS = 1.0; // reenviar se com subiu ≥ R$ 1,00
const RESEND_MIN_PCT = 0.05; // ou ≥ 5%

/**
 * Decide se o push de hoje para `dateKey` pode disparar.
 * - sem registro ainda: dispara.
 * - já disparou mas a comissão SUBIU de forma significativa e passou o rate limit: dispara de novo.
 * - caso contrário: bloqueia.
 */
async function alreadyNotified(userId, dateKey, newCom) {
  const sb = getSupabaseAdmin();
  const { data, error } = await sb
    .from("push_notify_state")
    .select("fingerprint, notified_at")
    .eq("user_id", userId)
    .eq("kind", "comissao-ontem")
    .eq("date_key", dateKey)
    .maybeSingle();
  if (error) {
    // Tabela pode não existir ainda — não bloqueia o push
    console.warn("[push] dedup read:", error.message);
    return { blocked: false, reason: "no_state_table" };
  }
  if (!data) return { blocked: false, reason: "first" };

  const prev = parseFp(data.fingerprint);
  const nowCom = Number(newCom || 0);
  const delta = nowCom - prev.com;
  const grew = delta >= RESEND_MIN_ABS || (prev.com > 0 && delta / prev.com >= RESEND_MIN_PCT);
  if (!grew) {
    return { blocked: true, reason: `no_growth prev=${prev.com} new=${nowCom}` };
  }

  const lastMs = data.notified_at ? Date.parse(data.notified_at) : 0;
  const sinceMs = Date.now() - lastMs;
  if (lastMs && sinceMs < RESEND_MIN_INTERVAL_MS) {
    return { blocked: true, reason: `too_recent ${Math.round(sinceMs / 1000)}s` };
  }

  return { blocked: false, reason: `grew prev=${prev.com} new=${nowCom} delta=${delta.toFixed(2)}` };
}

async function markNotified(userId, dateKey, fp) {
  const sb = getSupabaseAdmin();
  const { error } = await sb.from("push_notify_state").upsert(
    {
      user_id: userId,
      kind: "comissao-ontem",
      date_key: dateKey,
      fingerprint: fp,
      notified_at: new Date().toISOString(),
    },
    { onConflict: "user_id,kind,date_key" },
  );
  if (error) console.warn("[push] dedup write:", error.message);
}

/**
 * @param {string} userId
 * @param {{ email?: string, baseUrl?: string, force?: boolean, req?: object }} [opts]
 */
async function notifyYesterdayCommission(userId, opts = {}) {
  const yesterday = shopeeEndDate();
  const email = opts.email || "";
  const baseUrl = opts.baseUrl || getPushBaseUrl(opts.req);
  const force = !!opts.force;

  let com = 0;
  let lucro = 0;
  let venda = 0;
  let pedidos = 0;

  await runWithUser({ id: userId, email }, async () => {
    const dash = await buildDashboard({
      startDate: yesterday,
      endDate: yesterday,
      persist: false,
      persistSubIds: false,
    });
    com = Number(dash.kpis?.comissao || 0);
    lucro = Number(dash.kpis?.lucro || 0);
    venda = Number(dash.kpis?.faturamento || 0);
    pedidos = Number(dash.kpis?.pedidos || 0);
  });

  if (com <= 0) {
    console.log(`[push] skip ${email || userId}: comissão ontem (${yesterday}) = 0`);
    return { sent: false, reason: "com_zero", date: yesterday, com, lucro, venda, pedidos };
  }

  const fp = fingerprint({ com, lucro, pedidos });
  if (!force) {
    const dedup = await alreadyNotified(userId, yesterday, com);
    if (dedup.blocked) {
      console.log(`[push] skip ${email || userId}: ${yesterday} ${dedup.reason}`);
      return { sent: false, reason: dedup.reason, date: yesterday, com, lucro, venda, pedidos };
    }
    console.log(`[push] dedup pass ${email || userId}: ${yesterday} ${dedup.reason}`);
  }

  const payload = buildCommissionPush({
    com,
    lucro,
    venda,
    pedidos,
    date: yesterday,
    baseUrl,
  });

  // Aquece o banner na Vercel antes do celular tentar baixar
  if (payload.image) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 15000);
      await fetch(payload.image, { signal: ctrl.signal, cache: "no-cache" });
      clearTimeout(t);
      console.log("[push] banner aquecido");
    } catch (e) {
      console.warn("[push] banner warm falhou:", e.message || e);
    }
  }

  const results = await sendToUser(userId, payload);
  const subCount = Array.isArray(results) ? results.length : 0;
  if (!results) {
    console.warn(`[push] não enviado ${email || userId}: VAPID ausente ou sem subscription`);
    return { sent: false, reason: "no_vapid_or_subs", date: yesterday, com, lucro, venda, pedidos };
  }

  await markNotified(userId, yesterday, fp);
  console.log(`[push] enviado ${email || userId}: ${yesterday} com=${com} lucro=${lucro} venda=${venda} subs=${subCount}`);
  return { sent: true, date: yesterday, com, lucro, venda, pedidos, subs: subCount };
}

module.exports = { notifyYesterdayCommission, fingerprint };
