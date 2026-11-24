-- Módulo fiscal NFS-e (afiliado). Pode rodar mais de uma vez: só cria o que falta.
-- Cole no Supabase > SQL Editor > New query e clique em Run.

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


notify pgrst, 'reload schema';
