# Cloudflare Workers deployment

The storefront and API are deployed together as the `cod-sportswear-store` Worker.

## Production configuration

- Worker name: `cod-sportswear-store`
- Build command: `npm run build`
- Static assets directory: `dist/store/browser`
- Wrangler configuration: repository-root `wrangler.toml`

The root Wrangler configuration attaches the Angular browser build as Worker static assets. Cloudflare serves storefront files directly and uses the single-page application fallback for client-side routes such as `/admin`. Requests under `/api/*` are sent to the Worker fetch handler.

## Services

- D1 binding: `DB` (existing `mokiko` database)
- R2 binding: `PRODUCT_MEDIA` (existing `mokiko` bucket)
- API health endpoint: `/api/health`
- Public catalog endpoint: `/api/products`

## Deployment

Build the Angular app before deploying the Worker so `dist/store/browser` exists:

```sh
npm install
npm run build
cd worker
npm install
npx wrangler deploy --config ../wrangler.toml
```

The Worker configuration is also mirrored in `worker/wrangler.toml` for deployments launched from the worker directory.

## Verification

After deployment, verify:

1. The Worker root URL loads the storefront.
2. `/admin` loads the admin application directly.
3. `/api/health` returns the API health response.
4. `/api/products` returns the public catalog.
5. Admin PIN login, checkout, stock management and image uploads continue to work.

Do not apply database migrations as part of this deployment; the existing D1 database and R2 bucket are retained.
