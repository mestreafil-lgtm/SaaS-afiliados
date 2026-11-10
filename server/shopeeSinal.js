"use strict";

/**
 * Detecta início, término e retomada da atualização da comissão de ontem na Shopee.
 *
 * Regras:
 * - Início: a primeira vez que a comissão de ontem passa de zero (uma vez por dia).
 * - Mudança: sempre que o valor OU a quantidade de pedidos muda.
 * - Término: 20 min sem nenhuma mudança depois de uma mudança.
 * - Retomada: se houver mudança depois de um término, avisa de novo.
 *   No máximo MAX_RETOMADAS_DIA avisos de retomada por dia; depois disso,
 *   o sistema segue atualizando os dados, mas não manda mais aviso no dia.
 *
 * Função pura: recebe o estado anterior, o valor, a quantidade de pedidos e a hora,
 * e devolve o novo estado e o aviso a enviar (ou null).
 */

const JANELA_PARADA_MS = 20 * 60 * 1000;
const MAX_RETOMADAS_DIA = 3;

function estadoInicial() {
  return {
    iniciadoEm: null,
    ultimoValor: 0,
    ultimosPedidos: 0,
    ultimaMudancaEm: null,
    aberto: false,
    retomadas: 0,
    silencioso: false,
  };
}

function decidirSinal(estadoAnterior, comissao, pedidos, agoraMs) {
  const estado = { ...estadoInicial(), ...(estadoAnterior || {}) };
  const valor = Number(comissao || 0);
  const qtd = Number(pedidos || 0);

  if (!estado.iniciadoEm) {
    if (valor > 0) {
      const novo = {
        ...estado,
        iniciadoEm: agoraMs,
        aberto: true,
        ultimoValor: valor,
        ultimosPedidos: qtd,
        ultimaMudancaEm: agoraMs,
      };
      return { estado: novo, notificar: { tipo: "inicio", valor, em: agoraMs } };
    }
    return { estado, notificar: null };
  }

  const mudou = valor !== estado.ultimoValor || qtd !== estado.ultimosPedidos;

  if (mudou) {
    const base = { ...estado, ultimoValor: valor, ultimosPedidos: qtd, ultimaMudancaEm: agoraMs };
    if (estado.aberto) {
      return { estado: base, notificar: null };
    }
    // Estava fechada (já houve término): é uma retomada.
    if (estado.silencioso || estado.retomadas >= MAX_RETOMADAS_DIA) {
      return { estado: { ...base, aberto: true, silencioso: true }, notificar: null };
    }
    const retomadas = estado.retomadas + 1;
    return {
      estado: { ...base, aberto: true, retomadas, silencioso: retomadas >= MAX_RETOMADAS_DIA ? true : false },
      notificar: { tipo: "retomada", valor, em: agoraMs },
    };
  }

  if (estado.aberto && agoraMs - estado.ultimaMudancaEm >= JANELA_PARADA_MS) {
    const fechado = { ...estado, aberto: false };
    if (estado.silencioso) return { estado: fechado, notificar: null };
    return {
      estado: fechado,
      notificar: { tipo: "fim", valor: estado.ultimoValor, em: agoraMs },
    };
  }

  return { estado, notificar: null };
}

module.exports = { decidirSinal, estadoInicial, JANELA_PARADA_MS, MAX_RETOMADAS_DIA };
