# Inventory and order lifecycle audit

- Stock movements are the ledger for sales, cancellation restorations and manual adjustments.
- Admin GET /api/admin/stock-movements returns up to 200 recent ledger rows and supports variantId and q filters.
- Admin GET /api/admin/inventory-audit compares current quantities against summed movement deltas. Differences are informational: stock balances may predate ledger tracking.
- Order transitions follow a defined forward workflow; cancelled and returned orders are terminal. Return handling does not automatically restock.
- Status changes and manual stock adjustments are written to audit_logs.
