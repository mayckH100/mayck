import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { registerClient, Client, prisma, app } from '../helpers.js';
import { setFetch, resetFetch } from '../../server/lib/fetcher.js';
import { decrypt, hmacSha256Hex } from '../../server/lib/crypto.js';

// ---------- Mercado Pago simulado (nenhuma chamada real) ----------
type Call = { url: string; method: string; headers: Record<string, string>; body: any };
const mp = {
  calls: [] as Call[],
  orders: new Map<string, any>(),
  porChave: new Map<string, string>(),
  terminais: [{ id: 'NEWLAND_N950__LOJA1', pos_id: 1, store_id: '10', external_pos_id: 'CX1', operating_mode: 'STANDALONE' }],
  falhar: [] as { status: number; body?: unknown; rede?: boolean }[],
  cancelar202: false,
  n: 0,
  reset() { this.calls = []; this.falhar = []; this.cancelar202 = false; },
  set(id: string, status: string, paid?: string) {
    const o = this.orders.get(id);
    o.status = status;
    o.transactions.payments[0].status = status;
    if (paid) o.transactions.payments[0].paid_amount = paid;
  },
};
function instalarMp() {
  setFetch(async (input, init) => {
    const url = String(input);
    if (!url.startsWith('https://api.mercadopago.com/')) throw new Error('Rede bloqueada nos testes: ' + url);
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    const c: Call = { url, method: init?.method ?? 'GET', headers, body: init?.body ? JSON.parse(String(init.body)) : null };
    mp.calls.push(c);
    const f = mp.falhar.shift();
    if (f?.rede) throw new Error('ECONNRESET');
    if (f) return new Response(JSON.stringify(f.body ?? {}), { status: f.status });
    const json = (s: number, b: unknown) => new Response(JSON.stringify(b), { status: s });
    const path = url.slice('https://api.mercadopago.com'.length);
    if (c.method === 'GET' && path.startsWith('/terminals/v1/list')) return json(200, { data: { terminals: mp.terminais }, paging: { total: mp.terminais.length, offset: 0, limit: 50 } });
    if (c.method === 'PATCH' && path === '/terminals/v1/setup') {
      for (const t of c.body.terminals) { const x = mp.terminais.find((y) => y.id === t.id); if (x) x.operating_mode = t.operating_mode; }
      return json(200, { terminals: c.body.terminals });
    }
    if (c.method === 'POST' && path === '/v1/orders') {
      const key = headers['x-idempotency-key'];
      if (!key) return json(400, { errors: [{ code: 'empty_required_header' }] });
      const existente = mp.porChave.get(key);
      if (existente) return json(201, mp.orders.get(existente));
      const id = `ORD${String(++mp.n).padStart(6, '0')}`;
      const o = { id, type: 'point', external_reference: c.body.external_reference, status: 'created', status_detail: 'created', config: c.body.config, transactions: { payments: [{ id: `PAY${mp.n}`, amount: c.body.transactions.payments[0].amount, status: 'created' }] } };
      mp.orders.set(id, o); mp.porChave.set(key, id);
      return json(201, o);
    }
    const m = /^\/v1\/orders\/([A-Za-z0-9]+)(\/cancel)?$/.exec(path);
    if (m) {
      const o = mp.orders.get(m[1]);
      if (!o) return json(404, { errors: [{ code: 'order_not_found' }] });
      if (m[2]) {
        if (o.status === 'canceled') return json(409, { errors: [{ code: 'order_already_canceled' }] });
        if (!['created', 'at_terminal'].includes(o.status)) return json(409, { errors: [{ code: 'cannot_cancel_order' }] });
        if (mp.cancelar202) return json(202, { id: o.id, status: o.status });
        mp.set(o.id, 'canceled');
        return json(200, o);
      }
      return json(200, o);
    }
    return json(404, { message: 'rota simulada inexistente' });
  });
}

const TOKEN = 'APP_USR-1234567890123456-111111-abcdefabcdefabcdefabcdefabcdef12-999999';

async function preparar(c: Client, sku: string, qtdMil = 10_000) {
  const end = (await c.post('/api/erp/estoque/depositos', { nome: 'Loja', enderecos: ['C-01'] })).body.enderecos[0].id;
  const id = (await c.post('/api/erp/produtos', { sku, nome: `Produto ${sku}`, precoBaseCents: 1000 })).body.id as string;
  await c.post('/api/erp/estoque/entrada', { produtoId: id, enderecoId: end, qtdMil, custoUnitCents: 400 });
  return id;
}
const saldo = async (produtoId: string) => (await prisma.erpSaldo.findMany({ where: { produtoId } })).reduce((a, s) => a + s.fisicoMil, 0);
const cobrar = (c: Client, produtoId: string, qtdMil = 1_000, extra: object = {}) =>
  c.post('/api/erp/vendas/balcao/cartao', { itens: [{ produtoId, qtdMil }], tipo: 'CREDITO', parcelas: 1, ...extra });

describe('ERP · PDV com maquininha (Mercado Pago Point simulado)', () => {
  let c: Client; let prod: string; let sessaoId: string; let chave: string;
  beforeAll(async () => {
    instalarMp();
    c = await registerClient();
    prod = await preparar(c, 'MQ-1');
    sessaoId = (await c.post('/api/erp/vendas/caixa/abrir', { valorAberturaCents: 0 })).body.id;
  });
  afterAll(() => resetFetch());
  beforeEach(() => mp.reset());

  it('sem maquininha: PDV mantém o cartão manual e a cobrança no terminal é recusada (409)', async () => {
    expect((await c.get('/api/erp/vendas/balcao/cartao/maquininha')).body).toEqual({ ativa: false });
    expect((await cobrar(c, prod)).status).toBe(409);
    const v = await c.post('/api/erp/vendas/balcao', { forma: 'CARTAO', itens: [{ produtoId: prod, qtdMil: 1_000 }] });
    expect(v.status).toBe(201);
    expect(mp.calls).toHaveLength(0);
  });

  it('configuração: provedores "em breve" recusados; token do MP cifrado e mascarado; lista e ativa modo PDV', async () => {
    const cfg0 = (await c.get('/api/erp/vendas/maquininhas/config')).body;
    expect(cfg0.config).toBeNull();
    expect(cfg0.provedores.map((p: any) => p.id)).toEqual(['mercadopago_point', 'stone_connect', 'pagbank_smart', 'cielo']);
    const stone = await c.put('/api/erp/vendas/maquininhas/config', { provedor: 'stone_connect', accessToken: TOKEN });
    expect(stone.status).toBe(501);
    expect(stone.body.error).toMatch(/em breve/);
    expect((await c.put('/api/erp/vendas/maquininhas/config', { provedor: 'mercadopago_point', accessToken: 'curto' })).status).toBe(400);

    const r = await c.put('/api/erp/vendas/maquininhas/config', { provedor: 'mercadopago_point', accessToken: TOKEN });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ temToken: true, token: '••••' + TOKEN.slice(-4), terminalPadraoId: null });
    expect(JSON.stringify(r.body)).not.toContain(TOKEN);
    const row = await prisma.erpMaquininhaConfig.findUniqueOrThrow({ where: { orgId: c.me.org.id } });
    expect(row.accessTokenEnc).not.toContain(TOKEN);
    expect(decrypt(row.accessTokenEnc!)).toBe(TOKEN);
    chave = row.webhookChave;
    expect(r.body.webhookUrl).toMatch(new RegExp(`/api/webhooks/maquininhas/mercadopago_point/${chave}$`));

    const t = await c.get('/api/erp/vendas/maquininhas/terminais');
    expect(t.status).toBe(200);
    expect(t.body).toEqual([{ id: 'NEWLAND_N950__LOJA1', modo: 'STANDALONE', loja: '10', caixa: 'CX1', prontoParaPdv: false }]);
    expect(mp.calls[0].headers.authorization).toBe(`Bearer ${TOKEN}`);
    const pdv = await c.post('/api/erp/vendas/maquininhas/terminais/NEWLAND_N950__LOJA1/modo-pdv', {});
    expect(pdv.status).toBe(200);
    expect(pdv.body).toMatchObject({ modo: 'PDV', prontoParaPdv: true });

    // Token salvo mas sem terminal escolhido: PDV ainda não usa a maquininha.
    expect((await c.get('/api/erp/vendas/balcao/cartao/maquininha')).body.ativa).toBe(false);
    const s = await c.put('/api/erp/vendas/maquininhas/config', { provedor: 'mercadopago_point', terminalPadraoId: 'NEWLAND_N950__LOJA1' });
    expect(s.body).toMatchObject({ temToken: true, terminalPadraoId: 'NEWLAND_N950__LOJA1' }); // token mantido
    expect((await c.get('/api/erp/vendas/balcao/cartao/maquininha')).body).toEqual({ ativa: true, provedor: 'mercadopago_point', nome: 'Mercado Pago Point', terminalId: 'NEWLAND_N950__LOJA1' });
  });

  it('cobrança aprovada: envia ao terminal, só vende quando aprovado, baixa estoque e entra no caixa (uma vez só)', async () => {
    const antes = await saldo(prod);
    const pedidosAntes = await prisma.erpPedidoVenda.count({ where: { caixaSessaoId: sessaoId } });
    const r = await cobrar(c, prod, 3_000, { parcelas: 3, descontoCents: 0 });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ status: 'PENDENTE', valorCents: 3_000, tipo: 'CREDITO', parcelas: 3, terminalId: 'NEWLAND_N950__LOJA1', pedidoId: null });
    const post = mp.calls.find((x) => x.method === 'POST' && x.url.endsWith('/v1/orders'))!;
    expect(post.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(post.headers['x-idempotency-key']).toBe(r.body.referencia);
    expect(post.body).toMatchObject({ type: 'point', external_reference: r.body.referencia, transactions: { payments: [{ amount: '30.00' }] }, config: { point: { terminal_id: 'NEWLAND_N950__LOJA1' }, payment_method: { default_type: 'credit_card', default_installments: 3, installments_cost: 'seller' } } });
    // Nada vendido ainda
    expect(await saldo(prod)).toBe(antes);
    expect(await prisma.erpPedidoVenda.count({ where: { caixaSessaoId: sessaoId } })).toBe(pedidosAntes);

    // Na maquininha, ainda sem pagar
    mp.set(r.body.externalId, 'at_terminal');
    const p1 = await c.get(`/api/erp/vendas/balcao/cartao/${r.body.id}`);
    expect(p1.body).toMatchObject({ status: 'PENDENTE', statusProvedor: 'at_terminal', pedido: null });

    // Aprovado
    mp.set(r.body.externalId, 'processed', '30.00');
    const p2 = await c.get(`/api/erp/vendas/balcao/cartao/${r.body.id}`);
    expect(p2.body.status).toBe('APROVADA');
    expect(p2.body.pedido).toMatchObject({ totalCents: 3_000, caixaSessaoId: sessaoId, statusOperacional: 'ENTREGUE' });
    expect(p2.body.pedido.observacoes).toContain('Maquininha Mercado Pago Point');
    expect(await saldo(prod)).toBe(antes - 3_000);
    const bx = await prisma.erpBaixa.findMany({ where: { titulo: { docId: p2.body.pedido.id } } });
    expect(bx).toHaveLength(1);
    expect(bx[0]).toMatchObject({ forma: 'CARTAO', valorCents: 3_000, caixaSessaoId: sessaoId });

    // Consultas/notificações repetidas não duplicam a venda
    await c.get(`/api/erp/vendas/balcao/cartao/${r.body.id}`);
    const wh = await request(app).post(`/api/webhooks/maquininhas/mercadopago_point/${chave}`).send({ type: 'order', action: 'order.processed', data: { id: r.body.externalId, status: 'processed' } });
    expect(wh.status).toBe(200);
    expect(await prisma.erpPedidoVenda.count({ where: { caixaSessaoId: sessaoId } })).toBe(pedidosAntes + 1);
    expect(await saldo(prod)).toBe(antes - 3_000);
    // Não dá para cancelar depois de aprovada
    expect((await c.post(`/api/erp/vendas/balcao/cartao/${r.body.id}/cancelar`, {})).status).toBe(409);
  });

  it('recusada e expirada não geram venda; débito vai sem parcelas', async () => {
    const antes = await saldo(prod);
    const r = await cobrar(c, prod, 1_000, { tipo: 'DEBITO' });
    expect(r.status).toBe(201);
    expect(mp.calls.find((x) => x.method === 'POST')!.body.config.payment_method).toEqual({ default_type: 'debit_card' });
    mp.set(r.body.externalId, 'failed');
    expect((await c.get(`/api/erp/vendas/balcao/cartao/${r.body.id}`)).body).toMatchObject({ status: 'RECUSADA', pedido: null });
    const r2 = await cobrar(c, prod);
    mp.set(r2.body.externalId, 'expired');
    expect((await c.get(`/api/erp/vendas/balcao/cartao/${r2.body.id}`)).body).toMatchObject({ status: 'EXPIRADA', pedido: null });
    expect(await saldo(prod)).toBe(antes);
    expect((await c.post('/api/erp/vendas/balcao/cartao', { itens: [{ produtoId: prod, qtdMil: 1_000 }], tipo: 'DEBITO', parcelas: 2 })).status).toBe(400);
  });

  it('uma cobrança por vez no terminal; cancelar (200 na hora e 202 confirmado pelo webhook)', async () => {
    const r = await cobrar(c, prod);
    const dup = await cobrar(c, prod);
    expect(dup.status).toBe(409);
    expect(dup.body.details.cobrancaId).toBe(r.body.id);
    const k = await c.post(`/api/erp/vendas/balcao/cartao/${r.body.id}/cancelar`, {});
    expect(k.status).toBe(200);
    expect(k.body).toMatchObject({ status: 'CANCELADA', pedido: null });
    expect(mp.calls.some((x) => x.url.endsWith(`/v1/orders/${r.body.externalId}/cancel`) && x.headers['x-allow-cancelable-status'] === 'at_terminal')).toBe(true);

    const r2 = await cobrar(c, prod);
    expect(r2.status).toBe(201);
    mp.set(r2.body.externalId, 'at_terminal');
    mp.cancelar202 = true;
    const k2 = await c.post(`/api/erp/vendas/balcao/cartao/${r2.body.id}/cancelar`, {});
    expect(k2.body).toMatchObject({ status: 'PENDENTE', cancelamentoSolicitado: true });
    // MP confirma o cancelamento por notificação
    mp.set(r2.body.externalId, 'canceled');
    const wh = await request(app).post(`/api/webhooks/maquininhas/mercadopago_point/${chave}?data.id=${r2.body.externalId}&type=order`).send({ type: 'order', action: 'order.canceled', data: { id: r2.body.externalId } });
    expect(wh.status).toBe(200);
    expect((await prisma.erpCobrancaCartao.findUniqueOrThrow({ where: { id: r2.body.id } })).status).toBe('CANCELADA');
  });

  it('webhook: chave errada 404; corpo não é confiado (consulta a API); assinatura validada quando há segredo', async () => {
    const antes = await saldo(prod);
    const r = await cobrar(c, prod);
    expect((await request(app).post('/api/webhooks/maquininhas/mercadopago_point/chave-errada').send({ type: 'order', data: { id: r.body.externalId } })).status).toBe(404);
    // Corpo diz "processed", mas a API diz que ainda está na maquininha: nada de venda.
    mp.set(r.body.externalId, 'at_terminal');
    const forjado = await request(app).post(`/api/webhooks/maquininhas/mercadopago_point/${chave}`).send({ type: 'order', action: 'order.processed', data: { id: r.body.externalId, status: 'processed' } });
    expect(forjado.status).toBe(200);
    expect((await prisma.erpCobrancaCartao.findUniqueOrThrow({ where: { id: r.body.id } })).status).toBe('PENDENTE');
    expect(await saldo(prod)).toBe(antes);

    await c.put('/api/erp/vendas/maquininhas/config', { provedor: 'mercadopago_point', webhookSecret: 'segredo-webhook-da-loja' });
    mp.set(r.body.externalId, 'processed', '10.00');
    const semAss = await request(app).post(`/api/webhooks/maquininhas/mercadopago_point/${chave}`).send({ type: 'order', data: { id: r.body.externalId } });
    expect(semAss.status).toBe(401);
    const ts = String(Date.now());
    const v1 = hmacSha256Hex('segredo-webhook-da-loja', `id:${r.body.externalId.toLowerCase()};request-id:req-1;ts:${ts};`);
    const ok = await request(app).post(`/api/webhooks/maquininhas/mercadopago_point/${chave}?data.id=${r.body.externalId}&type=order`).set('x-signature', `ts=${ts},v1=${v1}`).set('x-request-id', 'req-1').send({ type: 'order', data: { id: r.body.externalId } });
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe('APROVADA');
    expect(await saldo(prod)).toBe(antes - 1_000);
    await c.put('/api/erp/vendas/maquininhas/config', { provedor: 'mercadopago_point', webhookSecret: '' });
  });

  it('sem estoque: recusa antes de cobrar (nada vai para a maquininha)', async () => {
    const r = await cobrar(c, prod, 999_000);
    expect(r.status).toBe(400);
    expect(r.body.error).toContain('Sem estoque');
    expect(mp.calls.filter((x) => x.method === 'POST')).toHaveLength(0);
    expect(await prisma.erpCobrancaCartao.count({ where: { status: 'PENDENTE' } })).toBe(0);
  });

  it('token recusado pelo MP: erro claro e nenhuma cobrança fica pendurada', async () => {
    const n = await prisma.erpCobrancaCartao.count();
    mp.falhar.push({ status: 401, body: { message: 'invalid access token' } });
    const r = await cobrar(c, prod);
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/access token/);
    expect(await prisma.erpCobrancaCartao.count()).toBe(n);
  });

  it('queda de rede no envio: fica pendente e a consulta reenvia com a MESMA chave de idempotência', async () => {
    mp.falhar.push({ status: 0, rede: true });
    const r = await cobrar(c, prod);
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ status: 'PENDENTE', externalId: null });
    const p = await c.get(`/api/erp/vendas/balcao/cartao/${r.body.id}`);
    expect(p.body.externalId).toMatch(/^ORD/);
    const posts = mp.calls.filter((x) => x.method === 'POST' && x.url.endsWith('/v1/orders'));
    expect(posts).toHaveLength(2);
    expect(posts[0].headers['x-idempotency-key']).toBe(posts[1].headers['x-idempotency-key']);
    await c.post(`/api/erp/vendas/balcao/cartao/${r.body.id}/cancelar`, {});
  });

  it('aprovado com o caixa já fechado: ERRO_VENDA; reabrindo o caixa, "concluir" registra a venda', async () => {
    const r = await cobrar(c, prod);
    await c.post(`/api/erp/vendas/caixa/sessoes/${sessaoId}/fechar`, { valorContadoCents: 0, observacao: 'teste' });
    mp.set(r.body.externalId, 'processed', '10.00');
    const p = await c.get(`/api/erp/vendas/balcao/cartao/${r.body.id}`);
    expect(p.body.status).toBe('ERRO_VENDA');
    expect(p.body.detalhe).toMatch(/Pagamento aprovado, mas a venda não foi registrada/);
    expect(p.body.pedido).toBeNull();
    const nova = (await c.post('/api/erp/vendas/caixa/abrir', { valorAberturaCents: 0 })).body.id as string;
    const k = await c.post(`/api/erp/vendas/balcao/cartao/${r.body.id}/concluir`, { caixaSessaoId: nova });
    expect(k.status).toBe(200);
    expect(k.body).toMatchObject({ status: 'APROVADA', caixaSessaoId: nova });
    expect(k.body.pedido.caixaSessaoId).toBe(nova);
    expect((await c.post(`/api/erp/vendas/balcao/cartao/${r.body.id}/concluir`, {})).status).toBe(409);
    sessaoId = nova;
  });

  it('isolamento: outra empresa não vê a cobrança nem usa a maquininha desta', async () => {
    const r = await cobrar(c, prod);
    const outra = await registerClient();
    expect((await outra.get(`/api/erp/vendas/balcao/cartao/${r.body.id}`)).status).toBe(404);
    expect((await outra.post(`/api/erp/vendas/balcao/cartao/${r.body.id}/cancelar`, {})).status).toBe(404);
    expect((await outra.get('/api/erp/vendas/balcao/cartao/maquininha')).body.ativa).toBe(false);
    expect((await outra.get('/api/erp/vendas/maquininhas/config')).body.config).toBeNull();
    await c.post(`/api/erp/vendas/balcao/cartao/${r.body.id}/cancelar`, {});
  });
});
