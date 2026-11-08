import { test, expect } from '@playwright/test';
import { db, signup, login, fakeCnpjAlfa, pngSolido } from './helpers';

// Conta promovida a superadmin pelo SUPERADMIN_EMAILS do webServer (playwright.config.ts).
const MASTER_EMAIL = 'master-e2e@teste.dev';

test.afterAll(async () => { await db.$disconnect(); });

test.describe.serial('Telas críticas: cadastro, renovação e avisos', () => {
  test('cadastro com código por e-mail (CNPJ alfanumérico) leva ao painel', async ({ page, request }) => {
    const cnpj = fakeCnpjAlfa();
    const conta = await signup(page, request, { documento: cnpj.toLowerCase() });
    // Máscara em maiúsculas na tela e documento guardado normalizado.
    const user = await db.user.findUnique({ where: { email: conta.email } });
    expect(user?.documento).toBe(cnpj);
    expect(user?.emailVerifiedAt).not.toBeNull();
  });

  test('conta vencida vê o pop-up de renovação; reabre no clique; "Sair" continua funcionando', async ({ page, request }) => {
    const conta = await signup(page, request);
    const user = await db.user.findUniqueOrThrow({ where: { email: conta.email }, include: { memberships: true } });
    await db.subscription.updateMany({
      where: { orgId: user.memberships[0].orgId, product: 'MCKBOT' },
      data: { status: 'VENCIDA', validUntil: new Date(Date.now() - 86400000) },
    });
    await page.reload();
    const gate = page.getByRole('dialog');
    await expect(gate).toBeVisible();
    await expect(gate.getByRole('heading')).toHaveText(/teste grátis acabou|plano venceu/i);
    await expect(gate.getByRole('button', { name: 'Renovar agora' })).toBeVisible();
    await gate.getByRole('button', { name: 'Fechar' }).click();
    await expect(gate).toBeHidden();
    // Qualquer clique no app reabre o pop-up e não navega.
    await page.getByRole('navigation').getByRole('link', { name: 'Contatos', exact: true }).click();
    await expect(gate).toBeVisible();
    await expect(page.getByRole('heading', { level: 1, name: 'Visão geral' })).toBeVisible();
    await gate.getByRole('button', { name: 'Fechar' }).click();
    // "Sair" nunca é bloqueado.
    await page.getByRole('button', { name: 'Sair' }).click();
    await expect(page.getByRole('button', { name: 'Entrar' })).toBeVisible();
  });

  test('Indique e ganhe: link no Perfil, cadastro pelo link grava a indicação e a contagem aparece', async ({ page, request, browser }) => {
    const quem = await signup(page, request, { org: 'Indicadora E2E' });
    await page.goto('/perfil');
    const card = page.getByTestId('indique-ganhe');
    await expect(card.getByRole('heading', { name: /Indique e ganhe/ })).toBeVisible();
    const link = await card.getByLabel('Seu link de indicação').inputValue();
    expect(link).toMatch(/\/cadastro\?indica=[A-Z2-9]{8}$/);
    await expect(card.getByRole('button', { name: 'Copiar link' })).toBeVisible();
    await expect(card.getByRole('link', { name: 'Compartilhar no WhatsApp' })).toHaveAttribute('href', /^https:\/\/wa\.me\/\?text=/);
    await expect(card.getByTestId('indicados')).toHaveText('0');
    // Outra pessoa abre o link em outro navegador e se cadastra.
    const ctx = await browser.newContext();
    const p2 = await ctx.newPage();
    await p2.goto(new URL(link).pathname + new URL(link).search);
    await expect(p2.getByTestId('aviso-indicacao')).toBeVisible();
    const indicada = await signup(p2, ctx.request, { org: 'Indicada E2E' });
    await ctx.close();
    const u = await db.user.findUniqueOrThrow({ where: { email: indicada.email }, include: { memberships: true } });
    const ref = await db.referral.findUnique({ where: { referredOrgId: u.memberships[0].orgId } });
    expect(ref?.status).toBe('PENDENTE');
    const dono = await db.user.findUniqueOrThrow({ where: { email: quem.email }, include: { memberships: true } });
    expect(ref?.referrerOrgId).toBe(dono.memberships[0].orgId);
    await page.reload();
    await expect(page.getByTestId('indique-ganhe').getByTestId('indicados')).toHaveText('1');
  });

  test('Master › Avisos: envia imagem e o cliente vê o pop-up central uma única vez', async ({ page, request, browser }) => {
    // Master: cadastra, sai e entra de novo (promoção a superadmin acontece no login).
    const master = await signup(page, request, { email: MASTER_EMAIL, org: 'Plataforma E2E' });
    await page.getByRole('button', { name: 'Sair' }).click();
    await login(page, master.email, master.password);
    // Menu lateral por módulo: o Painel Master aparece em "Trocar módulo".
    await expect(page.getByRole('navigation').getByRole('link', { name: 'Painel Master' })).toBeVisible();
    await page.goto('/master?aba=avisos');
    await page.getByRole('button', { name: 'Novo aviso' }).click();
    await page.locator('input[type="file"]').setInputFiles({ name: 'aviso.png', mimeType: 'image/png', buffer: pngSolido(320, 160) });
    await page.getByLabel('Título (opcional)').fill('Promoção E2E');
    await page.getByLabel('Texto (opcional)').fill('Aviso criado pelo teste de tela.');
    await page.getByRole('button', { name: 'Criar aviso' }).click();
    await expect(page.getByRole('cell', { name: /Promoção E2E/ }).first()).toBeVisible();

    // Cliente em outro navegador (sem cookies do Master).
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const cli = await ctx.newPage();
    await signup(cli, ctx.request);
    const aviso = cli.getByRole('dialog', { name: 'Promoção E2E' });
    await expect(aviso).toBeVisible();
    await expect(aviso.getByText('Aviso criado pelo teste de tela.')).toBeVisible();
    await expect.poll(() => aviso.locator('img').evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth)).toBe(320);
    // Centralizado na tela.
    const box = (await aviso.boundingBox())!;
    expect(Math.abs(box.x + box.width / 2 - 640)).toBeLessThan(30);
    expect(Math.abs(box.y + box.height / 2 - 400)).toBeLessThan(60);
    await aviso.getByRole('button', { name: 'Fechar' }).click();
    await expect(aviso).toBeHidden();
    // Recarregou: não aparece de novo no mesmo dia.
    const active = cli.waitForResponse((r) => r.url().includes('/api/announcements/active'));
    await cli.reload();
    await active;
    await cli.waitForTimeout(500);
    await expect(cli.getByRole('dialog')).toHaveCount(0);
    await ctx.close();
  });
});
