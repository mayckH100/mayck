import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { registerClient, Client, createTestChannel, installGraphMock, graph, sendInbound, fakeCnpj, prisma } from '../helpers.js';
import { fakeAi } from '../../server/ai/providers.js';

/**
 * v1.24.0 — De onde a IA consulta os produtos: catálogo (padrão), ERP (saldo em tempo real) ou os dois.
 * Custo e fornecedor nunca vão ao prompt; organizações isoladas; sem Plano Completo ou com erro no ERP → catálogo.
 */
describe('IA · fonte dos produtos (Produtos / ERP / os dois)', () => {
  let a: Client, b: Client;
  let ctx: Awaited<ReturnType<typeof createTestChannel>>;
  let dep1: string, dep2: string, depB: string;
  let phone = 5511740000000;
  const nextPhone = () => String(++phone);
  const lastSystem = () => fakeAi.calls.at(-1)?.find((m) => m.role === 'system')?.content ?? '';
  const ask = async (text: string) => { fakeAi.calls.length = 0; await sendInbound(ctx, nextPhone(), text); return lastSystem(); };

  async function erpProduto(c: Client, body: Record<string, unknown>) {
    const r = await c.post('/api/erp/produtos', body);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body;
  }

  beforeAll(async () => {
    installGraphMock();
    a = await registerClient();
    b = await registerClient();
    await a.get('/api/billing/status'); // assinaturas em teste = Plano Completo em teste
    await b.get('/api/billing/status');
    ctx = await createTestChannel(a.me.org.id);
    await a.put('/api/ai/settings', { provider: 'fake', model: 'fake-1', enabled: true, autoReply: true });

    // Catálogo (Produtos)
    expect((await a.post('/api/ai/products', { name: 'Furadeira Bosch', priceCents: 29990, description: 'Furadeira de impacto 650W, ideal para alvenaria', details: 'cód FUR-01; voltagem 220V', stock: 'esgotado' })).status).toBe(201);

    // ERP: dois depósitos, fornecedor, produto com custo e custos adicionais (nunca podem ir ao prompt)
    const d1 = await a.post('/api/erp/estoque/depositos', { nome: 'Central', enderecos: ['A-01-01'] });
    const d2 = await a.post('/api/erp/estoque/depositos', { nome: 'Loja 2', enderecos: ['L-01-01'] });
    dep1 = d1.body.id; dep2 = d2.body.id;
    const end1 = d1.body.enderecos[0].id;
    const forn = await a.post('/api/erp/crm/parceiros', { documento: fakeCnpj(), nome: 'Fornecedor Oculto LTDA' });
    const fur = await erpProduto(a, { sku: 'FUR-01', nome: 'Furadeira Bosch 650W', precoBaseCents: 39990, custoMedioCents: 12345, custosAdicionais: [{ nome: 'Embalagem Secreta', valorCents: 777 }], fornecedorPadraoId: forn.body.id });
    const serra = await erpProduto(a, { sku: 'SER-02', nome: 'Serra Tico-Tico', precoBaseCents: 25000, descricao: 'Serra de recorte' });
    await erpProduto(a, { sku: 'INS-03', nome: 'Serra matéria-prima interna', tipo: 'INSUMO', precoBaseCents: 100 });
    expect((await a.post('/api/erp/estoque/entrada', { produtoId: fur.id, enderecoId: end1, qtdMil: 20_000, custoUnitCents: 12345 })).status).toBe(201);
    expect((await a.post('/api/erp/estoque/entrada', { produtoId: serra.id, enderecoId: end1, qtdMil: 2_000, custoUnitCents: 9000 })).status).toBe(201);
    // 8 reservadas (pedido em andamento): disponível = 20 − 8 = 12
    const s = await prisma.erpSaldo.findFirstOrThrow({ where: { orgId: a.me.org.id, produtoId: fur.id } });
    await prisma.erpSaldo.update({ where: { id: s.id }, data: { reservadoMil: 8_000 } });

    // Outra organização com ERP próprio
    const db = await b.post('/api/erp/estoque/depositos', { nome: 'Depósito B', enderecos: ['B-01-01'] });
    depB = db.body.id;
    const mak = await erpProduto(b, { sku: 'MAK-1', nome: 'Furadeira Makita', precoBaseCents: 55500 });
    await b.post('/api/erp/estoque/entrada', { produtoId: mak.id, enderecoId: db.body.enderecos[0].id, qtdMil: 50_000, custoUnitCents: 100 });
  });
  beforeEach(() => { graph.reset(); fakeAi.calls.length = 0; fakeAi.script.length = 0; });

  it('padrão "catalogo": só os Produtos cadastrados, o ERP é ignorado', async () => {
    expect((await a.get('/api/ai/products/source')).body).toMatchObject({ productSource: 'catalogo', erpShowQuantity: false, erpDepositoId: null, erpLiberado: true, efetivo: 'catalogo' });
    const sys = await ask('quanto custa a furadeira bosch?');
    expect(sys).toContain('[Produtos do catálogo]');
    expect(sys).toContain('R$ 299,90');
    expect(sys).toContain('Esgotado');
    expect(sys).not.toContain('R$ 399,90');
    expect(sys).not.toContain('cód. FUR-01');
    expect(await ask('vocês tem serra tico-tico?')).not.toContain('Serra Tico-Tico');
  });

  it('"erp": usa o saldo (reservado descontado), quantidade escondida por padrão, nada de custo/fornecedor', async () => {
    const put = await a.put('/api/ai/products/source', { productSource: 'erp' });
    expect(put.status).toBe(200);
    expect(put.body).toMatchObject({ productSource: 'erp', erpShowQuantity: false });
    const sys = await ask('quanto custa a furadeira bosch?');
    expect(sys).toContain('[Produtos do ERP]');
    expect(sys).toContain('Furadeira Bosch 650W');
    expect(sys).toContain('R$ 399,90');
    expect(sys).toMatch(/Furadeira Bosch 650W[^\n]*\| Disponível/);
    expect(sys).not.toMatch(/\b(12|20) UN\b/);
    expect(sys).toContain('Não informe quantidade');
    expect(sys).not.toContain('R$ 299,90'); // catálogo fora
    for (const segredo of ['123,45', '12345', 'Embalagem Secreta', '7,77', 'Fornecedor Oculto', 'custoMedio']) expect(sys).not.toContain(segredo);
    // insumo não vai para o cliente
    expect(await ask('tem serra?')).not.toContain('matéria-prima interna');
    const logs = await prisma.auditLog.count({ where: { orgId: a.me.org.id, action: 'ai.product_source' } });
    expect(logs).toBeGreaterThan(0);
  });

  it('"erp" com quantidade ligada mostra o disponível exato; depósito sem saldo = sem estoque; poucas unidades', async () => {
    await a.put('/api/ai/products/source', { productSource: 'erp', erpShowQuantity: true });
    let sys = await ask('quanto custa a furadeira bosch?');
    expect(sys).toContain('Disponível (12 UN)');
    expect(sys).toContain('Pode informar a quantidade');
    sys = await ask('tem serra tico-tico?');
    expect(sys).toContain('Poucas unidades (2 UN)');

    await a.put('/api/ai/products/source', { productSource: 'erp', erpShowQuantity: true, erpDepositoId: dep2 });
    sys = await ask('quanto custa a furadeira bosch?');
    expect(sys).toContain('Sem estoque');
    expect(sys).not.toContain('(12 UN)');
    await a.put('/api/ai/products/source', { productSource: 'erp', erpShowQuantity: true, erpDepositoId: dep1 });
    expect(await ask('quanto custa a furadeira bosch?')).toContain('Disponível (12 UN)');
    await a.put('/api/ai/products/source', { productSource: 'erp', erpShowQuantity: false, erpDepositoId: null });
  });

  it('"ambos": descrição/preço do catálogo + saldo do ERP (liga pelo SKU); produto só do ERP também entra', async () => {
    await a.put('/api/ai/products/source', { productSource: 'ambos' });
    const sys = await ask('quanto custa a furadeira bosch?');
    expect(sys).toContain('[Produtos do catálogo]');
    expect(sys).toMatch(/Furadeira Bosch \| cód\. FUR-01 \| preço R\$ 299,90 \| Disponível/);
    expect(sys).toContain('Furadeira de impacto 650W');
    expect(sys).not.toMatch(/Furadeira Bosch \|[^\n]*Esgotado/); // estoque do catálogo substituído pelo do ERP
    expect(sys).not.toContain('Fornecedor Oculto');
    expect(await ask('tem serra tico-tico?')).toContain('Serra Tico-Tico');
  });

  it('prévia ("Testar") segue a fonte salva ou a escolhida na tela', async () => {
    const saved = await a.post('/api/ai/products/preview', { message: 'furadeira bosch' });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ source: 'ambos', requested: 'ambos', fallback: null });
    expect(saved.body.products[0]).toMatchObject({ name: 'Furadeira Bosch', origem: 'ambos' });
    const cat = await a.post('/api/ai/products/preview', { message: 'furadeira bosch', productSource: 'catalogo' });
    expect(cat.body.context).toContain('R$ 299,90');
    expect(cat.body.context).not.toContain('cód.');
    const erp = await a.post('/api/ai/products/preview', { message: 'furadeira bosch', productSource: 'erp', erpShowQuantity: true });
    expect(erp.body.context).toContain('Disponível (12 UN)');
    expect(erp.body.context).not.toContain('123,45');
    const src = (await a.get('/api/ai/products/source')).body;
    expect(src.depositos.map((d: any) => d.nome).sort()).toEqual(['Central', 'Loja 2']);
    expect(Object.keys(src.depositos[0]).sort()).toEqual(['id', 'nome']);
  });

  it('isolamento: o ERP de outra organização nunca entra; depósito alheio é recusado', async () => {
    await a.put('/api/ai/products/source', { productSource: 'erp' });
    const sys = await ask('tem furadeira makita?');
    expect(sys).not.toContain('Makita');
    expect(sys).not.toContain('555,00');
    expect((await b.put('/api/ai/products/source', { productSource: 'erp', erpDepositoId: dep1 })).status).toBe(404);
    expect((await b.post('/api/ai/products/preview', { message: 'furadeira', productSource: 'erp', erpDepositoId: dep1 })).status).toBe(404);
    const pb = await b.post('/api/ai/products/preview', { message: 'furadeira', productSource: 'erp' });
    expect(pb.body.context).toContain('Furadeira Makita');
    expect(pb.body.context).not.toContain('Bosch');
    expect((await b.get('/api/ai/products/source')).body.depositos.map((d: any) => d.id)).toEqual([depB]);
  });

  it('se a consulta ao ERP falhar, volta para o catálogo e a IA responde', async () => {
    await a.put('/api/ai/products/source', { productSource: 'erp' });
    const spy = vi.spyOn(prisma.erpProduto, 'findMany').mockRejectedValueOnce(new Error('banco do ERP fora'));
    const sys = await ask('quanto custa a furadeira bosch?');
    spy.mockRestore();
    expect(sys).toContain('[Produtos do catálogo]');
    expect(sys).toContain('R$ 299,90');
    expect(fakeAi.calls.length).toBe(1);
  });

  it('sem Plano Completo: opção do ERP recusada, a configuração salva volta ao catálogo', async () => {
    await a.put('/api/ai/products/source', { productSource: 'erp' });
    const orgId = a.me.org.id;
    const before = await prisma.subscription.findUniqueOrThrow({ where: { orgId_product: { orgId, product: 'MCKMENSAGEM' } } });
    await prisma.subscription.update({ where: { id: before.id }, data: { validUntil: new Date(Date.now() - 86400e3), status: 'ATIVA', source: 'MP' } });
    try {
      const src = (await a.get('/api/ai/products/source')).body;
      expect(src).toMatchObject({ productSource: 'erp', erpLiberado: false, efetivo: 'catalogo', depositos: [] });
      expect(src.motivo).toMatch(/Plano Completo/);
      const put = await a.put('/api/ai/products/source', { productSource: 'ambos' });
      expect(put.status).toBe(400);
      expect((await a.put('/api/ai/products/source', { productSource: 'catalogo' })).status).toBe(200);
      await prisma.aiSettings.update({ where: { orgId }, data: { productSource: 'erp' } });
      const sys = await ask('quanto custa a furadeira bosch?');
      expect(sys).toContain('R$ 299,90');
      expect(sys).not.toContain('R$ 399,90');
      const pv = await a.post('/api/ai/products/preview', { message: 'furadeira bosch' });
      expect(pv.body).toMatchObject({ requested: 'erp', source: 'catalogo', fallback: 'sem_plano' });
    } finally {
      await prisma.subscription.update({ where: { id: before.id }, data: { validUntil: before.validUntil, status: before.status, source: before.source } });
    }
  });
});
