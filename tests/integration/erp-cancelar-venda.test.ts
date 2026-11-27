/**
 * v1.57.0: "Cancelar venda" para pedido já faturado/entregue (ex.: venda de balcão).
 * Devolve o estoque, estorna o recebido, cancela o título; só gestor; NF-e autorizada bloqueia.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { registerClient, Client, prisma } from '../helpers.js';

describe('cancelar venda faturada/entregue', () => {
  let owner: Client; let orgId: string; let caneta: any; let end: string;

  beforeAll(async () => {
    owner = await registerClient();
    const dep = (await owner.post('/api/erp/estoque/depositos', { nome: 'Loja', enderecos: ['A-01'] })).body;
    end = dep.enderecos[0].id; orgId = dep.orgId;
    caneta = (await owner.post('/api/erp/produtos', { sku: 'CAN', nome: 'Caneta azul', precoBaseCents: 2500 })).body;
    expect((await owner.post('/api/erp/estoque/entrada', { produtoId: caneta.id, enderecoId: end, qtdMil: 10_000, custoUnitCents: 100 })).status).toBe(201);
    expect((await owner.post('/api/erp/vendas/caixa/abrir', { valorAberturaCents: 0 })).status).toBe(201);
  });

  const saldo = async () => (await prisma.erpMovimento.aggregate({ where: { orgId, produtoId: caneta.id }, _sum: { qtdMil: true } }))._sum.qtdMil;

  it('venda de balcão entregue: oferece "Cancelar venda", devolve estoque e estorna o dinheiro', async () => {
    const v = (await owner.post('/api/erp/vendas/balcao', { forma: 'DINHEIRO', itens: [{ produtoId: caneta.id, qtdMil: 1_000 }] })).body;
    expect(await saldo()).toBe(9_000);
    const ped = (await owner.get(`/api/erp/vendas/pedidos/${v.id}`)).body;
    expect(ped.statusOperacional).toBe('ENTREGUE');
    expect(ped.acoes).toContain('CANCELAR_VENDA');

    expect((await owner.post(`/api/erp/vendas/pedidos/${v.id}/acao`, { evento: 'CANCELAR_VENDA' })).status).toBe(400);
    const r = await owner.post(`/api/erp/vendas/pedidos/${v.id}/acao`, { evento: 'CANCELAR_VENDA', motivo: 'Cliente desistiu' });
    expect(r.status).toBe(200);
    expect(r.body.statusOperacional).toBe('CANCELADO');
    expect(r.body.acoes).toEqual([]);
    expect(await saldo()).toBe(10_000);

    const tits = await prisma.erpTitulo.findMany({ where: { orgId, docTipo: 'pedido_venda', docId: v.id } });
    expect(tits.length).toBeGreaterThan(0);
    expect(tits.every((t) => t.status === 'CANCELADO')).toBe(true);
    const lanc = await prisma.erpLancamento.aggregate({ where: { orgId, origemTipo: { in: ['baixa', 'estorno'] } }, _sum: { valorCents: true } });
    expect(lanc._sum.valorCents).toBe(0);
    // Cancelar de novo: recusado.
    expect((await owner.post(`/api/erp/vendas/pedidos/${v.id}/acao`, { evento: 'CANCELAR_VENDA', motivo: 'de novo' })).status).toBe(400);
  });

  it('NF-e autorizada bloqueia o cancelamento', async () => {
    const v = (await owner.post('/api/erp/vendas/balcao', { forma: 'DINHEIRO', itens: [{ produtoId: caneta.id, qtdMil: 1_000 }] })).body;
    const chave = '3'.repeat(44);
    await prisma.erpNfeSaida.create({ data: { orgId, pedidoId: v.id, parceiroId: v.parceiroId, numero: 7, serie: 1, chave, ambiente: 2, status: 'AUTORIZADA', totalCents: v.totalCents, xml: '<x/>' } });
    const r = await owner.post(`/api/erp/vendas/pedidos/${v.id}/acao`, { evento: 'CANCELAR_VENDA', motivo: 'Erro' });
    expect(r.status).toBe(400);
    expect(r.body.error).toContain('NF-e');
  });
});
