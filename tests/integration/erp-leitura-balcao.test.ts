/**
 * v1.34.0 — venda de balcão por leitura (etiqueta do lote → baixa daquele lote), localizar pedido (código PV, nº,
 * chave, cliente, lote, produto), "Ler código" de qualquer tela e documento impresso com o código do pedido.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { registerClient, Client, fakeCnpj, prisma } from '../helpers.js';
import { gs1Lote, qrLote } from '../../server/erp/estoque/codigoLote.js';

const GS = '\u001D';
const etiquetaGs1 = (sku: string, lote: string, validadeIso: string) => gs1Lote({ sku, lote, validadeIso }).dados.replace(/\u00CF/g, GS);

describe('ERP · leitura unificada, balcão por etiqueta e localizar pedido (v1.34.0)', () => {
  let owner: Client; let orgId: string; let end: string; let leite: any; let caneta: any;
  let loteVelho: any; let loteNovo: any; let cliente: any;

  beforeAll(async () => {
    owner = await registerClient();
    const dep = (await owner.post('/api/erp/estoque/depositos', { nome: 'Loja', enderecos: ['A-01'] })).body;
    end = dep.enderecos[0].id; orgId = dep.orgId;
    leite = (await owner.post('/api/erp/produtos', { sku: 'LEITE', nome: 'Leite 1L', controlaLote: true, controlaValidade: true, regraSaida: 'FEFO', precoBaseCents: 900, codigoBarras: '7891234567895' })).body;
    caneta = (await owner.post('/api/erp/produtos', { sku: 'CAN', nome: 'Caneta azul', precoBaseCents: 300, codigoBarras: '7890000000017' })).body;
    expect((await owner.post('/api/erp/estoque/entrada', { produtoId: leite.id, enderecoId: end, qtdMil: 5_000, custoUnitCents: 400, lote: { validade: '2099-01-10' } })).status).toBe(201);
    expect((await owner.post('/api/erp/estoque/entrada', { produtoId: leite.id, enderecoId: end, qtdMil: 5_000, custoUnitCents: 400, lote: { validade: '2099-06-10' } })).status).toBe(201);
    expect((await owner.post('/api/erp/estoque/entrada', { produtoId: caneta.id, enderecoId: end, qtdMil: 10_000, custoUnitCents: 100 })).status).toBe(201);
    const lotes = await prisma.erpLote.findMany({ where: { orgId, produtoId: leite.id }, orderBy: { validade: 'asc' } });
    [loteVelho, loteNovo] = lotes;
    cliente = (await owner.post('/api/erp/crm/parceiros', { documento: fakeCnpj(), nome: 'Padaria Estrela LTDA' })).body;
    expect((await owner.post('/api/erp/vendas/caixa/abrir', { valorAberturaCents: 0 })).status).toBe(201);
  });

  it('balcão: ler a etiqueta GS1 traz o lote; ler o EAN sugere o lote FEFO', async () => {
    const r = await owner.get(`/api/erp/vendas/balcao/ler?codigo=${encodeURIComponent(etiquetaGs1('LEITE', loteNovo.numero, '2099-06-10'))}`);
    expect(r.status).toBe(200);
    expect(r.body.produto).toMatchObject({ id: leite.id, precoBaseCents: 900 });
    expect(r.body.lote).toMatchObject({ id: loteNovo.id, numero: loteNovo.numero, disponivelMil: 5_000, vencido: false });
    const qr = await owner.get(`/api/erp/vendas/balcao/ler?codigo=${encodeURIComponent(qrLote({ lote: loteVelho.numero, sku: 'LEITE', nome: 'Leite 1L', validadeIso: '2099-01-10' }))}`);
    expect(qr.body.lote.id).toBe(loteVelho.id);
    const ean = await owner.get('/api/erp/vendas/balcao/ler?codigo=7891234567895');
    expect(ean.body.lote).toBeNull();
    expect(ean.body.sugestao).toMatchObject({ loteId: loteVelho.id, regra: 'FEFO' });
    expect(ean.body.produto.saldo.disponivelMil).toBe(10_000);
    expect((await owner.get('/api/erp/vendas/balcao/ler?codigo=NAOEXISTE')).status).toBe(404);
    const pv = await owner.get('/api/erp/vendas/balcao/ler?codigo=PV-1');
    expect(pv.status).toBe(400);
    expect(pv.body.error).toContain('Localizar pedido');
  });

  let vendaLote: any;
  it('balcão: item com o lote lido baixa daquele lote (não do FEFO)', async () => {
    const r = await owner.post('/api/erp/vendas/balcao', { forma: 'DINHEIRO', itens: [{ produtoId: leite.id, qtdMil: 2_000, loteId: loteNovo.id }, { produtoId: caneta.id, qtdMil: 3_000 }] });
    expect(r.status).toBe(201);
    vendaLote = r.body;
    const movs = await prisma.erpMovimento.findMany({ where: { orgId, docTipo: 'pedido_venda', docId: r.body.id, tipo: 'SAIDA', produtoId: leite.id } });
    expect(movs.map((m) => m.loteId)).toEqual([loteNovo.id]);
    expect(movs[0].qtdMil).toBe(-2_000);
    const item = await prisma.erpPedidoItem.findFirst({ where: { pedidoId: r.body.id, produtoId: leite.id } });
    expect(item?.loteId).toBe(loteNovo.id);
    // Lote lido com menos saldo do que a venda: recusa e explica (não completa com outro lote).
    const sem = await owner.post('/api/erp/vendas/balcao', { forma: 'PIX', itens: [{ produtoId: leite.id, qtdMil: 4_000, loteId: loteNovo.id }] });
    expect(sem.status).toBe(400);
    expect(sem.body.error).toContain(`lote ${loteNovo.numero}`);
    // Lote de outro produto: recusa.
    const errado = await owner.post('/api/erp/vendas/balcao', { forma: 'PIX', itens: [{ produtoId: caneta.id, qtdMil: 1_000, loteId: loteNovo.id }] });
    expect(errado.status).toBe(400);
    // Sem lote: FEFO (vence primeiro).
    const fefo = await owner.post('/api/erp/vendas/balcao', { parceiroId: cliente.id, forma: 'PIX', itens: [{ produtoId: leite.id, qtdMil: 1_000 }] });
    expect(fefo.status).toBe(201);
    const m2 = await prisma.erpMovimento.findFirst({ where: { orgId, docId: fefo.body.id, tipo: 'SAIDA' } });
    expect(m2?.loteId).toBe(loteVelho.id);
  });

  it('localizar pedido: código PV, nº, nota balcão, cliente, lote (etiqueta e digitado) e produto', async () => {
    const pv = (await owner.get(`/api/erp/vendas/localizar?q=PV-${vendaLote.numero}`)).body;
    expect(pv.tipo).toBe('pedido');
    expect(pv.pedidos.map((p: any) => p.id)).toEqual([vendaLote.id]);
    expect(pv.pedidos[0]).toMatchObject({ codigo: `PV-${vendaLote.numero}`, balcao: true });
    expect((await owner.get(`/api/erp/vendas/localizar?q=${vendaLote.numero}`)).body.pedidos.map((p: any) => p.id)).toContain(vendaLote.id);
    expect((await owner.get(`/api/erp/vendas/localizar?q=BALCAO-${vendaLote.numero}`)).body.pedidos.map((p: any) => p.id)).toContain(vendaLote.id);
    const cli = (await owner.get('/api/erp/vendas/localizar?q=padaria')).body;
    expect(cli.pedidos.length).toBe(1);
    expect(cli.pedidos[0].motivos.join(' ')).toContain('cliente');
    const porEtiqueta = (await owner.get(`/api/erp/vendas/localizar?q=${encodeURIComponent(etiquetaGs1('LEITE', loteNovo.numero, '2099-06-10'))}`)).body;
    expect(porEtiqueta.pedidos.map((p: any) => p.id)).toEqual([vendaLote.id]);
    expect(porEtiqueta.pedidos[0].motivos[0]).toContain(loteNovo.numero);
    expect((await owner.get(`/api/erp/vendas/localizar?q=${loteVelho.numero}`)).body.pedidos.length).toBe(1);
    const prod = (await owner.get('/api/erp/vendas/localizar?q=7890000000017')).body;
    expect(prod.pedidos.map((p: any) => p.id)).toContain(vendaLote.id);
  });

  it('localizar pedido pela chave de NF-e (código de barras do DANFE e QR da NFC-e)', async () => {
    const chave = '35261112345678000195550010000000011000000015';
    await prisma.erpNfeSaida.create({ data: { orgId, pedidoId: vendaLote.id, parceiroId: vendaLote.parceiroId, numero: 1, serie: 1, chave, ambiente: 2, status: 'AUTORIZADA', totalCents: vendaLote.totalCents, xml: '<x/>' } });
    const r = (await owner.get(`/api/erp/vendas/localizar?q=${chave}`)).body;
    expect(r.tipo).toBe('chave_nfe');
    expect(r.pedidos.map((p: any) => p.id)).toEqual([vendaLote.id]);
    const qr = (await owner.get(`/api/erp/vendas/localizar?q=${encodeURIComponent(`https://www.nfce.fazenda.sp.gov.br/qrcode?p=${chave}|2|2|1|ABC`)}`)).body;
    expect(qr.pedidos.map((p: any) => p.id)).toEqual([vendaLote.id]);
    const ler = (await owner.get(`/api/erp/leitura?codigo=${chave.replace(/(\d{4})/g, '$1 ')}`)).body;
    expect(ler).toMatchObject({ tipo: 'pedido', destino: `/erp/pedidos/${vendaLote.id}` });
  });

  it('"Ler código" de qualquer tela leva ao lugar certo', async () => {
    expect((await owner.get(`/api/erp/leitura?codigo=PV-${vendaLote.numero}`)).body).toMatchObject({ tipo: 'pedido', destino: `/erp/pedidos/${vendaLote.id}` });
    expect((await owner.get(`/api/erp/leitura?codigo=${encodeURIComponent(etiquetaGs1('LEITE', loteNovo.numero, '2099-06-10'))}`)).body).toMatchObject({ tipo: 'lote', destino: `/erp/rastreio?lote=${loteNovo.id}` });
    expect((await owner.get('/api/erp/leitura?codigo=7890000000017')).body).toMatchObject({ tipo: 'produto', destino: '/erp/rastreio?q=CAN' });
    expect((await owner.get('/api/erp/leitura?codigo=qualquer%20coisa')).body.tipo).toBe('localizar');
    expect((await owner.get('/api/erp/leitura?codigo=PV-999999')).body.tipo).toBe('localizar');
  });

  it('documento (recibo / pedido / romaneio) traz o código do pedido, lotes e pagamento', async () => {
    const d = (await owner.get(`/api/erp/vendas/localizar/documento/${vendaLote.id}`)).body;
    expect(d.pedido.codigo).toBe(`PV-${vendaLote.numero}`);
    expect(d.pedido.balcao).toBe(true);
    const it = d.pedido.itens.find((i: any) => i.descricao.includes('Leite'));
    expect(it.lotes.map((l: any) => l.numero)).toEqual([loteNovo.numero]);
    expect(d.pedido.pagamentos).toEqual([{ forma: 'DINHEIRO', valorCents: vendaLote.totalCents }]);
    // v1.56.2: produto antigo com unidade numérica ("30") não pode sair como "1 30" no recibo.
    const pid = (await prisma.erpPedidoItem.findFirst({ where: { pedidoId: vendaLote.id } }))!.produtoId;
    const antes = (await prisma.erpProduto.findUnique({ where: { id: pid } }))!.unidade;
    await prisma.erpProduto.update({ where: { id: pid }, data: { unidade: '30' } });
    const d2 = (await owner.get(`/api/erp/vendas/localizar/documento/${vendaLote.id}`)).body;
    expect(d2.pedido.itens.every((i: any) => i.unidade !== '30')).toBe(true);
    await prisma.erpProduto.update({ where: { id: pid }, data: { unidade: antes } });
    expect((await owner.get('/api/erp/vendas/localizar/documento/naoexiste')).status).toBe(404);
  });

  it('isolamento: outra empresa não acha os pedidos nem o documento', async () => {
    const outro = await registerClient();
    expect((await outro.get(`/api/erp/vendas/localizar?q=PV-${vendaLote.numero}`)).body.pedidos.map((p: any) => p.id)).not.toContain(vendaLote.id);
    expect((await outro.get(`/api/erp/vendas/localizar/documento/${vendaLote.id}`)).status).toBe(404);
    expect((await outro.get(`/api/erp/leitura?codigo=PV-${vendaLote.numero}`)).body.destino).not.toContain(vendaLote.id);
  });
});
