import { test, expect, type Page } from '@playwright/test';
import { db, signup } from './helpers';

test.afterAll(async () => { await db.$disconnect(); });

/** Chama a API logado, com o token CSRF da sessão (como a tela faz). */
async function api(page: Page, method: string, path: string, body?: unknown) {
  return page.evaluate(async ({ method, path, body }) => {
    const me = await (await fetch('/api/auth/me', { headers: { 'x-requested-with': 'mckbot' } })).json();
    const r = await fetch(`/api${path}`, { method, headers: { 'x-requested-with': 'mckbot', 'x-csrf-token': me.csrfToken, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => null) };
  }, { method, path, body });
}

// v1.32.0: Compras › O que comprar — lista clara, embalagem (pacote com 10 peças) e gerar pedido; legível no celular.
test('O que comprar: lista, quantidade sugerida, embalagem e pedido de compra', async ({ page, request }) => {
  await signup(page, request);
  const end = (await api(page, 'POST', '/erp/estoque/depositos', { nome: 'Loja', enderecos: ['GERAL'] })).body.enderecos[0].id;
  const forn = (await api(page, 'POST', '/erp/crm/parceiros', { documento: '11444777000161', nome: 'Ferragens Silva LTDA', fantasia: 'Ferragens Silva', ehCliente: false, ehFornecedor: true })).body;
  const caneta = (await api(page, 'POST', '/erp/produtos', { nome: 'Canetack', estoqueMinimoMil: 10_000, custoMedioCents: 500 })).body;
  const paraf = (await api(page, 'POST', '/erp/produtos', { nome: 'Parafuso 6 mm', unidade: 'PC', unidadeCompra: 'PCT', fatorCompraMil: 10_000, estoqueMinimoMil: 10_000, fornecedorPadraoId: forn.id })).body;
  await api(page, 'POST', '/erp/estoque/entrada', { produtoId: caneta.id, enderecoId: end, qtdMil: 5_000, custoUnitCents: 500 });
  await api(page, 'POST', '/erp/estoque/entrada', { produtoId: paraf.id, enderecoId: end, qtdMil: 5_000, custoUnitCents: 200 });
  await db.erpProduto.updateMany({ where: { id: { in: [caneta.id, paraf.id] } }, data: { createdAt: new Date(Date.now() - 120 * 86_400_000) } });
  const s = await db.erpSaldo.findFirstOrThrow({ where: { produtoId: paraf.id } });
  await db.erpMovimento.create({ data: { orgId: paraf.orgId, produtoId: paraf.id, loteId: s.loteId, enderecoId: s.enderecoId, tipo: 'SAIDA', qtdMil: -60_000, saldoAposMil: 5_000, docTipo: 'pedido_venda', createdAt: new Date(Date.now() - 5 * 86_400_000) } });

  await page.goto('/erp/compras');
  await expect(page.getByRole('button', { name: 'O que comprar' })).toBeVisible();
  await expect(page.getByText('Ferragens Silva').first()).toBeVisible();
  await expect(page.getByText('vende ~2 peças por dia, dura 2 dias, compra para 30 dias, arredondado para embalagem inteira')).toBeVisible();
  await expect(page.getByLabel('Quantidade de Parafuso 6 mm')).toHaveValue('6');
  await expect(page.getByText('= 60 peças')).toBeVisible();
  await expect(page.getByText('sem vendas nos últimos 90 dias, completa o estoque mínimo')).toBeVisible();
  await expect(page.locator('.oqc-total')).toHaveText(/R\$\s?145,00/);
  await page.screenshot({ path: 'tests/e2e/.resultados/o-que-comprar-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(page.getByText('= 60 peças')).toBeVisible();
  await page.screenshot({ path: 'tests/e2e/.resultados/o-que-comprar-celular.png', fullPage: true });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.reload();

  // Editar a quantidade muda o total; gerar pedido cria rascunho + solicitação
  await page.getByLabel('Quantidade de Parafuso 6 mm').fill('5');
  await expect(page.locator('.oqc-total')).toHaveText(/R\$\s?125,00/);
  page.once('dialog', (d) => d.accept());
  await page.getByRole('button', { name: 'Gerar pedido de compra' }).click();
  await expect(page.getByText(/Pedido de compra nº \d+/)).toBeVisible();
  const pc = await db.erpPedidoCompra.findFirstOrThrow({ where: { orgId: paraf.orgId }, include: { itens: true } });
  expect(pc.status).toBe('RASCUNHO');
  expect(pc.itens[0]).toMatchObject({ produtoId: paraf.id, qtdMil: 50_000, precoUnitCents: 200 });
});
