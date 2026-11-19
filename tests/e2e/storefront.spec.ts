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
  await expect(page.getByText(/items selected/i)).toBeVisible();
});

test('bag count increments when another product is added', async ({ page }) => {
  await page.goto('/');
  const bag = page.getByRole('button', { name: /^bag/i });
  await expect(bag).toContainText('0');
  await page.getByRole('button', { name: /add to bag/i }).first().click();
  await expect(bag).toContainText('1');
  await page.getByRole('button', { name: /continue shopping/i }).click();
  await page.getByRole('button', { name: /add to bag/i }).nth(1).click();
  await expect(bag).toContainText('2');
});

test('storefront renders on a narrow mobile viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /move with purpose/i })).toBeVisible();
  await expect(page.getByRole('button', { name: /add to bag/i }).first()).toBeVisible();
});
