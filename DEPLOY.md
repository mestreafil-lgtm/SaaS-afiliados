# Deploy — Shopylitcs (Jurandy)

## Conta demonstração

Após `npm run seed:demo` (local) ou seed no ambiente:

- Email: `teste@gmail.com`
- Senha: `123456789`
- Admin: `/admin`

## Railway (recomendado)

1. Em [railway.app](https://railway.app) → **New Project** → **Deploy from GitHub** → repo `mestreafil-lgtm/SaaS-afiliados`.
2. O `railway.toml` já define:
   - **Build:** `npm run build`
   - **Start:** `npm start` (Node escuta `PORT` do Railway)
3. Em **Variables**, cole as chaves de `railway.env.example` (valores reais do seu `.env` / Supabase / Stripe).
4. Gere o domínio público (Settings → Networking → Generate Domain).
5. Ajuste `PUBLIC_BASE_URL` para essa URL (ex.: `https://….up.railway.app`).
6. No Stripe, webhook → `https://SEU-DOMINIO/api/billing/webhook`.
7. No Supabase Auth → Site URL / Redirect URLs → mesma URL do Railway.

### Variáveis obrigatórias no Railway

| Variável | Uso |
|---|---|
| `SUPABASE_URL` | Projeto Supabase |
| `SUPABASE_ANON_KEY` | Auth cliente |
| `SUPABASE_SERVICE_ROLE_KEY` | Backend |
| `SUPABASE_DB_PASSWORD` | `npm run setup:db` / migrations |
| `PUBLIC_BASE_URL` | Stripe + push + links |
| `ADMIN_EMAIL` | Acesso `/admin` |
| `STRIPE_SECRET_KEY` | Billing |
| `STRIPE_WEBHOOK_SECRET` | Webhook Stripe |
| `STRIPE_PRICE_MONTHLY` / `_6M` / `_12M` | Planos |
| `CRON_SECRET` | Auth do sync externo |

Opcionais: `VAPID_*` (push), `CLAUDE_API_KEY` (fallback), Pinterest.

### Emissão fiscal

| Variável | Uso |
|---|---|
| `FISCAL_PRODUCTION_ENABLED` | Use `0` até concluir homologação e revisão fiscal |
| `FISCAL_LAYOUT_VERSION` | Leiaute autorizado pelo conector; atualmente `1.01` |
| `FISCAL_RESTRICTED_ENABLED` | `1` libera a produção restrita (testes na Sefin Nacional com certificado real) |
| `FISCAL_ICP_ROOTS_PEM` | Raízes ICP-Brasil (PEM ou caminho). Sem ela a cadeia do certificado não é conferida e a emissão em produção fica bloqueada |
| `FISCAL_XSD_PATH` | Opcional: zip do pacote XSD oficial; sem ele o servidor baixa do gov.br |
| `FISCAL_PARAMS_SERVICE` / `FISCAL_PARAMS_PREFIX` | Opcional: caminho da consulta de parâmetros municipais, se o padrão não responder |

Rode `npm run setup:db` para criar `fiscal_profiles`, `fiscal_imports`,
`fiscal_drafts` e `fiscal_events` (auditoria). Não habilite produção apenas por ter configurado as variáveis:
o cadastro de cada emitente, o tratamento de IBS/CBS e o certificado A1 também
precisam passar nas validações do módulo.

**Não** crie `PORT` — o Railway injeta sozinho.

Lista completa para colar: [`railway.env.example`](railway.env.example).

### Sync Shopee/Meta

O painel no Railway **serve a app**. O sync pesado continua via **Google Cloud** (Cloud Run + Scheduler) ou cron externo batendo em `/api/cron/sync` com `CRON_SECRET`.

```powershell
gcloud auth login
gcloud config set project SEU_PROJECT_ID
.\gcp\deploy.ps1 -ProjectId SEU_PROJECT_ID
```

Detalhes: `gcp/README.md`.

## Vercel (alternativa)

1. Importe o repo no Vercel (Framework: **Other**).
2. Configure as mesmas variáveis de ambiente.
3. App sobe como função serverless (`api/index.js` + `vercel.json`).

## Local

```bash
cp .env.example .env
# ou use railway.env.example como checklist
npm install
npm run setup:db
npm run seed:demo
npm start
```

http://localhost:3790
