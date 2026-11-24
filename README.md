# Shopylitcs — SaaS Afiliados

**Autor:** Jurandy

Painel de afiliados com dados reais (Open API Shopee, Meta Ads, Pinterest) e persistência no Supabase.

```
api/          entrada Vercel
gcp/          sync no Cloud Run
public/       frontend (landing em /, painel em /app)
scripts/      setup do banco e seed demo
server/       backend Node
sql/          schema.sql (único arquivo SQL)
styles/       fonte do Tailwind
```

## Setup rápido

1. Copie o ambiente:
   ```bash
   cp .env.example .env
   ```
2. Preencha no `.env`:
   - `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_DB_PASSWORD`
   - `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `PUBLIC_BASE_URL`
   - Price IDs (já no `.env.example`): mensal / 6 meses / 12 meses
3. Instale e prepare o banco:
   ```bash
   npm install
   npm run setup:db
   npm run seed:demo
   npm start
   ```
4. Abra http://localhost:3790 (landing) e http://localhost:3790/app (painel)

`setup:db` aplica só `sql/schema.sql` (idempotente — não apaga dados). `seed:demo` cria a conta `teste@gmail.com`.

## Stripe

1. No Stripe Dashboard, crie um webhook apontando para:
   `https://SEU_DOMINIO/api/billing/webhook`
2. Eventos sugeridos: `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid`, `invoice.payment_failed`
3. Cole o `whsec_...` em `STRIPE_WEBHOOK_SECRET`
4. Landing (`/`) chama Checkout; no painel use **Configurações → Assinatura → Gerenciar assinatura** (Customer Portal)

## Segurança

- **Nunca** commite o `.env` (já está no `.gitignore`).
- Use `service_role` só no backend.

## NFS-e para afiliados Shopee

O painel possui um módulo fiscal multiusuário em **Notas fiscais**. Ele importa o
relatório fiscal CSV/XLSX da Shopee, agrupa por tomador e competência, valida
pendências, prepara/aprova a DPS, confere certificado A1 e preserva o XML
autorizado.

A importação do relatório fiscal é obrigatória porque a API de afiliados não entrega CNPJ,
razão social e endereço fiscal do vendedor, necessários para preencher a NFS-e.

O valor da nota é a comissão pelo serviço de afiliação, não o total vendido na
Shopee. Antes do primeiro uso, execute `npm run setup:db` e mantenha
`FISCAL_PRODUCTION_ENABLED=0`. A transmissão real só deve ser habilitada após:

- revisão do código de serviço, NBS, município, ISS e IBS/CBS pelo contador;
- homologação do leiaute 1.01 usado pelo emitente;
- teste do certificado A1 pertencente ao CNPJ cadastrado;
- validação do fluxo em ambiente de produção restrita.

Certificado e senha são recebidos apenas na requisição de validação/emissão e
não são gravados no banco. Resultado inconclusivo nunca é reenviado
automaticamente; a DPS fica bloqueada para conciliação.

## Deploy

- **Railway:** veja [`DEPLOY.md`](DEPLOY.md) e [`railway.env.example`](railway.env.example)
- Repo: https://github.com/mestreafil-lgtm/SaaS-afiliados

## Licença / autoria

Projeto de **Jurandy** (Shopylitcs).
