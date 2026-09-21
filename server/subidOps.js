"use strict";

const { getSupabase } = require("./supabase");
const { requireUserId, requestCached, invalidateRequestCache } = require("./auth");

const CANAIS = new Set(["meta", "pinterest", "organico", "indefinido"]);
const STATUS_SOURCES = new Set(["manual", "meta", "pinterest"]);
const CLASSIFIED_CANAIS = new Set(["meta", "pinterest", "organico"]);

function normalizeStatus(status) {
  if (status == null || status === "") return null;
  const s = String(status).trim().toLowerCase();
  if (s === "pausada" || s === "desativada") return "desativada";
  if (s === "teste") return "teste";
  if (s === "ativa") return "ativa";
  return s;
}

function normalizeCanal(canal) {
  if (canal == null || canal === "") return null;
  const s = String(canal).trim().toLowerCase();
  if (CANAIS.has(s)) return s;
  return null;
}

function normalizeStatusSource(source) {
  if (source == null || source === "") return null;
  const s = String(source).trim().toLowerCase();
  return STATUS_SOURCES.has(s) ? s : null;
}

function isClassifiedCanal(canal) {
  return CLASSIFIED_CANAIS.has(normalizeCanal(canal));
}

/** Canal já classificado pelo cliente — sync não pode rebaixar pra indefinido. */
function isCanalLocked(prev = {}) {
  if (isClassifiedCanal(prev.canal)) return true;
  return isManualStatusLocked(prev);
}

/** Chave canônica em subid_ops — sempre minúscula (evita duplicata Unha001/unha001). */
function opsSubidKey(subid) {
  return String(subid || "").trim().toLowerCase();
}

/**
 * Escolhe o próximo canal em upserts em massa (CSV/sync).
 * Nunca apaga nem troca meta/pin/orgânico — só a UI (upsertSubidOps) reclassifica.
 */
function resolveNextCanal(prev, incoming) {
  const prevCanal = normalizeCanal(prev.canal);
  if (incoming === undefined) return prevCanal;
  const next = normalizeCanal(incoming);
  if (isClassifiedCanal(prevCanal)) {
    // Não rebaixa pra indefinido nem troca de canal (ex.: CSV Pin roubando Meta/orgânico)
    if (!next || next === "indefinido" || next !== prevCanal) return prevCanal;
  }
  return next;
}

/** Em duplicatas por case, preferir classificação real + status manual. */
function preferOpsRow(a, b) {
  if (!a) return b;
  if (!b) return a;
  // Manual sempre ganha (classificação do cliente na UI)
  const aManual = a.status_source === "manual" || a.status === "teste";
  const bManual = b.status_source === "manual" || b.status === "teste";
  if (aManual && !bManual) return a;
  if (bManual && !aManual) return b;
  const aClass = isClassifiedCanal(a.canal);
  const bClass = isClassifiedCanal(b.canal);
  if (aClass && !bClass) return a;
  if (bClass && !aClass) return b;
  // Mesmo canal: preferir quem tem status preenchido
  if (b.status && !a.status) return b;
  return a;
}

/** Remove variantes de caixa legadas (Unha001) após gravar chave canônica. */
async function deleteCaseVariants(userId, keys) {
  const list = [...new Set((Array.isArray(keys) ? keys : [keys]).map(opsSubidKey).filter(Boolean))];
  if (!list.length) return;
  const supabase = getSupabase();
  try {
    const want = new Set(list);
    const { data, error } = await supabase
      .from("subid_ops")
      .select("subid")
      .eq("user_id", userId);
    if (error || !data?.length) return;
    const dupes = data.filter((r) => {
      const raw = String(r.subid || "");
      const low = raw.toLowerCase();
      return want.has(low) && raw !== low;
    });
    for (const d of dupes) {
      await supabase
        .from("subid_ops")
        .delete()
        .eq("user_id", userId)
        .eq("subid", d.subid);
    }
  } catch (_) { /* ignore */ }
}

/** Status manual / teste / legado com valor setado — sync Meta/Pin não sobrescreve. */
function isManualStatusLocked(prev = {}) {
  if (prev.status_source === "manual" || prev.status === "teste") return true;
  // Legado: status preenchido antes de status_source existir = escolha do cliente
  return Boolean(prev.status && !prev.status_source);
}

/** Status operacional global por SubID — nunca inferido por gasto ou período. */
function resolveSubidStatus(op = {}, _row = {}) {
  if (op.status != null && op.status !== "") {
    let status = op.status;
    if (status === "pausada") status = "desativada";
    return normalizeStatus(status);
  }
  // Sem registro em subid_ops: conservador (campanha antiga / sem sinal → desativada)
  return "desativada";
}

async function loadSubidOps(userId = requireUserId()) {
  return requestCached(`loadSubidOps:${userId}`, async () => {
    const supabase = getSupabase();
    try {
      // Pagina em blocos: PostgREST corta em 1000 e conta acima disso perdia
      // op.status/canal manuais, fazendo campanha desativada voltar como ativa.
      const pageSize = 1000;
      const maxPages = 50;
      const map = {};
      for (let page = 0; page < maxPages; page++) {
        const from = page * pageSize;
        const to = from + pageSize - 1;
        const { data, error } = await supabase
          .from("subid_ops")
          .select("*")
          .eq("user_id", userId)
          .order("subid", { ascending: true })
          .range(from, to);
        if (error) throw error;
        const rows = data || [];
        for (const r of rows) {
          const rawStatus = r.status || null;
          const key = opsSubidKey(r.subid);
          if (!key) continue;
          const incoming = {
            canal: r.canal || null,
            status: rawStatus === "pausada" ? "desativada" : rawStatus,
            produto: r.produto || null,
            status_source: normalizeStatusSource(r.status_source) || null,
          };
          // Duplicata Unha001 vs unha001: não deixar indefinido sobrescrever classificado
          map[key] = preferOpsRow(map[key], incoming);
        }
        if (rows.length < pageSize) break;
      }
      return map;
    } catch (e) {
      // Nunca devolver {} — senão o dashboard trata tudo como indefinido/inferido
      console.error("[subidOps] load falhou:", e.message);
      throw e;
    }
  });
}

async function upsertSubidOps(subid, partial, userId = requireUserId()) {
  const key = opsSubidKey(subid);
  if (!key) throw new Error("SubID obrigatório");
  const supabase = getSupabase();
  const prevMap = await loadSubidOps(userId);
  const prev = prevMap[key] || {};
  const nextStatus =
    partial.status != null ? normalizeStatus(partial.status) : normalizeStatus(prev.status);
  const nextCanal =
    partial.canal !== undefined
      ? normalizeCanal(partial.canal)
      : normalizeCanal(prev.canal);

  // UI: status OU canal classificado → trava manual (sync não apaga)
  let nextSource = normalizeStatusSource(prev.status_source);
  if (partial.status_source !== undefined) {
    nextSource = normalizeStatusSource(partial.status_source);
  } else if (partial.status != null) {
    nextSource = "manual";
  } else if (partial.canal != null && isClassifiedCanal(partial.canal)) {
    nextSource = "manual";
  }

  const row = {
    user_id: userId,
    subid: key,
    canal: nextCanal,
    status: nextStatus,
    produto: partial.produto != null ? partial.produto : prev.produto,
    status_source: nextSource,
    updated_at: new Date().toISOString(),
  };
  let { error } = await supabase.from("subid_ops").upsert(row, { onConflict: "user_id,subid" });
  if (error && /status_source|indefinido|canal/i.test(error.message || "")) {
    try {
      const { ensureConfigSchema } = require("./ensureDb");
      await ensureConfigSchema();
    } catch (_) { /* ignore */ }
    ({ error } = await supabase.from("subid_ops").upsert(row, { onConflict: "user_id,subid" }));
  }
  // Coluna status_source ainda inexistente: grava sem ela
  if (error && /status_source/i.test(error.message || "")) {
    const { status_source: _drop, ...legacy } = row;
    ({ error } = await supabase.from("subid_ops").upsert(legacy, { onConflict: "user_id,subid" }));
  }
  if (error) throw new Error(error.message);
  await deleteCaseVariants(userId, [key]);
  invalidateRequestCache(`loadSubidOps:${userId}`);
  return row;
}

async function upsertSubidOpsMany(rows, userId = requireUserId()) {
  const list = (rows || []).filter((r) => r && r.subid);
  if (!list.length) return 0;
  const prevMap = await loadSubidOps(userId);
  const now = new Date().toISOString();
  const payload = list.map((r) => {
    const key = opsSubidKey(r.subid);
    const prev = prevMap[key] || {};
    const locked = isManualStatusLocked(prev);
    let nextStatus = normalizeStatus(prev.status);
    if (r.status != null && !locked) {
      nextStatus = normalizeStatus(r.status);
    }
    let statusSource = normalizeStatusSource(prev.status_source);
    if (locked) {
      statusSource = normalizeStatusSource(prev.status_source) || "manual";
    } else if (r.status_source !== undefined) {
      statusSource = normalizeStatusSource(r.status_source);
    } else if (r.status != null) {
      statusSource = normalizeStatusSource(r.status_source_hint) || statusSource;
    }
    const nextCanal =
      r.canal !== undefined ? resolveNextCanal(prev, r.canal) : normalizeCanal(prev.canal);
    return {
      user_id: userId,
      subid: key,
      canal: nextCanal,
      status: nextStatus,
      produto: r.produto != null ? r.produto : (prev.produto || null),
      status_source: statusSource,
      updated_at: now,
    };
  }).filter((r) => r.subid);
  const supabase = getSupabase();
  let error = null;
  for (let i = 0; i < payload.length; i += 200) {
    const chunk = payload.slice(i, i + 200);
    ({ error } = await supabase.from("subid_ops").upsert(chunk, { onConflict: "user_id,subid" }));
    if (error && /status_source|indefinido|canal/i.test(error.message || "")) {
      try {
        const { ensureConfigSchema } = require("./ensureDb");
        await ensureConfigSchema();
      } catch (_) { /* ignore */ }
      ({ error } = await supabase.from("subid_ops").upsert(chunk, { onConflict: "user_id,subid" }));
    }
    if (error && /status_source/i.test(error.message || "")) {
      const legacy = chunk.map(({ status_source: _s, ...rest }) => rest);
      ({ error } = await supabase.from("subid_ops").upsert(legacy, { onConflict: "user_id,subid" }));
    }
    if (error) throw new Error(error.message);
  }
  const keys = [...new Set(payload.map((r) => r.subid).filter(Boolean))];
  await deleteCaseVariants(userId, keys);
  invalidateRequestCache(`loadSubidOps:${userId}`);
  return payload.length;
}

async function persistInferredOps(subIds, userId = requireUserId()) {
  const list = Array.isArray(subIds) ? subIds : [];
  if (!list.length) return 0;
  const opsMap = await loadSubidOps(userId);
  const now = new Date().toISOString();
  const rows = [];
  for (const r of list) {
    const key = opsSubidKey(r.subid);
    if (!key) continue;
    // Já existe qualquer registro em subid_ops — NÃO mexer (nunca sobrescrever classificação)
    if (opsMap[key]) continue;
    const canal = inferCanal(r.subid, r.inv_meta, r.inv_pin);
    if (canal !== "indefinido") continue;
    rows.push({
      user_id: userId,
      subid: key,
      canal: "indefinido",
      status: null,
      status_source: null,
      produto: r.produto || null,
      updated_at: now,
    });
  }
  if (!rows.length) return 0;
  const supabase = getSupabase();
  // ignoreDuplicates: só insere SubIDs novos — nunca sobrescreve meta/pin/orgânico
  let { error } = await supabase.from("subid_ops").upsert(rows, {
    onConflict: "user_id,subid",
    ignoreDuplicates: true,
  });
  if (error && /status_source|indefinido|canal/i.test(error.message || "")) {
    try {
      const { ensureConfigSchema } = require("./ensureDb");
      await ensureConfigSchema();
    } catch (_) { /* ignore */ }
    ({ error } = await supabase.from("subid_ops").upsert(rows, {
      onConflict: "user_id,subid",
      ignoreDuplicates: true,
    }));
  }
  if (error && /status_source/i.test(error.message || "")) {
    const legacy = rows.map(({ status_source: _s, ...rest }) => rest);
    ({ error } = await supabase.from("subid_ops").upsert(legacy, {
      onConflict: "user_id,subid",
      ignoreDuplicates: true,
    }));
  }
  if (error) {
    console.warn("[subidOps] persist indefinidos:", error.message);
    return 0;
  }
  invalidateRequestCache(`loadSubidOps:${userId}`);
  return rows.length;
}

function inferCanal(subid, invMeta, invPin) {
  const invM = Number(invMeta || 0);
  const invP = Number(invPin || 0);
  // Canal pago só com gasto real (Meta API / CSV Pin)
  if (invM > 0 && invP <= 0) return "meta";
  if (invP > 0 && invM <= 0) return "pinterest";
  // Sem sinal claro de canal pago: cai como indefinido para o usuário classificar manualmente.
  // "Orgânico" só via classificação manual — nunca inferido.
  return "indefinido";
}

function applyOpsToSubIds(subIds, opsMap) {
  const map = opsMap || {};
  return (subIds || []).map((r) => {
    const key = String(r.subid || "").trim().toLowerCase();
    const hasOps = Object.prototype.hasOwnProperty.call(map, key);
    const op = hasOps ? map[key] : {};
    // Com registro em subid_ops: canal da UI/sync — NÃO re-inferir por gasto do período
    // (isso fazia classificados "sumirem" e voltarem pra indefinidos ao mudar período/CSV).
    const canal = hasOps
      ? (normalizeCanal(op.canal) || "indefinido")
      : inferCanal(r.subid, r.inv_meta, r.inv_pin);
    const status = resolveSubidStatus(op, r);
    return {
      ...r,
      canal,
      status,
      produto: op.produto || r.produto || null,
      status_source: op.status_source || null,
    };
  });
}

module.exports = {
  loadSubidOps,
  upsertSubidOps,
  upsertSubidOpsMany,
  applyOpsToSubIds,
  inferCanal,
  persistInferredOps,
  normalizeStatusSource,
  isManualStatusLocked,
  resolveSubidStatus,
};
