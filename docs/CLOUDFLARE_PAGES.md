# Cloudflare Pages deployment

## Frontend

- Framework preset: None
- Build command: `npm run build`
- Build output directory: `dist/store/browser`
- Root directory: `/`

The Angular build generates a browser bundle under `dist/store/browser`. The `_redirects` file is copied into the root of that output to allow client-side routes (including `/admin`) to load directly.

## API connection

The Pages frontend is static and does not host the API. Keep the existing API Worker, D1 and R2 deployment separate. In the Admin connection settings, set the deployed API Worker URL (including `https://`) and save it. The frontend will use that API URL for catalog, orders, authentication, inventory and image operations. Ensure the Worker allows requests from the Pages domain via CORS.

## Important

- This change does not deploy or alter the API Worker, D1 database or R2 bucket.
- Do not deploy/apply database migrations without approval.
- Test the Pages site, `/admin`, API health, admin PIN login, catalog, checkout, stock management and image uploads after deployment.
