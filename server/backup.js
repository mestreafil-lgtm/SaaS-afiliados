"use strict";

const https = require("https");
const { getSupabase } = require("./supabase");
const { requireUserId } = require("./auth");
const { shopeeGraphql } = require("./shopee");

const PRODUCT_OFFER_NODES = `
  itemId shopId productName productLink offerLink
  price priceMin priceMax commissionRate commission sales imageUrl
  ratingStar shopName shopType productCatIds
  periodStartTime periodEndTime sellerCommissionRate shopeeCommissionRate
  priceDiscountRate
`;

function parseShopeeUrl(url) {
  if (!url || typeof url !== "string") return null;
  const cleaned = url.trim();

  let m = cleaned.match(/\/product\/(\d+)\/(\d+)/);
  if (m) return { shopId: m[1], itemId: m[2], isShort: false };

  m = cleaned.match(/-i\.(\d+)\.(\d+)/i);
  if (m) return { shopId: m[1], itemId: m[2], isShort: false };

  const mShop = cleaned.match(/[?&]shop(?:_?id)?=(\d+)/i);
  const mItem = cleaned.match(/[?&]item(?:_?id)?=(\d+)/i);
  if (mShop && mItem) return { shopId: mShop[1], itemId: mItem[1], isShort: false };

  if (/s\.shopee\.com\.br/i.test(cleaned) || /shopee\.com\.br\/s\//i.test(cleaned) || /shp\.ee\//i.test(cleaned)) {
    return { shopId: null, itemId: null, isShort: true, shortUrl: cleaned };
  }
  return null;
}

function httpsGetFollow(url, { maxRedirects = 8, timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    let current = url;
    let left = maxRedirects;

    const go = () => {
      let u;
      try {
        u = new URL(current);
      } catch (err) {
        reject(err);
        return;
      }
      const req = https.request({
        hostname: u.hostname,
        port: 443,
        path: u.pathname + u.search,
        method: "GET",
        family: 4,
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; MetriclyBackup/1.0)",
          Accept: "text/html,application/xhtml+xml",
        },
        timeout: timeoutMs,
      }, (res) => {
        const loc = res.headers.location;
        if (res.statusCode >= 300 && res.statusCode < 400 && loc && left > 0) {
          left -= 1;
          current = new URL(loc, current).toString();
          res.resume();
          go();
          return;
        }
        res.resume();
        resolve({ status: res.statusCode, url: current });
      });
      req.on("timeout", () => {
        req.destroy();
        reject(Object.assign(new Error("Timeout ao resolver URL Shopee"), { code: "ETIMEDOUT" }));
      });
      req.on("error", reject);
      req.end();
    };
    go();
  });
}

async function resolveShopeeProductUrl(url) {
  let parsed = parseShopeeUrl(url);
  if (parsed && !parsed.isShort) return parsed;

  const target = parsed?.shortUrl || url;
  try {
    const r = await httpsGetFollow(target);
    const finalParsed = parseShopeeUrl(r.url);
    if (finalParsed && !finalParsed.isShort) return finalParsed;
  } catch (err) {
    if (parsed?.isShort) {
      const e = new Error("Falha ao resolver link curto da Shopee. Cole a URL completa /product/SHOP/ITEM.");
      e.code = "short_url_resolve_failed";
      e.cause = err;
      throw e;
    }
  }

  if (parsed?.isShort) {
    const err = new Error("Não foi possível extrair shopId/itemId do link curto. Abra o produto e copie a URL completa.");
    err.code = "short_url_resolve_failed";
    throw err;
  }
  return null;
}

function toComissaoPct(rate) {
  const n = Number(rate || 0);
  if (!Number.isFinite(n) || n <= 0) return 0;
  // API docs: "0.0123" = 1.23%
  const pct = n > 0 && n <= 1 ? n * 100 : n;
  return Math.round(pct * 100) / 100;
}

const imagemCache = new Map();

async function imagemOferta(itemId) {
  const id = String(itemId || "").replace(/\D/g, "");
  if (!id) return "";
  if (imagemCache.has(id)) return imagemCache.get(id);
  try {
    const query = `{
      productOfferV2(itemId: ${Number(id)}) {
        nodes { imageUrl itemId }
      }
    }`;
    const data = await shopeeGraphql(query);
    const url = String(data?.productOfferV2?.nodes?.[0]?.imageUrl || "").trim();
    imagemCache.set(id, url);
    return url;
  } catch (_) {
    imagemCache.set(id, "");
    return "";
  }
}

async function hidratarImagens(lista) {
  const alvos = (lista || []).filter((p) => p && !p.imagem && p.itemId).slice(0, 36);
  if (!alvos.length) return;
  let cursor = 0;
  const worker = async () => {
    while (cursor < alvos.length) {
      const item = alvos[cursor];
      cursor += 1;
      item.imagem = await imagemOferta(item.itemId);
    }
  };
  const n = Math.min(5, alvos.length);
  await Promise.race([
    Promise.all(Array.from({ length: n }, () => worker())),
    new Promise((resolve) => setTimeout(resolve, 12000)),
  ]);
}

function normalizeShopeeProduct(node) {
  const preco = Number(node.price || node.priceMin || 0);
  const comissaoShopee = toComissaoPct(node.shopeeCommissionRate);
  const comissaoVendedor = toComissaoPct(node.sellerCommissionRate);
  const comissaoTotal = toComissaoPct(node.commissionRate) || Math.round((comissaoShopee + comissaoVendedor) * 100) / 100;
  return {
    itemId: String(node.itemId || ""),
    shopId: String(node.shopId || ""),
    nome: String(node.productName || ""),
    preco,
    precoMin: Number(node.priceMin || 0),
    precoMax: Number(node.priceMax || 0),
    comissao_pct: comissaoTotal,
    comissaoShopee,
    comissaoVendedor,
    comissao_valor: Number(node.commission || 0),
    vendas_shopee: Number(node.sales || 0),
    imagem: String(node.imageUrl || ""),
    rating: Number(node.ratingStar || 0),
    loja: String(node.shopName || ""),
    shopType: Array.isArray(node.shopType) ? node.shopType : [],
    categoriaIds: Array.isArray(node.productCatIds) ? node.productCatIds : [],
    linkProduto: String(node.productLink || ""),
    linkAfiliado: String(node.offerLink || ""),
    periodoInicio: node.periodStartTime ? Number(node.periodStartTime) : null,
    periodoFim: node.periodEndTime ? Number(node.periodEndTime) : null,
    desconto_pct: Number(node.priceDiscountRate || 0),
  };
}

async function queryProductOffer(itemId, shopId) {
  const iid = Number(itemId);
  const sid = Number(shopId);
  if (!iid || !sid) return null;

  const query = `{
    productOfferV2(itemId: ${iid}, shopId: ${sid}) {
      nodes { ${PRODUCT_OFFER_NODES} }
      pageInfo { page limit hasNextPage }
    }
  }`;
  const data = await shopeeGraphql(query);
  const nodes = data?.productOfferV2?.nodes || [];
  if (nodes.length) return nodes[0];

  try {
    const q2 = `{
      productOfferV2(itemId: ${iid}) {
        nodes { ${PRODUCT_OFFER_NODES} }
      }
    }`;
    const data2 = await shopeeGraphql(q2);
    const nodes2 = data2?.productOfferV2?.nodes || [];
    return nodes2.find((n) => String(n.shopId) === String(shopId)) || nodes2[0] || null;
  } catch (_) {
    return null;
  }
}

async function queryProductOffersByShop(shopId, { page = 1, limit = 50, sortType = 5 } = {}) {
  const sid = Number(shopId);
  if (!sid) return { nodes: [], pageInfo: {} };
  const query = `{
    productOfferV2(shopId: ${sid}, sortType: ${Number(sortType) || 5}, page: ${page}, limit: ${Math.min(50, limit)}) {
      nodes { ${PRODUCT_OFFER_NODES} }
      pageInfo { page limit hasNextPage scrollId }
    }
  }`;
  const data = await shopeeGraphql(query);
  return data?.productOfferV2 || { nodes: [], pageInfo: {} };
}

async function queryProductOffersByKeyword(keyword, { shopId = null, page = 1, limit = 20, sortType = 1, listType = 0 } = {}) {
  const termo = String(keyword || "").trim();
  if (!termo) return { nodes: [], pageInfo: {} };
  const shopClause = shopId ? `, shopId: ${Number(shopId)}` : "";
  const query = `{
    productOfferV2(keyword: ${JSON.stringify(termo)}${shopClause}, listType: ${Number(listType) || 0}, sortType: ${Number(sortType) || 1}, page: ${page}, limit: ${Math.min(50, limit)}) {
      nodes { ${PRODUCT_OFFER_NODES} }
      pageInfo { page limit hasNextPage }
    }
  }`;
  const data = await shopeeGraphql(query);
  return data?.productOfferV2 || { nodes: [], pageInfo: {} };
}

async function queryCommissionFeed({ page = 1, limit = 50, listType = 0 } = {}) {
  const query = `{
    productOfferV2(listType: ${Number(listType) || 0}, sortType: 5, page: ${page}, limit: ${Math.min(50, limit)}) {
      nodes { ${PRODUCT_OFFER_NODES} }
      pageInfo { page limit hasNextPage }
    }
  }`;
  const data = await shopeeGraphql(query);
  return data?.productOfferV2 || { nodes: [], pageInfo: {} };
}

function toRadarProduto(p) {
  const shopee = Number(p.comissaoShopee || 0);
  const vendedor = Number(p.comissaoVendedor || 0);
  const total = Number(p.comissao_pct || shopee + vendedor || 0);
  const preco = Number(p.preco || 0);
  return {
    itemId: p.itemId,
    shopId: p.shopId,
    nome: p.nome,
    loja: p.loja,
    imagem: p.imagem,
    preco,
    comissaoShopee: shopee,
    comissaoVendedor: vendedor,
    comissaoTotal: Math.round(total * 100) / 100,
    lucroEstimado: Math.round(preco * total) / 100,
    vendas: Number(p.vendas_shopee || 0),
    rating: Number(p.rating || 0),
    link: p.linkAfiliado || p.linkProduto || "",
    linkProduto: p.linkProduto || "",
    linkAfiliado: p.linkAfiliado || "",
  };
}

async function radarSupercomissoes({ keyword = "", min = 15, page = 1, limit = 50 } = {}) {
  const minPct = Number(min) || 0;
  const kw = String(keyword || "").trim();
  const lim = Math.min(50, Number(limit) || 50);
  const pg = Math.max(1, Number(page) || 1);

  let offer = { nodes: [], pageInfo: {} };
  if (kw) {
    offer = await queryProductOffersByKeyword(kw, { page: pg, limit: lim, sortType: 5, listType: 0 });
  } else {
    try {
      offer = await queryTopCommissionOffers({ page: pg, limit: lim });
    } catch (_) {
      offer = { nodes: [], pageInfo: {} };
    }
    if (!(offer.nodes || []).length) {
      offer = await queryCommissionFeed({ page: pg, limit: lim, listType: 0 });
    }
  }

  const produtos = (offer.nodes || [])
    .map(normalizeShopeeProduct)
    .map(toRadarProduto)
    .filter((p) => p.itemId && p.comissaoTotal >= minPct)
    .sort((a, b) => b.comissaoTotal - a.comissaoTotal);

  const media = produtos.length
    ? Math.round((produtos.reduce((s, p) => s + p.comissaoTotal, 0) / produtos.length) * 10) / 10
    : 0;

  return {
    produtos,
    media,
    pageInfo: offer.pageInfo || {},
    varredura: new Date().toISOString(),
  };
}

async function queryTopCommissionOffers({ page = 1, limit = 50 } = {}) {
  const query = `{
    productOfferV2(listType: 1, sortType: 5, page: ${page}, limit: ${Math.min(50, limit)}) {
      nodes { ${PRODUCT_OFFER_NODES} }
      pageInfo { page limit hasNextPage }
    }
  }`;
  const data = await shopeeGraphql(query);
  return data?.productOfferV2 || { nodes: [], pageInfo: {} };
}

async function generateAffiliateShortLink(originUrl, subIds = []) {
  const origin = String(originUrl || "").trim();
  if (!origin) return null;
  const cleanSubIds = (subIds || []).map((s) => String(s).trim()).filter(Boolean).slice(0, 5);
  const mutation = `
    mutation generateLink($originUrl: String!, $subIds: [String!]) {
      generateShortLink(input: { originUrl: $originUrl, subIds: $subIds }) {
        shortLink
        longLink
      }
    }
  `;
  const data = await shopeeGraphql(mutation, {
    originUrl: origin,
    subIds: cleanSubIds.length ? cleanSubIds : null,
  });
  return data?.generateShortLink || null;
}

async function ensureAffiliateLink(produto) {
  if (!produto) return produto;
  if (produto.linkAfiliado) return produto;
  const origin = produto.linkProduto
    || (produto.shopId && produto.itemId
      ? `https://shopee.com.br/product/${produto.shopId}/${produto.itemId}`
      : "");
  if (!origin) return produto;
  try {
    const link = await generateAffiliateShortLink(origin);
    if (link?.shortLink || link?.longLink) {
      produto.linkAfiliado = String(link.shortLink || link.longLink);
    }
  } catch (err) {
    console.warn("[backup] generateShortLink falhou:", err.message);
  }
  return produto;
}

function buildAlertas(dadosAtuais, novo) {
  const alertas = [];
  const precoAntigo = Number(dadosAtuais.preco || 0);
  const comissaoAntiga = Number(dadosAtuais.comissao_pct || 0);
  const precoNovo = Number(novo.preco || 0);
  const comissaoNova = Number(novo.comissao_pct || 0);

  if (comissaoAntiga > 0 && comissaoNova === 0) {
    alertas.push({
      tipo: "comissao_zero",
      nivel: "critico",
      mensagem: "Comissão caiu para 0%. Produto saiu do programa de afiliados.",
    });
  } else if (comissaoAntiga > 0 && comissaoNova < comissaoAntiga * 0.7) {
    alertas.push({
      tipo: "comissao_caiu",
      nivel: "aviso",
      mensagem: `Comissão caiu de ${comissaoAntiga}% para ${comissaoNova}%.`,
    });
  } else if (comissaoAntiga > 0 && comissaoNova > comissaoAntiga * 1.3) {
    alertas.push({
      tipo: "comissao_subiu",
      nivel: "info",
      mensagem: `Comissão subiu de ${comissaoAntiga}% para ${comissaoNova}%.`,
    });
  }

  if (novo.periodoFim) {
    const agora = Math.floor(Date.now() / 1000);
    const dias = Math.floor((Number(novo.periodoFim) - agora) / 86400);
    if (dias >= 0 && dias < 7) {
      alertas.push({
        tipo: "periodo_acaba",
        nivel: "critico",
        mensagem: `Período de comissão termina em ${dias} dia(s).`,
        diasRestantes: dias,
      });
    }
  }

  if (precoAntigo > 0 && precoNovo > 0) {
    const delta = ((precoNovo - precoAntigo) / precoAntigo) * 100;
    if (delta <= -10) {
      alertas.push({
        tipo: "preco_caiu",
        nivel: "info",
        mensagem: `Preço caiu ${Math.abs(delta).toFixed(0)}% (${precoAntigo.toFixed(2)} → ${precoNovo.toFixed(2)}).`,
      });
    } else if (delta >= 15) {
      alertas.push({
        tipo: "preco_subiu",
        nivel: "aviso",
        mensagem: `Preço subiu ${delta.toFixed(0)}% (${precoAntigo.toFixed(2)} → ${precoNovo.toFixed(2)}).`,
      });
    }
  }
  return alertas;
}

async function historicoDoUsuario(itemId, userId) {
  const supabase = getSupabase();
  const { data } = await supabase
    .from("products")
    .select("*")
    .eq("user_id", userId)
    .eq("item_id", String(itemId))
    .maybeSingle();
  if (!data) return { ja_vendeu: false };
  return {
    ja_vendeu: true,
    vendas_minhas: Number(data.pedidos || 0),
    comissao_total_minha: Number(data.comissao || 0),
    gmv_total_meu: Number(data.faturamento || 0),
    preco_quando_vendi: 0,
    comissao_pct_quando_vendi: 0,
  };
}

function mapBackupRow(r) {
  return {
    itemId: r.item_id,
    shopId: r.shop_id,
    nome: r.nome,
    apelido: r.apelido || "",
    preco: Number(r.preco || 0),
    comissao_pct: Number(r.comissao_pct || 0),
    vendas_shopee: Number(r.vendas_shopee || 0),
    imagem: r.imagem || "",
    rating: Number(r.rating || 0),
    loja: r.loja || "",
    linkProduto: r.link_produto || "",
    linkAfiliado: r.link_afiliado || "",
    periodoInicio: r.periodo_inicio,
    periodoFim: r.periodo_fim,
    marcadoPrincipal: Boolean(r.marcado_principal),
    grupoId: r.grupo_id || null,
    status_api: r.status_api || "ok",
    alertas: Array.isArray(r.alertas) ? r.alertas : [],
    cadastrado_em: r.cadastrado_em,
    ultima_verificacao: r.ultima_verificacao,
    payload: r.payload || null,
  };
}

function rowFromProduto(userId, produto, { apelido = "", marcadoPrincipal = false, grupoId = null } = {}) {
  const now = new Date().toISOString();
  return {
    user_id: userId,
    item_id: String(produto.itemId),
    shop_id: String(produto.shopId || ""),
    nome: String(produto.nome || "").slice(0, 400),
    apelido: String(apelido || "").slice(0, 120),
    preco: Number(produto.preco || 0),
    comissao_pct: Number(produto.comissao_pct || 0),
    vendas_shopee: Number(produto.vendas_shopee || 0),
    imagem: String(produto.imagem || "").slice(0, 800),
    rating: Number(produto.rating || 0),
    loja: String(produto.loja || "").slice(0, 200),
    link_produto: String(produto.linkProduto || "").slice(0, 800),
    link_afiliado: String(produto.linkAfiliado || "").slice(0, 800),
    periodo_inicio: produto.periodoInicio || null,
    periodo_fim: produto.periodoFim || null,
    marcado_principal: Boolean(marcadoPrincipal),
    grupo_id: grupoId || null,
    status_api: "ok",
    alertas: [],
    payload: produto,
    cadastrado_em: now,
    ultima_verificacao: now,
  };
}

async function lookupProduto(url, userId = requireUserId()) {
  const parsed = await resolveShopeeProductUrl(url);
  if (!parsed) {
    const err = new Error("URL inválida. Use o link completo do produto Shopee (/product/SHOP_ID/ITEM_ID).");
    err.code = "invalid_url";
    throw err;
  }

  const node = await queryProductOffer(parsed.itemId, parsed.shopId);
  if (!node) {
    const err = new Error("Produto não encontrado no programa de afiliados (productOfferV2).");
    err.code = "product_not_found";
    throw err;
  }

  let produto = normalizeShopeeProduct(node);
  produto = await ensureAffiliateLink(produto);
  const historico = await historicoDoUsuario(parsed.itemId, userId);
  const supabase = getSupabase();
  const { data: existing } = await supabase
    .from("product_backups")
    .select("item_id, grupo_id")
    .eq("user_id", userId)
    .eq("item_id", String(parsed.itemId))
    .maybeSingle();

  return {
    success: true,
    produto,
    historico,
    jaSalvoComoBackup: Boolean(existing),
    grupoId: existing?.grupo_id || null,
  };
}

async function searchProdutosApi(keyword, { shopId = null, limit = 20 } = {}) {
  const offer = await queryProductOffersByKeyword(keyword, { shopId, limit });
  return { items: (offer.nodes || []).map(normalizeShopeeProduct), pageInfo: offer.pageInfo || {} };
}

async function salvarBackup(produto, opcoes = {}, userId = requireUserId()) {
  if (!produto?.itemId) throw new Error("Produto inválido");
  let prod = { ...produto };
  if (!prod.shopId && prod.linkProduto) {
    const p = parseShopeeUrl(prod.linkProduto);
    if (p?.shopId) prod.shopId = p.shopId;
  }
  if (prod.shopId && (!prod.nome || !Number(prod.preco))) {
    try {
      const node = await queryProductOffer(prod.itemId, prod.shopId);
      if (node) prod = { ...prod, ...normalizeShopeeProduct(node) };
    } catch (_) { /* keep partial */ }
  }
  prod = await ensureAffiliateLink(prod);

  const supabase = getSupabase();
  const row = rowFromProduto(userId, prod, opcoes);
  const { data: prev } = await supabase
    .from("product_backups")
    .select("cadastrado_em, marcado_principal, apelido, grupo_id")
    .eq("user_id", userId)
    .eq("item_id", row.item_id)
    .maybeSingle();
  if (prev?.cadastrado_em) row.cadastrado_em = prev.cadastrado_em;
  if (opcoes.apelido == null && prev?.apelido) row.apelido = prev.apelido;
  if (opcoes.marcadoPrincipal == null && prev) row.marcado_principal = prev.marcado_principal;
  if (opcoes.grupoId == null && prev?.grupo_id) row.grupo_id = prev.grupo_id;

  const { error } = await supabase.from("product_backups").upsert(row, { onConflict: "user_id,item_id" });
  if (error) throw new Error(error.message);
  return mapBackupRow(row);
}

async function listarBackups(userId = requireUserId()) {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("product_backups")
    .select("*")
    .eq("user_id", userId)
    .order("cadastrado_em", { ascending: false });
  if (error) throw new Error(error.message);
  const items = (data || []).map(mapBackupRow);
  items.sort((a, b) => {
    if (a.marcadoPrincipal && !b.marcadoPrincipal) return -1;
    if (!a.marcadoPrincipal && b.marcadoPrincipal) return 1;
    return String(b.cadastrado_em || "").localeCompare(String(a.cadastrado_em || ""));
  });
  return items;
}

async function removerBackup(itemId, userId = requireUserId()) {
  const supabase = getSupabase();
  const id = String(itemId);
  const { data: row } = await supabase
    .from("product_backups")
    .select("grupo_id")
    .eq("user_id", userId)
    .eq("item_id", id)
    .maybeSingle();

  if (row?.grupo_id) {
    try { await removerBackupDoGrupo(row.grupo_id, id, userId); } catch (_) { /* ignore */ }
  }

  const { error } = await supabase
    .from("product_backups")
    .delete()
    .eq("user_id", userId)
    .eq("item_id", id);
  if (error) throw new Error(error.message);
  return { ok: true };
}

async function editarBackupMeta(itemId, { apelido, marcadoPrincipal } = {}, userId = requireUserId()) {
  const supabase = getSupabase();
  const patch = { ultima_verificacao: new Date().toISOString() };
  if (apelido != null) patch.apelido = String(apelido).slice(0, 120);
  if (marcadoPrincipal != null) patch.marcado_principal = Boolean(marcadoPrincipal);
  const { error } = await supabase
    .from("product_backups")
    .update(patch)
    .eq("user_id", userId)
    .eq("item_id", String(itemId));
  if (error) throw new Error(error.message);
  return { ok: true };
}

async function atualizarBackup(itemId, userId = requireUserId()) {
  const supabase = getSupabase();
  const { data: atual, error } = await supabase
    .from("product_backups")
    .select("*")
    .eq("user_id", userId)
    .eq("item_id", String(itemId))
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!atual) {
    const err = new Error("Produto não está nos backups");
    err.code = "not_in_backup";
    throw err;
  }
  if (!atual.shop_id) {
    const err = new Error("Backup sem shopId — recadastre com o link completo da Shopee");
    err.code = "missing_shopId";
    throw err;
  }

  const node = await queryProductOffer(itemId, atual.shop_id);
  if (!node) {
    await supabase.from("product_backups").update({
      status_api: "produto_nao_encontrado",
      ultima_verificacao: new Date().toISOString(),
      alertas: [{
        tipo: "nao_encontrado",
        nivel: "critico",
        mensagem: "Produto não retornou na API productOfferV2. Pode ter saído do programa.",
      }],
    }).eq("user_id", userId).eq("item_id", String(itemId));
    return { success: true, status: "produto_nao_encontrado" };
  }

  let novo = normalizeShopeeProduct(node);
  novo = await ensureAffiliateLink(novo);
  const alertas = buildAlertas(atual, novo);
  const row = {
    ...rowFromProduto(userId, novo, {
      apelido: atual.apelido,
      marcadoPrincipal: atual.marcado_principal,
      grupoId: atual.grupo_id,
    }),
    cadastrado_em: atual.cadastrado_em,
    alertas,
    status_api: "ok",
  };
  const { error: upErr } = await supabase.from("product_backups").upsert(row, { onConflict: "user_id,item_id" });
  if (upErr) throw new Error(upErr.message);
  return { success: true, status: "ok", produto: mapBackupRow(row), alertas };
}

async function buscarSimilaresDaLoja(loja, excluirItemId = null, userId = null, shopId = null) {
  userId = userId || requireUserId();
  const out = [];
  const seen = new Set();
  const excluir = String(excluirItemId || "");

  if (shopId) {
    try {
      for (let page = 1; page <= 2; page += 1) {
        const offer = await queryProductOffersByShop(shopId, { page, limit: 50, sortType: 5 });
        for (const n of offer.nodes || []) {
          const id = String(n.itemId);
          if (!id || id === excluir || seen.has(id)) continue;
          seen.add(id);
          const p = normalizeShopeeProduct(n);
          out.push({
            itemId: p.itemId,
            shopId: p.shopId,
            nome: p.nome,
            loja: p.loja,
            preco: p.preco,
            comissao_pct: p.comissao_pct,
            comissao_total: p.comissao_valor || (p.preco * p.comissao_pct) / 100,
            vendas: p.vendas_shopee,
            rating: p.rating,
            imagem: p.imagem,
            link: p.linkAfiliado || p.linkProduto,
            fonte: "api",
          });
        }
        if (!offer.pageInfo?.hasNextPage || out.length >= 20) break;
      }
    } catch (err) {
      console.warn("[backup] similares API shopId falhou:", err.message);
    }
  }

  if (loja) {
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from("products")
      .select("*")
      .eq("user_id", userId)
      .ilike("shop_name", loja)
      .order("comissao", { ascending: false })
      .limit(30);
    if (!error) {
      for (const p of data || []) {
        const id = String(p.item_id);
        if (!id || id === excluir || seen.has(id)) continue;
        seen.add(id);
        out.push({
          itemId: id,
          shopId: "",
          nome: p.item_name,
          loja: p.shop_name,
          preco: 0,
          comissao_pct: 0,
          comissao_total: Number(p.comissao || 0),
          vendas: Number(p.pedidos || 0),
          gmv_total: Number(p.faturamento || 0),
          rating: 0,
          imagem: "",
          link: "",
          fonte: "historico",
        });
      }
    }
  }

  out.sort((a, b) => Number(b.comissao_total || 0) - Number(a.comissao_total || 0));
  return out.slice(0, 24);
}

function mapGrupoRow(g) {
  return {
    docId: g.id,
    id: g.id,
    nome: g.nome,
    principalItemId: g.principal_item_id,
    backupItemIds: Array.isArray(g.backup_item_ids) ? g.backup_item_ids : [],
    historico: Array.isArray(g.historico) ? g.historico : [],
    criado_em: g.criado_em,
    atualizado_em: g.atualizado_em,
  };
}

async function criarGrupo(nome, principalItemId, userId = requireUserId()) {
  if (!nome || !String(nome).trim()) throw new Error("Nome do grupo é obrigatório");
  if (!principalItemId) throw new Error("Selecione um produto principal");
  const supabase = getSupabase();
  const principal = String(principalItemId);

  const { data: prod } = await supabase
    .from("product_backups")
    .select("item_id, grupo_id")
    .eq("user_id", userId)
    .eq("item_id", principal)
    .maybeSingle();
  if (!prod) throw new Error("Produto principal precisa estar nos backups");
  if (prod.grupo_id) throw new Error("Produto já está em outro grupo");

  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from("product_backup_grupos")
    .insert({
      user_id: userId,
      nome: String(nome).trim().slice(0, 160),
      principal_item_id: principal,
      backup_item_ids: [],
      historico: [],
      criado_em: now,
      atualizado_em: now,
    })
    .select("*")
    .single();
  if (error) throw new Error(error.message);

  await supabase
    .from("product_backups")
    .update({ grupo_id: data.id })
    .eq("user_id", userId)
    .eq("item_id", principal);

  return mapGrupoRow(data);
}

async function listarGrupos(userId = requireUserId()) {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("product_backup_grupos")
    .select("*")
    .eq("user_id", userId)
    .order("atualizado_em", { ascending: false });
  if (error) throw new Error(error.message);
  return (data || []).map(mapGrupoRow);
}

async function carregarGrupoComProdutos(grupoId, userId = requireUserId()) {
  const supabase = getSupabase();
  const { data: g, error } = await supabase
    .from("product_backup_grupos")
    .select("*")
    .eq("user_id", userId)
    .eq("id", grupoId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!g) throw new Error("Grupo não encontrado");

  const ids = [g.principal_item_id, ...(Array.isArray(g.backup_item_ids) ? g.backup_item_ids : [])].filter(Boolean);
  const produtos = {};
  if (ids.length) {
    const { data: rows } = await supabase
      .from("product_backups")
      .select("*")
      .eq("user_id", userId)
      .in("item_id", ids);
    for (const r of rows || []) produtos[r.item_id] = mapBackupRow(r);
  }
  return { ...mapGrupoRow(g), produtos };
}

async function adicionarBackupAoGrupo(grupoId, itemId, userId = requireUserId()) {
  const supabase = getSupabase();
  const id = String(itemId);
  const { data: g, error } = await supabase
    .from("product_backup_grupos")
    .select("*")
    .eq("user_id", userId)
    .eq("id", grupoId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!g) throw new Error("Grupo não encontrado");

  const { data: prod } = await supabase
    .from("product_backups")
    .select("*")
    .eq("user_id", userId)
    .eq("item_id", id)
    .maybeSingle();
  if (!prod) throw new Error("Produto não está cadastrado em backups. Cadastre primeiro.");
  if (prod.grupo_id && prod.grupo_id !== grupoId) {
    throw new Error("Produto já está em outro grupo. Remova de lá primeiro.");
  }
  if (g.principal_item_id === id) throw new Error("Produto já é o principal deste grupo");

  const backups = Array.isArray(g.backup_item_ids) ? [...g.backup_item_ids] : [];
  if (!backups.includes(id)) backups.push(id);

  const { error: upErr } = await supabase
    .from("product_backup_grupos")
    .update({ backup_item_ids: backups, atualizado_em: new Date().toISOString() })
    .eq("user_id", userId)
    .eq("id", grupoId);
  if (upErr) throw new Error(upErr.message);

  await supabase.from("product_backups").update({ grupo_id: grupoId }).eq("user_id", userId).eq("item_id", id);
  return { ok: true };
}

async function removerBackupDoGrupo(grupoId, itemId, userId = requireUserId()) {
  const supabase = getSupabase();
  const id = String(itemId);
  const { data: g, error } = await supabase
    .from("product_backup_grupos")
    .select("*")
    .eq("user_id", userId)
    .eq("id", grupoId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!g) throw new Error("Grupo não encontrado");
  if (g.principal_item_id === id) throw new Error("Não remova o principal assim — troque o principal antes");

  const backups = (Array.isArray(g.backup_item_ids) ? g.backup_item_ids : []).filter((x) => x !== id);
  await supabase
    .from("product_backup_grupos")
    .update({ backup_item_ids: backups, atualizado_em: new Date().toISOString() })
    .eq("user_id", userId)
    .eq("id", grupoId);
  await supabase.from("product_backups").update({ grupo_id: null }).eq("user_id", userId).eq("item_id", id);
  return { ok: true };
}

async function trocarPrincipal(grupoId, novoPrincipalItemId, motivo = "", userId = requireUserId()) {
  const supabase = getSupabase();
  const novo = String(novoPrincipalItemId);
  const { data: g, error } = await supabase
    .from("product_backup_grupos")
    .select("*")
    .eq("user_id", userId)
    .eq("id", grupoId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!g) throw new Error("Grupo não encontrado");

  const antigo = String(g.principal_item_id || "");
  if (antigo === novo) throw new Error("Este produto já é o principal");
  const backups = Array.isArray(g.backup_item_ids) ? g.backup_item_ids.map(String) : [];
  if (!backups.includes(novo)) throw new Error("Produto selecionado não é backup deste grupo");

  const novosBackups = backups.filter((x) => x !== novo);
  if (antigo) novosBackups.push(antigo);

  const historico = Array.isArray(g.historico) ? [...g.historico] : [];
  historico.push({
    data: new Date().toISOString(),
    motivo: String(motivo || "").trim() || "não especificado",
    principalAntigo: antigo,
    principalNovo: novo,
  });

  const { error: upErr } = await supabase
    .from("product_backup_grupos")
    .update({
      principal_item_id: novo,
      backup_item_ids: novosBackups,
      historico,
      atualizado_em: new Date().toISOString(),
    })
    .eq("user_id", userId)
    .eq("id", grupoId);
  if (upErr) throw new Error(upErr.message);
  return { ok: true };
}

async function removerGrupo(grupoId, userId = requireUserId()) {
  const supabase = getSupabase();
  const { data: g, error } = await supabase
    .from("product_backup_grupos")
    .select("*")
    .eq("user_id", userId)
    .eq("id", grupoId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!g) throw new Error("Grupo não encontrado");

  const ids = [g.principal_item_id, ...(Array.isArray(g.backup_item_ids) ? g.backup_item_ids : [])].filter(Boolean);
  if (ids.length) {
    await supabase.from("product_backups").update({ grupo_id: null }).eq("user_id", userId).in("item_id", ids);
  }
  const { error: delErr } = await supabase
    .from("product_backup_grupos")
    .delete()
    .eq("user_id", userId)
    .eq("id", grupoId);
  if (delErr) throw new Error(delErr.message);
  return { ok: true };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function comissaoBRL(p) {
  return (Number(p?.preco || 0) * Number(p?.comissao_pct || 0)) / 100;
}

function tokensNome(nome) {
  return String(nome || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 4);
}

async function enriquecerGrupoComHistorico(grupo, userId = requireUserId()) {
  const ids = [grupo.principalItemId, ...(grupo.backupItemIds || [])].filter(Boolean);
  let lucro_historico = 0;
  let gmv_historico = 0;
  await Promise.all(
    ids.map(async (id) => {
      const h = await historicoDoUsuario(id, userId);
      if (h?.ja_vendeu) {
        lucro_historico += Number(h.comissao_total_minha || 0);
        gmv_historico += Number(h.gmv_total_meu || 0);
      }
    }),
  );
  return { ...grupo, lucro_historico, gmv_historico };
}

async function listarGruposCompletos(userId = requireUserId()) {
  const grupos = await listarGrupos(userId);
  const full = await Promise.all(grupos.map((g) => carregarGrupoComProdutos(g.id, userId)));
  return Promise.all(full.map((g) => enriquecerGrupoComHistorico(g, userId)));
}

async function atualizarBackupsEmLote(itemIds = [], userId = requireUserId()) {
  const ids = (Array.isArray(itemIds) ? itemIds : []).map(String).filter(Boolean);
  const results = [];
  for (let i = 0; i < ids.length; i += 1) {
    try {
      const r = await atualizarBackup(ids[i], userId);
      results.push({ itemId: ids[i], ok: true, status: r.status });
    } catch (err) {
      results.push({ itemId: ids[i], ok: false, error: err.message });
    }
    if (i < ids.length - 1) await sleep(400);
  }
  return results;
}

async function atualizarGrupoBackup(grupoId, userId = requireUserId()) {
  const g = await carregarGrupoComProdutos(grupoId, userId);
  const ids = [g.principalItemId, ...(g.backupItemIds || [])].filter(Boolean);
  const results = await atualizarBackupsEmLote(ids, userId);
  const refreshed = await enriquecerGrupoComHistorico(
    await carregarGrupoComProdutos(grupoId, userId),
    userId,
  );
  return { results, grupo: refreshed };
}

function analisarInsightGrupo(principal, backups) {
  if (!principal || !backups?.length) return [];
  const principalCom = comissaoBRL(principal);
  const insights = [];
  if (Number(principal.comissao_pct || 0) === 0 || principal.status_api === "produto_nao_encontrado") {
    insights.push({
      tipo: "critico",
      titulo: "Tráfego em perigo — fora do afiliado",
      mensagem: "O produto principal não retorna comissão no programa. Substitua pelo backup.",
    });
  }
  let melhor = null;
  let maiorDiff = 0;
  for (const b of backups) {
    if (!b) continue;
    const diff = comissaoBRL(b) - principalCom;
    if (diff > maiorDiff) {
      maiorDiff = diff;
      melhor = b;
    }
  }
  if (melhor && maiorDiff > 0.5) {
    insights.push({
      tipo: "lucro",
      titulo: "Oportunidade de maior margem",
      mensagem: `Backup "${melhor.apelido || melhor.nome?.slice(0, 25)}" rende R$ ${maiorDiff.toFixed(2)} a mais por venda.`,
      backupId: melhor.itemId,
      diff: maiorDiff,
    });
  }
  return insights;
}

async function getBackupDashboardStats(userId = requireUserId()) {
  const [backups, grupos] = await Promise.all([
    listarBackups(userId),
    listarGruposCompletos(userId),
  ]);

  const emGrupo = backups.filter((b) => b.grupoId).length;
  const livres = backups.length - emGrupo;
  const okApi = backups.filter((b) => b.status_api === "ok" && Number(b.comissao_pct || 0) > 0).length;
  const fora = backups.filter(
    (b) => b.status_api === "produto_nao_encontrado" || Number(b.comissao_pct || 0) === 0,
  ).length;
  const coberturaPct = backups.length ? Math.round((okApi / backups.length) * 100) : 0;

  let sinaisCriticos = 0;
  let foraAlertas = 0;
  for (const b of backups) {
    const crit = (b.alertas || []).filter((a) => a.nivel === "critico");
    sinaisCriticos += crit.length;
    if (crit.some((a) => /afiliado|não retornou|comissao_zero|nao_encontrado/i.test(`${a.tipo} ${a.mensagem}`))) {
      foraAlertas += 1;
    }
  }
  if (!sinaisCriticos) sinaisCriticos = fora;

  const scans = backups
    .map((b) => b.ultima_verificacao)
    .filter(Boolean)
    .map((d) => new Date(d).getTime())
    .filter((t) => !Number.isNaN(t));
  const maisAntigo = scans.length ? new Date(Math.min(...scans)).toISOString() : null;
  const maisNovo = scans.length ? new Date(Math.max(...scans)).toISOString() : null;

  const comissoes = backups.map(comissaoBRL).filter((n) => n > 0);
  const comissaoMedia = comissoes.length
    ? comissoes.reduce((a, b) => a + b, 0) / comissoes.length
    : 0;
  const comissaoTopo = comissoes.length ? Math.max(...comissoes) : 0;

  const trocas = [];
  let variantesComFaixa = 0;
  const lojaCount = {};

  for (const g of grupos) {
    const principal = g.produtos?.[g.principalItemId];
    const backs = (g.backupItemIds || []).map((id) => g.produtos?.[id]).filter(Boolean);
    const insights = analisarInsightGrupo(principal, backs);
    const lucro = insights.find((i) => i.tipo === "lucro");
    if (lucro) {
      trocas.push({
        grupoId: g.docId,
        nome: g.nome,
        diff: lucro.diff,
        mensagem: lucro.mensagem,
      });
    }
    const all = [principal, ...backs].filter(Boolean);
    const tokenMap = new Map();
    for (const p of all) {
      for (const t of tokensNome(p.apelido || p.nome)) {
        if (!tokenMap.has(t)) tokenMap.set(t, new Set());
        tokenMap.get(t).add(p.itemId);
      }
    }
    const variantIds = new Set();
    for (const set of tokenMap.values()) {
      if (set.size >= 2) set.forEach((id) => variantIds.add(id));
    }
    variantesComFaixa += variantIds.size;

    for (const p of all) {
      const loja = String(p.loja || "").trim();
      if (!loja) continue;
      lojaCount[loja] = (lojaCount[loja] || 0) + 1;
    }
  }

  const lojasSorted = Object.entries(lojaCount).sort((a, b) => b[1] - a[1]);
  const topLoja = lojasSorted[0] || null;
  const topLojasExtra = lojasSorted.slice(1, 3).map(([nome, n]) => `${nome} (${n})`);
  const trocasDiff = trocas.reduce((s, t) => s + Number(t.diff || 0), 0);
  const topTroca = trocas.sort((a, b) => Number(b.diff || 0) - Number(a.diff || 0))[0] || null;

  return {
    backups: backups.length,
    emGrupo,
    livres,
    coberturaApi: okApi,
    coberturaPct,
    foraAfiliado: fora,
    sinaisCriticos,
    foraAlertas,
    scanMaisAntigo: maisAntigo,
    scanMaisNovo: maisNovo,
    comissaoMedia,
    comissaoTopo,
    trocarPrincipal: trocas.length,
    trocarDiffTotal: trocasDiff,
    trocarTopNome: topTroca?.nome || null,
    trocarTopMsg: topTroca?.mensagem || null,
    variantesComFaixa,
    variantesPct: backups.length ? Math.round((variantesComFaixa / backups.length) * 100) : 0,
    lojaMaisBackups: topLoja ? topLoja[0] : null,
    lojaMaisBackupsCount: topLoja ? topLoja[1] : 0,
    lojaMaisBackupsExtra: topLojasExtra.join(" · "),
    gruposCount: grupos.length,
  };
}

async function getGarimpoLocal(limit = 80, userId = requireUserId()) {
  const supabase = getSupabase();
  const backups = await listarBackups(userId);
  const backupIds = new Set(backups.map((b) => String(b.itemId)));

  const { data, error } = await supabase
    .from("products")
    .select("*")
    .eq("user_id", userId)
    .order("comissao", { ascending: false })
    .limit(Math.max(limit * 2, 120));
  if (error) throw new Error(error.message);

  const histById = new Map();
  for (const p of data || []) histById.set(String(p.item_id), p);

  const jaVendo = [];
  const descoberta = [];
  const seen = new Set();

  // Descoberta ao vivo: productOfferV2 listType HIGHEST_COMMISSION + sort COMMISSION_DESC
  try {
    for (let page = 1; page <= 2; page += 1) {
      const offer = await queryTopCommissionOffers({ page, limit: 50 });
      for (const n of offer.nodes || []) {
        const p = normalizeShopeeProduct(n);
        if (!p.itemId || backupIds.has(p.itemId) || seen.has(p.itemId)) continue;
        seen.add(p.itemId);
        const hist = histById.get(p.itemId);
        const item = {
          itemId: p.itemId,
          shopId: p.shopId,
          nome: p.nome,
          shop_name: p.loja,
          loja: p.loja,
          preco: p.preco,
          comissao_pct: p.comissao_pct,
          comissao_total: p.comissao_valor || (p.preco * p.comissao_pct) / 100,
          minha_comissao_historica: hist ? Number(hist.comissao || 0) : 0,
          vendas: hist ? Number(hist.pedidos || 0) : p.vendas_shopee,
          gmv_total: hist ? Number(hist.faturamento || 0) : 0,
          ja_vendeu: Boolean(hist),
          no_backup: false,
          score_oportunidade: p.comissao_valor || (p.preco * p.comissao_pct) / 100,
          link_produto: p.linkProduto,
          link_afiliado: p.linkAfiliado,
          imagem: p.imagem,
          fonte: "api",
        };
        if (hist) jaVendo.push(item);
        else descoberta.push(item);
      }
      if (!offer.pageInfo?.hasNextPage) break;
    }
  } catch (err) {
    console.warn("[backup] garimpo API falhou:", err.message);
  }

  // Completa "já vendi" com histórico local fora do backup
  for (const p of data || []) {
    const id = String(p.item_id);
    if (backupIds.has(id) || seen.has(id)) continue;
    seen.add(id);
    jaVendo.push({
      itemId: id,
      shopId: "",
      nome: p.item_name || "",
      shop_name: p.shop_name || "",
      loja: p.shop_name || "",
      preco: 0,
      comissao_pct: 0,
      comissao_total: Number(p.comissao || 0),
      minha_comissao_historica: Number(p.comissao || 0),
      vendas: Number(p.pedidos || 0),
      gmv_total: Number(p.faturamento || 0),
      ja_vendeu: true,
      no_backup: false,
      score_oportunidade: Number(p.comissao || 0),
      link_produto: "",
      link_afiliado: "",
      imagem: "",
      fonte: "historico",
    });
  }

  jaVendo.sort((a, b) => Number(b.score_oportunidade || 0) - Number(a.score_oportunidade || 0));
  descoberta.sort((a, b) => Number(b.score_oportunidade || 0) - Number(a.score_oportunidade || 0));

  const ja = jaVendo.slice(0, limit);
  const desc = descoberta.slice(0, Math.min(40, limit));
  await hidratarImagens([...ja, ...desc]);

  return {
    data: new Date().toISOString().slice(0, 10),
    fonte: "api+products",
    jaVendo: ja,
    descoberta: desc,
  };
}

async function getRadarRecompra(limit = 40, userId = requireUserId()) {
  const supabase = getSupabase();
  const backups = await listarBackups(userId);
  const backupIds = new Set(backups.map((b) => String(b.itemId)));

  const { data, error } = await supabase
    .from("products")
    .select("*")
    .eq("user_id", userId)
    .gt("pedidos", 1)
    .order("comissao", { ascending: false })
    .limit(Math.max(limit * 2, 80));
  if (error) throw new Error(error.message);

  const produtos = (data || [])
    .filter((p) => !backupIds.has(String(p.item_id)))
    .slice(0, limit)
    .map((p) => ({
      itemId: String(p.item_id),
      nome: p.item_name || "",
      shop_name: p.shop_name || "",
      loja: p.shop_name || "",
      minha_comissao_historica: Number(p.comissao || 0),
      gmv_total: Number(p.faturamento || 0),
      vendas: Number(p.pedidos || 0),
      ja_vendeu: true,
      no_backup: false,
      imagem: "",
      link_produto: "",
      link_afiliado: "",
    }));

  return {
    data: new Date().toISOString().slice(0, 10),
    fonte: "products",
    produtos,
  };
}

function parseMoneyGarimpo(raw) {
  let s = String(raw || "").replace(/[^\d,.-]/g, "");
  if (s.includes(",") && s.includes(".")) s = s.replace(/\./g, "").replace(",", ".");
  else if (s.includes(",")) s = s.replace(",", ".");
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

function termoGarimpo(nome, apelido) {
  const stop = new Set(["de", "da", "do", "das", "dos", "e", "com", "para", "kit", "original", "shopee"]);
  const fonte = String(apelido || nome || "").trim();
  const tokens = fonte
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !stop.has(w));
  return tokens.slice(0, 3).join(" ") || String(nome || "").trim().slice(0, 60);
}

async function garimpoContextual(body = {}, userId = requireUserId()) {
  const termo = termoGarimpo(body.nome, body.apelido);
  if (!termo) return { ofertas: [], termoUsado: "" };
  const acima = Math.min(100, Math.max(0, Number(body.precoToleranciaAcimaPct ?? 15)));
  const abaixo = Math.min(100, Math.max(0, Number(body.precoToleranciaAbaixoPct ?? 25)));
  const preco = parseMoneyGarimpo(body.preco);
  const min = preco > 0 ? preco * (1 - abaixo / 100) : 0;
  const max = preco > 0 ? preco * (1 + acima / 100) : Infinity;
  const exclude = new Set((body.excludeItemIds || []).map(String));
  const shopId = body.shopId ? String(body.shopId) : null;
  let pack = await queryProductOffersByKeyword(termo, { shopId, limit: 20, sortType: 2 });
  let nodes = pack.nodes || [];
  let fonte = shopId ? "loja" : "geral";
  if (!nodes.length && shopId) {
    pack = await queryProductOffersByKeyword(termo, { limit: 20, sortType: 2 });
    nodes = pack.nodes || [];
    fonte = "geral";
  }
  const ofertas = nodes
    .map(normalizeShopeeProduct)
    .filter((p) => p.itemId && !exclude.has(String(p.itemId)))
    .filter((p) => {
      const v = Number(p.precoMin || p.preco || 0);
      if (!(preco > 0)) return true;
      return v >= min && v <= max;
    })
    .slice(0, 5);
  return { ofertas, termoUsado: termo, fonte };
}

module.exports = {
  lookupProduto,
  searchProdutosApi,
  salvarBackup,
  listarBackups,
  removerBackup,
  editarBackupMeta,
  atualizarBackup,
  atualizarBackupsEmLote,
  atualizarGrupoBackup,
  buscarSimilaresDaLoja,
  criarGrupo,
  listarGrupos,
  listarGruposCompletos,
  carregarGrupoComProdutos,
  adicionarBackupAoGrupo,
  removerBackupDoGrupo,
  trocarPrincipal,
  removerGrupo,
  getBackupDashboardStats,
  getGarimpoLocal,
  getRadarRecompra,
  garimpoContextual,
  analisarInsightGrupo,
  generateAffiliateShortLink,
  parseShopeeUrl,
  radarSupercomissoes,
};
