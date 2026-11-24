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
alter table if exists app_settings add column if not exists backup_comissao_min numeric not null default 5;
alter table if exists app_settings add column if not exists backup_vendas_min integer not null default 100;
alter table if exists app_settings add column if not exists backup_preco_acima_pct numeric not null default 15;
alter table if exists app_settings add column if not exists backup_preco_abaixo_pct numeric not null default 25;
alter table if exists app_settings add column if not exists backup_preco_alerta_min numeric not null default 0.01;
alter table if exists product_backups add column if not exists campanhas jsonb not null default '[]'::jsonb;
alter table if exists app_settings add column if not exists claude_api_key text not null default '';
alter table if exists app_settings add column if not exists claude_model text not null default 'claude-sonnet-4-20250514';

alter table if exists subid_ops drop constraint if exists subid_ops_canal_check;
alter table if exists subid_ops add constraint subid_ops_canal_check
  check (canal is null or canal in ('meta', 'pinterest', 'organico', 'indefinido'));

alter table if exists subid_ops add column if not exists status_source text;
alter table if exists subid_ops drop constraint if exists subid_ops_status_source_check;
alter table if exists subid_ops add constraint subid_ops_status_source_check
  check (status_source is null or status_source in ('manual', 'meta', 'pinterest'));

-- Validação do SubID pelo cliente: null = não marcado, 'sim' = validado, 'nao' = não validado.
alter table if exists subid_ops add column if not exists validado text;
alter table if exists subid_ops drop constraint if exists subid_ops_validado_check;
alter table if exists subid_ops add constraint subid_ops_validado_check
  check (validado is null or validado in ('sim', 'nao'));

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

-- Emissão fiscal NFS-e por usuário. O backend usa a service role; RLS bloqueia
-- acesso direto pelo navegador e todas as consultas também filtram user_id.
create table if not exists fiscal_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  legal_name text not null default '',
  trade_name text not null default '',
  cnpj text not null default '',
  municipal_registration text not null default '',
  municipality_code text not null default '',
  tax_regime text not null default 'Simples Nacional',
  service_code text not null default '',
  nbs_code text not null default '',
  description_template text not null default 'Serviços de divulgação de produtos como afiliado Shopee, referentes a {mes}/{ano}.',
  series text not null default '49999',
  next_dps_number bigint not null default 1,
  iss_withheld boolean not null default false,
  approximate_tax_pct numeric,
  ibscbs_status text not null default 'pending' check (ibscbs_status in ('pending','not_applicable','configured')),
  accountant_confirmed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists fiscal_imports (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  filename text not null,
  digest text not null,
  mapping jsonb not null default '{}'::jsonb,
  row_count integer not null default 0,
  duplicate_rows integer not null default 0,
  draft_count integer not null default 0,
  total_cents bigint not null default 0,
  created_at timestamptz not null default now(),
  unique(user_id, digest)
);
create index if not exists idx_fiscal_imports_user_created on fiscal_imports(user_id, created_at desc);

create table if not exists fiscal_drafts (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  import_id uuid references fiscal_imports(id) on delete cascade,
  recipient jsonb not null default '{}'::jsonb,
  recipient_document text not null default '',
  competence text not null default '',
  amount_cents bigint not null default 0,
  status text not null default 'pending' check (status in ('pending','ready','approved','submitting','homologating','authorized','homologated','rejected','uncertain','cancelled')),
  issues jsonb not null default '[]'::jsonb,
  warnings jsonb not null default '[]'::jsonb,
  source_lines jsonb not null default '[]'::jsonb,
  version integer not null default 1,
  approved_at timestamptz,
  dps_series text,
  dps_number bigint,
  dps_id text,
  signed_xml text,
  response_payload jsonb,
  authorized_xml text,
  access_key text,
  error_message text,
  submitted_at timestamptz,
  authorized_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_fiscal_drafts_user_status on fiscal_drafts(user_id, status, created_at desc);
alter table if exists fiscal_drafts add column if not exists recipient_document text not null default '';
create unique index if not exists uq_fiscal_recipient_competence on fiscal_drafts(user_id, recipient_document, competence) where recipient_document <> '' and status <> 'cancelled';

alter table fiscal_profiles enable row level security;
alter table fiscal_imports enable row level security;
alter table fiscal_drafts enable row level security;
-- NFS-e v2: regimes, tributos federais, competência, exterior, ambientes,
-- conciliação, cancelamento e auditoria.
alter table if exists fiscal_profiles add column if not exists simple_option smallint not null default 3;
alter table if exists fiscal_profiles add column if not exists simple_assessment_regime smallint not null default 1;
alter table if exists fiscal_profiles add column if not exists special_tax_regime smallint not null default 0;
alter table if exists fiscal_profiles add column if not exists municipal_service_code text not null default '';
alter table if exists fiscal_profiles add column if not exists next_test_dps_number bigint not null default 1;
alter table if exists fiscal_profiles add column if not exists iss_taxation smallint not null default 1;
alter table if exists fiscal_profiles add column if not exists iss_retention smallint not null default 1;
alter table if exists fiscal_profiles add column if not exists iss_rate numeric;
alter table if exists fiscal_profiles add column if not exists totals_mode text not null default 'not_informed';
alter table if exists fiscal_profiles add column if not exists approximate_federal_pct numeric;
alter table if exists fiscal_profiles add column if not exists approximate_state_pct numeric;
alter table if exists fiscal_profiles add column if not exists approximate_municipal_pct numeric;
alter table if exists fiscal_profiles add column if not exists pis_cofins_cst text not null default '';
alter table if exists fiscal_profiles add column if not exists pis_rate numeric;
alter table if exists fiscal_profiles add column if not exists cofins_rate numeric;
alter table if exists fiscal_profiles add column if not exists pis_cofins_retention smallint;
alter table if exists fiscal_profiles add column if not exists irrf_retention_pct numeric;
alter table if exists fiscal_profiles add column if not exists csll_retention_pct numeric;
alter table if exists fiscal_profiles add column if not exists cp_retention_pct numeric;
alter table if exists fiscal_profiles add column if not exists competence_rule text not null default '';
alter table if exists fiscal_profiles add column if not exists foreign_defaults jsonb not null default '{}'::jsonb;
alter table if exists fiscal_profiles add column if not exists municipal_params jsonb;
alter table if exists fiscal_profiles add column if not exists municipal_params_checked_at timestamptz;

alter table if exists fiscal_drafts add column if not exists environment text;
alter table if exists fiscal_drafts add column if not exists error_code text;
alter table if exists fiscal_drafts add column if not exists cancel_xml text;
alter table if exists fiscal_drafts add column if not exists cancelled_at timestamptz;
alter table if exists fiscal_drafts drop constraint if exists fiscal_drafts_status_check;
alter table if exists fiscal_drafts add constraint fiscal_drafts_status_check
  check (status in ('pending','ready','approved','submitting','homologating','authorized','homologated','rejected','uncertain','cancelled'));
alter table if exists fiscal_drafts drop constraint if exists fiscal_drafts_environment_check;
alter table if exists fiscal_drafts add constraint fiscal_drafts_environment_check
  check (environment is null or environment in ('restricted','production'));
-- A numeração de teste (produção restrita) é independente da de produção.
drop index if exists uq_fiscal_dps_number;
create unique index if not exists uq_fiscal_dps_number_env on fiscal_drafts(user_id, coalesce(environment, 'production'), dps_series, dps_number) where dps_number is not null;
create index if not exists idx_fiscal_drafts_user_competence on fiscal_drafts(user_id, competence, status);

create table if not exists fiscal_events (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  draft_id uuid references fiscal_drafts(id) on delete cascade,
  action text not null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists idx_fiscal_events_user_draft on fiscal_events(user_id, draft_id, created_at desc);
alter table fiscal_events enable row level security;

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
