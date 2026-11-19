# Browser testing

We use **Playwright CLI** for interactive, agent-driven browser testing during development and **Playwright Test** for repeatable regression tests in CI.

## Setup

```bash
npm install
npx playwright install chromium
npx playwright-cli install
```

## Run regression tests

```bash
npm run e2e
```

## Interactive agent browser

Start the Angular app in one terminal:

```bash
npm start
```

In another terminal, launch the browser and inspect its accessible snapshot:

```bash
npx playwright-cli open http://localhost:4200
npx playwright-cli snapshot
```

Use the snapshot element references to click, fill and interact. Helpful commands include:

```bash
npx playwright-cli screenshot
npx playwright-cli console
npx playwright-cli close
```

For CLI usage and commands, see https://playwright.dev/agent-cli/installation and https://playwright.dev/docs/getting-started-cli.

## Regression coverage

Current smoke coverage checks the hero/shop/delivery content, quick-add bag opening, bag count increment, and rendering at a mobile viewport. Checkout, order creation, inventory and WhatsApp flows will be added as they are implemented.

CI installs Playwright's Chromium browser and runs the Playwright Test suite on pushes and pull requests.
