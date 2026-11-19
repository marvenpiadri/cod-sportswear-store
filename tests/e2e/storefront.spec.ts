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
  await expect(page.getByRole('heading', { name: /your bag/i })).toBeVisible();
  await expect(page.getByText('Essential Training Tee')).toBeVisible();
});

test('cart quantity, subtotal and removal update correctly', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /add to bag/i }).first().click();
  await expect(page.getByText('Subtotal')).toBeVisible();
  await expect(page.getByRole('button', { name: /increase quantity/i })).toBeVisible();
  await page.getByRole('button', { name: /increase quantity/i }).click();
  await expect(page.getByRole('heading', { name: /your bag \(2\)/i })).toBeVisible();
  await page.getByRole('button', { name: /decrease quantity/i }).click();
  await expect(page.getByRole('heading', { name: /your bag \(1\)/i })).toBeVisible();
  await page.getByRole('button', { name: /remove/i }).click();
  await expect(page.getByText(/your bag is empty/i)).toBeVisible();
});

test('storefront renders on a narrow mobile viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /move with purpose/i })).toBeVisible();
  await expect(page.getByRole('button', { name: /add to bag/i }).first()).toBeVisible();
});
