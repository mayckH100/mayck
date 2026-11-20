/**
 * v1.33.0 — rastreabilidade de lote: lotes visíveis (produto e estoque), busca única (produto, lote interno, lote do
 * fornecedor, NF de entrada/saída, chave, pedido de venda/compra), linha do tempo completa, para frente (lote → clientes,
 * inclusive no produto acabado) e para trás (pedido → lotes → fornecedor/NF), CSV, lote gravado em toda saída,
 * devolução voltando ao mesmo lote e saldo antigo sem lote ("UNICO") virando L-INICIAL.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { registerClient, Client, fakeCnpj, prisma } from '../helpers.js';
import { nfeXml } from '../fixtures/nfe-exemplo.js';

const CHAVE = '35261100000000000000550010000012341000099999';

describe('ERP · rastreabilidade de lote (v1.33.0)', () => {
  let owner: Client; let orgId: string; let endA: string; let endB: string;
  let forn: any; let cliente: any; let leite: any; let iogurte: any; let caneta: any;
  let loteLeite: any; let pedidoId: string; let pedidoNumero: number;

  beforeAll(async () => {
    owner = await registerClient();
    const dep = (await owner.post('/api/erp/estoque/depositos', { nome: 'Loja', enderecos: ['A-01', 'B-01'] })).body;
    [endA, endB] = dep.enderecos.sort((x: any, y: any) => x.codigo.localeCompare(y.codigo)).map((e: any) => e.id);
    orgId = dep.orgId;
    const cnpj = fakeCnpj();
    forn = (await owner.post('/api/erp/crm/parceiros', { documento: cnpj, nome: 'Laticínios Exemplo LTDA', ehCliente: false, ehFornecedor: true })).body;
    forn.cnpj = cnpj;
    cliente = (await owner.post('/api/erp/crm/parceiros', { documento: fakeCnpj(), nome: 'Mercado Bom LTDA' })).body;
    leite = (await owner.post('/api/erp/produtos', { sku: 'LEITE', nome: 'Leite 1L', controlaLote: true, controlaValidade: true, regraSaida: 'FEFO', precoBaseCents: 900 })).body;
    iogurte = (await owner.post('/api/erp/produtos', { sku: 'IOG', nome: 'Iogurte 500g', tipo: 'PRODUZIDO', precoBaseCents: 1500 })).body;
  });

  it('saldo antigo sem lote (UNICO, antes da 1.31) passa a aparecer como L-INICIAL, com data e quantidade', async () => {
    caneta = (await owner.post('/api/erp/produtos', { sku: 'MCK0001', nome: 'Canetack', controlaLote: true, precoBaseCents: 300 })).body;
    // Simula a entrada de 13/11 feita antes da v1.31.0: lote "UNICO", sem nota.
    const quando = new Date('2026-11-13T15:00:00Z');
    const l = await prisma.erpLote.create({ data: { orgId, produtoId: caneta.id, numero: 'UNICO', createdAt: quando } });
    await prisma.erpSaldo.create({ data: { orgId, produtoId: caneta.id, loteId: l.id, enderecoId: endA, fisicoMil: 5_000 } });
    await prisma.erpMovimento.create({ data: { orgId, produtoId: caneta.id, loteId: l.id, enderecoId: endA, tipo: 'ENTRADA', qtdMil: 5_000, custoUnitCents: 150, saldoAposMil: 5_000, docTipo: 'ajuste', motivo: 'Entrada manual', createdAt: quando } });

    const lista = (await owner.get('/api/erp/produtos?q=Canetack')).body.items[0];
    expect(lista.lotes).toEqual({ total: 1, comSaldo: 1 });
    const r = (await owner.get(`/api/erp/estoque/lotes/produto/${caneta.id}`)).body;
    expect(r.lotes).toHaveLength(1);
    expect(r.lotes[0]).toMatchObject({ id: l.id, numero: 'L-INICIAL', recebidoMil: 5_000, saldoMil: 5_000, disponivelMil: 5_000 });
    expect(new Date(r.lotes[0].entradaEm).toISOString()).toBe(quando.toISOString());
    expect(r.lotes[0].documentoEntrada.rotulo).toMatch(/antes do controle de lote/);
    expect(r.lotes[0].locais[0]).toMatchObject({ deposito: 'Loja', endereco: 'A-01', fisicoMil: 5_000 });
    // mesmo registro (id), histórico intacto
    expect((await prisma.erpLote.findUniqueOrThrow({ where: { id: l.id } })).numero).toBe('L-INICIAL');
    expect(await prisma.erpMovimento.count({ where: { loteId: l.id } })).toBe(1);
    // busca pelo código do produto acha o lote
    const b = (await owner.get('/api/erp/estoque/rastreio?q=MCK0001')).body;
    expect(b.grupos.find((g: any) => g.tipo === 'produto').lotes[0].numero).toBe('L-INICIAL');
  });

  it('entrada por NF-e (XML) cria lote interno com lote do fornecedor; busca por lote do fornecedor, nº e chave da NF', async () => {
    const pc = (await owner.post('/api/erp/compras/pedidos', { parceiroId: forn.id, itens: [{ produtoId: leite.id, qtdMil: 24_000, precoUnitCents: 500 }] })).body;
    await owner.post(`/api/erp/compras/pedidos/${pc.id}/acao`, { evento: 'ENVIAR' });
    const imp = (await owner.post('/api/erp/estoque/nfe/importar', { xml: nfeXml(forn.cnpj, CHAVE) })).body;
    const nfe = (await owner.get(`/api/erp/estoque/nfe/${imp.id}`)).body;
    await owner.put(`/api/erp/estoque/nfe/${nfe.id}/itens/${nfe.itens[0].id}`, { produtoId: leite.id, fatorMil: 12_000 });
    await owner.put(`/api/erp/estoque/nfe/${nfe.id}/pedido`, { pedidoCompraId: pc.id });
    expect((await owner.post(`/api/erp/estoque/nfe/${nfe.id}/lancar`, { enderecoId: endA })).status).toBe(200);

    const porForn = (await owner.get('/api/erp/estoque/rastreio?q=abc123')).body;
    const g = porForn.grupos.find((x: any) => x.tipo === 'lote_fornecedor');
    expect(g.lotes).toHaveLength(1);
    loteLeite = g.lotes[0];
    expect(loteLeite.numero).toMatch(/^L\d{4}-\d{4}$/);
    expect(loteLeite.loteFornecedor.toUpperCase()).toBe('ABC123');
    expect(loteLeite.fornecedor.nome).toBe('Laticínios Exemplo LTDA');
    expect(loteLeite.documentoEntrada.rotulo).toMatch(/NF-e nº 1234\/1 · pedido de compra nº \d+/);
    expect(loteLeite).toMatchObject({ recebidoMil: 12_000, saldoMil: 12_000 });
    expect(loteLeite.validade).toBeTruthy();

    const porNf = (await owner.get('/api/erp/estoque/rastreio?q=1234')).body;
    expect(porNf.grupos.find((x: any) => x.tipo === 'nfe_entrada').lotes).toHaveLength(2);
    const porChave = (await owner.get(`/api/erp/estoque/rastreio?q=${CHAVE}`)).body;
    expect(porChave.busca.tipos).toEqual(['chave_nfe']);
    expect(porChave.grupos.map((x: any) => x.tipo)).toEqual(['nfe_entrada']);
    const porPc = (await owner.get(`/api/erp/estoque/rastreio?q=PC ${pc.numero}`)).body;
    expect(porPc.grupos.find((x: any) => x.tipo === 'pedido_compra').lotes).toHaveLength(2);
    const porLote = (await owner.get(`/api/erp/estoque/rastreio?q=${loteLeite.numero}`)).body;
    expect(porLote.grupos.find((x: any) => x.tipo === 'lote').lotes[0].id).toBe(loteLeite.id);
  });

  it('mudança de lugar, reserva, separação por QR, venda com NF: tudo na linha do tempo; busca pela NF de saída e pelo pedido', async () => {
    const s = (await owner.get(`/api/erp/estoque/saldos?produtoId=${leite.id}`)).body.find((x: any) => x.loteId === loteLeite.id);
    expect((await owner.post('/api/erp/estoque/transferencia', { saldoId: s.id, enderecoDestinoId: endB, qtdMil: 4_000 })).status).toBe(200);
    // pedido de 3 do lote que vence primeiro (FEFO = este lote, validade jan/2027)
    const ped = (await owner.post('/api/erp/vendas/pedidos', { parceiroId: cliente.id, depositoId: null, itens: [{ produtoId: leite.id, qtdMil: 3_000 }] })).body;
    pedidoId = ped.id; pedidoNumero = ped.numero;
    expect((await owner.post(`/api/erp/vendas/pedidos/${ped.id}/acao`, { evento: 'ENVIAR' })).body.statusOperacional).toBe('RESERVADO');
    await owner.post(`/api/erp/vendas/pedidos/${ped.id}/acao`, { evento: 'SEPARAR' });
    const det = (await owner.get(`/api/erp/vendas/pedidos/${ped.id}`)).body;
    for (const sep of det.separacao) {
      const etq = `MCK1;${sep.lote};-;-;LEITE;Leite 1L`; // QR da etiqueta
      expect((await owner.post(`/api/erp/vendas/pedidos/${ped.id}/conferencia`, { codigo: etq, qtdMil: sep.qtdMil })).status).toBe(200);
    }
    await owner.post(`/api/erp/vendas/pedidos/${ped.id}/acao`, { evento: 'CONFERIR' });
    expect((await owner.post(`/api/erp/vendas/pedidos/${ped.id}/acao`, { evento: 'FATURAR', nfNumero: '7788' })).status).toBe(200);
    // toda saída gravou o lote
    const saidas = await prisma.erpMovimento.findMany({ where: { docId: ped.id, tipo: 'SAIDA' } });
    expect(saidas.length).toBeGreaterThan(0);
    expect(saidas.every((m) => !!m.loteId)).toBe(true);

    const t = (await owner.get(`/api/erp/estoque/rastreio/lote/${loteLeite.id}`)).body;
    const cats = t.eventos.map((e: any) => e.categoria);
    expect(cats).toEqual(expect.arrayContaining(['entrada', 'transferencia', 'reserva', 'separacao', 'saida']));
    const ent = t.eventos.find((e: any) => e.categoria === 'entrada');
    expect(ent.texto).toMatch(/Entrada pela NF-e nº 1234\/1.*Laticínios Exemplo/);
    expect(ent.quem).toBe('Usuário Teste');
    expect(t.eventos.find((e: any) => e.categoria === 'saida').texto).toMatch(/Mercado Bom LTDA · NF nº 7788/);
    const vendido = saidas.filter((m) => m.loteId === loteLeite.id).reduce((a, m) => a - m.qtdMil, 0);
    expect(t.lote.saldoMil).toBe(12_000 - vendido);
    expect(t.lote.locais.map((l: any) => l.endereco).sort()).toEqual(['A-01', 'B-01']);
    expect(t.destinos.find((d: any) => d.tipo === 'cliente')).toMatchObject({ para: 'Mercado Bom LTDA', qtdMil: vendido });
    expect(t.clientesAlcancados[0]).toMatchObject({ cliente: 'Mercado Bom LTDA', nf: 'NF nº 7788', via: null });

    const porNfSaida = (await owner.get('/api/erp/estoque/rastreio?q=7788')).body;
    expect(porNfSaida.grupos.find((g: any) => g.tipo === 'nfe_saida').pedidoVendaId).toBe(ped.id);
    const porPedido = (await owner.get(`/api/erp/estoque/rastreio?q=${encodeURIComponent(`nº ${pedidoNumero}`)}`)).body;
    expect(porPedido.grupos.find((g: any) => g.tipo === 'pedido_venda').lotes.map((l: any) => l.id)).toContain(loteLeite.id);
  });

  it('produção: o lote de leite usado vira iogurte; recall do leite chega ao cliente do iogurte; iogurte aponta para o leite', async () => {
    expect((await owner.put(`/api/erp/producao/estruturas/${iogurte.id}`, { itens: [{ componenteId: leite.id, qtdMil: 500 }], operacoes: [] })).status).toBe(200);
    const op = (await owner.post('/api/erp/producao/ops', { produtoId: iogurte.id, qtdPlanejadaMil: 4_000 })).body;
    await owner.post(`/api/erp/producao/ops/${op.id}/acao`, { evento: 'LIBERAR' });
    expect((await owner.post(`/api/erp/producao/ops/${op.id}/apontar`, { qtdBoaMil: 4_000, enderecoId: endA, encerrar: true })).status).toBe(200);
    const consumo = await prisma.erpMovimento.findMany({ where: { docTipo: 'op', docId: op.id, tipo: 'CONSUMO' } });
    expect(consumo.every((m) => !!m.loteId)).toBe(true);
    const loteIog = (await owner.get(`/api/erp/estoque/lotes/produto/${iogurte.id}`)).body.lotes[0];
    expect(loteIog.documentoEntrada.rotulo).toMatch(/Ordem de produção nº/);
    // venda balcão do iogurte
    expect((await owner.post('/api/erp/vendas/caixa/abrir', { valorAberturaCents: 0 })).status).toBe(201);
    const v = await owner.post('/api/erp/vendas/balcao', { parceiroId: cliente.id, forma: 'DINHEIRO', itens: [{ produtoId: iogurte.id, qtdMil: 1_000 }] });
    expect(v.status).toBe(201);
    expect((await prisma.erpMovimento.findMany({ where: { docId: v.body.id, tipo: 'SAIDA' } })).every((m) => m.loteId === loteIog.id)).toBe(true);

    const usado = consumo[0].loteId;
    const t = (await owner.get(`/api/erp/estoque/rastreio/lote/${usado}`)).body;
    const prod = t.destinos.find((d: any) => d.tipo === 'producao');
    expect(prod.lotesGerados.map((g: any) => g.id)).toContain(loteIog.id);
    const via = t.clientesAlcancados.find((c: any) => c.via);
    expect(via).toMatchObject({ cliente: 'Mercado Bom LTDA', produto: 'Iogurte 500g', lote: { id: loteIog.id } });
    expect(via.pedido.rotulo).toMatch(/Venda balcão nº/);
    // para trás: iogurte → leite → fornecedor/NF
    const back = (await owner.get(`/api/erp/estoque/rastreio/lote/${loteIog.id}`)).body;
    expect(back.origem[0].lote.id).toBe(usado);
    expect(back.origem[0].lote.documentoEntrada.rotulo).toMatch(/NF-e nº 1234/);
    const ped = (await owner.get(`/api/erp/estoque/rastreio/pedido/${v.body.id}`)).body;
    expect(ped.lotes[0].lote.id).toBe(loteIog.id);
    expect(ped.lotes[0].origem[0].lote.fornecedor.nome).toBe('Laticínios Exemplo LTDA');
  });

  it('baixa manual grava o lote; devolução com retorno volta ao mesmo lote e endereço', async () => {
    const s = (await owner.get(`/api/erp/estoque/saldos?produtoId=${caneta.id}`)).body[0];
    expect((await owner.post('/api/erp/estoque/ajuste', { saldoId: s.id, qtdMil: 1_000, motivo: 'Quebrou' })).status).toBe(200);
    const b = await prisma.erpMovimento.findFirst({ where: { produtoId: caneta.id, tipo: 'AJUSTE' }, orderBy: { createdAt: 'desc' } });
    expect(b).toMatchObject({ loteId: s.loteId, qtdMil: -1_000 });

    await owner.post(`/api/erp/vendas/pedidos/${pedidoId}/acao`, { evento: 'EXPEDIR' });
    const antes = (await owner.get(`/api/erp/estoque/rastreio/lote/${loteLeite.id}`)).body.lote.saldoMil;
    const d = await owner.post(`/api/erp/vendas/pedidos/${pedidoId}/acao`, { evento: 'DEVOLVER', motivo: 'Produto avariado', voltarEstoque: true });
    expect(d.status).toBe(200);
    const devs = await prisma.erpMovimento.findMany({ where: { docId: pedidoId, tipo: 'DEVOLUCAO' } });
    const saidas = await prisma.erpMovimento.findMany({ where: { docId: pedidoId, tipo: 'SAIDA' } });
    expect(devs.map((m) => `${m.loteId}:${m.enderecoId}:${m.qtdMil}`).sort()).toEqual(saidas.map((m) => `${m.loteId}:${m.enderecoId}:${-m.qtdMil}`).sort());
    const t = (await owner.get(`/api/erp/estoque/rastreio/lote/${loteLeite.id}`)).body;
    expect(t.lote.saldoMil).toBe(antes + devs.filter((m) => m.loteId === loteLeite.id).reduce((a, m) => a + m.qtdMil, 0));
    expect(t.eventos.some((e: any) => e.categoria === 'devolucao' && /Devolvido pelo cliente/.test(e.texto))).toBe(true);
    expect(t.clientesAlcancados.find((c: any) => c.pedido.id === pedidoId && !c.via)).toBeUndefined(); // devolveu tudo
  });

  it('exporta o rastreio em CSV e a aba de saldo por lote mostra os lotes com saldo', async () => {
    const r = await owner.get(`/api/erp/estoque/rastreio/lote/${loteLeite.id}/csv`);
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/text\/csv/);
    expect(r.text).toContain('Rastreio do lote;' + loteLeite.numero);
    expect(r.text).toContain('Para onde foi');
    expect(r.text).toContain('Entrada pela NF-e nº 1234/1');
    const ls = (await owner.get('/api/erp/estoque/lotes-saldo')).body;
    expect(ls.map((l: any) => l.numero)).toEqual(expect.arrayContaining(['L-INICIAL', loteLeite.numero]));
  });

  it('outra empresa não vê os lotes nem o rastreio', async () => {
    const outra = await registerClient();
    expect((await outra.get(`/api/erp/estoque/rastreio/lote/${loteLeite.id}`)).status).toBe(404);
    expect((await outra.get('/api/erp/estoque/rastreio?q=abc123')).body.grupos).toEqual([]);
  });
});
