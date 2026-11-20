import { test, expect } from '@playwright/test';

test('storefront displays its core sections', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /training, simplified/i })).toBeVisible();
  await expect(page.getByRole('heading', { name: /training essentials/i })).toBeVisible();
  await expect(page.getByText(/pay on arrival/i)).toBeVisible();
  await expect(page.getByRole('button', { name: /add to bag/i }).first()).toBeVisible();
});

test('bag opens after adding an item', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /add to bag/i }).first().click();
  const bag = page.getByRole('complementary');
  await expect(bag.getByRole('heading', { name: /your bag/i })).toBeVisible();
  await expect(bag.locator('strong').filter({ hasText: 'Essential Training Tee' })).toBeVisible();
});

test('cart quantity, subtotal and removal update correctly', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /add to bag/i }).first().click();
  const bag = page.getByRole('complementary');
  await expect(bag.getByText('Subtotal')).toBeVisible();
  await expect(bag.getByRole('button', { name: /increase quantity/i })).toBeVisible();
  await bag.getByRole('button', { name: /increase quantity/i }).click();
  await expect(bag.getByRole('heading', { name: /your bag \(2\)/i })).toBeVisible();
  await bag.getByRole('button', { name: /decrease quantity/i }).click();
  await expect(bag.getByRole('heading', { name: /your bag \(1\)/i })).toBeVisible();
  await bag.getByRole('button', { name: /remove/i }).click();
  await expect(bag.getByText(/your bag is empty/i)).toBeVisible();
});

test('storefront renders on a narrow mobile viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /training, simplified/i })).toBeVisible();
  await expect(page.getByRole('button', { name: /add to bag/i }).first()).toBeVisible();
});


test('COD checkout validates and captures customer details', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /add to bag/i }).first().click();
  const bag = page.getByRole('complementary');
  await bag.getByRole('button', { name: /proceed to checkout/i }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: /delivery details/i })).toBeVisible();
  const submit = dialog.getByRole('button', { name: /review order details/i });
  await expect(submit).toBeDisabled();
  await dialog.locator('input[name="fullName"]').fill('Test Customer');
  await dialog.locator('input[name="phone"]').fill('0612345678');
  await dialog.locator('input[name="whatsapp"]').fill('0612345678');
  await dialog.locator('input[name="city"]').fill('Casablanca');
  await dialog.locator('textarea[name="address"]').fill('10 Test Street');
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect(dialog.getByRole('heading', { name: /details captured/i })).toBeVisible();
  await expect(dialog.getByText(/order transmission is not configured yet/i)).toBeVisible();
});

test('checkout stays usable on a small viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByRole('button', { name: /add to bag/i }).first().click();
  await page.getByRole('complementary').getByRole('button', { name: /proceed to checkout/i }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel(/full name/i)).toBeVisible();
  await expect(dialog.getByText(/no online payment/i)).toBeVisible();
});


test('captures storefront desktop, mobile and checkout screenshots', async ({ page }) => {
  await page.goto('/');
  await page.screenshot({ path: 'test-results/storefront-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: 'test-results/storefront-mobile.png', fullPage: true });
  await page.getByRole('button', { name: /add to bag/i }).first().click();
  await page.getByRole('complementary').getByRole('button', { name: /proceed to checkout/i }).click();
  await page.screenshot({ path: 'test-results/checkout-mobile.png', fullPage: true });
});

test('monochrome admin panel exposes product creation and image controls', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'ADMIN' }).click();
  const panel = page.getByRole('dialog', { name: /product management/i });
  await expect(panel.getByRole('heading', { name: 'Products' })).toBeVisible();
  await expect(panel.getByRole('heading', { name: 'New product' })).toBeVisible();
  await expect(panel.getByLabel(/worker api url/i)).toBeVisible();
  await expect(panel.getByLabel(/5-digit PIN/i)).toBeVisible();
  await expect(panel.getByRole('button', { name: /create product/i })).toBeVisible();
  await expect(panel.getByRole('button', { name: /load.*refresh products/i })).toBeVisible();
  await panel.getByRole('button', { name: 'Close admin panel' }).click();
  await expect(panel).toBeHidden();
});


test('admin can update an order status from the archive', async ({ page }) => {
  let updatedStatus = '';
  await page.route('**/api/admin/orders', async route => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ json: [{ id: 42, order_number: 'COD-TEST-42', total: 498, status: 'pending', created_at: '2026-11-20', full_name: 'Test Customer', phone: '0612345678', whatsapp_phone: '212612345678', city: 'Rabat', address: 'Test address' }] });
      return;
    }
    const body = route.request().postDataJSON();
    updatedStatus = body.status;
    await route.fulfill({ json: { id: body.id, status: body.status } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'ADMIN' }).click();
  const panel = page.getByRole('dialog', { name: /product management/i });
  await panel.getByLabel(/worker api url/i).fill('https://store-api.example');
  await panel.getByLabel(/5-digit PIN/i).fill('12345');
  await panel.getByRole('button', { name: /load history/i }).click();
  const order = panel.locator('.admin-product').filter({ hasText: 'COD-TEST-42' });
  await expect(order).toBeVisible();
  await expect(order.getByRole('link', { name: /contact customer on whatsapp/i })).toHaveAttribute('href', /wa\.me\/212612345678/);
  await order.getByLabel(/order status/i).selectOption('confirmed');
  await expect.poll(() => updatedStatus).toBe('confirmed');
  await expect(order.getByLabel(/order status/i)).toHaveValue('confirmed');
});


test('product details can be opened and added to the bag', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /view details/i }).first().click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('#detail-title')).toBeVisible();
  await dialog.getByRole('button', { name: /add to bag/i }).click();
  await expect(page.getByRole('complementary').getByRole('heading', { name: /your bag \(1\)/i })).toBeVisible();
});


test('admin can read checkout notifications and adjust variant stock', async ({ page }) => {
  let stockDelta = 0;
  let readId = 0;
  await page.route('**/api/admin/notifications', async route => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ json: [{ id: 7, order_id: 42, title: 'New COD order', message: 'A new order COD-TEST-42 has been placed.', is_read: 0, created_at: '2026-11-20 10:00:00' }] });
      return;
    }
    const body = route.request().postDataJSON(); readId = body.id;
    await route.fulfill({ json: { id: body.id, is_read: 1 } });
  });
  await page.route('**/api/admin/products', async route => {
    if (route.request().method() === 'GET') await route.fulfill({ json: [{ id: 3, name: 'Training Tee', price: 249, status: 'active', slug: 'training-tee', variants: [{ id: 31, sku: 'TEE-M-BLACK', size: 'M', color: 'Black', stock: 4 }] }] });
    else await route.fulfill({ json: { id: 4, name: 'Created' } });
  });
  await page.route('**/api/admin/products/variants/stock', async route => {
    const body = route.request().postDataJSON(); stockDelta = body.delta;
    await route.fulfill({ json: { variantId: body.variantId, delta: body.delta, stock: 5, stockMovementRecorded: true } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'ADMIN' }).click();
  const panel = page.getByRole('dialog', { name: /product management/i });
  await panel.getByLabel(/worker api url/i).fill('https://store-api.example');
  await panel.getByLabel(/5-digit PIN/i).fill('12345');
  await panel.getByRole('button', { name: /load notifications/i }).click();
  const notification = panel.locator('.admin-notification').filter({ hasText: 'COD-TEST-42' });
  await expect(notification).toBeVisible();
  await notification.getByRole('button', { name: /mark read/i }).click();
  await expect.poll(() => readId).toBe(7);
  await panel.getByRole('button', { name: /load.*refresh products/i }).click();
  await panel.getByRole('button', { name: 'Increase stock for M Black' }).click();
  await expect.poll(() => stockDelta).toBe(1);
});


test('catalog search filters products and resets pagination', async ({ page }) => {
  await page.goto('/');
  const search = page.getByRole('textbox', { name: 'Search products' });
  await search.fill('hoodie');
  await expect(page.getByRole('heading', { name: 'Performance Hoodie' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Essential Training Tee' })).toBeHidden();
  await expect(page.getByText('1 MATCHING')).toBeVisible();
  await search.fill('nothing matches this');
  await expect(page.getByText('NO MATCHES FOUND')).toBeVisible();
  await search.clear();
  await expect(page.getByRole('heading', { name: 'Essential Training Tee' })).toBeVisible();
});


test('checkout retries reuse the same idempotency key after a transient failure', async ({ page }) => {
  const requestKeys: string[] = [];
  await page.route('**/api/orders', async route => {
    const body = route.request().postDataJSON(); requestKeys.push(body.idempotencyKey);
    if (requestKeys.length === 1) {
      await route.fulfill({ status: 503, json: { error: 'Temporary service issue. Try again.' } });
      return;
    }
    await route.fulfill({ status: 201, json: { orderId: 81, orderNumber: 'COD-RETRY-81', total: 249, currency: 'MAD', status: 'pending' } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'ADMIN' }).click();
  const admin = page.getByRole('dialog', { name: /product management/i });
  await admin.getByLabel(/worker api url/i).fill('https://store-api.example');
  await admin.getByRole('button', { name: 'Close admin panel' }).click();
  await page.getByRole('button', { name: /add to bag/i }).first().click();
  const bag = page.getByRole('complementary');
  await bag.getByRole('button', { name: /proceed to checkout/i }).click();
  const checkout = page.getByRole('dialog');
  await checkout.locator('input[name="fullName"]').fill('Retry Customer');
  await checkout.locator('input[name="phone"]').fill('0612345678');
  await checkout.locator('input[name="whatsapp"]').fill('0612345678');
  await checkout.locator('input[name="city"]').fill('Rabat');
  await checkout.locator('textarea[name="address"]').fill('10 Retry Street');
  const submit = checkout.getByRole('button', { name: /review order details/i });
  await submit.click();
  await expect(checkout.getByText(/temporary service issue/i)).toBeVisible();
  await submit.click();
  await expect(checkout.getByRole('heading', { name: /order received — COD-RETRY-81/i })).toBeVisible();
  expect(requestKeys).toHaveLength(2);
  expect(requestKeys[0]).toBeTruthy();
  expect(requestKeys[1]).toBe(requestKeys[0]);
});


test('storefront fits a 320px phone viewport without horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 740 });
  await page.goto('/');
  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(width).toBeLessThanOrEqual(320);
  await expect(page.getByRole('button', { name: /add to bag/i }).first()).toBeVisible();
  await page.getByRole('button', { name: 'ADMIN' }).click();
  const admin = page.getByRole('dialog', { name: /product management/i });
  await expect(admin.getByRole('button', { name: 'Close admin panel' })).toBeVisible();
});


test('admin can edit a product price, description and visibility', async ({ page }) => {
  let saved: any = null;
  await page.route('**/api/admin/products', async route => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ json: [{ id: 9, name: 'Training Tee', description: 'Original description', price: 249, status: 'draft', slug: 'training-tee', variants: [] }] });
      return;
    }
    saved = route.request().postDataJSON();
    await route.fulfill({ json: saved });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'ADMIN' }).click();
  const panel = page.getByRole('dialog', { name: /product management/i });
  await panel.getByLabel(/worker api url/i).fill('https://store-api.example');
  await panel.getByLabel(/5-digit PIN/i).fill('12345');
  await panel.getByRole('button', { name: /load.*refresh products/i }).click();
  const product = panel.locator('.admin-product').filter({ hasText: 'Training Tee' });
  const editor = product.locator('form.product-edit-form');
  await editor.getByLabel('Product name').fill('Training Tee V2');
  await editor.getByLabel('Price (MAD)').fill('299');
  await editor.getByLabel('Description').fill('Updated training description');
  await editor.getByLabel('Visibility').selectOption('active');
  await editor.getByRole('button', { name: 'SAVE PRODUCT' }).click();
  await expect.poll(() => saved?.price).toBe(299);
  expect(saved.name).toBe('Training Tee V2');
  expect(saved.status).toBe('active');
});


test('admin can search orders by customer details', async ({ page }) => {
  let query = '';
  await page.route('**/api/admin/orders*', async route => {
    const url = new URL(route.request().url()); query = url.searchParams.get('q') || '';
    await route.fulfill({ json: query.toLowerCase() === 'rabat' ? [{ id: 73, order_number: 'COD-RABAT-73', total: 379, status: 'pending', created_at: '2026-11-20', full_name: 'Search Customer', phone: '0612345678', whatsapp_phone: '212612345678', city: 'Rabat', address: 'Agdal' }] : [] });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'ADMIN' }).click();
  const panel = page.getByRole('dialog', { name: /product management/i });
  await panel.getByLabel(/worker api url/i).fill('https://store-api.example');
  await panel.getByLabel(/5-digit PIN/i).fill('12345');
  await panel.getByLabel('Search orders and customers').fill('rabat');
  await panel.getByRole('button', { name: /search orders/i }).click();
  await expect.poll(() => query).toBe('rabat');
  await expect(panel.getByText('COD-RABAT-73')).toBeVisible();
});
