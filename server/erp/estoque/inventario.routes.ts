/**
 * Inventário: abre com a foto do saldo, conta por leitura do QR (lote/SKU) no endereço, envia para aprovação
 * e aplica a diferença (contado − foto) como movimento INVENTARIO. Contagem cega esconde o saldo do sistema do contador.
 */
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../db.js';
import { ah, badRequest, forbidden, notFound } from '../../lib/http.js';
import { orgOf } from '../../auth/session.js';
import { auditar } from '../shared/auditoria.js';
import { entrada, saidaDoSaldo, garantirLote, LOTE_UNICO } from './servico.js';

export const inventarioRouter = Router();

inventarioRouter.get('/', ah(async (req, res) => res.json(await prisma.erpInventario.findMany({ where: { orgId: orgOf(req) }, orderBy: { createdAt: 'desc' }, take: 100 }))));

inventarioRouter.get('/:id', ah(async (req, res) => {
  const orgId = orgOf(req);
  const inv = await prisma.erpInventario.findFirst({ where: { id: req.params.id, orgId }, include: { contagens: true } });
  if (!inv) throw notFound('Inventário');
  const gestor = req.auth?.role === 'OWNER' || req.auth?.role === 'ADMIN';
  const esconder = inv.cego && inv.status === 'CONTANDO' && !gestor;
  const [prods, lotes, ends] = await Promise.all([
    prisma.erpProduto.findMany({ where: { id: { in: [...new Set(inv.contagens.map((c) => c.produtoId))] } }, select: { id: true, sku: true, nome: true, unidade: true } }),
    prisma.erpLote.findMany({ where: { id: { in: [...new Set(inv.contagens.map((c) => c.loteId))] } }, select: { id: true, numero: true } }),
    prisma.erpEnderecoEstoque.findMany({ where: { id: { in: [...new Set(inv.contagens.map((c) => c.enderecoId))] } }, select: { id: true, codigo: true } }),
  ]);
  const P = new Map(prods.map((x) => [x.id, x])); const L = new Map(lotes.map((x) => [x.id, x.numero])); const E = new Map(ends.map((x) => [x.id, x.codigo]));
  res.json({
    ...inv,
    contagens: inv.contagens.map((c) => ({ ...c, sistemaMil: esconder ? null : c.sistemaMil, diferencaMil: esconder || c.contadoMil == null ? null : c.contadoMil - c.sistemaMil, produto: P.get(c.produtoId), lote: L.get(c.loteId) === LOTE_UNICO ? null : L.get(c.loteId), endereco: E.get(c.enderecoId) }))
      .sort((a, b) => (a.endereco ?? '').localeCompare(b.endereco ?? '') || (a.produto?.nome ?? '').localeCompare(b.produto?.nome ?? '')),
  });
}));

inventarioRouter.post('/', ah(async (req, res) => {
  const orgId = orgOf(req);
  const b = z.object({ descricao: z.string().trim().min(2).max(120), depositoId: z.string().nullish(), produtoIds: z.array(z.string()).max(2000).optional(), cego: z.boolean().default(true) }).parse(req.body);
  const ends = await prisma.erpEnderecoEstoque.findMany({ where: { orgId, ...(b.depositoId ? { depositoId: b.depositoId } : {}) }, select: { id: true } });
  const saldos = await prisma.erpSaldo.findMany({ where: { orgId, enderecoId: { in: ends.map((e) => e.id) }, fisicoMil: { gt: 0 }, ...(b.produtoIds?.length ? { produtoId: { in: b.produtoIds } } : {}) } });
  const inv = await prisma.erpInventario.create({ data: { orgId, descricao: b.descricao, depositoId: b.depositoId ?? null, cego: b.cego, criadoPorId: req.auth?.userId ?? null, contagens: { create: saldos.map((s) => ({ produtoId: s.produtoId, loteId: s.loteId, enderecoId: s.enderecoId, sistemaMil: s.fisicoMil })) } } });
  await auditar(req, 'inventario.abrir', 'erp_inventario', inv.id, null, { linhas: saldos.length });
  res.status(201).json(inv);
}));

/** Registra contagem: endereço lido + código (lote ou SKU/EAN) + quantidade. Item achado fora da foto entra como linha nova (sistema 0). */
inventarioRouter.post('/:id/contar', ah(async (req, res) => {
  const orgId = orgOf(req);
  const b = z.object({ endereco: z.string().trim().min(1).max(30), codigo: z.string().trim().min(1).max(60), qtdMil: z.number().int().min(0).max(2_000_000_000), somar: z.boolean().default(false) }).parse(req.body);
  const inv = await prisma.erpInventario.findFirst({ where: { id: req.params.id, orgId } });
  if (!inv) throw notFound('Inventário');
  if (inv.status !== 'CONTANDO') throw badRequest('Contagem encerrada');
  const end = await prisma.erpEnderecoEstoque.findFirst({ where: { orgId, codigo: b.endereco.toUpperCase(), ...(inv.depositoId ? { depositoId: inv.depositoId } : {}) } });
  if (!end) throw badRequest(`Endereço ${b.endereco} não existe${inv.depositoId ? ' neste depósito' : ''}`);
  const cod = b.codigo.toUpperCase();
  const r = await prisma.$transaction(async (tx) => {
    let lote = await tx.erpLote.findFirst({ where: { orgId, numero: cod } });
    if (!lote) {
      const p = await tx.erpProduto.findFirst({ where: { orgId, OR: [{ sku: cod }, { codigoBarras: b.codigo.trim() }] } });
      if (!p) throw badRequest(`Código ${b.codigo} não encontrado (lote, SKU ou código de barras)`);
      if (p.controlaLote) throw badRequest(`${p.sku} controla lote: leia o QR do lote`);
      lote = await garantirLote(tx, orgId, p.id, { origemTipo: 'inventario', origemId: inv.id });
    }
    const chave = { inventarioId_produtoId_loteId_enderecoId: { inventarioId: inv.id, produtoId: lote.produtoId, loteId: lote.id, enderecoId: end.id } };
    const atual = await tx.erpInventarioContagem.findUnique({ where: chave });
    const contado = b.somar && atual?.contadoMil != null ? atual.contadoMil + b.qtdMil : b.qtdMil;
    return tx.erpInventarioContagem.upsert({ where: chave, create: { inventarioId: inv.id, produtoId: lote.produtoId, loteId: lote.id, enderecoId: end.id, sistemaMil: 0, contadoMil: contado, contadoPorId: req.auth?.userId ?? null, contadoEm: new Date() }, update: { contadoMil: contado, contadoPorId: req.auth?.userId ?? null, contadoEm: new Date() } });
  });
  res.json({ id: r.id, contadoMil: r.contadoMil });
}));

inventarioRouter.post('/:id/acao', ah(async (req, res) => {
  const orgId = orgOf(req);
  const { acao } = z.object({ acao: z.enum(['ENVIAR', 'RECONTAR', 'APROVAR', 'CANCELAR']) }).parse(req.body);
  const inv = await prisma.erpInventario.findFirst({ where: { id: req.params.id, orgId }, include: { contagens: true } });
  if (!inv) throw notFound('Inventário');
  const gestor = req.auth?.role === 'OWNER' || req.auth?.role === 'ADMIN';
  if (acao === 'ENVIAR') {
    if (inv.status !== 'CONTANDO') throw badRequest('Inventário não está em contagem');
    // Linha não contada = contada como zero (padrão de inventário geral).
    await prisma.erpInventarioContagem.updateMany({ where: { inventarioId: inv.id, contadoMil: null }, data: { contadoMil: 0, contadoEm: new Date() } });
    await prisma.erpInventario.update({ where: { id: inv.id }, data: { status: 'EM_APROVACAO' } });
  } else if (acao === 'RECONTAR') {
    if (!gestor) throw forbidden();
    if (inv.status !== 'EM_APROVACAO') throw badRequest('Só volta para contagem quando está em aprovação');
    await prisma.erpInventario.update({ where: { id: inv.id }, data: { status: 'CONTANDO' } });
  } else if (acao === 'CANCELAR') {
    if (!gestor) throw forbidden();
    if (inv.status === 'CONCLUIDO') throw badRequest('Inventário já concluído');
    await prisma.erpInventario.update({ where: { id: inv.id }, data: { status: 'CANCELADO' } });
  } else {
    if (!gestor) throw forbidden('Só proprietário ou administrador aprova ajuste de inventário');
    if (inv.status !== 'EM_APROVACAO') throw badRequest('Envie a contagem para aprovação primeiro');
    await prisma.$transaction(async (tx) => {
      for (const c of inv.contagens) {
        const dif = (c.contadoMil ?? 0) - c.sistemaMil;
        if (!dif) continue;
        const motivo = `Inventário: ${inv.descricao}`;
        if (dif > 0) {
          const lote = await tx.erpLote.findUniqueOrThrow({ where: { id: c.loteId } });
          await entrada(tx, { orgId, produtoId: c.produtoId, enderecoId: c.enderecoId, qtdMil: dif, tipo: 'INVENTARIO', docTipo: 'inventario', docId: inv.id, motivo, userId: req.auth?.userId, lote: { numero: lote.numero, validade: lote.validade, status: lote.status } });
        } else {
          const s = await tx.erpSaldo.findUnique({ where: { produtoId_loteId_enderecoId: { produtoId: c.produtoId, loteId: c.loteId, enderecoId: c.enderecoId } } });
          if (!s) continue;
          await saidaDoSaldo(tx, { orgId, saldoId: s.id, qtdMil: Math.min(-dif, s.fisicoMil - s.reservadoMil), tipo: 'INVENTARIO', docTipo: 'inventario', docId: inv.id, motivo, userId: req.auth?.userId }).catch(() => { throw badRequest('Há reservas de pedidos sobre um saldo com falta. Libere ou cancele as reservas e aprove de novo.'); });
        }
      }
      await tx.erpInventario.update({ where: { id: inv.id }, data: { status: 'CONCLUIDO', aprovadoPorId: req.auth?.userId ?? null, concluidoEm: new Date() } });
    });
  }
  await auditar(req, `inventario.${acao.toLowerCase()}`, 'erp_inventario', inv.id, { status: inv.status }, null);
  res.json(await prisma.erpInventario.findUnique({ where: { id: inv.id } }));
}));
