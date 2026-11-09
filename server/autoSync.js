"use strict";

/**
 * Sync automático Shopee + Meta.
 * - ontem:  só o dia fechado (ontem BRT) — rápido, manhã cedo + push
 * - recent: últimos 3 dias até ontem + push se comissão de ontem subiu
 * - daily:  últimos 7 dias + grava SubIDs (sem push)
 *
 * Agenda GCP: ontem a cada 10 min (05–09h); recent 15 min (dia todo); daily 04h + manhã.
 */

const { getSupabaseAdmin, runWithUser } = require("./auth");
const { buildDashboard } = require("./metrics");
const { syncMetaDaily, metaCredentialsPublic } = require("./meta");
const { credentialsPublic } = require("./store");
const { shopeeEndDate, brtSubtractDays } = require("./brtDates");
const { notifyYesterdayCommission } = require("./pushCommission");
const { atualizarTodosBackupsDoUsuario } = require("./backup");

const LOCAL_INTERVAL_MS = Number(process.env.AUTO_SYNC_INTERVAL_MS || 2 * 60 * 60 * 1000);
const LOCAL_BOOT_DELAY_MS = Number(process.env.AUTO_SYNC_BOOT_DELAY_MS || 20_000);

function normalizeMode(mode) {
  const m = String(mode || "daily").toLowerCase();
  if (m === "ontem" || m === "yesterday" || m === "y") return "ontem";
  if (m === "recent" || m === "r") return "recent";
  return "daily";
}

function rangeForMode(mode) {
  const until = shopeeEndDate();
  const syncMode = normalizeMode(mode);
  if (syncMode === "ontem") {
    return { since: until, until, days: 1 };
  }
  const daysBack = syncMode === "recent" ? 2 : 6; // 3 dias ou 7 dias até ontem BRT
  const since = brtSubtractDays(daysBack, until);
  return { since, until, days: daysBack + 1 };
}

async function listSyncTargets() {
  const sb = getSupabaseAdmin();
  const { data: profiles, error: pErr } = await sb
    .from("user_profiles")
    .select("user_id, email, status, role")
    .or("status.eq.approved,role.eq.admin");
  if (pErr) throw new Error(pErr.message);

  const { data: creds, error: cErr } = await sb
    .from("app_credentials")
    .select("user_id, app_id");
  if (cErr) throw new Error(cErr.message);

  const credSet = new Set(
    (creds || []).filter((c) => String(c.app_id || "").trim()).map((c) => c.user_id),
  );

  return (profiles || [])
    .filter((p) => p.status === "approved" || p.role === "admin")
    .filter((p) => credSet.has(p.user_id))
    .map((p) => ({
      id: p.user_id,
      email: p.email || "",
    }));
}

async function syncOneUser(user, { since, until, persistSubIds = false }) {
  const out = { email: user.email, shopee: null, meta: null, error: null };
  await runWithUser({ id: user.id, email: user.email }, async () => {
    const shopee = await credentialsPublic(user.id);
    if (!shopee.configured) {
      out.error = "Shopee não configurada";
      return;
    }

    let metaResult = null;
    try {
      const metaCred = await metaCredentialsPublic(user.id);
      if (metaCred.configured) {
        metaResult = await syncMetaDaily({ since, until }, user.id);
      }
    } catch (e) {
      metaResult = { error: e.message || String(e) };
    }

    // daily (7d): grava SubIDs — campanhas/Meta/Pin/Orgânico leem subid_metrics.
    // recent (3d): só daily_metrics, para não apagar snapshot de janela maior.
    const dash = await buildDashboard({
      startDate: since,
      endDate: until,
      persist: true,
      persistSubIds: Boolean(persistSubIds),
    });

    out.shopee = {
      nodes: dash.nodes,
      fat: dash.kpis?.faturamento,
      com: dash.kpis?.comissao,
      pedidos: dash.kpis?.pedidos,
      persistSubIds: Boolean(persistSubIds),
    };
    out.meta = metaResult && !metaResult.error
      ? { gravados: metaResult.gravados, gasto: metaResult.totais?.gasto }
      : metaResult;
  });
  return out;
}

async function runAutoSync({ mode = "daily" } = {}) {
  const started = Date.now();
  const syncMode = normalizeMode(mode);
  const range = rangeForMode(syncMode);
  const persistSubIds = syncMode === "daily";
  const users = await listSyncTargets();
  const results = [];

  console.log(
    `[autoSync] ${syncMode} ${range.since}→${range.until} · ${users.length} conta(s) · subids=${persistSubIds ? "yes" : "no"}`,
  );

  for (const user of users) {
    try {
      const r = await syncOneUser(user, { ...range, persistSubIds });
      results.push({ ok: !r.error, ...r });
      // Verificação diária dos backups (principal e reservas): preço e comissão
      // atualizados de madrugada, e quedas de comissão viram alerta no Backup.
      if (syncMode === "daily") {
        try {
          const b = await atualizarTodosBackupsDoUsuario(user.id);
          console.log(`[autoSync] ${user.email}: backups verificados ${b.ok}/${b.total}`);
        } catch (e) {
          console.warn(`[autoSync] ${user.email} backups:`, e.message || e);
        }
      }
      console.log(
        `[autoSync] ${user.email}: shopee nodes=${r.shopee?.nodes ?? "—"} meta=${r.meta?.gravados ?? r.meta?.error ?? "skip"}`,
      );
      // Push de comissão de ontem: no "ontem" (manhã) e no "recent" (dia todo,
      // a cada 15 min). Dedup em pushCommission só reenvia se a comissão SUBIU
      // (≥ R$1 ou ≥5%) e passou 20 min — assim o celular acompanha conversões
      // que caem depois das 09h, não só o primeiro aviso ~07h.
      if (!r.error && (syncMode === "ontem" || syncMode === "recent")) {
        try {
          await notifyYesterdayCommission(user.id, { email: user.email });
        } catch (e) {
          console.warn(`[push] ${user.email}:`, e.message || e);
        }
      }
    } catch (e) {
      const msg = e.message || String(e);
      results.push({ ok: false, email: user.email, error: msg });
      console.warn(`[autoSync] ${user.email} falhou:`, msg);
    }
  }

  return {
    ok: results.every((r) => r.ok),
    mode: syncMode,
    range,
    users: users.length,
    elapsedMs: Date.now() - started,
    results,
  };
}

function cronAuthorized(req) {
  const secret = String(process.env.CRON_SECRET || "").trim();
  const auth = String(req.headers.authorization || "").trim();
  const headerSecret = String(req.headers["x-cron-secret"] || "").trim();
  if (secret && auth === `Bearer ${secret}`) return true;
  if (secret && headerSecret === secret) return true;
  if (String(req.headers["x-vercel-cron"] || "") === "1") return true;
  // Cloud Run / Cloud Functions: exige secret
  if (process.env.K_SERVICE || process.env.FUNCTION_TARGET) return false;
  if (!process.env.VERCEL && !secret) return true;
  return false;
}

let _localTimer = null;
function startLocalAutoSync() {
  if (process.env.VERCEL) return;
  if (process.env.AUTO_SYNC_DISABLE === "1") {
    console.log("[autoSync] desligado (AUTO_SYNC_DISABLE=1)");
    return;
  }
  if (_localTimer) return;

  const kick = (mode) => {
    runAutoSync({ mode }).catch((e) => console.warn("[autoSync] job:", e.message || e));
  };

  setTimeout(() => kick("recent"), LOCAL_BOOT_DELAY_MS);
  _localTimer = setInterval(() => kick("recent"), LOCAL_INTERVAL_MS);
  if (_localTimer.unref) _localTimer.unref();
  console.log(
    `[autoSync] local: 1ª rodada em ${Math.round(LOCAL_BOOT_DELAY_MS / 1000)}s, depois a cada ${Math.round(LOCAL_INTERVAL_MS / 3600000)}h`,
  );
}

module.exports = {
  runAutoSync,
  cronAuthorized,
  startLocalAutoSync,
  rangeForMode,
  normalizeMode,
};
