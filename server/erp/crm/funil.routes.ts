/** Funil de vendas (Kanban): etapas configuráveis e oportunidades governadas pela máquina de estados. */
import { Router } from 'express';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { prisma } from '../../db.js';
import { ah, badRequest, notFound } from '../../lib/http.js';
import { orgOf, requireRole } from '../../auth/session.js';
import { transicionar, eventosPermitidos } from '../shared/statemachine.js';
import { emitir, despacharEmBreve } from '../shared/events.js';
import { auditar } from '../shared/auditoria.js';
import { maquinaOportunidade, type EventoOportunidade, type StatusOportunidade } from './oportunidade.machine.js';

export const funilRouter = Router();

export const ETAPAS_PADRAO = [
  { nome: 'Prospecção', cor: '#64748b', probabilidade: 10 },
  { nome: 'Qualificação', cor: '#0ea5e9', probabilidade: 25 },
  { nome: 'Proposta', cor: '#8b5cf6', probabilidade: 50 },
  { nome: 'Negociação', cor: '#f59e0b', probabilidade: 75 },
];

/** Garante as etapas padrão na primeira vez que a empresa abre o funil. */
export async function etapasDa(orgId: string) {
  let etapas = await prisma.erpEtapaFunil.findMany({ where: { orgId }, orderBy: { posicao: 'asc' } });
  if (!etapas.length) {
    await prisma.erpEtapaFunil.createMany({ data: ETAPAS_PADRAO.map((e, i) => ({ orgId, posicao: i, ...e })) });
    etapas = await prisma.erpEtapaFunil.findMany({ where: { orgId }, orderBy: { posicao: 'asc' } });
  }
  return etapas;
}

funilRouter.get('/', ah(async (req, res) => {
  const orgId = orgOf(req);
  const etapas = await etapasDa(orgId);
  const filialId = typeof req.query.filialId === 'string' ? req.query.filialId : undefined;
  const ops = await prisma.erpOportunidade.findMany({
    where: { orgId, status: 'ABERTA', ...(filialId ? { filialId } : {}) },
    include: { parceiro: { select: { id: true, nome: true, fantasia: true } } },
    orderBy: [{ posicao: 'asc' }, { createdAt: 'asc' }], take: 1000,
  });
  res.json({ etapas, oportunidades: ops });
}));

// ---- Etapas (OWNER/ADMIN) ----
const etapaSchema = z.object({ nome: z.string().trim().min(1).max(60), cor: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#64748b'), probabilidade: z.number().int().min(0).max(100).default(10) });
funilRouter.post('/etapas', requireRole('OWNER', 'ADMIN'), ah(async (req, res) => {
  const orgId = orgOf(req);
  const n = await prisma.erpEtapaFunil.count({ where: { orgId } });
  if (n >= 15) throw badRequest('Máximo de 15 etapas');
  res.status(201).json(await prisma.erpEtapaFunil.create({ data: { orgId, posicao: n, ...etapaSchema.parse(req.body) } }));
}));
funilRouter.put('/etapas/:id', requireRole('OWNER', 'ADMIN'), ah(async (req, res) => {
  const r = await prisma.erpEtapaFunil.updateMany({ where: { id: req.params.id, orgId: orgOf(req) }, data: etapaSchema.parse(req.body) });
  if (!r.count) throw notFound('Etapa');
  res.json({ ok: true });
}));
funilRouter.put('/etapas-ordem', requireRole('OWNER', 'ADMIN'), ah(async (req, res) => {
  const { ids } = z.object({ ids: z.array(z.string()).min(1).max(15) }).parse(req.body);
  const orgId = orgOf(req);
  await prisma.$transaction(ids.map((id, i) => prisma.erpEtapaFunil.updateMany({ where: { id, orgId }, data: { posicao: i } })));
  res.json({ ok: true });
}));
funilRouter.delete('/etapas/:id', requireRole('OWNER', 'ADMIN'), ah(async (req, res) => {
  const orgId = orgOf(req);
  if (await prisma.erpOportunidade.count({ where: { orgId, etapaId: req.params.id, status: 'ABERTA' } })) throw badRequest('Mova as oportunidades desta etapa antes de excluí-la');
  await prisma.erpEtapaFunil.deleteMany({ where: { id: req.params.id, orgId } });
  res.json({ ok: true });
}));

// ---- Oportunidades ----
const opSchema = z.object({
  parceiroId: z.string().min(1), titulo: z.string().trim().min(2).max(200), etapaId: z.string().optional(),
  valorCents: z.number().int().min(0).max(2_000_000_000).default(0),
  probabilidade: z.number().int().min(0).max(100).optional(),
  custoAquisicaoCents: z.number().int().min(0).max(2_000_000_000).default(0),
  origem: z.string().trim().max(60).nullish(), responsavelId: z.string().nullish(),
  previsaoFechamento: z.coerce.date().nullish(), filialId: z.string().nullish(), centroCustoId: z.string().nullish(),
});

funilRouter.post('/oportunidades', ah(async (req, res) => {
  const orgId = orgOf(req);
  const b = opSchema.parse(req.body);
  const parceiro = await prisma.erpParceiro.findFirst({ where: { id: b.parceiroId, orgId } });
  if (!parceiro) throw notFound('Cliente');
  const etapas = await etapasDa(orgId);
  const etapa = b.etapaId ? etapas.find((e) => e.id === b.etapaId) : etapas[0];
  if (!etapa) throw badRequest('Etapa inválida');
  const op = await prisma.$transaction(async (tx) => {
    const o = await tx.erpOportunidade.create({
      data: { orgId, ...b, origem: b.origem ?? null, responsavelId: b.responsavelId ?? req.auth?.userId ?? null, previsaoFechamento: b.previsaoFechamento ?? null, filialId: b.filialId ?? null, centroCustoId: b.centroCustoId ?? null, etapaId: etapa.id, probabilidade: b.probabilidade ?? etapa.probabilidade, correlationId: randomUUID() },
    });
    await emitir(tx, { orgId, tipo: 'crm.oportunidade.criada', agregado: 'oportunidade', agregadoId: o.id, correlationId: o.correlationId, payload: { parceiroId: o.parceiroId, titulo: o.titulo, valorCents: o.valorCents } });
    return o;
  });
  despacharEmBreve();
  await auditar(req, 'oportunidade.criar', 'erp_oportunidade', op.id, null, { titulo: op.titulo, valorCents: op.valorCents });
  res.status(201).json(op);
}));

funilRouter.put('/oportunidades/:id', ah(async (req, res) => {
  const orgId = orgOf(req);
  const antes = await prisma.erpOportunidade.findFirst({ where: { id: req.params.id, orgId } });
  if (!antes) throw notFound('Oportunidade');
  const b = opSchema.omit({ parceiroId: true, etapaId: true }).partial().parse(req.body);
  const op = await prisma.erpOportunidade.update({ where: { id: antes.id }, data: b });
  await auditar(req, 'oportunidade.editar', 'erp_oportunidade', op.id, { valorCents: antes.valorCents }, { valorCents: op.valorCents });
  res.json(op);
}));

/** Ações de estado: mover (Kanban), ganhar, perder, reabrir, cancelar. */
const acaoSchema = z.object({
  evento: z.enum(['MOVER', 'GANHAR', 'PERDER', 'CANCELAR', 'REABRIR']),
  etapaId: z.string().optional(), posicao: z.number().int().min(0).optional(), motivoPerda: z.string().trim().max(300).optional(),
});

funilRouter.post('/oportunidades/:id/acao', ah(async (req, res) => {
  const orgId = orgOf(req);
  const a = acaoSchema.parse(req.body);
  const op = await prisma.erpOportunidade.findFirst({ where: { id: req.params.id, orgId }, include: { parceiro: { select: { status: true } } } });
  if (!op) throw notFound('Oportunidade');
  const r = transicionar(maquinaOportunidade, op.status as StatusOportunidade, a.evento as EventoOportunidade, { valorCents: op.valorCents, motivoPerda: a.motivoPerda, parceiroStatus: op.parceiro.status });
  if (!r.ok) throw badRequest(r.erro);
  let etapaId = op.etapaId;
  if (a.evento === 'MOVER' || a.evento === 'REABRIR') {
    const etapas = await etapasDa(orgId);
    const alvo = a.etapaId ? etapas.find((e) => e.id === a.etapaId) : etapas[0];
    if (!alvo) throw badRequest('Etapa inválida');
    etapaId = alvo.id;
  }
  const fechando = r.para === 'GANHA' || r.para === 'PERDIDA';
  const atualizada = await prisma.$transaction(async (tx) => {
    const o = await tx.erpOportunidade.update({
      where: { id: op.id },
      data: {
        status: r.para, etapaId, posicao: a.posicao ?? op.posicao,
        motivoPerda: r.para === 'PERDIDA' ? a.motivoPerda : r.para === 'ABERTA' ? null : op.motivoPerda,
        fechadaEm: fechando ? new Date() : r.para === 'ABERTA' ? null : op.fechadaEm,
        probabilidade: r.para === 'GANHA' ? 100 : r.para === 'PERDIDA' ? 0 : op.probabilidade,
      },
    });
    // MOVER dentro do Kanban é frequente: não polui o outbox com evento quando a etapa não muda.
    for (const tipo of r.emite) {
      if (tipo === 'crm.oportunidade.movida' && etapaId === op.etapaId) continue;
      await emitir(tx, { orgId, tipo, agregado: 'oportunidade', agregadoId: o.id, correlationId: o.correlationId, payload: { parceiroId: o.parceiroId, titulo: o.titulo, valorCents: o.valorCents, de: op.etapaId, para: etapaId, motivoPerda: o.motivoPerda } });
    }
    return o;
  });
  despacharEmBreve();
  if (a.evento !== 'MOVER' || etapaId !== op.etapaId) await auditar(req, `oportunidade.${a.evento.toLowerCase()}`, 'erp_oportunidade', op.id, { status: op.status, etapaId: op.etapaId }, { status: atualizada.status, etapaId });
  res.json({ ...atualizada, acoes: eventosPermitidos(maquinaOportunidade, atualizada.status as StatusOportunidade) });
}));
