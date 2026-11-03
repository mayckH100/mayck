import { describe, it, expect, beforeAll } from 'vitest';
import { registerClient, Client, fakeCnpj } from '../helpers.js';
import { despachar } from '../../server/erp/shared/events.js';
import { nfeXml } from '../fixtures/nfe-exemplo.js';

/** Faturamento gera contas a receber pela condição; NF-e gera contas a pagar; baixa parcial com juros, estorno e conciliação OFX. */
describe('ERP · financeiro', () => {
  let owner: Client; let conta: any; let end: string;
  beforeAll(async () => {
    owner = await registerClient();
    end = (await owner.post('/api/erp/estoque/depositos', { nome: 'CD', enderecos: ['A-01'] })).body.enderecos[0].id;
    conta = (await owner.post('/api/erp/financeiro/contas', { nome: 'Banco principal', chavePix: 'financeiro@exemplo.com.br', saldoInicialCents: 100_000 })).body;
  });

  it('pedido faturado vira 2 parcelas a receber; baixa com juros entra na conta e quita o pedido', async () => {
    const prod = (await owner.post('/api/erp/produtos', { sku: 'CAIXA', nome: 'Caixa', precoBaseCents: 1000 })).body;
    await owner.post('/api/erp/estoque/entrada', { produtoId: prod.id, enderecoId: end, qtdMil: 10_000, custoUnitCents: 500 });
    const cli = (await owner.post('/api/erp/crm/parceiros', { documento: fakeCnpj(), nome: 'Cliente Bom LTDA' })).body;
    const cond = (await owner.post('/api/erp/produtos/condicoes', { nome: '30/60', prazos: [30, 60] })).body;
    const ped = (await owner.post('/api/erp/vendas/pedidos', { parceiroId: cli.id, condicaoPagamentoId: cond.id, itens: [{ produtoId: prod.id, qtdMil: 5_001 }] })).body;
    for (const ev of ['ENVIAR', 'SEPARAR']) await owner.post(`/api/erp/vendas/pedidos/${ped.id}/acao`, { evento: ev });
    await owner.post(`/api/erp/vendas/pedidos/${ped.id}/conferencia`, { codigo: 'CAIXA', qtdMil: 5_001 });
    await owner.post(`/api/erp/vendas/pedidos/${ped.id}/acao`, { evento: 'CONFERIR' });
    expect((await owner.post(`/api/erp/vendas/pedidos/${ped.id}/acao`, { evento: 'FATURAR', nfNumero: '77' })).status).toBe(200);
    await despachar(200);
    const ts = (await owner.get(`/api/erp/financeiro/titulos?tipo=RECEBER&parceiroId=${cli.id}`)).body;
    expect(ts.map((t: any) => t.valorCents)).toEqual([2500, 2501]);
    expect((await owner.get(`/api/erp/financeiro/titulos/${ts[0].id}/pix`)).body.codigo).toContain('br.gov.bcb.pix');
    expect((await owner.post(`/api/erp/financeiro/titulos/${ts[0].id}/baixar`, { contaId: conta.id, valorCents: 9999 })).status).toBe(400);
    const b1 = (await owner.post(`/api/erp/financeiro/titulos/${ts[0].id}/baixar`, { contaId: conta.id, valorCents: 1000 })).body;
    expect(b1).toMatchObject({ status: 'PARCIAL', pagoCents: 1000 });
    await owner.post(`/api/erp/financeiro/titulos/${ts[0].id}/baixar`, { contaId: conta.id, valorCents: 1500, jurosCents: 30 });
    await owner.post(`/api/erp/financeiro/titulos/${ts[1].id}/baixar`, { contaId: conta.id, valorCents: 2501 });
    expect((await owner.get(`/api/erp/vendas/pedidos/${ped.id}`)).body.statusFinanceiro).toBe('LIQUIDADO');
    const contas = (await owner.get('/api/erp/financeiro/contas')).body;
    expect(contas[0].saldoCents).toBe(100_000 + 5001 + 30);
    // estorno volta o título e o saldo
    const det = (await owner.get(`/api/erp/financeiro/titulos/${ts[1].id}`)).body;
    expect((await owner.post(`/api/erp/financeiro/baixas/${det.baixas[0].id}/estornar`, {})).body.status).toBe('EM_ABERTO');
    expect((await owner.get('/api/erp/financeiro/contas')).body[0].saldoCents).toBe(100_000 + 2500 + 30);
    const dre = (await owner.get('/api/erp/financeiro/dre')).body;
    expect(dre.RECEITA_BRUTA).toBe(5001);
  });

  it('NF-e lançada gera conta a pagar; OFX concilia a baixa pelo valor', async () => {
    const cnpj = fakeCnpj();
    await owner.post('/api/erp/crm/parceiros', { documento: cnpj, nome: 'Fornecedor X LTDA' });
    const imp = (await owner.post('/api/erp/estoque/nfe/importar', { xml: nfeXml(cnpj) })).body;
    const nfe = (await owner.get(`/api/erp/estoque/nfe/${imp.id}`)).body;
    const p = (await owner.post('/api/erp/produtos', { sku: 'LEITE-X', nome: 'Leite', controlaLote: true, controlaValidade: true })).body;
    await owner.put(`/api/erp/estoque/nfe/${nfe.id}/itens/${nfe.itens[0].id}`, { produtoId: p.id, fatorMil: 12_000 });
    expect((await owner.post(`/api/erp/estoque/nfe/${nfe.id}/lancar`, { enderecoId: end })).status).toBe(200);
    await despachar(200);
    const [t] = (await owner.get('/api/erp/financeiro/titulos?tipo=PAGAR')).body;
    expect(t).toMatchObject({ valorCents: nfe.valorTotalCents, status: 'EM_ABERTO' });
    await owner.post(`/api/erp/financeiro/titulos/${t.id}/baixar`, { contaId: conta.id, valorCents: t.valorCents, data: '2026-11-05' });
    const v = (t.valorCents / 100).toFixed(2);
    const ofx = `<OFX><STMTTRN><DTPOSTED>20261106<TRNAMT>-${v}<FITID>F1<MEMO>PAG FORNECEDOR</STMTTRN><STMTTRN><DTPOSTED>20261106<TRNAMT>-8.50<FITID>F2<MEMO>TARIFA</STMTTRN></OFX>`;
    expect((await owner.post(`/api/erp/financeiro/contas/${conta.id}/ofx`, { ofx })).body.lidas).toBe(2);
    const c = (await owner.get(`/api/erp/financeiro/contas/${conta.id}/conciliacao`)).body;
    expect(c.sugestoes).toHaveLength(1);
    const tarifa = c.extrato.find((e: any) => e.valorCents === -850);
    expect((await owner.post('/api/erp/financeiro/conciliar', { pares: [...c.sugestoes, { extratoId: tarifa.id, criar: { descricao: 'Tarifa bancária' } }] })).body.conciliados).toBe(2);
    const painel = (await owner.get('/api/erp/financeiro/painel')).body;
    expect(painel.fluxo).toHaveLength(30);
  });
});
