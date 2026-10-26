"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const {
  credentialsPublic,
  saveCredentials,
  loadCredentials,
  loadDashboardFromDb,
  loadOrders,
  loadProducts,
  loadSettings,
  saveSettings,
  attachMenuPreviews,
  loadMenuOrders,
  slimDashForClient,
  loadSubidDaily,
  attachMtdKpis,
} = require("./store");
const { testCredentials, clearCredsCache } = require("./shopee");
const { buildDashboard } = require("./metrics");
const { enrichDashboardWithAds } = require("./finance");
const {
  metaCredentialsPublic,
  saveMetaCredentials,
  testMetaCredentials,
  syncMetaDaily,
  loadCampaigns,
} = require("./meta");
const { importPinterestCsv } = require("./pinterest");
const { importShopeeClicksCsv } = require("./shopeeClicks");
const {
  claudeCredentialsPublic,
  saveClaudeCredentials,
  testClaudeCredentials,
  chatClaude,
} = require("./claude");
const {
  lookupProduto,
  salvarBackup,
  listarBackups,
  removerBackup,
  editarBackupMeta,
  atualizarBackup,
  atualizarBackupsEmLote,
  atualizarGrupoBackup,
  buscarSimilaresDaLoja,
  criarGrupo,
  listarGruposCompletos,
  adicionarBackupAoGrupo,
  removerBackupDoGrupo,
  trocarPrincipal,
  removerGrupo,
  getBackupDashboardStats,
  getGarimpoLocal,
  getRadarRecompra,
  searchProdutosApi,
  generateAffiliateShortLink,
  radarSupercomissoes,
  garimpoContextual,
} = require("./backup");
const { runAutoSync, cronAuthorized, startLocalAutoSync } = require("./autoSync");
const { saveSubscription, getPublicKey } = require("./pushNotify");
const { latestJob, runUserDashboardSync } = require("./syncJobs");
const {
  runWithUser,
  verifyAccessToken,
  registerUser,
  loginUser,
  getUser,
} = require("./auth");
const {
  requireApprovedUser,
  requireAdmin,
  listProfiles,
  getUserDetail,
  setProfileStatus,
  deleteUserAccount,
  adminStats,
  profilePublic,
  ADMIN_EMAIL,
} = require("./profiles");
const { clampDashRange, shopeeEndDate } = require("./brtDates");

const PORT = Number(process.env.PORT || 3790);
const PUBLIC_DIR = path.join(__dirname, "..", "public");

function loadEnvFile() {
  const envPath = path.join(__dirname, "..", ".env");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i < 0) continue;
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!process.env[k]) process.env[k] = v;
  }
}
loadEnvFile();

if (!process.env.VERCEL) {
  try {
    const { ensureConfigSchema } = require("./ensureDb");
    ensureConfigSchema().catch((err) => console.warn("[boot schema]", err.message));
  } catch (err) {
    console.warn("[boot schema]", err.message);
  }
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body));
}

function sendText(res, status, text, type = "text/plain; charset=utf-8", extraHeaders = {}) {
  res.writeHead(status, { "Content-Type": type, ...extraHeaders });
  res.end(text);
}

function contentType(filePath) {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".js")) return "application/javascript; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".png")) return "image/png";
  if (filePath.endsWith(".svg")) return "image/svg+xml";
  if (filePath.endsWith(".woff2")) return "font/woff2";
  return "application/octet-stream";
}

function cacheHeadersFor(filePath) {
  if (filePath.endsWith(".html")) return { "Cache-Control": "no-cache" };
  if (/\.(js|css)$/.test(filePath)) {
    if (!process.env.VERCEL) {
      return { "Cache-Control": "no-store" };
    }
    return { "Cache-Control": "public, max-age=3600, stale-while-revalidate=86400" };
  }
  if (/\.(png|svg|jpg|jpeg|webp|woff2|ico)$/.test(filePath)) {
    return { "Cache-Control": "public, max-age=86400, stale-while-revalidate=604800" };
  }
  return { "Cache-Control": "public, max-age=300" };
}

function serveStatic(req, res, pathname) {
  let rel = pathname === "/" ? "/index.html" : pathname;
  if (rel === "/app" || rel === "/app/") rel = "/app.html";
  if (rel === "/admin" || rel === "/admin/") rel = "/admin.html";
  rel = decodeURIComponent(rel).replace(/\.\./g, "");
  const filePath = path.join(PUBLIC_DIR, rel);
  if (!filePath.startsWith(PUBLIC_DIR) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    sendText(res, 404, "Not found");
    return;
  }
  const stat = fs.statSync(filePath);
  const etag = `W/"${stat.size}-${stat.mtimeMs}"`;
  if (req.headers["if-none-match"] === etag) {
    res.writeHead(304, { ETag: etag, ...cacheHeadersFor(filePath) });
    res.end();
    return;
  }
  res.writeHead(200, {
    "Content-Type": contentType(filePath),
    ETag: etag,
    ...cacheHeadersFor(filePath),
  });
  fs.createReadStream(filePath).pipe(res);
}

const MAX_BODY_BYTES = 40 * 1024 * 1024;

async function readRawBody(req) {
  if (Buffer.isBuffer(req.rawBody)) return req.rawBody;
  if (typeof req.rawBody === "string") return Buffer.from(req.rawBody, "utf8");
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY_BYTES) {
      const err = new Error("Payload grande demais (máx. 40 MB)");
      err.code = "PAYLOAD_TOO_LARGE";
      throw err;
    }
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

async function readBody(req) {
  const buf = await readRawBody(req);
  const raw = buf.toString("utf8");
  if (!raw) return {};
  const ct = String(req.headers["content-type"] || "");
  if (ct.includes("multipart/form-data")) return { _raw: raw, _ct: ct };
  try {
    return JSON.parse(raw);
  } catch {
    return { _text: raw };
  }
}

function extractMultipartFile(raw, contentType) {
  const m = String(contentType || "").match(/boundary=(.+)$/i);
  if (!m) return null;
  const boundary = m[1].trim();
  const parts = raw.split(`--${boundary}`);
  for (const part of parts) {
    if (!part.includes("Content-Disposition") || part.includes('filename=""')) continue;
    if (!/filename="/i.test(part)) continue;
    const idx = part.indexOf("\r\n\r\n");
    if (idx < 0) continue;
    let body = part.slice(idx + 4);
    if (body.endsWith("\r\n")) body = body.slice(0, -2);
    if (body.endsWith("--")) body = body.slice(0, -2);
    return body;
  }
  return null;
}

function bearer(req) {
  const h = String(req.headers.authorization || "");
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : "";
}

const PUBLIC_API = new Set([
  "/api/health",
  "/api/auth/login",
  "/api/auth/register",
  "/api/cron/sync",
  "/api/push/banner.png",
  "/api/billing/plans",
  "/api/billing/checkout",
  "/api/billing/webhook",
]);

async function requestHandler(req, res) {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const { pathname } = url;

    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      });
      res.end();
      return;
    }

    if (pathname === "/api/health") {
      sendJson(res, 200, {
        ok: true,
        multiUser: true,
        supabase: Boolean(process.env.SUPABASE_URL),
      });
      return;
    }

    if (pathname === "/api/billing/webhook" && req.method === "POST") {
      try {
        const { constructEvent, handleWebhookEvent } = require("./stripeBilling");
        const raw = await readRawBody(req);
        const sig = req.headers["stripe-signature"];
        const event = constructEvent(raw, sig);
        const result = await handleWebhookEvent(event);
        sendJson(res, 200, { received: true, result: result || null });
      } catch (err) {
        console.warn("[stripe webhook]", err.message || err);
        sendJson(res, err.code === "STRIPE_NOT_CONFIGURED" ? 503 : 400, {
          success: false,
          error: err.message || String(err),
          code: err.code || "WEBHOOK_ERROR",
        });
      }
      return;
    }

    if (pathname === "/api/billing/plans" && req.method === "GET") {
      try {
        const { listPlans } = require("./stripeBilling");
        sendJson(res, 200, { success: true, plans: listPlans() });
      } catch (err) {
        sendJson(res, 500, { success: false, error: err.message });
      }
      return;
    }

    if (pathname === "/api/billing/checkout" && req.method === "POST") {
      try {
        const { createCheckoutSession } = require("./stripeBilling");
        const body = await readBody(req);
        let userId = null;
        let email = body.email || null;
        const token = bearer(req);
        if (token) {
          const user = await verifyAccessToken(token);
          if (user) {
            userId = user.id;
            email = email || user.email;
          }
        }
        const result = await createCheckoutSession({
          priceId: body.priceId || body.plan || body.planId,
          userId,
          email,
          req,
        });
        sendJson(res, 200, { success: true, ...result });
      } catch (err) {
        const status = err.code === "STRIPE_NOT_CONFIGURED" ? 503
          : err.code === "INVALID_PRICE" ? 400
            : 400;
        sendJson(res, status, {
          success: false,
          error: err.message || String(err),
          code: err.code || "CHECKOUT_ERROR",
        });
      }
      return;
    }

    if (pathname === "/api/cron/sync" && (req.method === "GET" || req.method === "POST")) {
      if (!cronAuthorized(req)) {
        sendJson(res, 401, { success: false, error: "unauthorized", code: "CRON_UNAUTHORIZED" });
        return;
      }
      const mode = String(url.searchParams.get("mode") || "daily").toLowerCase();
      try {
        const result = await runAutoSync({ mode });
        sendJson(res, 200, { success: true, ...result });
      } catch (err) {
        sendJson(res, 500, { success: false, error: err.message || String(err) });
      }
      return;
    }

    if (pathname === "/api/push/public-key" && req.method === "GET") {
      sendJson(res, 200, { key: getPublicKey() });
      return;
    }

    if (pathname === "/api/push/banner.png" && req.method === "GET") {
      try {
        const { renderCommissionBannerPng } = require("./pushBanner");
        const com = Number(url.searchParams.get("com") || 0);
        const lucro = Number(url.searchParams.get("lucro") || 0);
        const venda = Number(url.searchParams.get("venda") || 0);
        const pedidos = Number(url.searchParams.get("pedidos") || 0);
        const date = String(url.searchParams.get("d") || "");
        const buf = await renderCommissionBannerPng({ com, lucro, venda, pedidos, date });
        res.writeHead(200, {
          "Content-Type": "image/png",
          "Cache-Control": "public, max-age=600, s-maxage=600, stale-while-revalidate=86400",
          "Access-Control-Allow-Origin": "*",
        });
        res.end(buf);
      } catch (err) {
        sendJson(res, 500, { error: err.message || String(err) });
      }
      return;
    }

    if (pathname === "/api/auth/register" && req.method === "POST") {
      const body = await readBody(req);
      try {
        if (!body.email || !body.password || String(body.password).length < 6) {
          sendJson(res, 400, { success: false, error: "Email e senha (mín. 6) obrigatórios" });
          return;
        }
        const result = await registerUser(body.email, body.password, {
          displayName: body.displayName || body.name,
          company: body.company,
          shopee: {
            appId: body.appId || body.shopeeAppId,
            secret: body.secret || body.shopeeSecret,
          },
          meta: {
            accessToken: body.metaToken || body.accessToken,
            adAccountIds: body.metaAccounts || body.adAccountIds,
            apiVersion: body.metaVersion || body.apiVersion || "v19.0",
          },
        });
        if (result.pendingApproval) {
          sendJson(res, 200, {
            success: true,
            pendingApproval: true,
            user: result.user,
            shopeeOk: Boolean(result.shopeeTest?.ok),
            metaOk: Boolean(result.metaTest?.ok),
            metaWarning: result.metaTest?.warning || null,
            message: result.metaTest?.ok
              ? "Conta criada. Escolha um plano em / para liberar o acesso, ou aguarde aprovação."
              : "Conta criada. Escolha um plano em / para liberar o acesso, ou aguarde aprovação.",
          });
          return;
        }
        sendJson(res, 200, {
          success: true,
          pendingApproval: false,
          user: result.user,
          access_token: result.session.access_token,
          refresh_token: result.session.refresh_token,
          expires_at: result.session.expires_at,
        });
      } catch (err) {
        sendJson(res, 400, { success: false, error: err.message });
      }
      return;
    }

    if (pathname === "/api/auth/login" && req.method === "POST") {
      const body = await readBody(req);
      try {
        const result = await loginUser(body.email, body.password);
        sendJson(res, 200, {
          success: true,
          user: result.user,
          access_token: result.session.access_token,
          refresh_token: result.session.refresh_token,
          expires_at: result.session.expires_at,
        });
      } catch (err) {
        const code = err.code || "UNAUTHORIZED";
        const status = code === "PENDING_APPROVAL" || code === "ACCOUNT_BLOCKED" ? 403 : 401;
        sendJson(res, status, {
          success: false,
          error: err.message,
          code,
          profile: err.profile || null,
        });
      }
      return;
    }

    if (pathname.startsWith("/api/") && !PUBLIC_API.has(pathname)) {
      const token = bearer(req);
      const user = await verifyAccessToken(token);
      if (!user) {
        sendJson(res, 401, { success: false, error: "Faça login para continuar", code: "UNAUTHORIZED" });
        return;
      }

      await runWithUser(user, async () => {
        if (pathname === "/api/auth/me" && req.method === "GET") {
          sendJson(res, 200, { success: true, user: getUser() });
          return;
        }

        if (pathname === "/api/billing/portal" && req.method === "POST") {
          try {
            await requireApprovedUser();
            const { createPortalSession } = require("./stripeBilling");
            const { getProfile } = require("./profiles");
            const profile = await getProfile(require("./auth").requireUserId());
            const result = await createPortalSession({
              customerId: profile?.stripe_customer_id,
              req,
            });
            sendJson(res, 200, { success: true, ...result });
          } catch (err) {
            const status = err.code === "UNAUTHORIZED" ? 401
              : err.code === "NO_STRIPE_CUSTOMER" || err.code === "STRIPE_NOT_CONFIGURED" ? 400
                : err.code === "PENDING_APPROVAL" || err.code === "ACCOUNT_BLOCKED" ? 403
                  : 400;
            sendJson(res, status, {
              success: false,
              error: err.message || String(err),
              code: err.code || "PORTAL_ERROR",
            });
          }
          return;
        }

        // Admin APIs
        if (pathname.startsWith("/api/admin/")) {
          try {
            await requireAdmin();
          } catch (err) {
            sendJson(res, err.code === "FORBIDDEN" ? 403 : 403, {
              success: false,
              error: err.message,
              code: err.code || "FORBIDDEN",
            });
            return;
          }

          if (pathname === "/api/admin/overview" && req.method === "GET") {
            const overview = await adminStats();
            sendJson(res, 200, { success: true, adminEmail: ADMIN_EMAIL, ...overview });
            return;
          }

          if (pathname === "/api/admin/users" && req.method === "GET") {
            const status = url.searchParams.get("status") || "all";
            const q = url.searchParams.get("q") || "";
            const users = await listProfiles({ status, q });
            sendJson(res, 200, { success: true, users });
            return;
          }

          if (pathname.startsWith("/api/admin/users/") && req.method === "GET") {
            const userId = pathname.replace("/api/admin/users/", "").split("/")[0];
            const detail = await getUserDetail(userId);
            if (!detail) {
              sendJson(res, 404, { success: false, error: "Usuário não encontrado" });
              return;
            }
            sendJson(res, 200, { success: true, ...detail });
            return;
          }

          if (pathname.startsWith("/api/admin/users/") && pathname.endsWith("/status") && req.method === "POST") {
            const userId = pathname.replace("/api/admin/users/", "").replace("/status", "");
            const body = await readBody(req);
            try {
              const updated = await setProfileStatus(userId, body.status, {
                notes: body.notes,
                adminId: user.id,
              });
              sendJson(res, 200, { success: true, user: profilePublic(updated) });
            } catch (err) {
              sendJson(res, 400, { success: false, error: err.message });
            }
            return;
          }

          if (pathname.startsWith("/api/admin/users/") && pathname.endsWith("/delete") && req.method === "POST") {
            const userId = pathname.replace("/api/admin/users/", "").replace("/delete", "");
            try {
              const result = await deleteUserAccount(userId, user.id);
              sendJson(res, 200, { success: true, ...result });
            } catch (err) {
              sendJson(res, 400, { success: false, error: err.message });
            }
            return;
          }

          sendJson(res, 404, { error: "not_found" });
          return;
        }

        // Demais APIs exigem conta aprovada
        try {
          await requireApprovedUser();
        } catch (err) {
          sendJson(res, 403, {
            success: false,
            error: err.message,
            code: err.code || "ACCOUNT_BLOCKED",
            profile: err.profile || null,
          });
          return;
        }

        if (pathname === "/api/credentials" && req.method === "GET") {
          sendJson(res, 200, await credentialsPublic());
          return;
        }

        if (pathname === "/api/credentials" && req.method === "POST") {
          const body = await readBody(req);
          try {
            const saved = await saveCredentials({ appId: body.appId, secret: body.secret });
            clearCredsCache(user.id);
            sendJson(res, 200, {
              success: true,
              ...saved,
              message: saved.reset
                ? "Sua API Shopee trocou — só os seus dados foram resetados. Sincronize de novo."
                : "Credenciais Shopee salvas na sua conta.",
            });
          } catch (err) {
            sendJson(res, 400, { success: false, error: err.message });
          }
          return;
        }

        if (pathname === "/api/credentials/test" && req.method === "POST") {
          try {
            const { appId, secret } = await loadCredentials();
            if (!appId || !secret) {
              sendJson(res, 400, { success: false, error: "Credenciais não configuradas" });
              return;
            }
            const result = await testCredentials();
            sendJson(res, 200, { success: true, ...result });
          } catch (err) {
            sendJson(res, 400, { success: false, error: err.message || String(err) });
          }
          return;
        }

        if (pathname === "/api/meta/credentials" && req.method === "GET") {
          sendJson(res, 200, { success: true, ...(await metaCredentialsPublic()) });
          return;
        }

        if (pathname === "/api/meta/credentials" && req.method === "POST") {
          const body = await readBody(req);
          try {
            const saved = await saveMetaCredentials({
              accessToken: body.accessToken,
              adAccountIds: body.adAccountIds,
              apiVersion: body.apiVersion,
            });
            sendJson(res, 200, { success: true, ...saved, message: "Credenciais Meta salvas na sua conta." });
          } catch (err) {
            sendJson(res, 400, { success: false, error: err.message });
          }
          return;
        }

        if (pathname === "/api/meta/test" && req.method === "POST") {
          try {
            const result = await testMetaCredentials();
            sendJson(res, 200, { success: true, ...result });
          } catch (err) {
            sendJson(res, 400, { success: false, error: err.message || String(err) });
          }
          return;
        }

        if (pathname === "/api/meta/sync" && req.method === "POST") {
          const body = await readBody(req);
          try {
            const daysBack = Number(body.daysBack || url.searchParams.get("days") || 7);
            const since = body.since || url.searchParams.get("since") || null;
            const until = body.until || url.searchParams.get("until") || shopeeEndDate();
            const result = await syncMetaDaily({ daysBack, since, until });
            sendJson(res, 200, { success: true, ...result });
          } catch (err) {
            sendJson(res, 500, { success: false, error: err.message || String(err) });
          }
          return;
        }

        if (pathname === "/api/pinterest/import" && req.method === "POST") {
          const body = await readBody(req);
          try {
            let text = body.csv || body._text || "";
            if (body._raw && body._ct) text = extractMultipartFile(body._raw, body._ct) || text;
            if (!text.trim()) {
              sendJson(res, 400, { success: false, error: "Envie o CSV" });
              return;
            }
            const result = await importPinterestCsv(text);
            sendJson(res, 200, { success: true, ...result });
          } catch (err) {
            sendJson(res, 400, { success: false, error: err.message || String(err) });
          }
          return;
        }

        if (pathname === "/api/shopee/clicks-import" && req.method === "POST") {
          const body = await readBody(req);
          try {
            let text = body.csv || body._text || "";
            if (body._raw && body._ct) text = extractMultipartFile(body._raw, body._ct) || text;
            if (!text.trim()) {
              sendJson(res, 400, { success: false, error: "Envie o CSV de cliques Shopee" });
              return;
            }
            const result = await importShopeeClicksCsv(text);
            sendJson(res, 200, { success: true, ...result });
          } catch (err) {
            sendJson(res, 400, { success: false, error: err.message || String(err) });
          }
          return;
        }

        if (pathname === "/api/settings" && req.method === "GET") {
          sendJson(res, 200, { success: true, ...(await loadSettings()) });
          return;
        }

        if (pathname === "/api/settings" && req.method === "POST") {
          const body = await readBody(req);
          try {
            const s = await saveSettings(body);
            sendJson(res, 200, { success: true, ...s });
          } catch (err) {
            sendJson(res, 400, { success: false, error: err.message });
          }
          return;
        }

        if (pathname === "/api/ai/credentials" && req.method === "GET") {
          sendJson(res, 200, { success: true, ...(await claudeCredentialsPublic()) });
          return;
        }

        if (pathname === "/api/ai/credentials" && req.method === "POST") {
          const body = await readBody(req);
          try {
            const saved = await saveClaudeCredentials({
              apiKey: body.apiKey ?? body.claudeApiKey,
              model: body.model ?? body.claudeModel,
            });
            sendJson(res, 200, { success: true, ...saved });
          } catch (err) {
            sendJson(res, 400, { success: false, error: err.message || String(err) });
          }
          return;
        }

        if (pathname === "/api/ai/test" && req.method === "POST") {
          try {
            const r = await testClaudeCredentials();
            sendJson(res, 200, { success: true, ...r });
          } catch (err) {
            sendJson(res, 400, { success: false, error: err.message || String(err) });
          }
          return;
        }

        if (pathname === "/api/ai/chat" && req.method === "POST") {
          const body = await readBody(req);
          try {
            const startDate = body.start || body.startDate || url.searchParams.get("start");
            const endDate = body.end || body.endDate || url.searchParams.get("end");
            const r = await chatClaude({
              message: body.message || body.prompt,
              history: body.history || body.messages,
              startDate,
              endDate,
            });
            sendJson(res, 200, { success: true, ...r });
          } catch (err) {
            sendJson(res, 400, { success: false, error: err.message || String(err) });
          }
          return;
        }

        if (pathname === "/api/subid-daily" && req.method === "GET") {
          const subid = url.searchParams.get("subid") || "";
          const { startDate, endDate } = clampDashRange(url.searchParams.get("start"), url.searchParams.get("end"));
          try {
            const daily = await loadSubidDaily(subid, startDate, endDate);
            sendJson(res, 200, { success: true, subid, daily });
          } catch (err) {
            sendJson(res, 400, { success: false, error: err.message });
          }
          return;
        }

        if (pathname === "/api/sync" && req.method === "POST") {
          const body = await readBody(req);
          const { startDate, endDate } = clampDashRange(body.start || body.startDate, body.end || body.endDate);
          try {
            const current = await latestJob();
            if (current.status === "running") {
              sendJson(res, 202, { success: true, status: "running", already: true });
              return;
            }
            const { markJob } = require("./syncJobs");
            await markJob(require("./auth").requireUserId(), startDate, endDate, "running");
            sendJson(res, 202, { success: true, status: "running" });
          } catch (err) {
            sendJson(res, 400, { success: false, error: err.message });
          }
          return;
        }

        if (pathname === "/api/sync/status" && req.method === "GET") {
          try {
            sendJson(res, 200, { success: true, ...(await latestJob()) });
          } catch (err) {
            sendJson(res, 400, { success: false, error: err.message });
          }
          return;
        }

        if (pathname === "/api/push/test" && req.method === "POST") {
          try {
            const userId = require("./auth").requireUserId();
            const { notifyYesterdayCommission } = require("./pushCommission");
            const { getPushBaseUrl } = require("./pushPayload");
            const result = await notifyYesterdayCommission(userId, {
              force: true,
              baseUrl: getPushBaseUrl(req),
              req,
            });
            sendJson(res, 200, { success: true, ...result });
          } catch (err) {
            sendJson(res, 400, { success: false, error: err.message });
          }
          return;
        }

        if (pathname === "/api/push/subscribe" && req.method === "POST") {
          try {
            const body = await readBody(req);
            const userId = require("./auth").requireUserId();
            console.log("[push] subscribe userId:", userId, "endpoint:", body?.endpoint?.slice(0, 60));
            await saveSubscription(userId, body);
            console.log("[push] gravado com sucesso");
            sendJson(res, 200, { success: true });
          } catch (err) {
            console.warn("[push] subscribe erro:", err.message);
            sendJson(res, 400, { success: false, error: err.message });
          }
          return;
        }

        if (pathname === "/api/sync/worker" && req.method === "POST") {
          const body = await readBody(req);
          const { startDate, endDate } = clampDashRange(body.start || body.startDate, body.end || body.endDate);
          try {
            const result = await runUserDashboardSync({ startDate, endDate });
            sendJson(res, 200, result);
          } catch (err) {
            sendJson(res, 500, { success: false, error: err.message || String(err) });
          }
          return;
        }

        if (pathname === "/api/subid-ops" && req.method === "GET") {
          const { loadSubidOps } = require("./subidOps");
          sendJson(res, 200, { success: true, ops: await loadSubidOps() });
          return;
        }

        if (pathname === "/api/subid-ops" && req.method === "POST") {
          const body = await readBody(req);
          try {
            const { upsertSubidOps } = require("./subidOps");
            const row = await upsertSubidOps(body.subid, {
              canal: body.canal,
              status: body.status,
              produto: body.produto,
              status_source: body.status_source,
            });
            sendJson(res, 200, { success: true, ...row });
          } catch (err) {
            sendJson(res, 400, { success: false, error: err.message });
          }
          return;
        }

        if (pathname === "/api/backup/lookup" && req.method === "POST") {
          const body = await readBody(req);
          try {
            const result = await lookupProduto(body.url || "");
            sendJson(res, 200, result);
          } catch (err) {
            sendJson(res, err.code === "product_not_found" ? 404 : 400, {
              success: false,
              error: err.message,
              code: err.code,
            });
          }
          return;
        }

        if (pathname === "/api/backup" && req.method === "GET") {
          try {
            const items = await listarBackups();
            sendJson(res, 200, { success: true, items });
          } catch (err) {
            sendJson(res, 500, { success: false, error: err.message, code: err.code });
          }
          return;
        }

        if (pathname === "/api/backup" && req.method === "POST") {
          const body = await readBody(req);
          try {
            const row = await salvarBackup(body.produto, {
              apelido: body.apelido,
              marcadoPrincipal: body.marcadoPrincipal,
            });
            sendJson(res, 200, { success: true, item: row });
          } catch (err) {
            sendJson(res, 400, { success: false, error: err.message });
          }
          return;
        }

        if (pathname === "/api/backup/refresh" && req.method === "POST") {
          const body = await readBody(req);
          try {
            const result = await atualizarBackup(body.itemId);
            sendJson(res, 200, result);
          } catch (err) {
            sendJson(res, 400, { success: false, error: err.message, code: err.code });
          }
          return;
        }

        if (pathname === "/api/backup/refresh-all" && req.method === "POST") {
          const body = await readBody(req);
          try {
            let ids = Array.isArray(body.itemIds) ? body.itemIds : null;
            if (!ids || !ids.length) {
              const items = await listarBackups();
              ids = items.map((b) => b.itemId);
            }
            const results = await atualizarBackupsEmLote(ids);
            const sucesso = results.filter((r) => r.ok).length;
            sendJson(res, 200, { success: true, results, sucesso, total: results.length });
          } catch (err) {
            sendJson(res, 400, { success: false, error: err.message });
          }
          return;
        }

        if (pathname === "/api/backup/stats" && req.method === "GET") {
          try {
            const stats = await getBackupDashboardStats();
            sendJson(res, 200, { success: true, stats });
          } catch (err) {
            sendJson(res, 500, { success: false, error: err.message });
          }
          return;
        }

        if (pathname === "/api/backup/garimpo" && req.method === "GET") {
          try {
            const data = await getGarimpoLocal(80);
            sendJson(res, 200, { success: true, ...data });
          } catch (err) {
            sendJson(res, 500, { success: false, error: err.message });
          }
          return;
        }

        if (pathname === "/api/backup/recompra" && req.method === "GET") {
          try {
            const data = await getRadarRecompra(40);
            sendJson(res, 200, { success: true, ...data });
          } catch (err) {
            sendJson(res, 500, { success: false, error: err.message });
          }
          return;
        }

        if (pathname === "/api/backup/grupos/refresh" && req.method === "POST") {
          const body = await readBody(req);
          try {
            const result = await atualizarGrupoBackup(body.grupoId);
            sendJson(res, 200, { success: true, ...result });
          } catch (err) {
            sendJson(res, 400, { success: false, error: err.message });
          }
          return;
        }

        if (pathname === "/api/backup/meta" && req.method === "POST") {
          const body = await readBody(req);
          try {
            await editarBackupMeta(body.itemId, {
              apelido: body.apelido,
              marcadoPrincipal: body.marcadoPrincipal,
            });
            sendJson(res, 200, { success: true });
          } catch (err) {
            sendJson(res, 400, { success: false, error: err.message });
          }
          return;
        }

        if (pathname === "/api/backup/delete" && req.method === "POST") {
          const body = await readBody(req);
          try {
            await removerBackup(body.itemId);
            sendJson(res, 200, { success: true });
          } catch (err) {
            sendJson(res, 400, { success: false, error: err.message });
          }
          return;
        }

        if (pathname === "/api/backup/similares" && req.method === "POST") {
          const body = await readBody(req);
          try {
            const items = await buscarSimilaresDaLoja(
              body.loja,
              body.excluirItemId || null,
              undefined,
              body.shopId || null,
            );
            sendJson(res, 200, { success: true, items });
          } catch (err) {
            sendJson(res, 400, { success: false, error: err.message });
          }
          return;
        }

        if (pathname === "/api/backup/search" && req.method === "POST") {
          const body = await readBody(req);
          try {
            const result = await searchProdutosApi(body.keyword || "", {
              shopId: body.shopId || null,
              limit: Number(body.limit) || 20,
            });
            sendJson(res, 200, { success: true, ...result });
          } catch (err) {
            sendJson(res, 400, { success: false, error: err.message });
          }
          return;
        }

        if (pathname === "/api/backup/garimpo-contextual" && req.method === "POST") {
          const body = await readBody(req);
          try {
            const result = await garimpoContextual(body || {});
            sendJson(res, 200, { success: true, ...result });
          } catch (err) {
            sendJson(res, 400, { success: false, error: err.message });
          }
          return;
        }

        if (pathname === "/api/radar-supercomissoes" && req.method === "GET") {
          const cred = await credentialsPublic();
          if (!cred.configured) {
            sendJson(res, 400, {
              success: false,
              error: "Configure a sua API Shopee em Configurações.",
              code: "CREDS_MISSING",
            });
            return;
          }
          try {
            const result = await radarSupercomissoes({
              keyword: url.searchParams.get("keyword") || "",
              min: Number(url.searchParams.get("min") || 15),
              page: Number(url.searchParams.get("page") || 1),
              limit: Number(url.searchParams.get("limit") || 50),
            });
            sendJson(res, 200, { success: true, ...result });
          } catch (err) {
            sendJson(res, 400, { success: false, error: err.message });
          }
          return;
        }

        if (pathname === "/api/backup/shortlink" && req.method === "POST") {
          const body = await readBody(req);
          try {
            const link = await generateAffiliateShortLink(body.originUrl || "", body.subIds || []);
            sendJson(res, 200, { success: true, ...link });
          } catch (err) {
            sendJson(res, 400, { success: false, error: err.message });
          }
          return;
        }

        if (pathname === "/api/backup/grupos" && req.method === "GET") {
          try {
            const grupos = await listarGruposCompletos();
            sendJson(res, 200, { success: true, grupos });
          } catch (err) {
            sendJson(res, 500, { success: false, error: err.message });
          }
          return;
        }

        if (pathname === "/api/backup/grupos" && req.method === "POST") {
          const body = await readBody(req);
          try {
            const g = await criarGrupo(body.nome, body.principalItemId);
            sendJson(res, 200, { success: true, grupo: g });
          } catch (err) {
            sendJson(res, 400, { success: false, error: err.message });
          }
          return;
        }

        if (pathname === "/api/backup/grupos/add" && req.method === "POST") {
          const body = await readBody(req);
          try {
            await adicionarBackupAoGrupo(body.grupoId, body.itemId);
            sendJson(res, 200, { success: true });
          } catch (err) {
            sendJson(res, 400, { success: false, error: err.message });
          }
          return;
        }

        if (pathname === "/api/backup/grupos/remove-item" && req.method === "POST") {
          const body = await readBody(req);
          try {
            await removerBackupDoGrupo(body.grupoId, body.itemId);
            sendJson(res, 200, { success: true });
          } catch (err) {
            sendJson(res, 400, { success: false, error: err.message });
          }
          return;
        }

        if (pathname === "/api/backup/grupos/swap" && req.method === "POST") {
          const body = await readBody(req);
          try {
            await trocarPrincipal(body.grupoId, body.novoPrincipalItemId, body.motivo || "");
            sendJson(res, 200, { success: true });
          } catch (err) {
            sendJson(res, 400, { success: false, error: err.message });
          }
          return;
        }

        if (pathname === "/api/backup/grupos/delete" && req.method === "POST") {
          const body = await readBody(req);
          try {
            await removerGrupo(body.grupoId);
            sendJson(res, 200, { success: true });
          } catch (err) {
            sendJson(res, 400, { success: false, error: err.message });
          }
          return;
        }

        if (pathname === "/api/orders" && req.method === "GET") {
          try {
            const { startDate, endDate } = clampDashRange(url.searchParams.get("start"), url.searchParams.get("end"));
            const orders = await loadOrders({ startDate, endDate, limit: 500 });
            sendJson(res, 200, { success: true, orders });
          } catch (err) {
            sendJson(res, 500, { success: false, error: err.message });
          }
          return;
        }

        if (pathname === "/api/products" && req.method === "GET") {
          try {
            const products = await loadProducts({ limit: 500 });
            sendJson(res, 200, { success: true, products });
          } catch (err) {
            sendJson(res, 500, { success: false, error: err.message });
          }
          return;
        }

        if (pathname === "/api/campaigns" && req.method === "GET") {
          try {
            const { startDate, endDate } = clampDashRange(url.searchParams.get("start"), url.searchParams.get("end"));
            const campaigns = await loadCampaigns(startDate, endDate);
            sendJson(res, 200, { success: true, campaigns });
          } catch (err) {
            sendJson(res, 500, { success: false, error: err.message });
          }
          return;
        }

        if (pathname === "/api/dashboard" && req.method === "GET") {
          const { startDate, endDate } = clampDashRange(url.searchParams.get("start"), url.searchParams.get("end"));
          const force = url.searchParams.get("force") === "1";
          const cred = await credentialsPublic();
          if (!cred.configured) {
            sendJson(res, 400, {
              success: false,
              error: "Configure a sua API Shopee em Configuração.",
              code: "CREDS_MISSING",
            });
            return;
          }
          try {
            if (force) {
              sendJson(res, 202, {
                success: true,
                status: "running",
                error: "Use POST /api/sync + worker; GET force não puxa Shopee neste caminho.",
                code: "USE_ASYNC_SYNC",
              });
              return;
            }

            const [fromDbRes, ordersRes] = await Promise.all([
              loadDashboardFromDb(startDate, endDate),
              loadMenuOrders(startDate, endDate).catch((e) => {
                console.warn("[dashboard] orders:", e.message);
                return [];
              }),
            ]);
            let fromDb = fromDbRes;
            if (fromDb) {
              fromDb = await attachMenuPreviews(fromDb, startDate, endDate, undefined, {
                preloadedOrders: ordersRes,
              });
              fromDb = await enrichDashboardWithAds(fromDb, undefined, {
                persistSubIds: false,
                persistDaily: false,
              });
              fromDb = slimDashForClient(fromDb);
              sendJson(res, 200, { success: true, cached: true, ...fromDb });
              return;
            }

            sendJson(res, 200, {
              success: true,
              cached: true,
              empty: true,
              range: { startDate, endDate },
              kpis: {},
              daily: [],
              subIds: [],
              dailyByChannel: { meta: [], pinterest: [], organico: [] },
            });
          } catch (err) {
            sendJson(res, 500, { success: false, error: err.message || String(err), partial: true });
          }
          return;
        }

        sendJson(res, 404, { error: "not_found" });
      });
      return;
    }

    if (pathname.startsWith("/api/")) {
      sendJson(res, 404, { error: "not_found" });
      return;
    }

    serveStatic(req, res, pathname);
  } catch (err) {
    if (err?.code === "PAYLOAD_TOO_LARGE") {
      sendJson(res, 413, { success: false, error: err.message, code: "PAYLOAD_TOO_LARGE" });
      return;
    }
    sendJson(res, 500, { error: err.message || String(err) });
  }
}

module.exports = requestHandler;

// Local / Railway / Render: sobe HTTP server
// Vercel: usa o export serverless (api/index.js)
if (!process.env.VERCEL) {
  process.on("unhandledRejection", (err) => {
    console.error("[unhandledRejection]", err);
  });
  process.on("uncaughtException", (err) => {
    console.error("[uncaughtException]", err);
  });
  const server = http.createServer((req, res) => {
    Promise.resolve(requestHandler(req, res)).catch((err) => {
      try {
        sendJson(res, 500, { error: err.message || String(err) });
      } catch (_) { /* ignore */ }
    });
  });
  server.listen(PORT, () => {
    console.log(`\n  Teste de Shopylitcs - http://localhost:${PORT}`);
    console.log(`  Auth: login/registro por conta`);
    console.log(`  Cada usuário: Shopee + Meta + dados isolados\n`);
    startLocalAutoSync();
    // ── FIM TESTE TEMPORÁRIO ──

  });
}
