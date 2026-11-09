"use strict";

const crypto = require("crypto");
const https = require("https");

const SHOPEE_API_URL = "https://open-api.affiliate.shopee.com.br/graphql";
const SHOPEE_PAGE_LIMIT = 500;
const SHOPEE_MAX_PAGES = 1000;
const SHOPEE_PAGE_DELAY_MS = 200;
const SHOPEE_NEW_QUERY_DELAY_MS = Math.max(
  8_000,
  Number(process.env.SHOPEE_NEW_QUERY_DELAY_MS || (process.env.VERCEL ? 15_000 : 31_000)),
);
const SHOPEE_MAX_SCROLL_RESTARTS = 3;
const SHOPEE_CONNECT_TIMEOUT_MS = Number(
  process.env.SHOPEE_CONNECT_TIMEOUT_MS || (process.env.VERCEL ? 20_000 : 60_000),
);
const SHOPEE_FORCE_IPV4 = process.env.SHOPEE_FORCE_IPV4 !== "0";

let _credsCache = new Map();
let _lastNoScrollQueryAt = 0;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function getCredsAsync() {
  const { requireUserId } = require("./auth");
  const userId = requireUserId();
  const cached = _credsCache.get(userId);
  if (cached && Date.now() - cached.at < 5000) return cached.value;
  const { loadCredentials } = require("./store");
  const c = await loadCredentials(userId);
  if (!c.appId || !c.secret) {
    const err = new Error("Configure SHOPEE_APP_ID e SHOPEE_SECRET em Configuração");
    err.code = "SHOPEE_CREDS_MISSING";
    throw err;
  }
  const value = { appId: c.appId, secret: c.secret };
  _credsCache.set(userId, { at: Date.now(), value });
  return value;
}

function clearCredsCache(userId) {
  if (userId) _credsCache.delete(userId);
  else _credsCache.clear();
}

function sign(appId, timestamp, payload, secret) {
  return crypto.createHash("sha256").update(String(appId) + String(timestamp) + payload + String(secret)).digest("hex");
}

async function waitNoScrollInterval() {
  const elapsed = Date.now() - _lastNoScrollQueryAt;
  if (_lastNoScrollQueryAt > 0 && elapsed < SHOPEE_NEW_QUERY_DELAY_MS) {
    await sleep(SHOPEE_NEW_QUERY_DELAY_MS - elapsed);
  }
}

/** POST HTTPS com IPv4 forçado — mesmo padrão do Afiliadoteste (evita timeout IPv6). */
function shopeeHttpsPost(url, headers, body, timeoutMs = SHOPEE_CONNECT_TIMEOUT_MS) {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: u.hostname,
      port: 443,
      path: u.pathname + u.search,
      method: "POST",
      family: 4,
      headers: {
        ...headers,
        "Content-Length": Buffer.byteLength(body),
      },
      timeout: timeoutMs,
    }, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          text: async () => data,
          json: async () => {
            try { return JSON.parse(data); } catch { return {}; }
          },
        });
      });
    });
    req.on("timeout", () => {
      req.destroy();
      reject(Object.assign(new Error(`Connect Timeout (${timeoutMs}ms)`), { code: "ETIMEDOUT" }));
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function shopeeHttpPost(body, headers) {
  if (SHOPEE_FORCE_IPV4) {
    return shopeeHttpsPost(SHOPEE_API_URL, headers, body);
  }
  const { fetchWithTimeout } = require("./httpUtil");
  const res = await fetchWithTimeout(SHOPEE_API_URL, { method: "POST", headers, body }, SHOPEE_CONNECT_TIMEOUT_MS);
  const text = await res.text();
  return {
    ok: res.ok,
    status: res.status,
    text: async () => text,
    json: async () => {
      try { return JSON.parse(text); } catch { return {}; }
    },
  };
}

/**
 * GraphQL assinado — alinhado ao Afiliadoteste:
 * - Signature SHA256(appId + timestamp + body + secret)
 * - Retry em rate limit 10030 (backoff 8s × tentativa)
 * - IPv4 forçado
 */
async function shopeeGraphqlRaw(appId, secret, query, variables = null, { retries = 2 } = {}) {
  const bodyObj = variables ? { query, variables } : { query };
  const body = JSON.stringify(bodyObj);
  let lastErr = null;

  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = sign(appId, timestamp, body, secret);
    try {
      const res = await shopeeHttpPost(body, {
        "Content-Type": "application/json",
        Authorization: `SHA256 Credential=${appId}, Timestamp=${timestamp}, Signature=${signature}`,
      });
      const json = await res.json();
      if (!res.ok) {
        lastErr = new Error(`HTTP ${res.status}: ${JSON.stringify(json).slice(0, 200)}`);
        if (res.status === 429 && attempt <= retries) {
          await sleep(8000 * attempt);
          continue;
        }
        throw lastErr;
      }
      if (json.errors?.length) {
        const msg = json.errors.map((e) => `${e.extensions?.code || "?"}: ${e.message || String(e)}`).join("; ");
        const isRateLimit = json.errors.some((e) => String(e.extensions?.code || "") === "10030")
          || /rate limit|quota|throttl/i.test(msg);
        // 10000 = "System Error" da Shopee: costuma ser passageiro, então tenta de novo
        const isSystemError = json.errors.some((e) => String(e.extensions?.code || "") === "10000");
        lastErr = new Error(msg);
        if (isRateLimit && attempt <= retries) {
          console.warn(`[shopee] rate limit (10030), retry ${attempt}/${retries} em ${8000 * attempt}ms`);
          await sleep(8000 * attempt);
          continue;
        }
        if (isSystemError && attempt <= retries) {
          console.warn(`[shopee] erro 10000 (System Error), retry ${attempt}/${retries} em ${3000 * attempt}ms`);
          await sleep(3000 * attempt);
          continue;
        }
        throw lastErr;
      }
      return json.data || {};
    } catch (err) {
      lastErr = err;
      const code = String(err?.code || "");
      const isTimeout = code === "ETIMEDOUT" || /Connect Timeout|fetch failed/i.test(String(err?.message || ""));
      if (isTimeout && attempt <= retries) {
        await sleep(Math.min(15_000, 2000 * attempt));
        continue;
      }
      if (attempt <= retries && !/Shopee API|HTTP |10010|10020/i.test(String(err?.message || ""))) {
        await sleep(800 * attempt);
        continue;
      }
      throw err;
    }
  }
  throw lastErr || new Error("Falha na API Shopee");
}

async function shopeeGraphql(query, variables = null, opts = {}) {
  const { appId, secret } = await getCredsAsync();
  return shopeeGraphqlRaw(appId, secret, query, variables, opts);
}

async function shopeeGraphqlWithCreds(appId, secret, query, variables = null, opts = {}) {
  const id = String(appId || "").trim();
  const sec = String(secret || "").trim();
  if (!id || !sec) throw new Error("Informe APP_ID e SECRET da Shopee");
  return shopeeGraphqlRaw(id, sec, query, variables, { retries: opts.retries ?? 2 });
}

/** Teste rápido de credencial (conta logada). */
async function testCredentials() {
  const data = await shopeeGraphql(`{
    productOfferV2(page: 1, limit: 1, listType: 0, sortType: 2) {
      nodes { itemId productName priceMin commissionRate }
      pageInfo { hasNextPage }
    }
  }`);
  const node = data?.productOfferV2?.nodes?.[0] || null;
  return { ok: true, sample: node };
}

/** Valida APP_ID + SECRET sem precisar de sessão. */
async function testCredentialsPair(appId, secret) {
  const data = await shopeeGraphqlWithCreds(appId, secret, `{
    productOfferV2(page: 1, limit: 1, listType: 0, sortType: 2) {
      nodes { itemId productName priceMin commissionRate }
      pageInfo { hasNextPage }
    }
  }`);
  const node = data?.productOfferV2?.nodes?.[0] || null;
  return { ok: true, sample: node };
}

function classifyStatus(raw) {
  const s = String(raw || "").toUpperCase().trim();
  if (!s) return "pendente";
  if (s === "COMPLETED" || s.includes("CONCLU") || s.includes("COMPLET") || s.includes("SETTLE") || s.includes("FINISH")) {
    return "concluida";
  }
  if (
    s.includes("CANCEL")
    || s.includes("REFUND")
    || s.includes("FRAUD")
    || s.includes("REJECT")
    || s.includes("VOID")
    || s.includes("INVALID")
    || s === "FAILED"
    || s === "EXPIRED"
  ) {
    return "cancelada";
  }
  if (s === "UNPAID") return "unpaid";
  return "pendente";
}

function parseMoney(v) {
  const n = Number(String(v ?? "0").replace(",", "."));
  return Number.isFinite(n) ? n : 0;
}

/** Comissão do nó = totalCommission (painel Shopee), com fallback capped+seller / itens. */
function nodeCommission(node) {
  let tc = parseMoney(node?.totalCommission);
  if (tc > 0) return tc;
  const capped = parseMoney(node?.shopeeCommissionCapped);
  const seller = parseMoney(node?.sellerCommission);
  if (capped + seller > 0) return capped + seller;
  const orders = Array.isArray(node?.orders) ? node.orders : [];
  let sum = 0;
  for (const ord of orders) {
    for (const it of ord.items || []) {
      sum += parseMoney(it.itemTotalCommission);
    }
  }
  if (sum > 0) return sum;
  return parseMoney(node?.netCommission);
}

function parseSubId(utmContent) {
  const { normalizeShopeeSubId } = require("./normalizeSubId");
  return normalizeShopeeSubId(utmContent) || "organico";
}

/** Início do dia BRT (America/Sao_Paulo ≈ UTC−3): YYYY-MM-DD 00:00:00−03:00 */
function toUnixDayStart(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return Math.floor(Date.UTC(y, m - 1, d, 3, 0, 0) / 1000);
}

/** Fim do dia BRT: YYYY-MM-DD 23:59:59−03:00 */
function toUnixDayEnd(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return Math.floor(Date.UTC(y, m - 1, d + 1, 2, 59, 59) / 1000);
}

function dateFromPurchaseTs(ts) {
  const ms = Number(ts) * 1000 - 3 * 3600 * 1000;
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Query mínima como no Afiliadoteste — SEM enums `: ALL`
 * (orderStatus: ALL / conversionStatus: ALL quebram com DisplayOrderStatus 10010).
 */
function buildConversionQuery(startTs, endTs, scrollId) {
  const scrollClause = scrollId ? `, scrollId: ${JSON.stringify(String(scrollId))}` : "";
  return `{
    conversionReport(
      limit: ${SHOPEE_PAGE_LIMIT},
      purchaseTimeStart: ${startTs},
      purchaseTimeEnd: ${endTs}${scrollClause}
    ) {
      nodes {
        purchaseTime
        clickTime
        conversionId
        totalCommission
        netCommission
        shopeeCommissionCapped
        sellerCommission
        mcnManagementFee
        mcnManagementFeeRate
        linkedMcnName
        referrer
        utmContent
        device
        buyerType
        orders {
          orderId
          orderStatus
          shopType
          items {
            itemId
            itemName
            itemPrice
            actualAmount
            refundAmount
            qty
            completeTime
            fraudStatus
            displayItemStatus
            itemNotes
            itemTotalCommission
            itemSellerCommission
            itemSellerCommissionRate
            itemShopeeCommissionCapped
            itemShopeeCommissionRate
            shopId
            shopName
            attributionType
            channelType
            imageUrl
          }
        }
      }
      pageInfo { hasNextPage scrollId }
    }
  }`;
}

function nodeDedupKey(node) {
  const cid = String(node?.conversionId || "").trim();
  const orderId = String(node?.orders?.[0]?.orderId || "").trim();
  if (cid && orderId) return `${cid}__${orderId}`;
  if (cid) return cid;
  return `__noid_${node?.purchaseTime || ""}_${orderId}`;
}

/**
 * Puxa conversionReport completo no intervalo (scrollId).
 * Espelha shopeePullRange do Afiliadoteste: limit 500, delay 200ms,
 * reinício de scroll, intervalo >30s em nova query sem scrollId.
 */
async function pullConversionReport(startDate, endDate) {
  const startTs = toUnixDayStart(startDate);
  const endTs = toUnixDayEnd(endDate);
  const nodes = [];
  const seen = new Set();
  let scrollId = null;
  let hasNext = true;
  let pages = 0;
  let scrollRestarts = 0;
  let duplicates = 0;

  while (hasNext && pages < SHOPEE_MAX_PAGES) {
    pages += 1;
    if (!scrollId) {
      await waitNoScrollInterval();
      _lastNoScrollQueryAt = Date.now();
    }

    const query = buildConversionQuery(startTs, endTs, scrollId);
    let data;
    try {
      data = await shopeeGraphql(query);
    } catch (err) {
      const msg = String(err?.message || err);
      if (pages === 1 || !/scroll|11001|params/i.test(msg)) throw err;
      scrollRestarts += 1;
      if (scrollRestarts > SHOPEE_MAX_SCROLL_RESTARTS) {
        throw new Error(`Shopee: cadeia scrollId reiniciada ${scrollRestarts}x — abortando. Último erro: ${msg}`);
      }
      console.warn(`[shopee] scroll_expired_restart pág ${pages} (${scrollRestarts}/${SHOPEE_MAX_SCROLL_RESTARTS})`);
      scrollId = null;
      hasNext = true;
      pages = 0;
      continue;
    }

    const report = data?.conversionReport || {};
    const batch = Array.isArray(report.nodes) ? report.nodes : [];
    for (const node of batch) {
      const key = nodeDedupKey(node);
      if (seen.has(key)) {
        duplicates += 1;
        continue;
      }
      seen.add(key);
      nodes.push(node);
    }

    const pi = report.pageInfo || {};
    hasNext = pi.hasNextPage === true;
    const novoScrollId = pi.scrollId || null;

    if (hasNext && novoScrollId === scrollId && novoScrollId !== null) {
      console.warn("[shopee] scrollId repetido — paginação em loop, parando.");
      break;
    }
    scrollId = novoScrollId;
    if (hasNext && !scrollId) {
      console.warn("[shopee] hasNextPage=true mas sem scrollId. Parando.");
      break;
    }
    if (hasNext) await sleep(SHOPEE_PAGE_DELAY_MS);
  }

  if (duplicates > 0) {
    console.warn(`[shopee] ${duplicates} conversões duplicadas removidas no pull`);
  }

  return { nodes, pages, startTs, endTs, duplicates };
}

module.exports = {
  testCredentials,
  testCredentialsPair,
  pullConversionReport,
  classifyStatus,
  parseMoney,
  parseSubId,
  dateFromPurchaseTs,
  nodeCommission,
  getCredsAsync,
  clearCredsCache,
  toUnixDayStart,
  toUnixDayEnd,
  shopeeGraphql,
};
