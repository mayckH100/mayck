import { describe, it, expect, beforeAll } from 'vitest';
import { registerClient, Client, fakeCnpj, uniq, prisma } from '../helpers.js';

/** v1.56.0: inadimplência do Painel CRM pelo Financeiro e score do cliente na ficha e no painel. */
describe('ERP · CRM inadimplência e score (v1.56.0)', () => {
  let owner: Client; let outra: Client; let vendedor: Client;
  let bom: any; let ruim: any; let conta: any;
  const iso = (dias: number) => new Date(Date.now() + dias * 86_400_000).toISOString().slice(0, 10);

  beforeAll(async () => {
    owner = await registerClient();
    conta = (await owner.post('/api/erp/financeiro/contas', { nome: 'Banco', saldoInicialCents: 0 })).body;
    bom = (await owner.post('/api/erp/crm/parceiros', { documento: fakeCnpj(), nome: 'Cliente Bom LTDA' })).body;
    ruim = (await owner.post('/api/erp/crm/parceiros', { documento: fakeCnpj(), nome: 'Cliente Atrasado LTDA' })).body;
    // Bom: 2 contas pagas antes do vencimento. Ruim: 1 conta vencida há 40 dias e 1 a vencer.
    for (const n of [1, 2]) {
      const t = (await owner.post('/api/erp/financeiro/titulos', { tipo: 'RECEBER', parceiroId: bom.id, descricao: `Venda ${n}`, valorCents: 10_000, parcelas: [{ vencimento: iso(-10 * n), valorCents: 10_000 }] })).body[0];
      const b = await owner.post(`/api/erp/financeiro/titulos/${t.id}/baixar`, { contaId: conta.id, valorCents: 10_000, data: `${iso(-10 * n - 2)}T12:00:00.000Z` });
      expect(b.status).toBe(200);
    }
    await owner.post('/api/erp/financeiro/titulos', { tipo: 'RECEBER', parceiroId: ruim.id, descricao: 'Venda atrasada', valorCents: 30_000, parcelas: [{ vencimento: iso(-40), valorCents: 30_000 }] });
    await owner.post('/api/erp/financeiro/titulos', { tipo: 'RECEBER', parceiroId: ruim.id, descricao: 'Venda futura', valorCents: 50_000, parcelas: [{ vencimento: iso(5), valorCents: 50_000 }] });
    // Outra empresa com conta vencida: não pode entrar na conta desta.
    outra = await registerClient();
    const c2 = (await outra.post('/api/erp/crm/parceiros', { documento: fakeCnpj(), nome: 'Cliente de outra empresa' })).body;
    await outra.post('/api/erp/financeiro/titulos', { tipo: 'RECEBER', parceiroId: c2.id, descricao: 'Outra', valorCents: 999_000, parcelas: [{ vencimento: iso(-3), valorCents: 999_000 }] });
    // Vendedor só com a área de vendas: não vê a inadimplência do Financeiro.
    const inv = await owner.post('/api/team/invites', { email: `${uniq()}@t.dev`, role: 'AGENT', modules: ['erp_crm', 'erp_vendas'] });
    vendedor = new Client();
    const ac = await vendedor.agent.post('/api/auth/accept-invite').set('x-requested-with', 'mckbot').send({ token: inv.body.link.split('/convite/')[1], name: 'Vendedor', password: 'senhaMembro123' });
    vendedor.csrf = ac.body.csrfToken; vendedor.me = ac.body;
  });

  it('painel: inadimplência = vencido em aberto ÷ total a receber do período (só da empresa)', async () => {
    const r = await owner.get(`/api/erp/crm/kpis?de=${iso(-60)}&ate=${iso(30)}T23:59:59`);
    expect(r.status).toBe(200);
    // total 20.000 (pagos) + 30.000 + 50.000 = 100.000; vencido 30.000
    expect(r.body.kpis).toMatchObject({ inadimplenciaPct: 30, inadimplenciaVencidoCents: 30_000, inadimplenciaTotalCents: 100_000, inadimplenciaTitulos: 1 });
    expect(r.body.podeVerFinanceiro).toBe(true);
    // período só com o futuro: nada vencido
    const f = await owner.get(`/api/erp/crm/kpis?de=${iso(1)}&ate=${iso(30)}T23:59:59`);
    expect(f.body.kpis).toMatchObject({ inadimplenciaPct: 0, inadimplenciaTotalCents: 50_000 });
  });

  it('painel: scores por faixa e quem pede atenção', async () => {
    const r = await owner.get(`/api/erp/crm/kpis?de=${iso(-60)}&ate=${iso(30)}T23:59:59`);
    expect(r.body.scores).toMatchObject({ atencao: 1, risco: 1 }); // bom: 540 (atenção); ruim: 350 (risco)
    expect(r.body.scores.piores.map((x: any) => [x.id, x.score])).toEqual([[ruim.id, 350], [bom.id, 540]]);
  });

  it('ficha do cliente: score calculado com os motivos (não fica mais em 500)', async () => {
    const b = (await owner.get(`/api/erp/crm/parceiros/${bom.id}`)).body;
    expect(b).toMatchObject({ score: 540, scoreFaixa: 'ATENCAO' });
    expect(b.scoreMotivos).toEqual([{ texto: '2 contas pagas em dia', pontos: 40 }]);
    const r = (await owner.get(`/api/erp/crm/parceiros/${ruim.id}`)).body;
    expect(r).toMatchObject({ score: 350, scoreFaixa: 'RISCO' });
    // nada gravado no cadastro: a coluna antiga continua 500
    expect((await prisma.erpParceiro.findUniqueOrThrow({ where: { id: ruim.id } })).score).toBe(500);
  });

  it('sem acesso ao Financeiro: inadimplência null; score continua', async () => {
    const r = await vendedor.get(`/api/erp/crm/kpis?de=${iso(-60)}&ate=${iso(30)}T23:59:59`);
    expect(r.status).toBe(200);
    expect(r.body.kpis.inadimplenciaPct).toBeNull();
    expect(r.body.kpis.inadimplenciaVencidoCents).toBeNull();
    expect(r.body.podeVerFinanceiro).toBe(false);
    expect((await vendedor.get(`/api/erp/crm/parceiros/${ruim.id}`)).body.score).toBe(350);
  });

  it('outra empresa não enxerga o cliente nem soma os títulos daqui', async () => {
    expect((await outra.get(`/api/erp/crm/parceiros/${ruim.id}`)).status).toBe(404);
    const r = await outra.get(`/api/erp/crm/kpis?de=${iso(-60)}&ate=${iso(30)}T23:59:59`);
    expect(r.body.kpis).toMatchObject({ inadimplenciaVencidoCents: 999_000, inadimplenciaTotalCents: 999_000, inadimplenciaPct: 100 });
  });
});
