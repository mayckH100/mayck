/**
 * Entrada por XML de NF-e: importa, confere (autorizada, duplicada), vincula produto × fornecedor (com fator de conversão)
 * e lança no estoque gerando lote interno amarrado ao lote do fornecedor. Custo de entrada inclui IPI, ST, frete, seguro e outras, menos desconto.
 */
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../db.js';
import { ah, badRequest, notFound } from '../../lib/http.js';
import { orgOf } from '../../auth/session.js';
import { auditar } from '../shared/auditoria.js';
import { emitir, despacharEmBreve } from '../shared/events.js';
import { vincular } from '../shared/trace.js';
import { lerNfe, NfeXmlErro, numeroLoteInterno, repartirLotes, type LoteXml } from './nfe-xml.js';
import { entrada } from './servico.js';
import { configDa } from '../produtos/produtos.routes.js';
import { divergenciasRecebimento, maquinaCompra, type StatusCompra } from '../compras/compra.machine.js';
import { transicionar } from '../shared/statemachine.js';
import { forbidden } from '../../lib/http.js';

export const nfeRouter = Router();
const js = <T>(s: string, d: T): T => { try { return JSON.parse(s) as T; } catch { return d; } };

nfeRouter.get('/', ah(async (req, res) => {
  const orgId = orgOf(req);
  const items = await prisma.erpNfeEntrada.findMany({ where: { orgId, ...(typeof req.query.status === 'string' ? { status: req.query.status } : {}) }, orderBy: { createdAt: 'desc' }, take: 200, select: { id: true, chave: true, numero: true, serie: true, dataEmissao: true, emitenteNome: true, emitenteCnpj: true, valorTotalCents: true, autorizada: true, status: true, createdAt: true, lancadaEm: true } });
  res.json(items);
}));

nfeRouter.get('/:id', ah(async (req, res) => {
  const orgId = orgOf(req);
  const n = await prisma.erpNfeEntrada.findFirst({ where: { id: req.params.id, orgId }, include: { itens: { orderBy: { nItem: 'asc' } } }, omit: { xml: true } });
  if (!n) throw notFound('NF-e');
  const prods = await prisma.erpProduto.findMany({ where: { id: { in: n.itens.map((i) => i.produtoId).filter(Boolean) as string[] } }, select: { id: true, sku: true, nome: true, unidade: true, controlaLote: true, controlaValidade: true } });
  const P = new Map(prods.map((p) => [p.id, p]));
  const lotesIds = n.itens.flatMap((i) => js<string[]>(i.lotesGerados, []));
  const lotes = lotesIds.length ? await prisma.erpLote.findMany({ where: { id: { in: lotesIds } } }) : [];
  const L = new Map(lotes.map((l) => [l.id, l]));
  const cfg = await configDa(orgId);
  const gestor = req.auth?.role === 'OWNER' || req.auth?.role === 'ADMIN';
  const cego = cfg.recebimentoCego && n.status === 'PENDENTE' && !gestor;
  const pedidosAbertos = await prisma.erpPedidoCompra.findMany({ where: { orgId, parceiroId: n.parceiroId, status: { in: ['APROVADO', 'ENVIADO', 'RECEBIDO_PARCIAL'] } }, select: { id: true, numero: true, totalCents: true, status: true, previsaoEntrega: true }, orderBy: { numero: 'desc' } });
  res.json({ ...n, cego, pedidosAbertos, itens: n.itens.map((i) => ({ ...i, qtdMil: cego ? null : i.qtdMil, lotes: js<LoteXml[]>(i.lotes, []).map((l) => (cego ? { ...l, qtdMil: null } : l)), produto: i.produtoId ? P.get(i.produtoId) : null, lotesGerados: js<string[]>(i.lotesGerados, []).map((id) => L.get(id)).filter(Boolean) })) });
}));

nfeRouter.post('/importar', ah(async (req, res) => {
  const orgId = orgOf(req);
  const { xml } = z.object({ xml: z.string().min(100).max(900_000) }).parse(req.body);
  let nfe;
  try { nfe = lerNfe(xml); } catch (e) { if (e instanceof NfeXmlErro) throw badRequest(e.message); throw e; }
  const dup = await prisma.erpNfeEntrada.findUnique({ where: { orgId_chave: { orgId, chave: nfe.chave } } });
  if (dup) throw badRequest(`Esta NF-e já foi importada (nº ${dup.numero}, ${dup.status === 'LANCADA' ? 'já lançada' : 'pendente'})`);
  const doc = nfe.emitente.cnpj.replace(/\D/g, '');
  const criada = await prisma.$transaction(async (tx) => {
    // Fornecedor: usa o cadastro existente (marca como fornecedor) ou cria pelo XML.
    let forn = await tx.erpParceiro.findUnique({ where: { orgId_documento: { orgId, documento: doc } } });
    if (forn && !forn.ehFornecedor) forn = await tx.erpParceiro.update({ where: { id: forn.id }, data: { ehFornecedor: true } });
    if (!forn) forn = await tx.erpParceiro.create({ data: { orgId, documento: doc, tipoPessoa: doc.length === 14 ? 'PJ' : 'PF', nome: nfe.emitente.nome, fantasia: nfe.emitente.fantasia, ehCliente: false, ehFornecedor: true, inscricaoEstadual: nfe.emitente.ie, uf: nfe.emitente.uf, municipio: nfe.emitente.municipio, cep: nfe.emitente.cep, logradouro: nfe.emitente.logradouro, numero: nfe.emitente.numero, bairro: nfe.emitente.bairro, origem: 'NF-e de entrada' } });
    // Vínculo automático: de-para do fornecedor, senão EAN = código de barras do produto.
    const depara = await tx.erpProdutoFornecedor.findMany({ where: { orgId, parceiroId: forn.id, codigoFornecedor: { in: nfe.itens.map((i) => i.codigo) } } });
    const D = new Map(depara.map((d) => [d.codigoFornecedor, d]));
    const eans = nfe.itens.map((i) => i.ean).filter(Boolean) as string[];
    const porEan = eans.length ? await tx.erpProduto.findMany({ where: { orgId, codigoBarras: { in: eans } }, select: { id: true, codigoBarras: true } }) : [];
    const E = new Map(porEan.map((p) => [p.codigoBarras, p.id]));
    return tx.erpNfeEntrada.create({
      data: {
        orgId, chave: nfe.chave, numero: nfe.numero, serie: nfe.serie, dataEmissao: nfe.dataEmissao, parceiroId: forn.id, emitenteCnpj: doc, emitenteNome: nfe.emitente.nome,
        valorTotalCents: nfe.valorTotalCents, autorizada: nfe.autorizada, xml,
        itens: { create: nfe.itens.map((i) => { const d = D.get(i.codigo); return { nItem: i.nItem, codigo: i.codigo, descricao: i.descricao, ean: i.ean, ncm: i.ncm, cfop: i.cfop, unidade: i.unidade, qtdMil: i.qtdMil, valorUnitCents: i.valorUnitCents, custoTotalCents: i.custoTotalCents, lotes: JSON.stringify(i.lotes), produtoId: d?.produtoId ?? (i.ean ? E.get(i.ean) ?? null : null), fatorMil: d?.fatorMil ?? 1000 }; }) },
      },
    });
  });
  await auditar(req, 'nfe_entrada.importar', 'erp_nfe_entrada', criada.id, null, { chave: nfe.chave, numero: nfe.numero });
  res.status(201).json({ id: criada.id, autorizada: nfe.autorizada, avisos: nfe.autorizada ? [] : ['XML sem protocolo de autorização (protNFe 100). Confira a nota na SEFAZ antes de lançar.'] });
}));

/** Vincula o item a um produto interno (e lembra para as próximas notas desse fornecedor). Pode criar o produto pelo item. */
nfeRouter.put('/:id/itens/:itemId', ah(async (req, res) => {
  const orgId = orgOf(req);
  const b = z.object({ produtoId: z.string().optional(), criarProduto: z.object({ sku: z.string().trim().min(1).max(40), precoBaseCents: z.number().int().min(0).default(0), controlaLote: z.boolean().default(false), controlaValidade: z.boolean().default(false) }).optional(), fatorMil: z.number().int().min(1).max(100_000_000).default(1000), lembrar: z.boolean().default(true) }).parse(req.body);
  const n = await prisma.erpNfeEntrada.findFirst({ where: { id: req.params.id, orgId } });
  if (!n) throw notFound('NF-e');
  if (n.status !== 'PENDENTE') throw badRequest('NF-e já lançada');
  const item = await prisma.erpNfeEntradaItem.findFirst({ where: { id: req.params.itemId, nfeId: n.id } });
  if (!item) throw notFound('Item');
  const r = await prisma.$transaction(async (tx) => {
    let produtoId = b.produtoId;
    if (b.criarProduto) {
      const sku = b.criarProduto.sku.toUpperCase();
      if (await tx.erpProduto.findUnique({ where: { orgId_sku: { orgId, sku } } })) throw badRequest(`SKU ${sku} já existe`);
      const fator = b.fatorMil / 1000;
      const p = await tx.erpProduto.create({ data: { orgId, sku, nome: item.descricao.slice(0, 200), codigoBarras: b.fatorMil === 1000 ? item.ean : null, ncm: item.ncm, unidade: b.fatorMil === 1000 ? item.unidade.slice(0, 6) : 'UN', precoBaseCents: b.criarProduto.precoBaseCents, controlaLote: b.criarProduto.controlaLote || b.criarProduto.controlaValidade, controlaValidade: b.criarProduto.controlaValidade, regraSaida: b.criarProduto.controlaValidade ? 'FEFO' : 'FIFO', tipo: 'REVENDA', custoMedioCents: Math.round(item.custoTotalCents / Math.max(0.001, (item.qtdMil / 1000) * fator)) } });
      produtoId = p.id;
    }
    if (!produtoId || !(await tx.erpProduto.findFirst({ where: { id: produtoId, orgId } }))) throw badRequest('Escolha um produto');
    if (b.lembrar) await tx.erpProdutoFornecedor.upsert({ where: { orgId_parceiroId_codigoFornecedor: { orgId, parceiroId: n.parceiroId, codigoFornecedor: item.codigo } }, create: { orgId, parceiroId: n.parceiroId, codigoFornecedor: item.codigo, produtoId, fatorMil: b.fatorMil }, update: { produtoId, fatorMil: b.fatorMil } });
    return tx.erpNfeEntradaItem.update({ where: { id: item.id }, data: { produtoId, fatorMil: b.fatorMil } });
  });
  res.json(r);
}));

/** Vincula a NF-e a um pedido de compra aberto do mesmo fornecedor (para o confronto no lançamento). */
nfeRouter.put('/:id/pedido', ah(async (req, res) => {
  const orgId = orgOf(req);
  const { pedidoCompraId } = z.object({ pedidoCompraId: z.string().nullable() }).parse(req.body);
  const n = await prisma.erpNfeEntrada.findFirst({ where: { id: req.params.id, orgId } });
  if (!n) throw notFound('NF-e');
  if (n.status !== 'PENDENTE') throw badRequest('NF-e já lançada');
  if (pedidoCompraId) {
    const pc = await prisma.erpPedidoCompra.findFirst({ where: { id: pedidoCompraId, orgId } });
    if (!pc || pc.parceiroId !== n.parceiroId) throw badRequest('Pedido de compra não é deste fornecedor');
    if (!['APROVADO', 'ENVIADO', 'RECEBIDO_PARCIAL'].includes(pc.status)) throw badRequest('Pedido de compra não está aberto para recebimento');
  }
  res.json(await prisma.erpNfeEntrada.update({ where: { id: n.id }, data: { pedidoCompraId }, select: { id: true, pedidoCompraId: true } }));
}));

/** Conferência física do recebimento (na unidade do fornecedor). Com recebimento cego, o conferente não vê a quantidade da nota. */
nfeRouter.put('/:id/conferencia', ah(async (req, res) => {
  const orgId = orgOf(req);
  const b = z.object({ itens: z.array(z.object({ itemId: z.string(), qtdMil: z.number().int().min(0).max(2_000_000_000) })).min(1) }).parse(req.body);
  const n = await prisma.erpNfeEntrada.findFirst({ where: { id: req.params.id, orgId }, include: { itens: true } });
  if (!n) throw notFound('NF-e');
  if (n.status !== 'PENDENTE') throw badRequest('NF-e já lançada');
  const ids = new Set(n.itens.map((i) => i.id));
  await prisma.$transaction(b.itens.filter((i) => ids.has(i.itemId)).map((i) => prisma.erpNfeEntradaItem.update({ where: { id: i.itemId }, data: { conferidoMil: i.qtdMil } })));
  const atual = await prisma.erpNfeEntradaItem.findMany({ where: { nfeId: n.id } });
  const div = atual.filter((i) => i.conferidoMil != null && i.conferidoMil !== i.qtdMil).length;
  await auditar(req, 'nfe_entrada.conferir', 'erp_nfe_entrada', n.id, null, { itens: b.itens.length, divergentes: div });
  res.json({ ok: true, conferidos: atual.filter((i) => i.conferidoMil != null).length, total: atual.length, divergentes: div });
}));

/**
 * Lança a NF-e no estoque. Para cada item × lote do rastro:
 *  - produto com lote: gera lote interno (formato configurado) guardando o lote do fornecedor e o fornecedor;
 *    sem rastro no XML, usa os lotes informados na conferência (ou gera só o interno);
 *  - quantidade convertida pelo fator; custo unitário = custo total do item ÷ quantidade convertida.
 */
nfeRouter.post('/:id/lancar', ah(async (req, res) => {
  const orgId = orgOf(req);
  const b = z.object({
    enderecoId: z.string(), quarentena: z.boolean().default(false), usarLoteFornecedor: z.boolean().default(false),
    aceitarDivergencias: z.boolean().default(false),
    lotesManuais: z.record(z.array(z.object({ numero: z.string().trim().max(40), qtdMil: z.number().int().min(1), validade: z.string().nullish(), fabricacao: z.string().nullish() }))).default({}),
  }).parse(req.body);
  const n = await prisma.erpNfeEntrada.findFirst({ where: { id: req.params.id, orgId }, include: { itens: true } });
  if (!n) throw notFound('NF-e');
  if (n.status !== 'PENDENTE') throw badRequest('NF-e já lançada');
  const semVinculo = n.itens.filter((i) => !i.produtoId);
  if (semVinculo.length) throw badRequest(`Vincule os itens ${semVinculo.map((i) => i.nItem).join(', ')} a produtos antes de lançar`);
  const cfg = await configDa(orgId);
  // Confronto: conferência física × nota e nota × pedido de compra (quantidade pendente e preço na tolerância).
  if (cfg.recebimentoCego && n.itens.some((i) => i.conferidoMil == null)) throw badRequest('Recebimento cego: confira todos os itens antes de lançar');
  const divergencias: string[] = n.itens.filter((i) => i.conferidoMil != null && i.conferidoMil !== i.qtdMil).map((i) => `Item ${i.nItem}: conferido ${i.conferidoMil! / 1000}, nota ${i.qtdMil / 1000} ${i.unidade}`);
  const pc = n.pedidoCompraId ? await prisma.erpPedidoCompra.findFirst({ where: { id: n.pedidoCompraId, orgId }, include: { itens: true } }) : null;
  if (pc) {
    const prods = await prisma.erpProduto.findMany({ where: { id: { in: n.itens.map((i) => i.produtoId!) } }, select: { id: true, sku: true } });
    const S = new Map(prods.map((p) => [p.id, p.sku]));
    divergencias.push(...divergenciasRecebimento(n.itens.map((i) => ({ produtoId: i.produtoId!, sku: S.get(i.produtoId!) ?? '', qtdMil: Math.round((i.qtdMil * i.fatorMil) / 1000), custoUnitCents: Math.round((i.valorUnitCents * 1000) / i.fatorMil) })), pc.itens, cfg.toleranciaPrecoBp));
  }
  if (divergencias.length && !b.aceitarDivergencias) throw badRequest('Divergências no recebimento', { divergencias });
  if (divergencias.length && !(req.auth?.role === 'OWNER' || req.auth?.role === 'ADMIN')) throw forbidden('Só proprietário ou administrador aceita divergência de recebimento');
  const gerados: string[] = [];
  await prisma.$transaction(async (tx) => {
    let seq = (await tx.erpConfig.findUniqueOrThrow({ where: { orgId } })).proximoLoteInterno;
    for (const item of n.itens) {
      const p = await tx.erpProduto.findUniqueOrThrow({ where: { id: item.produtoId! } });
      if (p.tipo === 'SERVICO') continue;
      const qtdTotal = Math.round((item.qtdMil * item.fatorMil) / 1000);
      const custoUnit = qtdTotal > 0 ? Math.round((item.custoTotalCents * 1000) / qtdTotal) : 0;
      const rastro = js<LoteXml[]>(item.lotes, []).map((l) => ({ ...l, qtdMil: Math.round((l.qtdMil * item.fatorMil) / 1000) }));
      const manuais = (b.lotesManuais[item.id] ?? []).map((l) => ({ numero: l.numero.toUpperCase(), qtdMil: l.qtdMil, validade: l.validade ?? null, fabricacao: l.fabricacao ?? null }));
      const partes = p.controlaLote ? repartirLotes(qtdTotal, rastro.length ? rastro : manuais) : [{ numero: null, qtdMil: qtdTotal, fabricacao: null, validade: null }];
      const idsItem: string[] = [];
      for (const parte of partes) {
        if (p.controlaValidade && !parte.validade) throw badRequest(`Item ${item.nItem} (${p.sku}): informe a validade do lote`);
        const interno = p.controlaLote ? (b.usarLoteFornecedor && parte.numero ? parte.numero : numeroLoteInterno(cfg.formatoLote, seq++, p.sku)) : null;
        const r = await entrada(tx, {
          orgId, produtoId: p.id, enderecoId: b.enderecoId, qtdMil: parte.qtdMil, custoUnitCents: custoUnit, tipo: 'ENTRADA', docTipo: 'nfe_entrada', docId: n.id,
          motivo: `NF-e ${n.numero}/${n.serie} · ${n.emitenteNome}`, userId: req.auth?.userId,
          lote: { numero: interno, validade: parte.validade ? new Date(`${parte.validade.slice(0, 10)}T12:00:00Z`) : null, fabricacao: parte.fabricacao ? new Date(`${parte.fabricacao.slice(0, 10)}T12:00:00Z`) : null, status: b.quarentena ? 'QUARENTENA' : 'LIBERADO' },
        });
        if (p.controlaLote) {
          await tx.erpLote.update({ where: { id: r.lote.id }, data: { loteFornecedor: parte.numero ?? null, fornecedorId: n.parceiroId, origemTipo: 'nfe_entrada', origemId: n.id } });
          await vincular(tx, orgId, { tipo: 'nfe_entrada', id: n.id }, { tipo: 'lote', id: r.lote.id }, 'originou');
        }
        idsItem.push(r.lote.id);
      }
      gerados.push(...idsItem);
      await tx.erpNfeEntradaItem.update({ where: { id: item.id }, data: { lotesGerados: JSON.stringify([...new Set(idsItem)]) } });
    }
    await tx.erpConfig.update({ where: { orgId }, data: { proximoLoteInterno: seq } });
    if (pc) {
      // baixa o pendente do pedido de compra, por produto, na ordem dos itens
      const recebido = new Map<string, number>();
      for (const i of n.itens) recebido.set(i.produtoId!, (recebido.get(i.produtoId!) ?? 0) + Math.round((i.qtdMil * i.fatorMil) / 1000));
      const somar = new Map<string, number>();
      for (const it of pc.itens) {
        const r = recebido.get(it.produtoId) ?? 0;
        const q = Math.min(r, Math.max(0, it.qtdMil - it.recebidoMil));
        somar.set(it.id, q); recebido.set(it.produtoId, r - q);
      }
      for (const [produtoId, sobra] of recebido) { // excesso aceito fica no último item do produto
        const ult = [...pc.itens].reverse().find((i) => i.produtoId === produtoId);
        if (ult && sobra > 0) somar.set(ult.id, (somar.get(ult.id) ?? 0) + sobra);
      }
      for (const [id, q] of somar) if (q > 0) await tx.erpPedidoCompraItem.update({ where: { id }, data: { recebidoMil: { increment: q } } });
      const itens = await tx.erpPedidoCompraItem.findMany({ where: { pedidoId: pc.id } });
      const ev = itens.every((i) => i.recebidoMil >= i.qtdMil) ? 'RECEBER' : 'RECEBER_PARCIAL';
      const t = transicionar(maquinaCompra, pc.status as StatusCompra, ev, { itens: itens.length, totalCents: pc.totalCents, gestor: true, alcadaCents: 0 });
      if (t.ok) {
        await tx.erpPedidoCompra.update({ where: { id: pc.id }, data: { status: t.para } });
        for (const tipo of t.emite) await emitir(tx, { orgId, tipo, agregado: 'pedido_compra', agregadoId: pc.id, payload: { numero: pc.numero, nfeId: n.id } });
      }
      await vincular(tx, orgId, { tipo: 'pedido_compra', id: pc.id }, { tipo: 'nfe_entrada', id: n.id }, 'recebido_por');
    }
    await tx.erpNfeEntrada.update({ where: { id: n.id }, data: { status: 'LANCADA', lancadaEm: new Date(), lancadaPorId: req.auth?.userId ?? null } });
    await vincular(tx, orgId, { tipo: 'parceiro', id: n.parceiroId }, { tipo: 'nfe_entrada', id: n.id }, 'forneceu');
    await emitir(tx, { orgId, tipo: 'estoque.nfe_entrada.lancada', agregado: 'nfe_entrada', agregadoId: n.id, payload: { numero: n.numero, parceiroId: n.parceiroId, valorTotalCents: n.valorTotalCents, lotes: gerados.length } });
  });
  despacharEmBreve();
  await auditar(req, 'nfe_entrada.lancar', 'erp_nfe_entrada', n.id, null, { lotes: gerados.length });
  res.json({ ok: true, loteIds: [...new Set(gerados)], divergenciasAceitas: divergencias });
}));
