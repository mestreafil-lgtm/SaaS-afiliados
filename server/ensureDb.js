"use strict";

const { Client } = require("pg");

const ENSURE_SQL = `
alter table if exists app_settings add column if not exists tax_rate numeric not null default 0;
alter table if exists app_settings add column if not exists team_name text not null default 'Minha conta';
alter table if exists app_settings add column if not exists team_plan text not null default 'Shopee · Meta';
alter table if exists app_settings add column if not exists meta_base numeric not null default 863959;
alter table if exists app_settings add column if not exists meta_tax_rate numeric default 12;
alter table if exists app_settings add column if not exists meta_dias numeric null;
alter table if exists app_settings add column if not exists meta_bonus_100 numeric null default 1;
alter table if exists app_settings add column if not exists meta_bonus_125 numeric null default 2;
alter table if exists app_settings add column if not exists meta_bonus_150 numeric null default 3;
alter table if exists app_settings add column if not exists meta_bonus_no_lucro boolean not null default false;
alter table if exists app_settings add column if not exists claude_api_key text not null default '';
alter table if exists app_settings add column if not exists claude_model text not null default 'claude-sonnet-4-20250514';

alter table if exists subid_ops drop constraint if exists subid_ops_canal_check;
alter table if exists subid_ops add constraint subid_ops_canal_check
  check (canal is null or canal in ('meta', 'pinterest', 'organico', 'indefinido'));

alter table if exists subid_ops add column if not exists status_source text;
alter table if exists subid_ops drop constraint if exists subid_ops_status_source_check;
alter table if exists subid_ops add constraint subid_ops_status_source_check
  check (status_source is null or status_source in ('manual', 'meta', 'pinterest'));

-- Backfill: registros legados com status setado mas sem origem foram edições
-- manuais do usuário (antes do rastreio de origem). Marca como 'manual' para
-- que sync da API Meta/CSV Pin não sobrescreva.
update subid_ops
set status_source = 'manual'
where status is not null and status_source is null;

create table if not exists clique_daily (
  user_id uuid not null,
  data date not null,
  subid text not null,
  cliques integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (user_id, data, subid)
);
create index if not exists idx_clique_daily_user_data on clique_daily (user_id, data);

create table if not exists push_subscriptions (
  id bigint generated always as identity primary key,
  user_id uuid not null,
  endpoint text not null unique,
  subscription text not null,
  created_at timestamptz default now()
);
create index if not exists idx_push_sub_user on push_subscriptions(user_id);

create table if not exists push_notify_state (
  user_id uuid not null,
  kind text not null default 'comissao-ontem',
  date_key text not null,
  fingerprint text not null,
  notified_at timestamptz not null default now(),
  primary key (user_id, kind, date_key)
);

-- Colunas usadas no snapshot de SubIDs (sem elas o sync apaga a tabela e falha ao gravar)
alter table if exists subid_metrics add column if not exists unpaid integer not null default 0;
alter table if exists subid_metrics add column if not exists cliques_shopee numeric not null default 0;
alter table if exists daily_metrics add column if not exists unpaid integer not null default 0;
alter table if exists meta_ads_daily add column if not exists cliques_link integer not null default 0;

-- Stripe Billing
alter table if exists user_profiles add column if not exists stripe_customer_id text;
alter table if exists user_profiles add column if not exists stripe_subscription_id text;
alter table if exists user_profiles add column if not exists stripe_price_id text;
alter table if exists user_profiles add column if not exists subscription_status text not null default 'none';
alter table if exists user_profiles add column if not exists subscription_current_period_end timestamptz;
create index if not exists idx_user_profiles_stripe_customer on user_profiles (stripe_customer_id);
create index if not exists idx_user_profiles_stripe_subscription on user_profiles (stripe_subscription_id);

notify pgrst, 'reload schema';
`;

function projectRef() {
  return (process.env.SUPABASE_URL || "")
    .replace(/^https?:\/\//, "")
    .replace(/\.supabase\.co.*$/, "")
    .trim();
}

function connectionStrings() {
  const password = process.env.SUPABASE_DB_PASSWORD || "";
  const ref = projectRef();
  const list = [];
  if (process.env.DATABASE_URL) list.push(process.env.DATABASE_URL);
  if (password && ref) {
    list.push(
      `postgresql://postgres.${ref}:${encodeURIComponent(password)}@aws-0-sa-east-1.pooler.supabase.com:6543/postgres`
    );
    list.push(
      `postgresql://postgres:${encodeURIComponent(password)}@db.${ref}.supabase.co:5432/postgres`
    );
  }
  return [...new Set(list)];
}

async function withPg(fn) {
  const strings = connectionStrings();
  if (!strings.length) return null;
  let lastErr = null;
  for (const connectionString of strings) {
    const client = new Client({ connectionString, ssl: { rejectUnauthorized: false } });
    try {
      await client.connect();
      const result = await fn(client);
      await client.end();
      return result === undefined ? true : result;
    } catch (err) {
      lastErr = err;
      try { await client.end(); } catch (_) { /* ignore */ }
    }
  }
  if (lastErr) console.warn("[ensureDb]", lastErr.message);
  return null;
}

let ensured = false;

async function ensureConfigSchema() {
  if (ensured) return true;
  const ok = await withPg(async (client) => {
    await client.query(ENSURE_SQL);
  });
  if (ok) {
    ensured = true;
    console.log("[ensureDb] colunas de configuração aplicadas e schema PostgREST recarregado");
  }
  return Boolean(ok);
}

async function upsertAppSettingsSql(row) {
  const cols = Object.keys(row);
  if (!cols.length) return false;
  const values = cols.map((k) => row[k]);
  const placeholders = cols.map((_, i) => `$${i + 1}`);
  const updates = cols
    .filter((k) => k !== "user_id")
    .map((k) => `${k} = excluded.${k}`);
  const sql = `
    insert into app_settings (${cols.join(", ")})
    values (${placeholders.join(", ")})
    on conflict (user_id) do update set ${updates.join(", ")}
  `;
  const ok = await withPg(async (client) => {
    await client.query(sql, values);
  });
  return Boolean(ok);
}

module.exports = {
  ensureConfigSchema,
  upsertAppSettingsSql,
};
