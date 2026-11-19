# Architecture

Angular standalone frontend; Cloudflare Worker API; D1; R2. API is the trust boundary. Browser never supplies trusted totals or stock. Inventory is auditable through stock movements. Order creation and inventory changes must be atomic/idempotent to prevent overselling. No privileged credentials in browser. WhatsApp V1 is user-driven wa.me messaging.
