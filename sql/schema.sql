-- Schema único do SaaS Afiliados (idempotente).
-- Uso: npm run setup:db
-- Novos ambientes: CREATE IF NOT EXISTS. Bancos já existentes: ALTER no final.

create extension if not exists "pgcrypto";

-- Credenciais Shopee por usuário
create table if not exists app_credentials (
  user_id uuid primary key,
  app_id text not null,
  secret text not null,
  updated_at timestamptz not null default now()
);

-- Credenciais Meta por usuário
create table if not exists meta_credentials (
  user_id uuid primary key,
  access_token text not null default '',
  ad_account_ids text not null default '',
  api_version text not null default 'v19.0',
  last_sync_at timestamptz,
  last_sync_meta jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- Credenciais Pinterest Ads por usuário
create table if not exists pinterest_credentials (
  user_id uuid primary key,
  app_id text not null default '',
  access_token text not null default '',
  ad_account_ids text not null default '',
  last_sync_at timestamptz,
  last_sync_meta jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists app_settings (
  user_id uuid primary key,
  meta_base numeric not null default 863959,
  tax_rate numeric not null default 0,
  meta_tax_rate numeric default 12,
  meta_dias numeric null,
  meta_bonus_100 numeric null default 1,
  meta_bonus_125 numeric null default 2,
  meta_bonus_150 numeric null default 3,
  meta_bonus_no_lucro boolean not null default false,
  team_name text not null default 'Minha conta',
  team_plan text not null default 'Shopee · Meta',
  claude_api_key text not null default '',
  claude_model text not null default 'claude-sonnet-4-20250514',
  updated_at timestamptz not null default now()
);

create table if not exists sync_runs (
  id bigserial primary key,
  user_id uuid not null,
  start_date date not null,
  end_date date not null,
  nodes integer not null default 0,
  pages integer not null default 0,
  kpis jsonb not null default '{}'::jsonb,
  synced_at timestamptz not null default now()
);
create index if not exists idx_sync_runs_user on sync_runs (user_id, synced_at desc);

create table if not exists daily_metrics (
  user_id uuid not null,
  data date not null,
  faturamento numeric not null default 0,
  comissao numeric not null default 0,
  pedidos integer not null default 0,
  concluidos integer not null default 0,
  pendentes integer not null default 0,
  cancelados integer not null default 0,
  unpaid integer not null default 0,
  inv_meta numeric not null default 0,
  inv_pin numeric not null default 0,
  inv_total numeric not null default 0,
  lucro numeric not null default 0,
  roi numeric not null default 0,
  updated_at timestamptz not null default now(),
  primary key (user_id, data)
);

create table if not exists subid_metrics (
  user_id uuid not null,
  subid text not null,
  faturamento numeric not null default 0,
  comissao numeric not null default 0,
  pedidos integer not null default 0,
  concluidos integer not null default 0,
  pendentes integer not null default 0,
  cancelados integer not null default 0,
  itens integer not null default 0,
  abatimento numeric not null default 0,
  cliques_shopee integer not null default 0,
  inv_meta numeric not null default 0,
  inv_pin numeric not null default 0,
  inv_total numeric not null default 0,
  lucro numeric not null default 0,
  roi numeric not null default 0,
  updated_at timestamptz not null default now(),
  primary key (user_id, subid)
);

create table if not exists meta_ads_daily (
  user_id uuid not null,
  ad_id text not null,
  data date not null,
  ad_name text not null default '',
  subid text not null default '',
  adset_name text not null default '',
  campaign_name text not null default '',
  gasto numeric not null default 0,
  impressoes integer not null default 0,
  alcance integer not null default 0,
  cliques integer not null default 0,
  cliques_link integer not null default 0,
  ctr numeric not null default 0,
  cpc numeric not null default 0,
  account_id text not null default '',
  updated_at timestamptz not null default now(),
  primary key (user_id, ad_id, data)
);
create index if not exists idx_meta_ads_user_data on meta_ads_daily (user_id, data);

create table if not exists pinterest_ads_daily (
  user_id uuid not null,
  id text not null,
  ad_id text not null default '',
  data date,
  ad_name text not null default '',
  subid text not null default '',
  gasto numeric not null default 0,
  cliques integer not null default 0,
  status text not null default '',
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);
create index if not exists idx_pin_ads_user_data on pinterest_ads_daily (user_id, data);

create table if not exists orders (
  user_id uuid not null,
  order_id text not null,
  conversion_id text,
  data date,
  subid text not null default 'organico',
  status text not null default 'pendente',
  faturamento numeric not null default 0,
  comissao numeric not null default 0,
  updated_at timestamptz not null default now(),
  primary key (user_id, order_id)
);
create index if not exists idx_orders_user_data on orders (user_id, data);

create table if not exists order_items (
  user_id uuid not null,
  id text not null,
  order_id text not null,
  item_id text not null default '',
  item_name text not null default '',
  shop_name text not null default '',
  qty integer not null default 0,
  faturamento numeric not null default 0,
  comissao numeric not null default 0,
  data date,
  subid text not null default 'organico',
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);

create table if not exists products (
  user_id uuid not null,
  item_id text not null,
  item_name text not null default '',
  shop_name text not null default '',
  faturamento numeric not null default 0,
  comissao numeric not null default 0,
  pedidos integer not null default 0,
  qty integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (user_id, item_id)
);

create table if not exists product_backups (
  user_id uuid not null,
  item_id text not null,
  shop_id text not null default '',
  nome text not null default '',
  apelido text not null default '',
  preco numeric not null default 0,
  comissao_pct numeric not null default 0,
  vendas_shopee integer not null default 0,
  imagem text not null default '',
  rating numeric not null default 0,
  loja text not null default '',
  link_produto text not null default '',
  link_afiliado text not null default '',
  periodo_inicio bigint,
  periodo_fim bigint,
  marcado_principal boolean not null default false,
  grupo_id uuid,
  status_api text not null default 'ok',
  alertas jsonb not null default '[]'::jsonb,
  payload jsonb not null default '{}'::jsonb,
  cadastrado_em timestamptz not null default now(),
  ultima_verificacao timestamptz not null default now(),
  primary key (user_id, item_id)
);
create index if not exists idx_product_backups_user on product_backups (user_id, cadastrado_em desc);
create index if not exists idx_product_backups_grupo on product_backups (user_id, grupo_id);
create index if not exists idx_product_backups_loja on product_backups (user_id, loja);

create table if not exists product_backup_grupos (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  nome text not null default '',
  principal_item_id text not null default '',
  backup_item_ids jsonb not null default '[]'::jsonb,
  historico jsonb not null default '[]'::jsonb,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);
create index if not exists idx_product_backup_grupos_user
  on product_backup_grupos (user_id, atualizado_em desc);

-- Reset só dos dados Shopee do usuário (não apaga Meta credentials)
create or replace function reset_shopee_data_for_user(p_user_id uuid)
returns void
language plpgsql
security definer
as $$
begin
  delete from sync_runs where user_id = p_user_id;
  delete from daily_metrics where user_id = p_user_id;
  delete from subid_metrics where user_id = p_user_id;
  delete from order_items where user_id = p_user_id;
  delete from orders where user_id = p_user_id;
  delete from products where user_id = p_user_id;
end;
$$;

-- Perfis + aprovação admin
create table if not exists user_profiles (
  user_id uuid primary key,
  email text not null default '',
  role text not null default 'user' check (role in ('admin', 'user')),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'suspended')),
  display_name text not null default '',
  company text not null default '',
  notes text not null default '',
  approved_by uuid,
  approved_at timestamptz,
  last_login_at timestamptz,
  stripe_customer_id text,
  stripe_subscription_id text,
  stripe_price_id text,
  subscription_status text not null default 'none',
  subscription_current_period_end timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_user_profiles_status on user_profiles (status);
create index if not exists idx_user_profiles_email on user_profiles (email);
create index if not exists idx_user_profiles_role on user_profiles (role);
create index if not exists idx_user_profiles_stripe_customer on user_profiles (stripe_customer_id);
create index if not exists idx_user_profiles_stripe_subscription on user_profiles (stripe_subscription_id);

-- Emissão fiscal NFS-e segregada por usuário
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

-- Canal / status por SubID
create table if not exists subid_ops (
  user_id uuid not null,
  subid text not null,
  canal text check (canal is null or canal in ('meta', 'pinterest', 'organico', 'indefinido')),
  status text check (status is null or status in ('ativa', 'teste', 'desativada', 'pausada')),
  produto text,
  updated_at timestamptz default now(),
  primary key (user_id, subid)
);
create index if not exists subid_ops_user_idx on subid_ops (user_id);

-- Cliques do Relatório de cliques Shopee (CSV) — abatimento do painel
create table if not exists clique_daily (
  user_id uuid not null,
  data date not null,
  subid text not null,
  cliques integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (user_id, data, subid)
);
create index if not exists idx_clique_daily_user_data on clique_daily (user_id, data);

-- Upgrades idempotentes para bancos criados antes deste schema
alter table if exists app_settings
  add column if not exists tax_rate numeric not null default 0,
  add column if not exists team_name text not null default 'Minha conta',
  add column if not exists team_plan text not null default 'Shopee · Meta',
  add column if not exists meta_base numeric not null default 863959,
  add column if not exists claude_api_key text not null default '',
  add column if not exists claude_model text not null default 'claude-sonnet-4-20250514',
  add column if not exists meta_tax_rate numeric default 12,
  add column if not exists meta_dias numeric null,
  add column if not exists meta_bonus_100 numeric null default 1,
  add column if not exists meta_bonus_125 numeric null default 2,
  add column if not exists meta_bonus_150 numeric null default 3;

alter table if exists subid_metrics
  add column if not exists cliques_shopee integer not null default 0;

alter table if exists meta_ads_daily
  add column if not exists cliques_link integer not null default 0;

alter table if exists subid_ops drop constraint if exists subid_ops_status_check;
alter table if exists subid_ops
  add constraint subid_ops_status_check
  check (status is null or status in ('ativa', 'teste', 'desativada', 'pausada'));

do $$
declare r record;
begin
  for r in
    select conname from pg_constraint
    where conrelid = 'public.subid_ops'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%canal%'
  loop
    execute format('alter table public.subid_ops drop constraint if exists %I', r.conname);
  end loop;
end $$;

alter table if exists subid_ops
  add constraint subid_ops_canal_check
  check (canal is null or canal in ('meta', 'pinterest', 'organico', 'indefinido'));

-- Push notification subscriptions
create table if not exists push_subscriptions (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  endpoint text not null unique,
  subscription text not null,
  created_at timestamptz default now()
);
create index if not exists idx_push_sub_user on push_subscriptions(user_id);

alter table push_subscriptions enable row level security;
create policy "Users manage own push subs" on push_subscriptions
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Stripe Billing (bancos já existentes)
alter table if exists user_profiles add column if not exists stripe_customer_id text;
alter table if exists user_profiles add column if not exists stripe_subscription_id text;
alter table if exists user_profiles add column if not exists stripe_price_id text;
alter table if exists user_profiles add column if not exists subscription_status text not null default 'none';
alter table if exists user_profiles add column if not exists subscription_current_period_end timestamptz;
create index if not exists idx_user_profiles_stripe_customer on user_profiles (stripe_customer_id);
create index if not exists idx_user_profiles_stripe_subscription on user_profiles (stripe_subscription_id);

notify pgrst, 'reload schema';
