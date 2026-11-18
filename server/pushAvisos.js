"use strict";

/**
 * Push no celular para avisos de comissão (queda ou zerada) do Backup.
 * Usa a mesma infraestrutura de push já existente (sendToUser).
 */

const { sendToUser } = require("./pushNotify");

function textoPushAviso(aviso) {
  const nome = String(aviso?.nome || "Produto").slice(0, 60);
  if (aviso?.tipo === "comissao_zero") {
    return { title: "Comissão zerou", body: `${nome}: saiu do programa (0%).` };
  }
  const de = Number(aviso?.de ?? 0);
  const para = Number(aviso?.para ?? 0);
  return { title: "Comissão caiu", body: `${nome}: de ${de}% para ${para}%.` };
}

async function enviarPushAviso(userId, aviso) {
  try {
    const { title, body } = textoPushAviso(aviso);
    const r = await sendToUser(userId, {
      title,
      body,
      icon: "/assets/shopee.png",
      badge: "/assets/push/shopee-coin-72.png",
      tag: `comissao-${aviso?.itemId || "x"}`,
      url: "/app",
    });
    return { enviado: Array.isArray(r) && r.some((x) => x.status === "fulfilled") };
  } catch (err) {
    console.warn("[push] aviso de comissão falhou:", err.message || err);
    return { enviado: false, motivo: "erro" };
  }
}

module.exports = { enviarPushAviso, textoPushAviso };
