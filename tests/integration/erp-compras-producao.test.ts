import { describe, it, expect, beforeAll } from 'vitest';
import { registerClient, Client, fakeCnpj } from '../helpers.js';
import { nfeXml } from '../fixtures/nfe-exemplo.js';

/** Fluxo crítico da Etapa 3: pedido de compra com alçada → recebimento pela NF-e com confronto → OP com consumo, lote e genealogia → MRP. */
describe('ERP · compras e produção', () => {
  let owner: Client; let end: string; let forn: any; let leite: any; let iogurte: any; let pote: any;
  beforeAll(async () => {
    owner = await registerClient();
    end = (await owner.post('/api/erp/estoque/depositos', { nome: 'Fábrica', enderecos: ['F-01'] })).body.enderecos[0].id;
    const cnpj = fakeCnpj();
    forn = (await owner.post('/api/erp/crm/parceiros', { documento: cnpj, nome: 'Laticínios Exemplo LTDA' })).body;
    leite = (await owner.post('/api/erp/produtos', { sku: 'LEITE-UN', nome: 'Leite 1L', tipo: 'INSUMO', controlaLote: true, controlaValidade: true })).body;
    pote = (await owner.post('/api/erp/produtos', { sku: 'POTE', nome: 'Pote 500g', tipo: 'INSUMO' })).body;
    iogurte = (await owner.post('/api/erp/produtos', { sku: 'IOG', nome: 'Iogurte 500g', tipo: 'PRODUZIDO', controlaLote: true, controlaValidade: true })).body;
    forn.cnpj = cnpj;
  });

  it('pedido de compra dentro da alçada aprova ao enviar e a NF-e baixa o pendente; preço fora da tolerância trava', async () => {
    const pc = (await owner.post('/api/erp/compras/pedidos', { parceiroId: forn.id, itens: [{ produtoId: leite.id, qtdMil: 24_000, precoUnitCents: 500 }] })).body;
    expect((await owner.post(`/api/erp/compras/pedidos/${pc.id}/acao`, { evento: 'ENVIAR' })).body.status).toBe('APROVADO');
    const imp = (await owner.post('/api/erp/estoque/nfe/importar', { xml: nfeXml(forn.cnpj) })).body;
    const nfe = (await owner.get(`/api/erp/estoque/nfe/${imp.id}`)).body;
    expect(nfe.pedidosAbertos.map((p: any) => p.id)).toEqual([pc.id]);
    await owner.put(`/api/erp/estoque/nfe/${nfe.id}/itens/${nfe.itens[0].id}`, { produtoId: leite.id, fatorMil: 12_000 });
    await owner.put(`/api/erp/estoque/nfe/${nfe.id}/pedido`, { pedidoCompraId: pc.id });
    // nota: R$ 60,00 a caixa de 12 = R$ 5,00 a unidade → dentro da tolerância; conferência com 1 caixa a menos → divergência
    await owner.put(`/api/erp/estoque/nfe/${nfe.id}/conferencia`, { itens: [{ itemId: nfe.itens[0].id, qtdMil: 1_000 }] });
    const trava = await owner.post(`/api/erp/estoque/nfe/${nfe.id}/lancar`, { enderecoId: end });
    expect(trava.status).toBe(400);
    expect(trava.body.details.divergencias[0]).toMatch(/conferido 1, nota 2/);
    await owner.put(`/api/erp/estoque/nfe/${nfe.id}/conferencia`, { itens: [{ itemId: nfe.itens[0].id, qtdMil: 2_000 }] });
    expect((await owner.post(`/api/erp/estoque/nfe/${nfe.id}/lancar`, { enderecoId: end })).status).toBe(200);
    expect((await owner.get(`/api/erp/compras/pedidos/${pc.id}`)).body).toMatchObject({ status: 'RECEBIDO', itens: [{ recebidoMil: 24_000 }] });
    await owner.post('/api/erp/estoque/entrada', { produtoId: pote.id, enderecoId: end, qtdMil: 100_000, custoUnitCents: 20 });
  });

  it('OP: libera reservando, aponta consumindo por FEFO, gera lote do produto com genealogia e custo real', async () => {
    expect((await owner.put(`/api/erp/producao/estruturas/${iogurte.id}`, { itens: [{ componenteId: leite.id, qtdMil: 500 }, { componenteId: pote.id, qtdMil: 1000, perdaBp: 500 }], operacoes: [{ descricao: 'Fermentação', centroTrabalho: 'Tanque 1', segundosPorUn: 36, custoHoraCents: 10_000 }] })).status).toBe(200);
    expect((await owner.put(`/api/erp/producao/estruturas/${leite.id}`, { itens: [{ componenteId: iogurte.id, qtdMil: 1 }] })).status).toBe(400); // ciclo
    const op = (await owner.post('/api/erp/producao/ops', { produtoId: iogurte.id, qtdPlanejadaMil: 20_000 })).body;
    const lib = await owner.post(`/api/erp/producao/ops/${op.id}/acao`, { evento: 'LIBERAR' });
    expect(lib.body).toMatchObject({ status: 'LIBERADA' });
    expect(lib.body.componentes.map((c: any) => [c.produto.sku, c.qtdPrevistaMil, c.qtdReservadaMil]).sort()).toEqual([['LEITE-UN', 10_000, 10_000], ['POTE', 21_000, 21_000]]);
    const ap = await owner.post(`/api/erp/producao/ops/${op.id}/apontar`, { qtdBoaMil: 20_000, enderecoId: end, validade: '2030-01-01', encerrar: true });
    expect(ap.status).toBe(200);
    expect(ap.body).toMatchObject({ status: 'ENCERRADA', qtdProduzidaMil: 20_000 });
    // custo: 10 leites × 5,50 + 21 potes × 0,20 + 20 × 1,00 de operação (36 s a R$ 100/h) = 79,20 → 3,96 por pote
    expect(ap.body.apontamentos[0].custoUnitCents).toBe(396);
    const lote = ap.body.apontamentos[0].lote;
    expect(lote).toMatch(/^\d{6}-\d{5}$/);
    const saldoLeite = (await owner.get(`/api/erp/estoque/saldos?produtoId=${leite.id}`)).body.reduce((a: number, s: any) => a + s.fisicoMil, 0);
    expect(saldoLeite).toBe(14_000);
    // FEFO: consome o lote do leite que vence antes (ABC123 → val 2027-01-20) e liga ao lote do iogurte
    const lotes = (await owner.get(`/api/erp/estoque/lotes?q=${lote}`)).body;
    const g = (await owner.get(`/api/erp/core/rastreio/lote/${lotes[0].id}`)).body;
    expect(JSON.stringify(g)).toContain('compoe');
  });

  it('MRP sugere produzir pelo estoque mínimo e comprar o insumo que faltar', async () => {
    await owner.put(`/api/erp/produtos/${iogurte.id}`, { sku: 'IOG', nome: 'Iogurte 500g', tipo: 'PRODUZIDO', controlaLote: true, controlaValidade: true, estoqueMinimoMil: 60_000 });
    const s = (await owner.get('/api/erp/producao/mrp')).body;
    const iog = s.find((x: any) => x.sku === 'IOG'); const le = s.find((x: any) => x.sku === 'LEITE-UN');
    expect(iog).toMatchObject({ acao: 'PRODUZIR', qtdMil: 40_000 });
    expect(le).toMatchObject({ acao: 'COMPRAR', qtdMil: 6_000 }); // 20 − 14 disponíveis
    const ap = (await owner.post('/api/erp/producao/mrp/aplicar', { itens: [{ produtoId: iogurte.id, acao: 'PRODUZIR', qtdMil: 40_000 }, { produtoId: leite.id, acao: 'COMPRAR', qtdMil: 6_000 }] })).body;
    expect(ap.ops).toHaveLength(1); expect(ap.solicitacao.numero).toBe(1);
    expect((await owner.get('/api/erp/producao/mrp')).body.filter((x: any) => ['IOG', 'LEITE-UN'].includes(x.sku))).toEqual([]);
  });
});
