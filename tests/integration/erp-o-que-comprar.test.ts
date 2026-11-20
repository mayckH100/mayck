import { describe, it, expect, beforeAll } from 'vitest';
import { registerClient, Client, uniq, fakeCnpj, prisma } from '../helpers.js';

const DIA = 86_400_000;
const API = '/api/erp/compras/o-que-comprar';

/** v1.32.0: tela Compras › O que comprar (lista, conta, embalagem) e geração dos pedidos de compra. */
describe('ERP · O que comprar + unidade de compra (v1.32.0)', () => {
  let a: Client; let b: Client; let vendedor: Client;
  let orgId: string; let end: string; let forn: any; let caneta: any; let parafuso: any; let parado: any;
  beforeAll(async () => {
    a = await registerClient();
    b = await registerClient();
    end = (await a.post('/api/erp/estoque/depositos', { nome: 'Loja', enderecos: ['GERAL'] })).body.enderecos[0].id;
    forn = (await a.post('/api/erp/crm/parceiros', { documento: fakeCnpj(), nome: 'Ferragens Silva LTDA', fantasia: 'Ferragens Silva', ehCliente: false, ehFornecedor: true })).body;
    // Canetack: tem 5, mínimo 10, sem vendas, custo R$ 5,00, sem fornecedor
    caneta = (await a.post('/api/erp/produtos', { nome: 'Canetack', estoqueMinimoMil: 10_000, custoMedioCents: 500 })).body;
    orgId = caneta.orgId;
    // Parafuso: estoque em peças, comprado em pacote com 10 peças; vende 2 por dia
    const r = await a.post('/api/erp/produtos', { nome: 'Parafuso 6 mm', unidade: 'PC', unidadeCompra: 'PCT', fatorCompraMil: 10_000, estoqueMinimoMil: 10_000, fornecedorPadraoId: forn.id });
    expect(r.status).toBe(201);
    parafuso = r.body;
    expect(parafuso).toMatchObject({ unidade: 'PC', unidadeCompra: 'PCT', fatorCompraMil: 10_000 });
    // Parado: zerado, sem mínimo, sem venda → não entra
    parado = (await a.post('/api/erp/produtos', { nome: 'Produto parado' })).body;
    await a.post('/api/erp/estoque/entrada', { produtoId: caneta.id, enderecoId: end, qtdMil: 5_000, custoUnitCents: 500 });
    await a.post('/api/erp/estoque/entrada', { produtoId: parafuso.id, enderecoId: end, qtdMil: 5_000, custoUnitCents: 200 });
    await prisma.erpProduto.updateMany({ where: { id: { in: [caneta.id, parafuso.id] } }, data: { createdAt: new Date(Date.now() - 120 * DIA) } });
    const s = await prisma.erpSaldo.findFirstOrThrow({ where: { orgId, produtoId: parafuso.id } });
    await prisma.erpMovimento.create({ data: { orgId, produtoId: parafuso.id, loteId: s.loteId, enderecoId: s.enderecoId, tipo: 'SAIDA', qtdMil: -60_000, saldoAposMil: 5_000, docTipo: 'pedido_venda', createdAt: new Date(Date.now() - 5 * DIA) } });
    // transferência e inventário não contam como consumo
    await prisma.erpMovimento.create({ data: { orgId, produtoId: parafuso.id, loteId: s.loteId, enderecoId: s.enderecoId, tipo: 'TRANSFERENCIA_SAIDA', qtdMil: -500_000, saldoAposMil: 5_000, createdAt: new Date(Date.now() - 5 * DIA) } });
    // Vendedor (só ERP Vendas): vê a lista (leitura) mas não gera pedido de compra
    const inv = await a.post('/api/team/invites', { email: `${uniq()}@t.dev`, role: 'AGENT', modules: ['erp_vendas'] });
    vendedor = new Client();
    const ac = await vendedor.agent.post('/api/auth/accept-invite').set('x-requested-with', 'mckbot').send({ token: inv.body.link.split('/convite/')[1], name: 'Vendedor', password: 'senhaMembro123' });
    vendedor.csrf = ac.body.csrfToken; vendedor.me = ac.body;
  });

  it('lista só zerados/abaixo do mínimo, mais urgente primeiro, com quantidade, embalagem, custo e total', async () => {
    const r = await a.get(API);
    expect(r.status).toBe(200);
    expect(r.body.coberturaDias).toBe(30);
    const ids = r.body.itens.map((i: any) => i.produtoId);
    expect(ids).toEqual([parafuso.id, caneta.id]); // parafuso acaba em 2 dias; caneta sem vendas
    expect(ids).not.toContain(parado.id);
    const [p, c] = r.body.itens;
    // 2/dia × 30 dias = 60 − 5 = 55 peças → 6 pacotes (60 peças) a R$ 20,00 o pacote
    expect(p).toMatchObject({ sku: parafuso.sku, unidade: 'PC', unidadeCompra: 'PCT', fatorCompraMil: 10_000, saldoMil: 5_000, sugeridaMil: 60_000, custoUnitCents: 200, custoEmbalagemCents: 2_000, custoOrigem: 'entrada', totalCents: 12_000, fornecedorNome: 'Ferragens Silva', embalagem: 'pacote com 10 peças' });
    expect(p.calculo).toMatchObject({ consumoDiaMil: 2_000, duraDias: 2, base: '30d' });
    expect(p.motivo).toBe('vende ~2 peças por dia, dura 2 dias, compra para 30 dias, arredondado para embalagem inteira');
    // Canetack: tem 5, mínimo 10, sem vendas → compra 5 a R$ 5,00 = R$ 25,00
    expect(c).toMatchObject({ sugeridaMil: 5_000, custoUnitCents: 500, totalCents: 2_500, fornecedorId: null, temEmbalagem: false });
    expect(c.motivo).toBe('sem vendas nos últimos 90 dias, completa o estoque mínimo');
    expect(r.body.totalCents).toBe(14_500);
    // cobertura pela tela
    expect((await a.get(`${API}?cobertura=15`)).body.itens[0].sugeridaMil).toBe(30_000); // 2 × 15 − 5 = 25 → 3 pacotes
  });

  it('gera pedido de compra (rascunho) por fornecedor; sem fornecedor vira solicitação; tudo no AuditLog', async () => {
    expect((await vendedor.get(API)).status).toBe(403); // sem compras, estoque nem financeiro
    expect((await vendedor.post(`${API}/gerar`, { itens: [{ produtoId: caneta.id, qtdMil: 5_000, precoUnitCents: 500 }] })).status).toBe(403);
    const r = await a.post(`${API}/gerar`, { itens: [
      { produtoId: parafuso.id, qtdMil: 60_000, precoUnitCents: 200, parceiroId: forn.id },
      { produtoId: caneta.id, qtdMil: 5_000, precoUnitCents: 500, parceiroId: null },
    ] });
    expect(r.status).toBe(201);
    const docs = r.body.documentos;
    expect(docs.map((d: any) => d.tipo).sort()).toEqual(['pedido', 'solicitacao']);
    const pc = await prisma.erpPedidoCompra.findFirstOrThrow({ where: { orgId, id: docs.find((d: any) => d.tipo === 'pedido').id }, include: { itens: true } });
    expect(pc).toMatchObject({ status: 'RASCUNHO', parceiroId: forn.id, totalCents: 12_000 });
    expect(pc.itens).toMatchObject([{ produtoId: parafuso.id, qtdMil: 60_000, precoUnitCents: 200, totalCents: 12_000 }]);
    const sol = await prisma.erpSolicitacaoCompra.findFirstOrThrow({ where: { orgId, id: docs.find((d: any) => d.tipo === 'solicitacao').id }, include: { itens: true } });
    expect(sol.itens).toMatchObject([{ produtoId: caneta.id, qtdMil: 5_000 }]);
    expect(await prisma.auditLog.count({ where: { orgId, action: 'erp.pedido_compra.criar', entityId: pc.id } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { orgId, action: 'erp.solicitacao_compra.criar', entityId: sol.id } })).toBe(1);
    // Depois de pedido, o parafuso continua na lista mas sem nada a comprar (o que já foi pedido cobre)
    const p = (await a.get(API)).body.itens.find((i: any) => i.produtoId === parafuso.id);
    expect(p).toMatchObject({ aCaminhoMil: 60_000, sugeridaMil: 0, totalCents: 0 });
    expect(p.motivo).toContain('o que já foi pedido cobre');
  });

  it('recusa produto/fornecedor de outra empresa e produto repetido', async () => {
    expect((await b.post(`${API}/gerar`, { itens: [{ produtoId: caneta.id, qtdMil: 1_000, precoUnitCents: 0 }] })).status).toBe(400);
    const fb = (await b.post('/api/erp/crm/parceiros', { documento: fakeCnpj(), nome: 'Outro', ehCliente: false, ehFornecedor: true })).body;
    expect((await a.post(`${API}/gerar`, { itens: [{ produtoId: caneta.id, qtdMil: 1_000, precoUnitCents: 0, parceiroId: fb.id }] })).status).toBe(400);
    expect((await a.post(`${API}/gerar`, { itens: [{ produtoId: caneta.id, qtdMil: 1_000, precoUnitCents: 0 }, { produtoId: caneta.id, qtdMil: 1_000, precoUnitCents: 0 }] })).status).toBe(400);
    expect((await b.get(API)).body.itens).toEqual([]);
  });

  it('cadastro: unidade de compra igual à de estoque zera a embalagem; editar sem os campos não apaga; quilo decimal', async () => {
    const up = await a.put(`/api/erp/produtos/${caneta.id}`, { nome: 'Canetack', unidade: 'UN', estoqueMinimoMil: 10_000, unidadeCompra: 'UN', fatorCompraMil: 12_000 });
    expect(up.status).toBe(200);
    expect(up.body).toMatchObject({ unidadeCompra: null, fatorCompraMil: 1000 });
    const p2 = (await a.put(`/api/erp/produtos/${parafuso.id}`, { nome: 'Parafuso 6 mm', unidade: 'PC', estoqueMinimoMil: 10_000, fornecedorPadraoId: forn.id })).body;
    expect(p2).toMatchObject({ unidadeCompra: 'PCT', fatorCompraMil: 10_000 }); // tela antiga não manda: mantém
    expect((await a.post('/api/erp/produtos', { nome: 'Ruim', unidadeCompra: '30', fatorCompraMil: 10_000 })).status).toBe(400);
    expect((await a.post('/api/erp/produtos', { nome: 'Ruim 2', unidadeCompra: 'CX', fatorCompraMil: 0 })).status).toBe(400);
    const cafe = (await a.post('/api/erp/produtos', { nome: 'Café a granel', unidade: 'KG', unidadeCompra: 'SC', fatorCompraMil: 2_500 })).body;
    expect(cafe).toMatchObject({ unidade: 'KG', unidadeCompra: 'SC', fatorCompraMil: 2_500 });
    expect((await a.post('/api/erp/estoque/entrada', { produtoId: cafe.id, enderecoId: end, qtdMil: 7_500, custoUnitCents: 4_000 })).status).toBe(201); // 3 sacos = 7,5 kg
  });
});
