/** Estoque/WMS: depósitos, endereços, saldos, entradas, ajustes, transferências, lotes (quarentena), razão e etiquetas QR. */
import { Router } from 'express';
import { z } from 'zod';
import QRCode from 'qrcode';
import { prisma } from '../../db.js';
import { ah, badRequest, notFound } from '../../lib/http.js';
import { orgOf, requireRole } from '../../auth/session.js';
import { auditar } from '../shared/auditoria.js';
import { entrada, saidaDoSaldo, transferir, mudarStatusLote } from './servico.js';
import { disponivel } from './saldo.js';
import { zpl, textoQr, type DadosEtiqueta } from './etiquetas.js';
import { configDa } from '../produtos/produtos.routes.js';

export const estoqueRouter = Router();
const admins = requireRole('OWNER', 'ADMIN');
const qtd = z.number().int().min(1).max(2_000_000_000);

// ---- Depósitos e endereços ----
estoqueRouter.get('/depositos', ah(async (req, res) => res.json(await prisma.erpDeposito.findMany({ where: { orgId: orgOf(req) }, include: { enderecos: { orderBy: { codigo: 'asc' } } }, orderBy: { nome: 'asc' } }))));
estoqueRouter.post('/depositos', admins, ah(async (req, res) => {
  const b = z.object({ nome: z.string().trim().min(1).max(80), filialId: z.string().nullish(), enderecos: z.array(z.string().trim().min(1).max(30)).max(2000).default(['GERAL']) }).parse(req.body);
  const orgId = orgOf(req);
  const d = await prisma.erpDeposito.create({ data: { orgId, nome: b.nome, filialId: b.filialId ?? null, enderecos: { create: [...new Set(b.enderecos.map((c) => c.toUpperCase()))].map((codigo) => ({ orgId, codigo })) } }, include: { enderecos: true } });
  res.status(201).json(d);
}));
/** Gera endereços em lote: ruas × prateleiras × posições (ex.: A-01-01 … B-05-04). */
estoqueRouter.post('/depositos/:id/enderecos', admins, ah(async (req, res) => {
  const orgId = orgOf(req);
  const dep = await prisma.erpDeposito.findFirst({ where: { id: req.params.id, orgId } });
  if (!dep) throw notFound('Depósito');
  const b = z.object({ codigos: z.array(z.string().trim().min(1).max(30)).max(2000).optional(), ruas: z.string().trim().max(26).optional(), prateleiras: z.number().int().min(1).max(99).optional(), posicoes: z.number().int().min(1).max(99).optional() }).parse(req.body);
  const pad = (n: number) => String(n).padStart(2, '0');
  const gerados = b.ruas && b.prateleiras && b.posicoes ? [...b.ruas.toUpperCase()].flatMap((r) => Array.from({ length: b.prateleiras! }, (_, i) => Array.from({ length: b.posicoes! }, (_, j) => `${r}-${pad(i + 1)}-${pad(j + 1)}`)).flat()) : [];
  const codigos = [...new Set([...(b.codigos ?? []), ...gerados].map((c) => c.toUpperCase()))];
  if (!codigos.length) throw badRequest('Informe os códigos ou ruas/prateleiras/posições');
  if (codigos.length > 2000) throw badRequest('Máximo de 2000 endereços por vez');
  const existentes = new Set((await prisma.erpEnderecoEstoque.findMany({ where: { depositoId: dep.id }, select: { codigo: true } })).map((e) => e.codigo));
  const novos = codigos.filter((c) => !existentes.has(c));
  if (novos.length) await prisma.erpEnderecoEstoque.createMany({ data: novos.map((codigo) => ({ orgId, depositoId: dep.id, codigo })) });
  res.status(201).json({ criados: novos.length });
}));

// ---- Saldos ----
estoqueRouter.get('/saldos', ah(async (req, res) => {
  const orgId = orgOf(req);
  const f = z.object({ produtoId: z.string().optional(), depositoId: z.string().optional(), comSaldo: z.string().optional() }).parse(req.query);
  const ends = await prisma.erpEnderecoEstoque.findMany({ where: { orgId, ...(f.depositoId ? { depositoId: f.depositoId } : {}) }, include: { deposito: { select: { nome: true } } } });
  const eMap = new Map(ends.map((e) => [e.id, e]));
  const saldos = await prisma.erpSaldo.findMany({ where: { orgId, enderecoId: { in: [...eMap.keys()] }, ...(f.produtoId ? { produtoId: f.produtoId } : {}), ...(f.comSaldo === '0' ? {} : { fisicoMil: { gt: 0 } }) }, take: 2000 });
  const [lotes, produtos] = await Promise.all([
    prisma.erpLote.findMany({ where: { id: { in: [...new Set(saldos.map((s) => s.loteId))] } } }),
    prisma.erpProduto.findMany({ where: { id: { in: [...new Set(saldos.map((s) => s.produtoId))] } }, select: { id: true, sku: true, nome: true, unidade: true, regraSaida: true } }),
  ]);
  const lMap = new Map(lotes.map((l) => [l.id, l])); const pMap = new Map(produtos.map((p) => [p.id, p]));
  res.json(saldos.map((s) => ({ ...s, disponivelMil: disponivel(s), lote: lMap.get(s.loteId), produto: pMap.get(s.produtoId), endereco: { codigo: eMap.get(s.enderecoId)?.codigo, deposito: eMap.get(s.enderecoId)?.deposito.nome } }))
    .sort((a, b) => (a.produto?.nome ?? '').localeCompare(b.produto?.nome ?? '') || (a.endereco.codigo ?? '').localeCompare(b.endereco.codigo ?? '')));
}));

// ---- Movimentações ----
const loteSchema = z.object({ numero: z.string().trim().max(40).nullish(), validade: z.coerce.date().nullish(), fabricacao: z.coerce.date().nullish(), status: z.enum(['LIBERADO', 'QUARENTENA']).default('LIBERADO') }).optional();

estoqueRouter.post('/entrada', ah(async (req, res) => {
  const orgId = orgOf(req);
  const b = z.object({ produtoId: z.string(), enderecoId: z.string(), qtdMil: qtd, custoUnitCents: z.number().int().min(0).max(2_000_000_000).optional(), lote: loteSchema, motivo: z.string().trim().max(200).optional(), inicial: z.boolean().default(false) }).parse(req.body);
  const r = await prisma.$transaction((tx) => entrada(tx, { orgId, ...b, tipo: b.inicial ? 'AJUSTE' : 'ENTRADA', docTipo: b.inicial ? 'inicial' : 'ajuste', motivo: b.motivo ?? (b.inicial ? 'Saldo inicial' : 'Entrada manual'), userId: req.auth?.userId }));
  await auditar(req, 'estoque.entrada', 'erp_saldo', r.saldo.id, null, { produtoId: b.produtoId, qtdMil: b.qtdMil, lote: r.lote.numero });
  res.status(201).json(r);
}));

estoqueRouter.post('/ajuste', ah(async (req, res) => {
  const orgId = orgOf(req);
  const b = z.object({ saldoId: z.string(), qtdMil: qtd, motivo: z.string().trim().min(3, 'Informe o motivo').max(200) }).parse(req.body);
  const s = await prisma.$transaction((tx) => saidaDoSaldo(tx, { orgId, saldoId: b.saldoId, qtdMil: b.qtdMil, tipo: 'AJUSTE', docTipo: 'ajuste', motivo: b.motivo, userId: req.auth?.userId }));
  await auditar(req, 'estoque.ajuste_saida', 'erp_saldo', s.id, null, { qtdMil: -b.qtdMil, motivo: b.motivo });
  res.json(s);
}));

estoqueRouter.post('/transferencia', ah(async (req, res) => {
  const orgId = orgOf(req);
  const b = z.object({ saldoId: z.string(), enderecoDestinoId: z.string(), qtdMil: qtd }).parse(req.body);
  const r = await prisma.$transaction((tx) => transferir(tx, { orgId, ...b, docTipo: 'transferencia', userId: req.auth?.userId }));
  await auditar(req, 'estoque.transferencia', 'erp_saldo', b.saldoId, null, { destino: b.enderecoDestinoId, qtdMil: b.qtdMil });
  res.json(r);
}));

estoqueRouter.patch('/lotes/:id', admins, ah(async (req, res) => {
  const { status } = z.object({ status: z.enum(['LIBERADO', 'QUARENTENA', 'BLOQUEADO']) }).parse(req.body);
  const l = await prisma.$transaction((tx) => mudarStatusLote(tx, orgOf(req), req.params.id, status, req.auth?.userId));
  await auditar(req, 'estoque.lote_status', 'erp_lote', l.id, null, { status });
  res.json(l);
}));

estoqueRouter.get('/movimentos', ah(async (req, res) => {
  const orgId = orgOf(req);
  const f = z.object({ produtoId: z.string().optional(), docId: z.string().optional() }).parse(req.query);
  const items = await prisma.erpMovimento.findMany({ where: { orgId, ...(f.produtoId ? { produtoId: f.produtoId } : {}), ...(f.docId ? { docId: f.docId } : {}) }, orderBy: { createdAt: 'desc' }, take: 300 });
  const [lotes, ends, prods] = await Promise.all([
    prisma.erpLote.findMany({ where: { id: { in: [...new Set(items.map((i) => i.loteId))] } }, select: { id: true, numero: true } }),
    prisma.erpEnderecoEstoque.findMany({ where: { id: { in: [...new Set(items.map((i) => i.enderecoId))] } }, select: { id: true, codigo: true } }),
    prisma.erpProduto.findMany({ where: { id: { in: [...new Set(items.map((i) => i.produtoId))] } }, select: { id: true, sku: true, nome: true } }),
  ]);
  const L = new Map(lotes.map((x) => [x.id, x.numero])); const E = new Map(ends.map((x) => [x.id, x.codigo])); const P = new Map(prods.map((x) => [x.id, x]));
  res.json(items.map((i) => ({ ...i, lote: L.get(i.loteId), endereco: E.get(i.enderecoId), produto: P.get(i.produtoId) })));
}));

/** Etiqueta QR (PNG em data URL): endereço de estoque ou lote. O leitor da separação lê o mesmo código. */
estoqueRouter.get('/etiqueta/:tipo/:id', ah(async (req, res) => {
  const orgId = orgOf(req);
  let texto: string; let titulo: string;
  if (req.params.tipo === 'endereco') {
    const e = await prisma.erpEnderecoEstoque.findFirst({ where: { id: req.params.id, orgId } });
    if (!e) throw notFound('Endereço');
    texto = e.codigo; titulo = `Endereço ${e.codigo}`;
  } else if (req.params.tipo === 'lote') {
    const l = await prisma.erpLote.findFirst({ where: { id: req.params.id, orgId } });
    if (!l) throw notFound('Lote');
    const p = await prisma.erpProduto.findUniqueOrThrow({ where: { id: l.produtoId } });
    texto = l.numero === 'UNICO' ? p.sku : l.numero; titulo = `${p.sku} · ${p.nome}${l.numero !== 'UNICO' ? ` · lote ${l.numero}` : ''}${l.validade ? ` · val. ${l.validade.toLocaleDateString('pt-BR')}` : ''}`;
  } else throw badRequest('Tipo de etiqueta inválido');
  res.json({ texto, titulo, png: await QRCode.toDataURL(texto, { margin: 1, width: 240 }) });
}));

// ---- Etiquetas de produto (lote): ZPL para Zebra e dados para impressora comum ----
const dataBR = (d: Date | null) => (d ? d.toISOString().slice(0, 10).split('-').reverse().join('/') : null);
async function dadosEtiquetas(orgId: string, loteIds: string[]) {
  const lotes = await prisma.erpLote.findMany({ where: { orgId, id: { in: loteIds } } });
  const [prods, forns] = await Promise.all([
    prisma.erpProduto.findMany({ where: { id: { in: lotes.map((l) => l.produtoId) } } }),
    prisma.erpParceiro.findMany({ where: { id: { in: lotes.map((l) => l.fornecedorId).filter(Boolean) as string[] } }, select: { id: true, nome: true, fantasia: true } }),
  ]);
  const P = new Map(prods.map((p) => [p.id, p])); const F = new Map(forns.map((f) => [f.id, f.fantasia || f.nome]));
  return loteIds.map((id) => lotes.find((l) => l.id === id)).filter(Boolean).map((l): DadosEtiqueta & { loteId: string } => {
    const p = P.get(l!.produtoId)!; const unico = l!.numero === 'UNICO';
    const lote = unico ? null : l!.numero; const validadeIso = l!.validade ? l!.validade.toISOString().slice(0, 10) : null;
    return { loteId: l!.id, barras: lote ?? (p.codigoBarras || p.sku), qr: textoQr({ lote, loteFornecedor: l!.loteFornecedor, validadeIso, sku: p.sku, nome: p.nome }), sku: p.sku, nome: p.nome, unidade: p.unidade, lote: unico ? null : l!.numero, loteFornecedor: l!.loteFornecedor, validade: dataBR(l!.validade), fabricacao: dataBR(l!.fabricacao), fornecedor: l!.fornecedorId ? F.get(l!.fornecedorId) ?? null : null };
  });
}
const etqSchema = z.object({ itens: z.array(z.object({ loteId: z.string(), copias: z.number().int().min(1).max(999).default(1) })).min(1).max(500) });

/** Dados + QR em PNG para imprimir em impressora comum (folha A4 ou rolo). */
estoqueRouter.post('/etiquetas', ah(async (req, res) => {
  const orgId = orgOf(req);
  const b = etqSchema.parse(req.body);
  const cfg = await configDa(orgId);
  const dados = await dadosEtiquetas(orgId, b.itens.map((i) => i.loteId));
  const out: unknown[] = [];
  for (const d of dados) out.push({ ...d, copias: b.itens.find((i) => i.loteId === d.loteId)?.copias ?? 1, png: await QRCode.toDataURL(d.qr, { margin: 1, width: 200 }) });
  res.json({ larguraMm: cfg.etiquetaLarguraMm, alturaMm: cfg.etiquetaAlturaMm, etiquetas: out });
}));

/** ZPL II para impressora Zebra (enviado pelo Zebra Browser Print no computador do usuário, ou baixado como .zpl). */
estoqueRouter.post('/etiquetas/zpl', ah(async (req, res) => {
  const orgId = orgOf(req);
  const b = etqSchema.parse(req.body);
  const cfg = await configDa(orgId);
  const dados = await dadosEtiquetas(orgId, b.itens.map((i) => i.loteId));
  const texto = dados.map((d) => zpl(d, { larguraMm: cfg.etiquetaLarguraMm, alturaMm: cfg.etiquetaAlturaMm, dpi: cfg.etiquetaDpi, copias: b.itens.find((i) => i.loteId === d.loteId)?.copias })).join('\n');
  res.json({ zpl: texto });
}));

/** Lotes (com fornecedor) para reimpressão de etiquetas e rastreio. */
estoqueRouter.get('/lotes', ah(async (req, res) => {
  const orgId = orgOf(req);
  const q = typeof req.query.q === 'string' ? req.query.q.trim().toUpperCase().slice(0, 40) : '';
  const lotes = await prisma.erpLote.findMany({ where: { orgId, numero: { not: 'UNICO' }, ...(q ? { OR: [{ numero: { contains: q } }, { loteFornecedor: { contains: q } }] } : {}) }, orderBy: { createdAt: 'desc' }, take: 200 });
  const prods = await prisma.erpProduto.findMany({ where: { id: { in: lotes.map((l) => l.produtoId) } }, select: { id: true, sku: true, nome: true } });
  const P = new Map(prods.map((p) => [p.id, p]));
  res.json(lotes.map((l) => ({ ...l, produto: P.get(l.produtoId) })));
}));
