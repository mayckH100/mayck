import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { registerClient, Client, uniq, createTestChannel, installGraphMock, graph, sendInbound, sentTexts, prisma } from '../helpers.js';
import { fakeAi } from '../../server/ai/providers.js';

describe('Produtos (catálogo para a IA)', () => {
  let a: Client, b: Client, agent: Client;
  let ctx: Awaited<ReturnType<typeof createTestChannel>>;
  let phone = 5511730000000;
  const nextPhone = () => String(++phone);

  beforeAll(async () => {
    installGraphMock();
    a = await registerClient();
    b = await registerClient();
    ctx = await createTestChannel(a.me.org.id);
    const inv = await a.post('/api/team/invites', { email: `${uniq()}@t.dev`, role: 'AGENT' });
    const token = inv.body.link.split('/convite/')[1];
    agent = new Client();
    const r = await agent.agent.post('/api/auth/accept-invite').set('x-requested-with', 'mckbot').send({ token, name: 'Atendente', password: 'senhaMembro123' });
    agent.csrf = r.body.csrfToken; agent.me = r.body;
    await a.put('/api/ai/settings', { provider: 'fake', model: 'fake-1', enabled: true, autoReply: true });
  });
  beforeEach(() => { graph.reset(); fakeAi.calls.length = 0; fakeAi.script.length = 0; });

  it('CRUD: cria, lista com busca, edita, desativa e exclui (com auditoria)', async () => {
    const c = await a.post('/api/ai/products', { name: 'Camiseta Básica', category: 'Roupas', priceCents: 4990, promoCents: 3990, details: 'cores: preta, branca', stock: 'disponivel', quantity: 10, link: 'https://loja.com.br/camiseta' });
    expect(c.status).toBe(201);
    expect(c.body).toMatchObject({ name: 'Camiseta Básica', priceCents: 4990, active: true, orgId: a.me.org.id });
    const id = c.body.id;
    await a.post('/api/ai/products', { name: 'Caneca', priceCents: 2500 });

    const all = await a.get('/api/ai/products');
    expect(all.status).toBe(200);
    expect(all.body.total).toBe(2);
    const s = await a.get('/api/ai/products?q=camiseta');
    expect(s.body.items.map((p: any) => p.name)).toEqual(['Camiseta Básica']);

    const u = await a.put(`/api/ai/products/${id}`, { name: 'Camiseta Básica', priceCents: 5990, stock: 'sob_encomenda' });
    expect(u.status).toBe(200);
    expect(u.body).toMatchObject({ priceCents: 5990, promoCents: null, stock: 'sob_encomenda' });

    expect((await a.patch(`/api/ai/products/${id}`, { active: false })).body.active).toBe(false);
    expect((await a.patch(`/api/ai/products/${id}`, { active: true })).body.active).toBe(true);

    const caneca = all.body.items.find((p: any) => p.name === 'Caneca');
    expect((await a.del(`/api/ai/products/${caneca.id}`)).status).toBe(200);
    expect((await a.get('/api/ai/products')).body.total).toBe(1);

    const logs = await prisma.auditLog.findMany({ where: { orgId: a.me.org.id, action: { startsWith: 'product.' } } });
    expect(logs.map((l) => l.action)).toEqual(expect.arrayContaining(['product.create', 'product.update', 'product.toggle', 'product.delete']));
  });

  it('valida dados: nome obrigatório, link só https, estoque válido', async () => {
    expect((await a.post('/api/ai/products', { name: '' })).status).toBe(400);
    expect((await a.post('/api/ai/products', { name: 'X', link: 'http://inseguro.com' })).status).toBe(400);
    expect((await a.post('/api/ai/products', { name: 'X', imageUrl: 'javascript:alert(1)' })).status).toBe(400);
    expect((await a.post('/api/ai/products', { name: 'X', stock: 'talvez' })).status).toBe(400);
    expect((await a.post('/api/ai/products', { name: 'X', priceCents: -1 })).status).toBe(400);
  });

  it('isolamento: outra organização não vê nem altera; atendente só lê', async () => {
    const p = (await a.post('/api/ai/products', { name: 'Produto secreto A', priceCents: 100 })).body;
    expect((await b.get('/api/ai/products')).body.total).toBe(0);
    expect((await b.put(`/api/ai/products/${p.id}`, { name: 'hack' })).status).toBe(404);
    expect((await b.patch(`/api/ai/products/${p.id}`, { active: false })).status).toBe(404);
    expect((await b.del(`/api/ai/products/${p.id}`)).status).toBe(404);
    expect((await prisma.product.findUnique({ where: { id: p.id } }))!.name).toBe('Produto secreto A');
    expect((await agent.post('/api/ai/products', { name: 'Do atendente' })).status).toBe(403);
    expect((await agent.del(`/api/ai/products/${p.id}`)).status).toBe(403);
    await a.del(`/api/ai/products/${p.id}`);
  });

  it('importa CSV (; ou ,), atualiza pelo nome e relata erros', async () => {
    const tpl = await a.get('/api/ai/products/template');
    expect(tpl.status).toBe(200);
    expect(tpl.headers['content-type']).toContain('text/csv');
    expect(tpl.text).toContain('nome;categoria;preco');

    const csv = 'nome;categoria;preco;descricao;detalhes;estoque;link;imagem\nFiat Uno 2015;Veículos;32.900,00;Revisado;"ano 2015; 80.000 km";sob encomenda;;\nCamiseta Básica;Roupas;44,90;;;3;;\n;sem nome;1;;;;;\nVaso;Casa;abc;;;;;';
    const r = await a.post('/api/ai/products/import', { text: csv });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ created: 1, updated: 1, errorCount: 2 });
    const uno = await prisma.product.findFirst({ where: { orgId: a.me.org.id, name: 'Fiat Uno 2015' } });
    expect(uno).toMatchObject({ priceCents: 3290000, stock: 'sob_encomenda', details: 'ano 2015; 80.000 km' });
    const cam = await prisma.product.findFirst({ where: { orgId: a.me.org.id, name: 'Camiseta Básica' } });
    expect(cam).toMatchObject({ priceCents: 4490, quantity: 3 });

    const comma = await a.post('/api/ai/products/import', { text: 'nome,preco,estoque\nCaneca Azul,25.00,esgotado' });
    expect(comma.body.created).toBe(1);
    expect((await a.post('/api/ai/products/import', { text: 'qualquer;coisa\n1;2' })).status).toBe(400);
    const tooMany = 'nome;preco\n' + Array.from({ length: 501 }, (_, i) => `P${i};1`).join('\n');
    expect((await a.post('/api/ai/products/import', { text: tooMany })).status).toBe(400);
    expect((await b.get('/api/ai/products')).body.total).toBe(0);
  });

  it('IA recebe os produtos relevantes (ativos) no contexto e responde com o preço do catálogo', async () => {
    await sendInbound(ctx, nextPhone(), 'quanto custa o fiat uno 2015?');
    const system = fakeAi.calls.at(-1)!.find((m) => m.role === 'system')!.content;
    expect(system).toContain('[Produtos do catálogo]');
    expect(system).toContain('Fiat Uno 2015');
    expect(system).toContain('R$ 32.900,00');
    expect(system).toContain('Sob encomenda');
    expect(system).toContain('Nunca invente preço');
    expect(system).not.toContain('Caneca Azul');
    expect(sentTexts()[0]).toContain('R$ 32.900,00');
  });

  it('produto desativado não vai para a IA; sem produto, a IA transfere em vez de inventar', async () => {
    const uno = await prisma.product.findFirstOrThrow({ where: { orgId: a.me.org.id, name: 'Fiat Uno 2015' } });
    await a.patch(`/api/ai/products/${uno.id}`, { active: false });
    await sendInbound(ctx, nextPhone(), 'quanto custa o fiat uno 2015?');
    const system = fakeAi.calls.at(-1)!.find((m) => m.role === 'system')!.content;
    expect(system).not.toContain('Fiat Uno 2015');
    expect(sentTexts().join(' ')).not.toContain('32.900');
    await a.patch(`/api/ai/products/${uno.id}`, { active: true });
  });

  it('produtos de outra organização nunca entram no prompt', async () => {
    await b.post('/api/ai/products', { name: 'Moto Honda CG', priceCents: 1500000 });
    await sendInbound(ctx, nextPhone(), 'tem moto honda cg?');
    const system = fakeAi.calls.at(-1)?.find((m) => m.role === 'system')?.content ?? '';
    expect(system).not.toContain('Moto Honda CG');
  });

  it('prévia mostra o que a IA receberia', async () => {
    const r = await a.post('/api/ai/products/preview', { message: 'camiseta preta' });
    expect(r.status).toBe(200);
    expect(r.body.products.map((p: any) => p.name)).toContain('Camiseta Básica');
    expect(r.body.context).toContain('R$ 44,90');
  });

  it('assinatura MCKBOT vencida: escrita 402, leitura ok', async () => {
    await a.get('/api/billing/status');
    const orgId = a.me.org.id;
    const before = await prisma.subscription.findUniqueOrThrow({ where: { orgId_product: { orgId, product: 'MCKBOT' } } });
    await prisma.subscription.update({ where: { id: before.id }, data: { validUntil: new Date(Date.now() - 86400e3) } });
    expect((await a.post('/api/ai/products', { name: 'Bloqueado' })).status).toBe(402);
    expect((await a.get('/api/ai/products')).status).toBe(200);
    await prisma.subscription.update({ where: { id: before.id }, data: { validUntil: before.validUntil } });
  });
});
