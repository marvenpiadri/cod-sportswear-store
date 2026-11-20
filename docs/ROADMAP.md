# Roadmap

## Implemented V1 capabilities
- [x] Responsive Angular storefront with compact, grid-first catalog, search and pagination.
- [x] Product details, size/colour variants, stock visibility and variant-aware cart.
- [x] COD checkout with server-side order persistence and WhatsApp customer handoff.
- [x] Cloudflare Worker API, D1 catalog/orders, R2 product image pipeline and WebP variants.
- [x] PIN-gated product creation/editing, image upload, order archive and order-status updates.
- [x] Checkout-created CRM notifications with read state and an owner inbox.
- [x] Manual variant stock adjustments with an auditable stock movement record.
- [x] Persistent admin PIN and public checkout rate limiting.
- [x] Transactional order creation with inventory checks, stock movement records and idempotent retry handling.
- [x] Playwright storefront/admin regression coverage and Worker typecheck in CI.

## Remaining before launch
- [x] Complete regression verification for inventory, CRM, catalog search and checkout submission safety.
- [ ] Verify idempotent checkout and concurrent stock contention against a configured Worker and real D1 database after migration 0006 is reviewed and applied.
- [ ] Configure production Worker URL and owner WhatsApp destination.
- [ ] Provision secrets, especially ADMIN_PIN, and review/apply migrations with explicit approval.
- [ ] Add the actual product catalog and approved product photography.
- [ ] Finish full accessibility/SEO review and production configuration checks. Extra-small phone overflow coverage and API security headers are implemented.
- [ ] Verify backup and recovery procedures.
- [ ] Perform end-to-end production checkout and WhatsApp handoff verification after authorization.

Do not deploy or apply production migrations without explicit approval.
