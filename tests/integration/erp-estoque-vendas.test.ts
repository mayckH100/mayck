import { describe, it, expect, beforeAll } from 'vitest';
import { registerClient, Client, fakeCnpj, prisma } from '../helpers.js';

/** Fluxo crítico do ERP: saldo → pedido → reserva FEFO → conferência QR → faturamento (baixa) e falta → aguardando suprimento. */
describe('ERP · estoque e pedido de venda', () => {
  let owner: Client; let endA: string; let endB: string; let prod: any; let cliente: any;
  beforeAll(async () => {
    owner = await registerClient();
    const dep = await owner.post('/api/erp/estoque/depositos', { nome: 'Central', enderecos: ['A-01-01', 'B-01-01'] });
    expect(dep.status).toBe(201);
    [endA, endB] = dep.body.enderecos.sort((x: any, y: any) => x.codigo.localeCompare(y.codigo)).map((e: any) => e.id);
    prod = (await owner.post('/api/erp/produtos', { sku: 'leite1', nome: 'Leite 1L', controlaLote: true, controlaValidade: true, regraSaida: 'FEFO', precoBaseCents: 500 })).body;
    cliente = (await owner.post('/api/erp/crm/parceiros', { documento: fakeCnpj(), nome: 'Mercado Bom LTDA' })).body;
    // lote que vence depois entra primeiro; FEFO tem que reservar o que vence antes
    expect((await owner.post('/api/erp/estoque/entrada', { produtoId: prod.id, enderecoId: endA, qtdMil: 10_000, custoUnitCents: 300, lote: { numero: 'L-TARDE', validade: '2030-06-01' } })).status).toBe(201);
    expect((await owner.post('/api/erp/estoque/entrada', { produtoId: prod.id, enderecoId: endB, qtdMil: 5_000, custoUnitCents: 360, lote: { numero: 'L-CEDO', validade: '2030-01-01' } })).status).toBe(201);
  });

  it('reserva por FEFO, confere pelo lote certo e baixa o saldo no faturamento', async () => {
    const ped = await owner.post('/api/erp/vendas/pedidos', { parceiroId: cliente.id, itens: [{ produtoId: prod.id, qtdMil: 7_000 }] });
    expect(ped.status).toBe(201);
    expect(ped.body).toMatchObject({ statusOperacional: 'RASCUNHO', totalCents: 3500 });
    const env = await owner.post(`/api/erp/vendas/pedidos/${ped.body.id}/acao`, { evento: 'ENVIAR' });
    expect(env.body).toMatchObject({ statusOperacional: 'RESERVADO', statusFinanceiro: 'PROVISIONADO' });
    const det = (await owner.get(`/api/erp/vendas/pedidos/${ped.body.id}`)).body;
    expect(det.separacao.map((s: any) => [s.lote, s.qtdMil]).sort()).toEqual([['L-CEDO', 5_000], ['L-TARDE', 2_000]]);
    // não pode retirar o que está reservado
    const sal = (await owner.get(`/api/erp/estoque/saldos?produtoId=${prod.id}`)).body;
    const cedo = sal.find((s: any) => s.lote.numero === 'L-CEDO');
    expect(cedo).toMatchObject({ reservadoMil: 5_000, disponivelMil: 0 });
    expect((await owner.post('/api/erp/estoque/ajuste', { saldoId: cedo.id, qtdMil: 1, motivo: 'quebra' })).status).toBe(400);

    await owner.post(`/api/erp/vendas/pedidos/${ped.body.id}/acao`, { evento: 'SEPARAR' });
    expect((await owner.post(`/api/erp/vendas/pedidos/${ped.body.id}/acao`, { evento: 'CONFERIR' })).status).toBe(400);
    expect((await owner.post(`/api/erp/vendas/pedidos/${ped.body.id}/conferencia`, { codigo: 'L-OUTRO', qtdMil: 1000 })).status).toBe(400);
    await owner.post(`/api/erp/vendas/pedidos/${ped.body.id}/conferencia`, { codigo: 'l-cedo', qtdMil: 5_000 });
    const ult = await owner.post(`/api/erp/vendas/pedidos/${ped.body.id}/conferencia`, { codigo: 'L-TARDE', qtdMil: 2_000 });
    expect(ult.body.tudoSeparado).toBe(true);
    expect((await owner.post(`/api/erp/vendas/pedidos/${ped.body.id}/acao`, { evento: 'CONFERIR' })).body.statusOperacional).toBe('SEPARADO');
    expect((await owner.post(`/api/erp/vendas/pedidos/${ped.body.id}/acao`, { evento: 'FATURAR' })).status).toBe(400);
    const fat = await owner.post(`/api/erp/vendas/pedidos/${ped.body.id}/acao`, { evento: 'FATURAR', nfNumero: '123' });
    expect(fat.body).toMatchObject({ statusOperacional: 'FATURADO', statusFinanceiro: 'EM_ABERTO' });
    const depois = (await owner.get(`/api/erp/estoque/saldos?produtoId=${prod.id}`)).body;
    expect(depois.map((s: any) => [s.lote.numero, s.fisicoMil, s.reservadoMil])).toEqual([['L-TARDE', 8_000, 0]]);
    const movs = await prisma.erpMovimento.count({ where: { docId: ped.body.id, tipo: 'SAIDA' } });
    expect(movs).toBe(2);
    expect((await owner.post(`/api/erp/vendas/pedidos/${ped.body.id}/acao`, { evento: 'CANCELAR', motivo: 'x' })).status).toBe(400);
  });

  it('falta de estoque deixa o pedido aguardando suprimento; cancelar libera a reserva parcial', async () => {
    const ped = (await owner.post('/api/erp/vendas/pedidos', { parceiroId: cliente.id, itens: [{ produtoId: prod.id, qtdMil: 9_000 }] })).body;
    const env = await owner.post(`/api/erp/vendas/pedidos/${ped.id}/acao`, { evento: 'ENVIAR' });
    expect(env.body.statusOperacional).toBe('AGUARDANDO_SUPRIMENTO');
    expect(env.body.itens[0].reservadoMil).toBe(8_000);
    const can = await owner.post(`/api/erp/vendas/pedidos/${ped.id}/acao`, { evento: 'CANCELAR', motivo: 'Cliente desistiu' });
    expect(can.body).toMatchObject({ statusOperacional: 'CANCELADO', statusFinanceiro: 'SEM_TITULO' });
    const s = (await owner.get(`/api/erp/estoque/saldos?produtoId=${prod.id}`)).body[0];
    expect(s).toMatchObject({ reservadoMil: 0, disponivelMil: 8_000 });
  });

  it('desconto acima da alçada bloqueia; só gestor aprova', async () => {
    const ped = (await owner.post('/api/erp/vendas/pedidos', { parceiroId: cliente.id, itens: [{ produtoId: prod.id, qtdMil: 1_000, descontoBp: 2_000 }] })).body;
    const env = await owner.post(`/api/erp/vendas/pedidos/${ped.id}/acao`, { evento: 'ENVIAR' });
    expect(env.body.statusOperacional).toBe('BLOQUEADO');
    expect(env.body.motivoBloqueio).toMatch(/alçada/);
    expect((await owner.post(`/api/erp/vendas/pedidos/${ped.id}/acao`, { evento: 'APROVAR' })).body.statusOperacional).toBe('RESERVADO');
  });
});

import { nfeXml } from '../fixtures/nfe-exemplo.js';
describe('ERP · entrada por XML e inventário', () => {
  let owner: Client; let end: string;
  beforeAll(async () => {
    owner = await registerClient();
    end = (await owner.post('/api/erp/estoque/depositos', { nome: 'CD', enderecos: ['R-01-01'] })).body.enderecos[0].id;
  });
  it('importa, vincula CX→12 UN, gera lote interno ligado ao lote do fornecedor e não importa duas vezes', async () => {
    const cnpj = fakeCnpj();
    const imp = await owner.post('/api/erp/estoque/nfe/importar', { xml: nfeXml(cnpj) });
    expect(imp.status).toBe(201);
    expect((await owner.post('/api/erp/estoque/nfe/importar', { xml: nfeXml(cnpj) })).status).toBe(400);
    const nfe = (await owner.get(`/api/erp/estoque/nfe/${imp.body.id}`)).body;
    expect(nfe.itens[0].produtoId).toBeNull();
    expect((await owner.post(`/api/erp/estoque/nfe/${nfe.id}/lancar`, { enderecoId: end })).status).toBe(400);
    const v = await owner.put(`/api/erp/estoque/nfe/${nfe.id}/itens/${nfe.itens[0].id}`, { criarProduto: { sku: 'LEITE-UN', controlaValidade: true }, fatorMil: 12_000 });
    expect(v.status).toBe(200);
    const l = await owner.post(`/api/erp/estoque/nfe/${nfe.id}/lancar`, { enderecoId: end });
    expect(l.body.loteIds).toHaveLength(2);
    const saldos = (await owner.get('/api/erp/estoque/saldos')).body;
    expect(saldos.map((s: any) => s.fisicoMil)).toEqual([12_000, 12_000]);
    const lotes = (await owner.get('/api/erp/estoque/lotes')).body;
    expect(lotes.map((x: any) => x.loteFornecedor).sort()).toEqual(['ABC123', 'ABC124']);
    expect(lotes[0].numero).toMatch(/^\d{6}-\d{5}$/);
    const prod = (await owner.get('/api/erp/produtos?q=LEITE-UN')).body.items[0];
    expect(prod.custoMedioCents).toBe(550); // 132,00 ÷ 24 un
    const z = await owner.post('/api/erp/estoque/etiquetas/zpl', { itens: [{ loteId: lotes[0].id, copias: 2 }] });
    expect(z.body.zpl).toContain('^PQ2');
    // a próxima nota do mesmo fornecedor já vem vinculada
    const imp2 = await owner.post('/api/erp/estoque/nfe/importar', { xml: nfeXml(cnpj, '35261100000000000000550010000012351000012346') });
    expect((await owner.get(`/api/erp/estoque/nfe/${imp2.body.id}`)).body.itens[0]).toMatchObject({ produtoId: prod.id, fatorMil: 12_000 });
  });
  it('inventário cego: conta, aprova e ajusta a diferença', async () => {
    const inv = (await owner.post('/api/erp/estoque/inventarios', { descricao: 'Geral novembro' })).body;
    const lote = (await owner.get('/api/erp/estoque/lotes')).body[0];
    expect((await owner.post(`/api/erp/estoque/inventarios/${inv.id}/contar`, { endereco: 'r-01-01', codigo: lote.numero, qtdMil: 10_000 })).status).toBe(200);
    await owner.post(`/api/erp/estoque/inventarios/${inv.id}/acao`, { acao: 'ENVIAR' });
    const det = (await owner.get(`/api/erp/estoque/inventarios/${inv.id}`)).body;
    expect(det.contagens.find((c: any) => c.lote === lote.numero).diferencaMil).toBe(-2_000);
    expect((await owner.post(`/api/erp/estoque/inventarios/${inv.id}/acao`, { acao: 'APROVAR' })).body.status).toBe('CONCLUIDO');
    const total = (await owner.get('/api/erp/estoque/saldos')).body.reduce((a: number, s: any) => a + s.fisicoMil, 0);
    expect(total).toBe(10_000); // 10 contadas no lote lido; o outro lote não contado zerou
  });
});
