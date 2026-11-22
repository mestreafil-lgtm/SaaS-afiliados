"use strict";

const crypto = require("crypto");
const { AsyncLocalStorage } = require("async_hooks");
const { createClient } = require("@supabase/supabase-js");

const als = new AsyncLocalStorage();
const TOKEN_CACHE_TTL_MS = 45_000;
const tokenCache = new Map();

let _adminClient = null;
let _anonClient = null;

function getSupabaseAdmin() {
  if (_adminClient) return _adminClient;
  const url = (process.env.SUPABASE_URL || "").trim().replace(/\/rest\/v1\/?$/, "");
  const key = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
  if (!url || !key) throw new Error("Configure SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY");
  _adminClient = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return _adminClient;
}

function getSupabaseAnon() {
  if (_anonClient) return _anonClient;
  const url = (process.env.SUPABASE_URL || "").trim().replace(/\/rest\/v1\/?$/, "");
  const key = (process.env.SUPABASE_ANON_KEY || "").trim();
  if (!url || !key) throw new Error("Configure SUPABASE_ANON_KEY");
  _anonClient = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return _anonClient;
}

function tokenCacheKey(accessToken) {
  return crypto.createHash("sha256").update(String(accessToken)).digest("hex").slice(0, 32);
}

function runWithUser(user, fn) {
  return als.run({ user, cache: new Map() }, fn);
}

function getUser() {
  return als.getStore()?.user || null;
}

async function requestCached(key, factory) {
  const store = als.getStore();
  if (!store || !store.cache) return factory();
  if (store.cache.has(key)) return store.cache.get(key);
  const promise = Promise.resolve().then(factory);
  store.cache.set(key, promise);
  try {
    return await promise;
  } catch (e) {
    store.cache.delete(key);
    throw e;
  }
}

function invalidateRequestCache(keyPrefix = null) {
  const store = als.getStore();
  if (!store?.cache) return;
  if (!keyPrefix) {
    store.cache.clear();
    return;
  }
  for (const k of store.cache.keys()) {
    if (String(k).startsWith(keyPrefix)) store.cache.delete(k);
  }
}

function requireUserId() {
  const u = getUser();
  if (!u?.id) {
    const err = new Error("Não autenticado");
    err.code = "UNAUTHORIZED";
    throw err;
  }
  return u.id;
}

async function verifyAccessToken(accessToken) {
  if (!accessToken) return null;
  const key = tokenCacheKey(accessToken);
  const hit = tokenCache.get(key);
  if (hit && Date.now() - hit.at < TOKEN_CACHE_TTL_MS) return hit.user;

  const admin = getSupabaseAdmin();
  const { data, error } = await admin.auth.getUser(accessToken);
  if (error || !data?.user) return null;

  const base = {
    id: data.user.id,
    email: data.user.email || "",
  };

  let user = base;
  try {
    const { ensureProfile, profilePublic } = require("./profiles");
    const profile = await ensureProfile(base);
    user = { ...base, profile: profilePublic(profile), role: profile.role, status: profile.status };
  } catch (_) {
    user = base;
  }
  tokenCache.set(key, { at: Date.now(), user });
  if (tokenCache.size > 500) {
    const now = Date.now();
    for (const [k, v] of tokenCache) {
      if (now - v.at > TOKEN_CACHE_TTL_MS) tokenCache.delete(k);
    }
  }
  return user;
}

async function rollbackAuthUser(userId) {
  try {
    const admin = getSupabaseAdmin();
    const { deleteUserAccount } = require("./profiles");
    // limpa dados se já gravou algo; ignore errors
    try {
      await deleteUserAccount(userId, null);
    } catch (_) {
      await admin.auth.admin.deleteUser(userId);
    }
  } catch (_) { /* ignore */ }
}

/**
 * Cadastro completo: valida Shopee + Meta, cria usuário, grava APIs.
 * extras: { displayName, company, shopee: {appId, secret}, meta: {accessToken, adAccountIds, apiVersion} }
 */
async function registerUser(email, password, extras = {}) {
  const cleanEmail = String(email || "").trim().toLowerCase();
  const pass = String(password || "");
  if (!cleanEmail || pass.length < 6) {
    throw new Error("Email e senha (mín. 6 caracteres) são obrigatórios");
  }

  const { isAdminEmail, createPendingProfile, profilePublic } = require("./profiles");
  const adminSignup = isAdminEmail(cleanEmail);

  const shopee = extras.shopee || {};
  const meta = extras.meta || {};
  const appId = String(shopee.appId || extras.appId || "").trim();
  const secret = String(shopee.secret || extras.secret || "").trim();
  const accessToken = String(meta.accessToken || extras.metaToken || "").trim();
  const adAccountIds = String(meta.adAccountIds || extras.metaAccounts || "").trim();
  const apiVersion = String(meta.apiVersion || extras.metaVersion || "v19.0").trim() || "v19.0";

  // Admin seed pode pular APIs; cadastro normal exige Shopee válida (Meta opcional)
  let shopeeTest = null;
  let metaTest = null;
  if (!adminSignup) {
    if (!appId || !secret) {
      throw new Error("Informe SHOPEE_APP_ID e SHOPEE_SECRET válidos no cadastro");
    }

    const { testCredentialsPair } = require("./shopee");
    const { testMetaCredentialsPair } = require("./meta");

    try {
      shopeeTest = await testCredentialsPair(appId, secret);
    } catch (err) {
      throw new Error(`API Shopee inválida: ${err.message}`);
    }

    const wantsMeta = Boolean(accessToken || adAccountIds);
    if (wantsMeta) {
      if (!accessToken || !adAccountIds) {
        throw new Error("Para cadastrar Meta, informe o token e ao menos um AD_ACCOUNT_ID");
      }
      try {
        metaTest = await testMetaCredentialsPair({ accessToken, adAccountIds, apiVersion });
      } catch (err) {
        throw new Error(`API Meta inválida: ${err.message}`);
      }
    }
  }

  const admin = getSupabaseAdmin();
  const { data, error } = await admin.auth.admin.createUser({
    email: cleanEmail,
    password: pass,
    email_confirm: true,
  });
  if (error) throw new Error(error.message);

  const userId = data.user.id;
  let profile;
  try {
    profile = await createPendingProfile({
      id: userId,
      email: cleanEmail,
      displayName: extras.displayName,
      company: extras.company,
    });

    if (!adminSignup) {
      const { saveCredentials } = require("./store");
      const { saveMetaCredentials } = require("./meta");
      const { clearCredsCache } = require("./shopee");
      await runWithUser({ id: userId, email: cleanEmail }, async () => {
        await saveCredentials({ appId, secret }, userId);
        clearCredsCache(userId);
        if (accessToken && adAccountIds) {
          await saveMetaCredentials({ accessToken, adAccountIds, apiVersion }, userId);
        }
      });
    }
  } catch (err) {
    await rollbackAuthUser(userId);
    throw err;
  }

  const { hasActiveSubscription } = require("./profiles");
  if (adminSignup || profile.status === "approved" || hasActiveSubscription(profile)) {
    const anon = getSupabaseAnon();
    const login = await anon.auth.signInWithPassword({ email: cleanEmail, password: pass });
    if (login.error) throw new Error(login.error.message);
    return {
      user: { id: userId, email: data.user.email, profile: profilePublic(profile) },
      session: login.data.session,
      pendingApproval: false,
      shopeeTest,
      metaTest,
    };
  }

  return {
    user: { id: userId, email: data.user.email, profile: profilePublic(profile) },
    session: null,
    pendingApproval: true,
    shopeeTest,
    metaTest,
  };
}

async function loginUser(email, password) {
  const anon = getSupabaseAnon();
  const cleanEmail = String(email || "").trim().toLowerCase();
  const { data, error } = await anon.auth.signInWithPassword({
    email: cleanEmail,
    password: String(password || ""),
  });
  if (error) throw new Error(error.message);

  const { ensureProfile, profilePublic, touchLogin, hasActiveSubscription } = require("./profiles");
  const profile = await ensureProfile({ id: data.user.id, email: data.user.email });
  touchLogin(data.user.id).catch(() => {});

  if (profile.role !== "admin" && profile.status !== "approved" && !hasActiveSubscription(profile)) {
    const err = new Error(
      profile.status === "pending"
        ? "Conta aguardando pagamento ou aprovação. Escolha um plano em / para liberar o acesso."
        : profile.status === "rejected"
          ? "Esta conta foi recusada pelo administrador."
          : "Esta conta está suspensa. Fale com o suporte.",
    );
    err.code = profile.status === "pending" ? "PENDING_APPROVAL" : "ACCOUNT_BLOCKED";
    err.profile = profilePublic(profile);
    throw err;
  }

  return {
    user: {
      id: data.user.id,
      email: data.user.email,
      profile: profilePublic(profile),
      role: profile.role,
      status: profile.status,
    },
    session: data.session,
  };
}

// Troca o refresh_token por uma sessão nova (access_token renovado).
async function refreshUserSession(refreshToken) {
  const anon = getSupabaseAnon();
  const { data, error } = await anon.auth.refreshSession({ refresh_token: String(refreshToken || "") });
  if (error || !data?.session) {
    const err = new Error("Sessão expirada");
    err.code = "UNAUTHORIZED";
    throw err;
  }
  return data.session;
}

module.exports = {
  refreshUserSession,
  getSupabaseAdmin,
  getSupabaseAnon,
  runWithUser,
  getUser,
  requireUserId,
  requestCached,
  invalidateRequestCache,
  verifyAccessToken,
  registerUser,
  loginUser,
};
