import { describe, it, expect, beforeAll } from 'vitest';
import { registerClient, Client, fakeCnpj } from '../helpers.js';

const enviar = (c: Client, url: string, csv: string) => c.agent.post(url).set((c as any).h()).set('content-type', 'application/octet-stream').send(Buffer.from(csv, 'utf8'));

describe('ERP · venda balcão e planilhas', () => {
  let owner: Client; let prodId: string;
  beforeAll(async () => {
    owner = await registerClient();
    const end = (await owner.post('/api/erp/estoque/depositos', { nome: 'Loja', enderecos: ['B-01'] })).body.enderecos[0].id;
    prodId = (await owner.post('/api/erp/produtos', { sku: 'BAL-1', nome: 'Balcão', precoBaseCents: 1500 })).body.id;
    await owner.post('/api/erp/estoque/entrada', { produtoId: prodId, enderecoId: end, qtdMil: 5_000, custoUnitCents: 700 });
  });

  it('venda balcão: entrega, baixa estoque e liquida', async () => {
    const r = await owner.post('/api/erp/vendas/balcao', { nomeCliente: 'João', forma: 'DINHEIRO', itens: [{ produtoId: prodId, qtdMil: 2_000 }] });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ statusOperacional: 'ENTREGUE', statusFinanceiro: 'LIQUIDADO', totalCents: 3000 });
    const p = (await owner.get('/api/erp/produtos?q=BAL-1')).body.items[0];
    expect(p.saldo.fisicoMil).toBe(3_000);
    const sem = await owner.post('/api/erp/vendas/balcao', { forma: 'PIX', itens: [{ produtoId: prodId, qtdMil: 9_000 }] });
    expect(sem.status).toBe(400);
    expect(sem.body.error).toContain('Sem estoque');
    expect((await owner.get('/api/erp/produtos?q=BAL-1')).body.items[0].saldo.fisicoMil).toBe(3_000);
  });

  it('modelo, importação com simulação e exportação', async () => {
    const m = await owner.get('/api/erp/io/fornecedores/modelo');
    expect(m.text).toContain('CPF/CNPJ *;Nome / Razão social *');
    const doc = fakeCnpj();
    const csv = `CPF/CNPJ;Nome / Razão social;Cidade;UF\n${doc};Fornecedor Planilha LTDA;Osasco;SP\n123;Ruim;;\n`;
    const sim = await enviar(owner, '/api/erp/io/fornecedores/importar?simular=1', csv);
    expect(sim.body).toMatchObject({ simulacao: true, validos: 1, novos: 1, qtdErros: 1 });
    expect((await owner.get('/api/erp/crm/parceiros?tipo=fornecedor&q=Planilha')).body.total).toBe(0);
    const ok = await enviar(owner, '/api/erp/io/fornecedores/importar', csv);
    expect(ok.body).toMatchObject({ novos: 1 });
    const prod = `SKU;Nome;Preço de venda (R$);Estoque mínimo;CNPJ do fornecedor padrão\nimp-1;Produto importado;1.234,50;10;${doc}\nBAL-1;Balcão renomeado;;;\n`;
    const r = await enviar(owner, '/api/erp/io/produtos/importar', prod);
    expect(r.body).toMatchObject({ novos: 1, atualizados: 1, qtdErros: 0 });
    const lista = (await owner.get('/api/erp/produtos?q=IMP-1')).body.items[0];
    expect(lista).toMatchObject({ precoBaseCents: 123450, estoqueMinimoMil: 10_000 });
    expect(lista.fornecedorPadraoId).toBeTruthy();
    const bal = (await owner.get('/api/erp/produtos?q=BAL-1')).body.items[0];
    expect(bal).toMatchObject({ nome: 'Balcão renomeado', precoBaseCents: 1500 });
    const ex = await owner.get('/api/erp/io/produtos/exportar');
    expect(ex.text).toContain('IMP-1;Produto importado');
    expect((await owner.get('/api/erp/io/clientes/exportar')).text).not.toContain('Consumidor final');
  });
});

describe('ERP · custo da NF-e protegido por senha', () => {
  it('pede senha, registra no log, avisa o proprietário e custos extras entram no CMV', async () => {
    const { prisma, outbox } = await import('../helpers.js').then(async (h) => ({ prisma: h.prisma, outbox: (await import('../../server/lib/mailer.js')).outbox }));
    const c = await registerClient();
    const end = (await c.post('/api/erp/estoque/depositos', { nome: 'D', enderecos: ['A'] })).body.enderecos[0].id;
    const p = (await c.post('/api/erp/produtos', { sku: 'XML-1', nome: 'Da nota', precoBaseCents: 2000, custoMedioCents: 500 })).body;
    await c.post('/api/erp/estoque/entrada', { produtoId: p.id, enderecoId: end, qtdMil: 2_000, custoUnitCents: 500 });
    await prisma.erpMovimento.updateMany({ where: { produtoId: p.id }, data: { docTipo: 'nfe_entrada' } });
    const base = { sku: 'XML-1', nome: 'Da nota', precoBaseCents: 2000 };
    expect((await c.put(`/api/erp/produtos/${p.id}`, { ...base, custoMedioCents: 900 })).status).toBe(403);
    expect((await c.put(`/api/erp/produtos/${p.id}`, { ...base, custoMedioCents: 900, senhaCusto: 'errada' })).status).toBe(403);
    const antes = outbox.length;
    const ok = await c.put(`/api/erp/produtos/${p.id}`, { ...base, custoMedioCents: 900, senhaCusto: 'senhaSegura123', custosAdicionais: [{ nome: 'Embalagem', valorCents: 100 }] });
    expect(ok.status).toBe(200);
    const log = await prisma.auditLog.findFirst({ where: { action: 'erp.produto.custo_xml' }, orderBy: { createdAt: 'desc' } });
    expect(log).toBeTruthy();
    await new Promise((r) => setTimeout(r, 200));
    expect(outbox.slice(antes).some((m) => m.subject.includes('Custo de produto alterado') && m.text.includes('R$ 5,00 → R$ 9,00'))).toBe(true);
    const v = await c.post('/api/erp/vendas/balcao', { forma: 'PIX', itens: [{ produtoId: p.id, qtdMil: 1_000 }] });
    expect(v.status).toBe(201);
    const mov = await prisma.erpMovimento.findFirst({ where: { produtoId: p.id, tipo: 'SAIDA' } });
    expect(mov?.custoUnitCents).toBe(1000);
  });
});

describe('ERP · relatório do dia e áreas de acesso', () => {
  it('relatório traz vendas e alterações; CSV baixa', async () => {
    const c = await registerClient();
    const end = (await c.post('/api/erp/estoque/depositos', { nome: 'D', enderecos: ['A'] })).body.enderecos[0].id;
    const p = (await c.post('/api/erp/produtos', { sku: 'REL-1', nome: 'Rel', precoBaseCents: 1000, custoMedioCents: 400 })).body;
    await c.post('/api/erp/estoque/entrada', { produtoId: p.id, enderecoId: end, qtdMil: 3_000, custoUnitCents: 400 });
    await c.post('/api/erp/vendas/balcao', { forma: 'DINHEIRO', itens: [{ produtoId: p.id, qtdMil: 1_000 }] });
    await c.put(`/api/erp/produtos/${p.id}`, { sku: 'REL-1', nome: 'Rel', precoBaseCents: 1000, custoMedioCents: 450 });
    const r = (await c.get('/api/erp/relatorios/dia')).body;
    expect(r.vendas).toMatchObject({ pedidos: 1, balcao: 1, totalCents: 1000 });
    expect(r.recebidoCents).toBe(1000);
    expect(r.cmvCents).toBe(400);
    expect(r.alteracoes.some((a: any) => a.acao === 'Custo alterado')).toBe(true);
    expect((await c.get('/api/erp/relatorios/dia.csv')).text).toContain('Total balcão');
  });
});
