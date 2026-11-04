import { test, expect } from '@playwright/test';
import { db, signup } from './helpers';

test.afterAll(async () => { await db.$disconnect(); });

test('número da versão na tela de entrada abre o histórico de versões', async ({ page }) => {
  await page.goto('/login');
  const versao = page.getByTestId('versao-rodape');
  await expect(versao).toHaveText(/^Versão \d+\.\d+\.\d+ · /);
  await versao.click();
  await expect(page).toHaveURL(/\/versoes$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Novidades e histórico de versões' })).toBeVisible();
  await expect(page.getByText('Atual', { exact: true })).toBeVisible();
  const r = await page.request.get('/api/versao');
  expect((await r.json()).ok).toBe(true);
});

test('logado: versão no fim do menu lateral abre o histórico dentro do app', async ({ page, request }) => {
  await signup(page, request);
  const versao = page.getByTestId('versao-rodape');
  await expect(versao).toHaveText(/^Versão \d+\.\d+\.\d+ · /);
  await versao.click();
  await expect(page.getByRole('heading', { level: 1, name: 'Novidades e histórico de versões' })).toBeVisible();
  await expect(page.locator('.sidebar')).toBeAttached();
  await page.screenshot({ path: 'tests/e2e/.resultados/versoes-logado.png', fullPage: false });
});
