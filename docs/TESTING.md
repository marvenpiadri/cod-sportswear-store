# Browser testing

Playwright Test provides automated browser regression checks. CI runs Angular production build, Playwright tests using Chromium, and Worker TypeScript typecheck on pushes and pull requests.

## Run regression tests

```bash
npm install
npx playwright install --with-deps chromium
npm run build
npm run e2e
```

## Current coverage

- Storefront sections and catalog rendering.
- Add-to-bag and cart quantity/removal behavior.
- Narrow/mobile rendering.
- COD form validation and customer-detail capture.
- Checkout usability on a small viewport.
- Screenshot capture for desktop storefront, mobile storefront and mobile checkout.
- Admin UI presence and product-management controls.

The suite currently has 8 tests. The green CI run also typechecks the Worker. These are browser/UI checks, not a live production integration test: Worker URL, PIN, database migrations and WhatsApp configuration remain deployment prerequisites.
