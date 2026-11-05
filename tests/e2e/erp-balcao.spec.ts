import { test, expect } from '@playwright/test';
import { db, signup } from './helpers';

test.afterAll(async () => { await db.$disconnect(); });

// Relato do dono (04/11): "no ERP não está aparecendo venda no balcão" — a venda balcão não tinha item no menu.
test('menu do MCK ERP tem "Venda balcão (PDV)" e abre a tela de venda', async ({ page, request }) => {
  await signup(page, request);
  const item = page.locator('.sidebar').getByRole('link', { name: 'Venda balcão (PDV)' });
  if (!(await item.isVisible())) await page.locator('.sidebar').getByText('MCK ERP', { exact: true }).first().click();
  await expect(item).toBeVisible();
  await item.click();
  await expect(page).toHaveURL(/\/erp\/balcao$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Venda balcão (PDV)' })).toBeVisible();
  await expect(page.getByText('Finalizar venda')).toBeVisible();
  await page.screenshot({ path: 'tests/e2e/.resultados/erp-balcao.png', fullPage: false });
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Vendas balcão' })).toBeVisible();
});
