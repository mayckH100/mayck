/** Painel do CRM: KPIs e funil com filtros de período, filial e centro de custo. */
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../db.js';
import { ah } from '../../lib/http.js';
import { orgOf } from '../../auth/session.js';
import { calcularKpis, funil } from './kpis.js';
import { etapasDa } from './funil.routes.js';

export const kpisRouter = Router();

kpisRouter.get('/', ah(async (req, res) => {
  const orgId = orgOf(req);
  const f = z.object({ de: z.coerce.date().optional(), ate: z.coerce.date().optional(), filialId: z.string().optional(), centroCustoId: z.string().optional() }).parse(req.query);
  const ate = f.ate ?? new Date();
  const de = f.de ?? new Date(ate.getTime() - 90 * 86_400_000);
  const filtroOp = { orgId, createdAt: { gte: de, lte: ate }, ...(f.filialId ? { filialId: f.filialId } : {}), ...(f.centroCustoId ? { centroCustoId: f.centroCustoId } : {}) };
  const [parceiros, ops, abertas, etapas] = await Promise.all([
    prisma.erpParceiro.findMany({ where: { orgId, ...(f.filialId ? { filialId: f.filialId } : {}) }, select: { id: true, status: true, ehCliente: true } }),
    prisma.erpOportunidade.findMany({ where: filtroOp, select: { status: true, valorCents: true, custoAquisicaoCents: true, parceiroId: true, createdAt: true, fechadaEm: true, etapaId: true } }),
    prisma.erpOportunidade.findMany({ where: { orgId, status: 'ABERTA', ...(f.filialId ? { filialId: f.filialId } : {}) }, select: { etapaId: true, status: true, valorCents: true } }),
    etapasDa(orgId),
  ]);
  res.json({ periodo: { de, ate }, kpis: calcularKpis(parceiros, ops), funil: funil(etapas, abertas) });
}));
