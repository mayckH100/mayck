import { describe, it, expect, beforeAll } from 'vitest';
import { registerClient, Client, fakeCnpj } from '../helpers.js';

describe('ERP · BI', () => {
  let owner: Client;
  beforeAll(async () => {
    owner = await registerClient();
    const end = (await owner.post('/api/erp/estoque/depositos', { nome: 'CD', enderecos: ['A-01'] })).body.enderecos[0].id;
    const prod = (await owner.post('/api/erp/produtos', { sku: 'BI-1', nome: 'Produto BI', precoBaseCents: 1000, estoqueMinimoMil: 50_000 })).body;
    await owner.post('/api/erp/estoque/entrada', { produtoId: prod.id, enderecoId: end, qtdMil: 10_000, custoUnitCents: 400 });
    const cli = (await owner.post('/api/erp/crm/parceiros', { documento: fakeCnpj(), nome: 'Cliente BI LTDA' })).body;
    const ped = (await owner.post('/api/erp/vendas/pedidos', { parceiroId: cli.id, itens: [{ produtoId: prod.id, qtdMil: 3_000 }] })).body;
    for (const ev of ['ENVIAR', 'SEPARAR']) await owner.post(`/api/erp/vendas/pedidos/${ped.id}/acao`, { evento: ev });
    await owner.post(`/api/erp/vendas/pedidos/${ped.id}/conferencia`, { codigo: 'BI-1', qtdMil: 3_000 });
    await owner.post(`/api/erp/vendas/pedidos/${ped.id}/acao`, { evento: 'CONFERIR' });
    await owner.post(`/api/erp/vendas/pedidos/${ped.id}/acao`, { evento: 'FATURAR', nfNumero: '9' });
  });

  it('resumo junta vendas, margem, estoque e ABC; exporta CSV', async () => {
    const r = (await owner.get('/api/erp/bi/resumo')).body;
    expect(r.vendas).toMatchObject({ receitaCents: 3000, cmvCents: 1200, margemBrutaBp: 6000, pedidos: 1, ticketMedioCents: 3000 });
    expect(r.vendas.curvaAbc[0]).toMatchObject({ sku: 'BI-1', classe: 'A', margemCents: 1800 });
    expect(r.vendas.topClientes[0].nome).toBe('Cliente BI LTDA');
    expect(r.estoque).toMatchObject({ valorCents: 2800, qtdAbaixoMinimo: 1 });
    expect(r.vendas.serie).toHaveLength(30);
    const c = await owner.get('/api/erp/bi/exportar?tipo=produtos');
    expect(c.text).toContain('BI-1;Produto BI;3;30,00;A');
    expect((await owner.get('/api/erp/bi/resumo?de=2026-12-10&ate=2026-01-01')).status).toBe(400);
  });
});
