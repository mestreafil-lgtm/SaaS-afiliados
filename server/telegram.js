// Envio de avisos para o Telegram. Só funciona se TELEGRAM_BOT_TOKEN e TELEGRAM_CHAT_ID
// estiverem configurados no ambiente; sem eles, não faz nada.

async function enviarTelegram(texto) {
  const token = String(process.env.TELEGRAM_BOT_TOKEN || "").trim();
  const chatId = String(process.env.TELEGRAM_CHAT_ID || "").trim();
  if (!token || !chatId) return { enviado: false, motivo: "nao_configurado" };
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: texto, disable_web_page_preview: true }),
    });
    if (!res.ok) return { enviado: false, motivo: `http_${res.status}` };
    return { enviado: true };
  } catch (err) {
    return { enviado: false, motivo: err.message || "erro" };
  }
}

// Monta a mensagem de queda de comissão: produto, valores e data.
function textoAvisoComissao(aviso) {
  const quando = new Date().toLocaleDateString("pt-BR");
  const linhas = [
    `Comissão mudou: ${aviso.nome || aviso.itemId}`,
    `${aviso.de}% → ${aviso.para}%`,
    `Veja no Backup (${quando}).`,
  ];
  return linhas.join("\n");
}

module.exports = { enviarTelegram, textoAvisoComissao };
