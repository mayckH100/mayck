/**
 * Localizar pedido (v1.34.0): um campo só, por leitura (código de barras/QR) ou digitação:
 *  - código do pedido impresso ("PV-123") ou nº do pedido;
 *  - nº da nota (NF-e emitida pelo ERP, nº digitado no faturamento, "BALCAO-12") ou chave de 44 dígitos (código de
 *    barras do DANFE, QR da NFC-e);
 *  - cliente (nome, fantasia, CPF/CNPJ);
 *  - lote (etiqueta GS1/QR, lote interno ou do fornecedor) → pedidos que levaram aquele lote;
 *  - produto (código de barras, código, nome) → pedidos com o produto.
 * Também monta os dados do pedido impresso / romaneio / recibo (com o código "PV-n" para ler depois).
 */
import { Router } from 'express';
import { prisma } from '../../db.js';
import { ah, badRequest, notFound } from '../../lib/http.js';
import { orgOf } from '../../auth/session.js';
import { contem } from '../../lib/busca.js';
import { resolverCodigo } from '../estoque/leitura.js';
import { classificarLeitura, codigoPedido } from '../leitura/codigo.js';
import { ehBalcao, PREFIXO_BALCAO } from './pedidos.routes.js';
import { LOTE_INICIAL, LOTE_SEM_NUMERO } from '../estoque/rastreio-regras.js';

export const localizarRouter = Router();
const MAX = 100;

export interface Achado { id: string; motivos: string[] }

/** Ids dos pedidos encontrados, com o porquê (mostrado na tela: "nº do pedido", "levou o lote L2611-0001"...). */
export async function localizarPedidos(orgId: string, qBruto: string): Promise<{ tipo: string; achados: Achado[] }> {
  const q = (qBruto ?? '').trim().slice(0, 600);
  const achados = new Map<string, Set<string>>();
  const add = (ids: string[], motivo: string) => { for (const id of ids) { if (!achados.has(id)) achados.set(id, new Set()); achados.get(id)!.add(motivo); } };
  if (!q) return { tipo: 'vazio', achados: [] };
  const c = classificarLeitura(q);

  if (c.tipo === 'pedido') {
    add((await prisma.erpPedidoVenda.findMany({ where: { orgId, numero: c.numero }, select: { id: true } })).map((p) => p.id), `código do pedido ${codigoPedido(c.numero)}`);
    return { tipo: 'pedido', achados: lista(achados) };
  }
  if (c.tipo === 'chave_nfe') {
    const nfs = await prisma.erpNfeSaida.findMany({ where: { orgId, chave: c.chave }, select: { pedidoId: true, numero: true, serie: true } });
    for (const n of nfs) if (n.pedidoId) add([n.pedidoId], `chave da NF-e nº ${n.numero}/${n.serie}`);
    add((await prisma.erpPedidoVenda.findMany({ where: { orgId, nfNumero: c.chave }, select: { id: true } })).map((p) => p.id), 'chave da nota informada no faturamento');
    return { tipo: 'chave_nfe', achados: lista(achados) };
  }

  const up = q.toUpperCase();
  const digitos = q.replace(/^(n[º°o.]?\s*|#|pedido\s*|nf-?e?\s*|nota\s*)/i, '').replace(/[.\-/\s]/g, '');
  const numero = /^\d{1,9}$/.test(digitos) ? Number(digitos) : null;

  // Etiqueta / código: lote ou produto (só se o código casar com um cadastro).
  const r = c.tipo === 'etiqueta' || q.length >= 2 ? await resolverCodigo(prisma, orgId, q).catch(() => null) : null;
  if (r?.lote) {
    add(await pedidosDoLote(orgId, [r.lote.id]), `levou o lote ${r.lote.numero === LOTE_SEM_NUMERO ? LOTE_INICIAL : r.lote.numero} (${r.produto.nome})`);
  } else if (r) {
    add(await pedidosDoProduto(orgId, r.produto.id), `tem o produto ${r.produto.sku} · ${r.produto.nome}`);
  }
  if (c.tipo === 'etiqueta') return { tipo: 'etiqueta', achados: lista(achados) };

  if (numero != null) {
    add((await prisma.erpPedidoVenda.findMany({ where: { orgId, numero }, select: { id: true } })).map((p) => p.id), `nº do pedido ${numero}`);
    const nfs = await prisma.erpNfeSaida.findMany({ where: { orgId, numero }, select: { pedidoId: true, numero: true, serie: true } });
    for (const n of nfs) if (n.pedidoId) add([n.pedidoId], `NF-e nº ${n.numero}/${n.serie}`);
  }
  const nfTxt = [...new Set([q, up, digitos].filter(Boolean))];
  add((await prisma.erpPedidoVenda.findMany({ where: { orgId, nfNumero: { in: [...nfTxt, ...(numero != null ? [`${PREFIXO_BALCAO}${numero}`] : [])] } }, select: { id: true, nfNumero: true } }))
    .filter((p) => !p.nfNumero?.startsWith(PREFIXO_BALCAO) || up.startsWith(PREFIXO_BALCAO) || numero != null).map((p) => p.id), `nota ${q}`);

  if (q.length >= 2) {
    // Cliente: nome, fantasia ou documento (só dígitos).
    const doc = q.replace(/\D/g, '');
    const parceiros = await prisma.erpParceiro.findMany({ where: { orgId, OR: [{ nome: contem(q) }, { fantasia: contem(q) }, ...(doc.length >= 5 ? [{ documento: { contains: doc } }] : [])] }, select: { id: true, nome: true, fantasia: true }, take: 30 });
    for (const pa of parceiros) add((await prisma.erpPedidoVenda.findMany({ where: { orgId, parceiroId: pa.id }, select: { id: true }, orderBy: { numero: 'desc' }, take: MAX })).map((p) => p.id), `cliente ${pa.fantasia || pa.nome}`);
    // Lote digitado (parte do número interno ou do fornecedor).
    if (!r?.lote && /[A-Z0-9]/i.test(q) && q.length >= 3) {
      const lotes = await prisma.erpLote.findMany({ where: { orgId, OR: [{ numero: contem(up) }, { loteFornecedor: contem(up) }] }, select: { id: true, numero: true }, take: 30 });
      for (const l of lotes) add(await pedidosDoLote(orgId, [l.id]), `levou o lote ${l.numero}`);
    }
    // Produto por nome (quando não veio código exato).
    if (!r && numero == null) {
      const prods = await prisma.erpProduto.findMany({ where: { orgId, OR: [{ nome: contem(q) }, { sku: contem(up) }] }, select: { id: true, sku: true, nome: true }, take: 10 });
      for (const p of prods) add(await pedidosDoProduto(orgId, p.id), `tem o produto ${p.sku} · ${p.nome}`);
    }
  }
  return { tipo: 'texto', achados: lista(achados) };
}

const lista = (m: Map<string, Set<string>>): Achado[] => [...m.entries()].map(([id, s]) => ({ id, motivos: [...s] }));

/** Pedidos que levaram (saída/devolução) ou têm reservado o lote. */
async function pedidosDoLote(orgId: string, loteIds: string[]): Promise<string[]> {
  const [movs, res] = await Promise.all([
    prisma.erpMovimento.findMany({ where: { orgId, loteId: { in: loteIds }, docTipo: { in: ['pedido_venda', 'devolucao'] }, docId: { not: null } }, select: { docId: true }, take: 2000 }),
    prisma.erpReserva.findMany({ where: { orgId, loteId: { in: loteIds }, status: { in: ['ATIVA', 'BAIXADA'] } }, select: { pedidoItemId: true }, take: 2000 }),
  ]);
  const itens = res.length ? await prisma.erpPedidoItem.findMany({ where: { id: { in: res.map((x) => x.pedidoItemId) } }, select: { pedidoId: true } }) : [];
  return [...new Set([...movs.map((m) => m.docId!), ...itens.map((i) => i.pedidoId)])];
}
async function pedidosDoProduto(orgId: string, produtoId: string): Promise<string[]> {
  const itens = await prisma.erpPedidoItem.findMany({ where: { produtoId, pedido: { orgId } }, select: { pedidoId: true }, orderBy: { pedido: { numero: 'desc' } }, take: MAX });
  return [...new Set(itens.map((i) => i.pedidoId))];
}

localizarRouter.get('/', ah(async (req, res) => {
  const orgId = orgOf(req);
  const q = typeof req.query.q === 'string' ? req.query.q : '';
  if (!q.trim()) throw badRequest('Leia um código ou digite o que procura');
  const { tipo, achados } = await localizarPedidos(orgId, q);
  const ids = achados.map((a) => a.id);
  const pedidos = ids.length ? await prisma.erpPedidoVenda.findMany({ where: { orgId, id: { in: ids } }, orderBy: { numero: 'desc' }, take: MAX }) : [];
  const [parceiros, nfes] = await Promise.all([
    prisma.erpParceiro.findMany({ where: { id: { in: [...new Set(pedidos.map((p) => p.parceiroId))] } }, select: { id: true, nome: true, fantasia: true, documento: true } }),
    prisma.erpNfeSaida.findMany({ where: { orgId, pedidoId: { in: pedidos.map((p) => p.id) }, status: { not: 'CANCELADA' } }, select: { pedidoId: true, numero: true, serie: true, status: true } }),
  ]);
  const P = new Map(parceiros.map((p) => [p.id, p])); const N = new Map(nfes.map((n) => [n.pedidoId, n]));
  const M = new Map(achados.map((a) => [a.id, a.motivos]));
  res.json({
    tipo, total: pedidos.length,
    pedidos: pedidos.map((p) => {
      const cli = P.get(p.parceiroId); const nf = N.get(p.id);
      return { id: p.id, numero: p.numero, codigo: codigoPedido(p.numero), status: p.statusOperacional, totalCents: p.totalCents, createdAt: p.createdAt, balcao: ehBalcao(p), cliente: cli ? cli.fantasia || cli.nome : '—', nf: nf ? `NF-e ${nf.numero}/${nf.serie}` : p.nfNumero && !ehBalcao(p) ? `NF ${p.nfNumero}` : null, motivos: M.get(p.id) ?? [] };
    }),
  });
}));

/** Dados do pedido impresso, romaneio de separação/entrega e recibo do balcão (todos com o código PV-n para ler depois). */
localizarRouter.get('/documento/:id', ah(async (req, res) => {
  const orgId = orgOf(req);
  const p = await prisma.erpPedidoVenda.findFirst({ where: { id: req.params.id, orgId }, include: { itens: { orderBy: { posicao: 'asc' } } } });
  if (!p) throw notFound('Pedido');
  const [org, fiscal, cli, reservas, movs, titulos, vendedor, nfe, cfgVendas] = await Promise.all([
    prisma.organization.findUnique({ where: { id: orgId }, select: { name: true } }),
    prisma.erpConfigFiscal.findUnique({ where: { orgId }, select: { razaoSocial: true, fantasia: true, cnpj: true } }),
    prisma.erpParceiro.findUnique({ where: { id: p.parceiroId }, select: { nome: true, fantasia: true, documento: true } }),
    prisma.erpReserva.findMany({ where: { orgId, pedidoItemId: { in: p.itens.map((i) => i.id) }, status: { in: ['ATIVA', 'BAIXADA'] } } }),
    prisma.erpMovimento.findMany({ where: { orgId, docTipo: 'pedido_venda', docId: p.id, tipo: 'SAIDA' }, select: { loteId: true, produtoId: true, qtdMil: true } }),
    prisma.erpTitulo.findMany({ where: { orgId, docTipo: 'pedido_venda', docId: p.id }, select: { id: true } }),
    p.vendedorId ? prisma.user.findUnique({ where: { id: p.vendedorId }, select: { name: true } }) : null,
    prisma.erpNfeSaida.findFirst({ where: { orgId, pedidoId: p.id, status: { not: 'CANCELADA' } }, select: { numero: true, serie: true, chave: true, status: true } }),
    p.statusOperacional === 'RASCUNHO' && !p.validadeOrcamento ? prisma.erpConfig.findUnique({ where: { orgId }, select: { validadeOrcamentoDias: true } }) : null,
  ]);
  // v1.54.0: rascunho imprime como "Orçamento nº X" com "Válido até" (gravado na criação = createdAt + validadeOrcamentoDias).
  const orcamento = p.statusOperacional === 'RASCUNHO';
  const validoAte = orcamento ? (p.validadeOrcamento ?? new Date(p.createdAt.getTime() + (cfgVendas?.validadeOrcamentoDias ?? 15) * 86_400_000)) : null;
  const [lotes, ends, baixas, produtos] = await Promise.all([
    prisma.erpLote.findMany({ where: { id: { in: [...reservas.map((r) => r.loteId), ...movs.map((m) => m.loteId)] } }, select: { id: true, numero: true, validade: true, loteFornecedor: true } }),
    prisma.erpEnderecoEstoque.findMany({ where: { id: { in: reservas.map((r) => r.enderecoId) } }, select: { id: true, codigo: true } }),
    titulos.length ? prisma.erpBaixa.findMany({ where: { tituloId: { in: titulos.map((t) => t.id) }, estornada: false }, select: { forma: true, valorCents: true } }) : [],
    prisma.erpProduto.findMany({ where: { id: { in: p.itens.map((i) => i.produtoId) } }, select: { id: true, unidade: true, sku: true, codigoBarras: true } }),
  ]);
  const L = new Map(lotes.map((l) => [l.id, l])); const E = new Map(ends.map((e) => [e.id, e.codigo])); const PR = new Map(produtos.map((x) => [x.id, x]));
  const loteNum = (id: string) => { const n = L.get(id)?.numero; return n === LOTE_SEM_NUMERO ? LOTE_INICIAL : n ?? '—'; };
  const pagamentos = new Map<string, number>();
  for (const b of baixas) pagamentos.set(b.forma, (pagamentos.get(b.forma) ?? 0) + b.valorCents);
  res.json({
    empresa: { nome: fiscal?.fantasia || fiscal?.razaoSocial || org?.name || '', cnpj: fiscal?.cnpj || null },
    pedido: {
      id: p.id, numero: p.numero, codigo: codigoPedido(p.numero), status: p.statusOperacional, createdAt: p.createdAt, balcao: ehBalcao(p), orcamento, validoAte,
      nf: nfe ? { numero: nfe.numero, serie: nfe.serie, chave: nfe.chave, status: nfe.status } : null, nfNumero: ehBalcao(p) ? null : p.nfNumero,
      observacoes: p.observacoes, transportadora: p.transportadora, rastreio: p.rastreio, vendedor: vendedor?.name ?? null,
      cliente: { nome: cli ? cli.fantasia || cli.nome : '—', documento: cli?.documento && cli.documento !== '00000000000' ? cli.documento : null },
      subtotalCents: p.subtotalCents, descontoCents: p.descontoCents, freteCents: p.freteCents, totalCents: p.totalCents,
      pagamentos: [...pagamentos.entries()].map(([forma, valorCents]) => ({ forma, valorCents })),
      itens: p.itens.map((i) => {
        const res = reservas.filter((r) => r.pedidoItemId === i.id);
        return {
          descricao: i.descricao, qtdMil: i.qtdMil, unidade: PR.get(i.produtoId)?.unidade ?? 'UN', codigoBarras: PR.get(i.produtoId)?.codigoBarras ?? null, precoUnitCents: i.precoUnitCents, descontoBp: i.descontoBp, totalCents: i.totalCents,
          lotes: res.map((r) => ({ numero: loteNum(r.loteId), validade: L.get(r.loteId)?.validade ?? null, endereco: E.get(r.enderecoId) ?? null, qtdMil: r.qtdMil, separadoMil: r.separadoMil })),
        };
      }),
    },
  });
}));
