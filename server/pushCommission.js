"use strict";

/**
 * Avisa no celular quando a Shopee começa, termina ou volta a atualizar a comissão de ontem (BRT).
 *
 * Estado do dia fica em push_notify_state (kind 'sinal-estado').
 * Cada aviso enviado fica em push_notify_log (uma linha por aviso, com a hora).
 * A regra de decisão está em shopeeSinal.js (função pura, testada).
 */

const { getSupabaseAdmin, runWithUser } = require("./auth");
const { buildDashboard } = require("./metrics");
const { shopeeEndDate } = require("./brtDates");
const { sendToUser } = require("./pushNotify");
const { buildCommissionPush, getPushBaseUrl } = require("./pushPayload");
const { decidirSinal, estadoInicial } = require("./shopeeSinal");

const KIND_ESTADO = "sinal-estado";

function horaBrt(ms) {
  return new Date(ms).toLocaleTimeString("pt-BR", {
    timeZone: "America/Sao_Paulo",
    hour: "2-digit",
    minute: "2-digit",
  }).replace(":", "h");
}

function textosDoAviso(tipo, valorFmt, hora) {
  if (tipo === "inicio") {
    return { title: "Comissão total Shopee · começou a atualizar", body: `${hora} · R$ ${valorFmt} até agora` };
  }
  if (tipo === "fim") {
    return { title: "Comissão total Shopee · terminou", body: `${hora} · R$ ${valorFmt} no total` };
  }
  return { title: "Comissão total Shopee atualizada novamente", body: `${hora} · R$ ${valorFmt} · valor corrigido` };
}

async function carregarEstado(userId, dateKey) {
  const sb = getSupabaseAdmin();
  const { data, error } = await sb
    .from("push_notify_state")
    .select("fingerprint")
    .eq("user_id", userId)
    .eq("kind", KIND_ESTADO)
    .eq("date_key", dateKey)
    .maybeSingle();
  if (error) {
    console.warn("[push] estado read:", error.message);
    return { estado: estadoInicial(), ok: false };
  }
  if (!data || !data.fingerprint) return { estado: estadoInicial(), ok: true };
  try {
    return { estado: { ...estadoInicial(), ...JSON.parse(data.fingerprint) }, ok: true };
  } catch {
    return { estado: estadoInicial(), ok: true };
  }
}

async function salvarEstado(userId, dateKey, estado) {
  const sb = getSupabaseAdmin();
  const { error } = await sb.from("push_notify_state").upsert(
    {
      user_id: userId,
      kind: KIND_ESTADO,
      date_key: dateKey,
      fingerprint: JSON.stringify(estado),
      notified_at: new Date().toISOString(),
    },
    { onConflict: "user_id,kind,date_key" },
  );
  if (error) console.warn("[push] estado write:", error.message);
}

async function registrarAviso(userId, dateKey, tipo, valor, emMs) {
  const sb = getSupabaseAdmin();
  const { error } = await sb.from("push_notify_log").insert({
    user_id: userId,
    date_key: dateKey,
    tipo,
    valor,
    notificado_em: new Date(emMs).toISOString(),
  });
  if (error) console.warn("[push] log write:", error.message);
}

/**
 * @param {string} userId
 * @param {{ email?: string, baseUrl?: string, req?: object, agoraMs?: number }} [opts]
 */
async function notifyYesterdayCommission(userId, opts = {}) {
  const yesterday = shopeeEndDate();
  const email = opts.email || "";
  const baseUrl = opts.baseUrl || getPushBaseUrl(opts.req);
  const agoraMs = Number(opts.agoraMs || Date.now());

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

  const { estado: anterior, ok } = await carregarEstado(userId, yesterday);
  if (!ok) {
    console.log(`[push] skip ${email || userId}: sem leitura do estado (${yesterday})`);
    return { sent: false, reason: "no_state", date: yesterday, com, lucro, venda, pedidos };
  }

  const { estado, notificar } = decidirSinal(anterior, com, pedidos, agoraMs);

  if (!notificar) {
    await salvarEstado(userId, yesterday, estado);
    console.log(`[push] sem aviso ${email || userId}: ${yesterday} com=${com} pedidos=${pedidos}`);
    return { sent: false, reason: "sem_aviso", date: yesterday, com, lucro, venda, pedidos };
  }

  const { title, body } = textosDoAviso(notificar.tipo, buildCommissionPush({ com: notificar.valor, date: yesterday }).comFmt, horaBrt(notificar.em));
  const payload = {
    ...buildCommissionPush({ com: notificar.valor, lucro, venda, pedidos, date: yesterday, baseUrl }),
    title,
    body,
    tag: `comissao-${notificar.tipo}-${yesterday}`,
  };

  if (payload.image) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 15000);
      await fetch(payload.image, { signal: ctrl.signal, cache: "no-cache" });
      clearTimeout(t);
    } catch (e) {
      console.warn("[push] banner warm falhou:", e.message || e);
    }
  }

  const results = await sendToUser(userId, payload);
  if (!results) {
    console.warn(`[push] não enviado ${email || userId}: VAPID ausente ou sem subscription`);
    return { sent: false, reason: "no_vapid_or_subs", date: yesterday, com, lucro, venda, pedidos };
  }

  if (!results.some((result) => result.status === "fulfilled")) {
    return { sent: false, reason: "delivery_failed", date: yesterday, com, lucro, venda, pedidos };
  }

  await salvarEstado(userId, yesterday, estado);
  await registrarAviso(userId, yesterday, notificar.tipo, notificar.valor, notificar.em);
  console.log(`[push] enviado ${email || userId}: ${yesterday} ${notificar.tipo} com=${notificar.valor}`);
  return { sent: true, tipo: notificar.tipo, date: yesterday, com, lucro, venda, pedidos, subs: results.length };
}

module.exports = { notifyYesterdayCommission, horaBrt, textosDoAviso };
