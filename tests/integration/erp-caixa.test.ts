import { describe, it, expect, beforeAll } from 'vitest';
import { registerClient, Client, fakeCnpj, prisma } from '../helpers.js';

async function preparar(c: Client, sku: string, qtdMil = 50_000) {
  const end = (await c.post('/api/erp/estoque/depositos', { nome: 'Loja', enderecos: ['C-01'] })).body.enderecos[0].id;
  const id = (await c.post('/api/erp/produtos', { sku, nome: `Produto ${sku}`, precoBaseCents: 1000 })).body.id as string;
  await c.post('/api/erp/estoque/entrada', { produtoId: id, enderecoId: end, qtdMil, custoUnitCents: 400 });
  return id;
}
const vender = (c: Client, produtoId: string, forma: string, qtdMil = 1_000, extra: object = {}) =>
  c.post('/api/erp/vendas/balcao', { forma, itens: [{ produtoId, qtdMil }], ...extra });

describe('ERP · caixa do PDV', () => {
  let c: Client; let prod: string;
  beforeAll(async () => { c = await registerClient(); prod = await preparar(c, 'CX-1'); });

  it('venda balcão sem caixa aberto é recusada (409) e nada é gravado; orçamento não depende do caixa', async () => {
    const r = await vender(c, prod, 'DINHEIRO');
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('Abra o caixa antes de vender');
    expect(await prisma.erpPedidoVenda.count({ where: { itens: { some: { produtoId: prod } } } })).toBe(0);
    const cli = (await c.post('/api/erp/crm/parceiros', { documento: fakeCnpj(), nome: 'Cliente Orç', ehCliente: true })).body;
    const orc = await c.post('/api/erp/vendas/pedidos', { parceiroId: cli.id, itens: [{ produtoId: prod, qtdMil: 1_000 }] });
    expect(orc.status).toBe(201);
    expect(orc.body.caixaSessaoId ?? null).toBeNull();
  });

  it('abre, vende, sangria/suprimento, fecha com diferença justificada e bloqueia nova venda', async () => {
    const ab = await c.post('/api/erp/vendas/caixa/abrir', { valorAberturaCents: 10_000, observacao: 'troco do dia' });
    expect(ab.status).toBe(201);
    expect(ab.body).toMatchObject({ status: 'ABERTO', valorAberturaCents: 10_000, contaNome: 'Caixa' });
    expect(ab.body.abertoPor.nome).toBeTruthy();
    const id = ab.body.id as string;
    // Só uma sessão aberta por caixa
    const dup = await c.post('/api/erp/vendas/caixa/abrir', { valorAberturaCents: 0 });
    expect(dup.status).toBe(409);

    const v1 = await vender(c, prod, 'DINHEIRO', 2_000); // 20,00
    expect(v1.status).toBe(201);
    expect(v1.body.caixaSessaoId).toBe(id);
    expect((await vender(c, prod, 'PIX', 1_000)).status).toBe(201); // 10,00
    expect((await vender(c, prod, 'CARTAO', 3_000)).status).toBe(201); // 30,00
    expect((await vender(c, prod, 'DINHEIRO', 1_000)).status).toBe(201); // 10,00
    // Dinheiro entra na conta do caixa aberto
    const baixa = await prisma.erpBaixa.findFirst({ where: { caixaSessaoId: id, forma: 'DINHEIRO' } });
    expect(baixa?.contaId).toBe(ab.body.contaFinanceiraId);

    expect((await c.post(`/api/erp/vendas/caixa/sessoes/${id}/movimentos`, { tipo: 'SUPRIMENTO', valorCents: 5_000, motivo: 'mais troco' })).status).toBe(201);
    expect((await c.post(`/api/erp/vendas/caixa/sessoes/${id}/movimentos`, { tipo: 'SANGRIA', valorCents: 99_999_00, motivo: 'cofre' })).status).toBe(400);
    expect((await c.post(`/api/erp/vendas/caixa/sessoes/${id}/movimentos`, { tipo: 'SANGRIA', valorCents: 8_000, motivo: 'cofre' })).status).toBe(201);
    expect((await c.post(`/api/erp/vendas/caixa/sessoes/${id}/movimentos`, { tipo: 'SANGRIA', valorCents: 100, motivo: '' })).status).toBe(400);
    const lancs = await prisma.erpLancamento.findMany({ where: { contaId: ab.body.contaFinanceiraId, origemTipo: { in: ['caixa_sangria', 'caixa_suprimento'] } } });
    expect(lancs.map((l) => l.valorCents).sort((a, b) => a - b)).toEqual([-8_000, 5_000]);

    const est = (await c.get('/api/erp/vendas/caixa')).body;
    expect(est.sessaoPadraoId).toBe(id);
    const r = est.abertas[0].resumo;
    // esperado = 100 + (20 + 10) dinheiro + 50 suprimento − 80 sangria = 100,00
    expect(r).toMatchObject({ aberturaCents: 10_000, vendasDinheiroCents: 3_000, totalVendasCents: 7_000, sangriasCents: 8_000, suprimentosCents: 5_000, esperadoDinheiroCents: 10_000, qtdVendas: 4 });
    expect(r.porForma).toMatchObject({ DINHEIRO: { qtd: 2, valorCents: 3_000 }, PIX: { qtd: 1, valorCents: 1_000 }, CARTAO: { qtd: 1, valorCents: 3_000 } });

    // Falta de R$ 2,00 sem observação: recusa e o caixa continua aberto
    const semObs = await c.post(`/api/erp/vendas/caixa/sessoes/${id}/fechar`, { valorContadoCents: 9_800 });
    expect(semObs.status).toBe(400);
    expect(semObs.body.error).toContain('falta');
    expect((await prisma.erpCaixaSessao.findUnique({ where: { id } }))?.status).toBe('ABERTO');
    const f = await c.post(`/api/erp/vendas/caixa/sessoes/${id}/fechar`, { valorContadoCents: 9_800, observacao: 'troco errado' });
    expect(f.status).toBe(200);
    expect(f.body).toMatchObject({ status: 'FECHADO', valorContadoCents: 9_800, valorEsperadoCents: 10_000, diferencaCents: -200, observacaoFechamento: 'troco errado' });
    expect(f.body.fechadoPor.nome).toBeTruthy();
    expect((await c.post(`/api/erp/vendas/caixa/sessoes/${id}/fechar`, { valorContadoCents: 10_000 })).status).toBe(409);
    expect((await c.post(`/api/erp/vendas/caixa/sessoes/${id}/movimentos`, { tipo: 'SANGRIA', valorCents: 100, motivo: 'troco' })).status).toBe(409);

    // Depois de fechar: sem venda até reabrir
    expect((await vender(c, prod, 'PIX')).status).toBe(409);
    expect((await vender(c, prod, 'PIX', 1_000, { caixaSessaoId: id })).status).toBe(409);

    // Relatório da sessão fechada fica congelado e lista as vendas e movimentos
    const det = (await c.get(`/api/erp/vendas/caixa/sessoes/${id}`)).body;
    expect(det.vendas).toHaveLength(4);
    expect(det.vendas.map((v: any) => v.forma).sort()).toEqual(['CARTAO', 'DINHEIRO', 'DINHEIRO', 'PIX']);
    expect(det.movimentos.map((m: any) => m.tipo)).toEqual(['SUPRIMENTO', 'SANGRIA']);
    expect(det.resumo).toMatchObject({ esperadoDinheiroCents: 10_000, totalVendasCents: 7_000 });

    // Reabre (nova sessão) e vende de novo; caixa que fecha conferindo não pede observação
    const ab2 = await c.post('/api/erp/vendas/caixa/abrir', { valorAberturaCents: 0 });
    expect(ab2.status).toBe(201);
    expect((await vender(c, prod, 'DINHEIRO')).status).toBe(201);
    const f2 = await c.post(`/api/erp/vendas/caixa/sessoes/${ab2.body.id}/fechar`, { valorContadoCents: 1_000 });
    expect(f2.body).toMatchObject({ status: 'FECHADO', diferencaCents: 0 });

    // Histórico com filtro por data
    const hoje = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
    const hist = (await c.get(`/api/erp/vendas/caixa/sessoes?de=${hoje}&ate=${hoje}`)).body as any[];
    expect(hist.map((s) => s.id)).toEqual(expect.arrayContaining([id, ab2.body.id]));
    expect((await c.get('/api/erp/vendas/caixa/sessoes?de=2001-01-01&ate=2001-01-02')).body).toHaveLength(0);
    expect((await c.get('/api/erp/vendas/caixa/sessoes?status=ABERTO')).body).toHaveLength(0);

    // Auditoria
    const acoes = (await prisma.auditLog.findMany({ where: { action: { startsWith: 'erp.caixa.' }, entityId: id } })).map((l) => l.action).sort();
    expect(acoes).toEqual(['erp.caixa.abrir', 'erp.caixa.fechar', 'erp.caixa.sangria', 'erp.caixa.suprimento']);
  });

  it('dois caixas (duas contas CAIXA): um aberto em cada; abrir sem escolher pede o caixa', async () => {
    const d = await registerClient();
    const p = await preparar(d, 'CX-2');
    const c1 = (await d.post('/api/erp/financeiro/contas', { nome: 'Caixa 1', tipo: 'CAIXA' })).body;
    const c2 = (await d.post('/api/erp/financeiro/contas', { nome: 'Caixa 2', tipo: 'CAIXA' })).body;
    expect(c1.id && c2.id).toBeTruthy();
    expect((await d.post('/api/erp/vendas/caixa/abrir', { valorAberturaCents: 0 })).status).toBe(400);
    const s1 = (await d.post('/api/erp/vendas/caixa/abrir', { contaId: c1.id, valorAberturaCents: 1_000 })).body;
    const s2 = (await d.post('/api/erp/vendas/caixa/abrir', { contaId: c2.id, valorAberturaCents: 2_000 })).body;
    expect((await d.post('/api/erp/vendas/caixa/abrir', { contaId: c2.id, valorAberturaCents: 0 })).status).toBe(409);
    // Duas abertas pelo mesmo usuário: a venda precisa dizer o caixa
    expect((await vender(d, p, 'DINHEIRO')).status).toBe(409);
    const v = await vender(d, p, 'DINHEIRO', 1_000, { caixaSessaoId: s2.id });
    expect(v.status).toBe(201);
    expect(v.body.caixaSessaoId).toBe(s2.id);
    const est = (await d.get('/api/erp/vendas/caixa')).body;
    const r2 = est.abertas.find((s: any) => s.id === s2.id).resumo;
    const r1 = est.abertas.find((s: any) => s.id === s1.id).resumo;
    expect(r2.esperadoDinheiroCents).toBe(3_000);
    expect(r1.esperadoDinheiroCents).toBe(1_000);
  });

  it('isolamento entre empresas: outra empresa não vê nem mexe no caixa', async () => {
    const a = await registerClient();
    await preparar(a, 'CX-3');
    const s = (await a.post('/api/erp/vendas/caixa/abrir', { valorAberturaCents: 500 })).body;
    const b = await registerClient();
    const pb = await preparar(b, 'CX-4');
    expect((await b.get(`/api/erp/vendas/caixa/sessoes/${s.id}`)).status).toBe(404);
    expect((await b.post(`/api/erp/vendas/caixa/sessoes/${s.id}/fechar`, { valorContadoCents: 500 })).status).toBe(404);
    expect((await b.post(`/api/erp/vendas/caixa/sessoes/${s.id}/movimentos`, { tipo: 'SUPRIMENTO', valorCents: 100, motivo: 'x1' })).status).toBe(404);
    expect((await b.get('/api/erp/vendas/caixa')).body.abertas).toHaveLength(0);
    expect((await b.get('/api/erp/vendas/caixa/sessoes')).body).toHaveLength(0);
    // Empresa B não vende usando o caixa aberto da A
    expect((await vender(b, pb, 'DINHEIRO')).status).toBe(409);
    expect((await vender(b, pb, 'DINHEIRO', 1_000, { caixaSessaoId: s.id })).status).toBe(409);
  });
});
