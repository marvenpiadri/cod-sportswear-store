# Roadmap

## Current implementation
- [x] Angular storefront, compact product-first layout and responsive grid.
- [x] Cart, quantity controls and subtotal.
- [x] COD customer-details checkout.
- [x] Worker API, D1 order persistence and product catalog endpoints.
- [x] PIN-gated product management and read-only order archive.
- [x] R2 image pipeline and WebP variants.
- [x] Client-side product pagination.
- [x] Playwright regression suite and Worker typecheck in CI (green).

## Remaining before launch
- [ ] Configure Worker URL and owner WhatsApp number.
- [ ] Provision secrets, especially ADMIN_PIN; add PIN rate limiting before production.
- [ ] Verify and apply database migrations only after review and authorization.
- [ ] Add real product photography and publish the actual catalog.
- [ ] Validate checkout against the configured production Worker and confirm WhatsApp handoff end-to-end.
- [ ] Review backups, security, accessibility, SEO and deployment settings.

Do not deploy or apply production migrations without explicit approval.