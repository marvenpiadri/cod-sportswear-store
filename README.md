# COD Sportswear Store

Independent cash-on-delivery sportswear store and lightweight order/inventory management app.

## Stack
- Angular storefront and admin
- Cloudflare Workers API
- Cloudflare D1 (SQLite)
- Cloudflare R2 (product media)
- WhatsApp-assisted order confirmation and customer communication

See `docs/` for the architecture, product scope, WhatsApp handoff, deployment notes and the D1/R2 backup and recovery runbook. The Wrangler resources are a temporary test setup; do not deploy or apply migrations to a production database without explicit approval.
