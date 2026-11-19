import { test, expect } from '@playwright/test';

test('storefront displays its core sections', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /move with purpose/i })).toBeVisible();
  await expect(page.getByRole('heading', { name: /training essentials/i })).toBeVisible();
  await expect(page.getByText(/pay on arrival/i)).toBeVisible();
  await expect(page.getByRole('link', { name: /explore the collection/i })).toBeVisible();
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
  await expect(page.getByRole('heading', { name: /move with purpose/i })).toBeVisible();
  await expect(page.getByRole('button', { name: /add to bag/i }).first()).toBeVisible();
});
