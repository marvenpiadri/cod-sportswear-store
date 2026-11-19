# Product brief

Independent single-store sportswear storefront for Morocco. Cash on delivery only. Currency: MAD.

## Customer experience
- Browse the product catalog, grid, pagination and cart.
- Collect customer name, phone, WhatsApp, city, address and optional delivery note.
- COD only; no online payment.
- Orders are stored by the Worker in D1 when the API is configured.
- WhatsApp is a customer-driven handoff; do not claim messages are automatically sent or delivered.

## Lightweight owner CRM
- PIN-gated product creation and catalog refresh.
- Product image processing/upload to R2.
- Read-only order history archive.
- No order-status workflow, notification inbox, automated WhatsApp API or multi-store features in this scope.

## Stack
Angular, Cloudflare Worker, D1 (SQLite), R2 and Playwright.

## Not in V1
Online payments, multi-store, warehouse/supplier/accounting workflows, complex CRM or automated WhatsApp messaging.