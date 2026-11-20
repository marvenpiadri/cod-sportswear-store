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
  await panel.getByRole('button', { name: '×' }).click();
  await expect(panel).toBeHidden();
});


test('admin can update an order status from the archive', async ({ page }) => {
  let updatedStatus = '';
  await page.route('**/api/admin/orders', async route => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ json: [{ id: 42, order_number: 'COD-TEST-42', total: 498, status: 'pending', created_at: '2026-11-20', full_name: 'Test Customer', phone: '0612345678', whatsapp_phone: '0612345678', city: 'Rabat', address: 'Test address' }] });
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
