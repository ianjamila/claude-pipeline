// Pipeline E2E smoke: a few fast checks that the app boots and key pages render.
// Screenshots land in .verify/screenshots/ so verify and reviewers can look at them.
import { test, expect } from '@playwright/test';

const shot = (name: string) => `.verify/screenshots/${name}.png`;

test('home page renders', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveTitle(/.+/);
  await page.screenshot({ path: shot('home'), fullPage: true });
});
