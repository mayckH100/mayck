/** Cadastros base do ERP (filiais, centros de custo) e administração da plataforma (eventos, fila morta, rastreio). */
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../db.js';
import { ah, notFound } from '../../lib/http.js';
import { orgOf, requireRole } from '../../auth/session.js';
import { reprocessar } from '../shared/events.js';
import { grafo } from '../shared/trace.js';

export const coreRouter = Router();
const admins = requireRole('OWNER', 'ADMIN');

coreRouter.get('/filiais', ah(async (req, res) => res.json(await prisma.erpFilial.findMany({ where: { orgId: orgOf(req) }, orderBy: { nome: 'asc' } }))));
const filialSchema = z.object({ nome: z.string().trim().min(1).max(120), cnpj: z.string().trim().max(18).nullish(), uf: z.string().trim().length(2).toUpperCase().nullish(), ativa: z.boolean().default(true) });
coreRouter.post('/filiais', admins, ah(async (req, res) => res.status(201).json(await prisma.erpFilial.create({ data: { orgId: orgOf(req), ...filialSchema.parse(req.body) } }))));
coreRouter.put('/filiais/:id', admins, ah(async (req, res) => {
  const r = await prisma.erpFilial.updateMany({ where: { id: req.params.id, orgId: orgOf(req) }, data: filialSchema.parse(req.body) });
  if (!r.count) throw notFound('Filial');
  res.json({ ok: true });
}));

coreRouter.get('/centros-custo', ah(async (req, res) => res.json(await prisma.erpCentroCusto.findMany({ where: { orgId: orgOf(req) }, orderBy: { codigo: 'asc' } }))));
const ccSchema = z.object({ codigo: z.string().trim().min(1).max(20), nome: z.string().trim().min(1).max(120), ativo: z.boolean().default(true) });
coreRouter.post('/centros-custo', admins, ah(async (req, res) => res.status(201).json(await prisma.erpCentroCusto.create({ data: { orgId: orgOf(req), ...ccSchema.parse(req.body) } }))));
coreRouter.put('/centros-custo/:id', admins, ah(async (req, res) => {
  const r = await prisma.erpCentroCusto.updateMany({ where: { id: req.params.id, orgId: orgOf(req) }, data: ccSchema.parse(req.body) });
  if (!r.count) throw notFound('Centro de custo');
  res.json({ ok: true });
}));

/** Monitor de eventos: pendentes, falhos (fila morta) e últimos processados. */
coreRouter.get('/eventos', admins, ah(async (req, res) => {
  const orgId = orgOf(req);
  const status = typeof req.query.status === 'string' ? req.query.status : undefined;
  const [items, contagem] = await Promise.all([
    prisma.erpEvento.findMany({ where: { orgId, ...(status ? { status } : {}) }, orderBy: { createdAt: 'desc' }, take: 100 }),
    prisma.erpEvento.groupBy({ by: ['status'], where: { orgId }, _count: { _all: true } }),
  ]);
  res.json({ items, contagem: Object.fromEntries(contagem.map((c) => [c.status, c._count._all])) });
}));
coreRouter.post('/eventos/:id/reprocessar', admins, ah(async (req, res) => {
  const r = await reprocessar(orgOf(req), req.params.id);
  if (!r.count) throw notFound('Evento na fila de falhas');
  res.json({ ok: true });
}));

/** Rastreabilidade: grafo de documentos ligados a partir de qualquer documento. */
coreRouter.get('/rastreio/:tipo/:id', ah(async (req, res) => res.json(await grafo(orgOf(req), { tipo: req.params.tipo, id: req.params.id }))));
