import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { ah, notFound } from '../lib/http.js';
import { orgOf, requireRole } from '../auth/session.js';
import { audit } from '../lib/audit.js';
import { parseJson } from '../lib/json.js';

export const kanbanRouter = Router();

kanbanRouter.get('/', ah(async (req, res) => {
  const q = z.object({ q: z.string().max(100).optional(), sort: z.enum(['name_asc', 'name_desc', 'created_desc', 'created_asc', 'last_desc', 'last_asc']).default('last_desc') }).parse(req.query);
  const orgId = orgOf(req);
  const stages = await prisma.kanbanStage.findMany({ where: { orgId }, orderBy: { position: 'asc' } });
  const orderBy = {
    name_asc: { name: 'asc' }, name_desc: { name: 'desc' }, created_desc: { createdAt: 'desc' }, created_asc: { createdAt: 'asc' }, last_desc: { lastMessageAt: 'desc' }, last_asc: { lastMessageAt: 'asc' },
  }[q.sort] as any;
  const where: any = { orgId };
  if (q.q) where.OR = [{ name: { contains: q.q } }, { phone: { contains: q.q } }];
  const contacts = await prisma.contact.findMany({ where, orderBy, take: 500 });
  const open = await prisma.conversation.findMany({ where: { orgId, status: { not: 'CLOSED' }, contactId: { in: contacts.map((c) => c.id) } }, select: { id: true, contactId: true, unreadCount: true } });
  res.json({
    stages,
    contacts: contacts.map((c) => {
      const conv = open.find((o) => o.contactId === c.id);
      return { id: c.id, name: c.name, phone: c.phone, stageId: c.stageId, tags: parseJson<string[]>(c.tags, []), lastMessageAt: c.lastMessageAt, createdAt: c.createdAt, conversationId: conv?.id ?? null, unread: conv?.unreadCount ?? 0 };
    }),
  });
}));

kanbanRouter.post('/move', ah(async (req, res) => {
  const { contactId, stageId } = z.object({ contactId: z.string(), stageId: z.string().nullable() }).parse(req.body);
  const orgId = orgOf(req);
  const c = await prisma.contact.findFirst({ where: { id: contactId, orgId } });
  if (!c) throw notFound('Contato');
  if (stageId && !(await prisma.kanbanStage.findFirst({ where: { id: stageId, orgId } }))) throw notFound('Etapa');
  await prisma.contact.update({ where: { id: c.id }, data: { stageId } });
  await audit(req, 'kanban.move', { entity: 'contact', entityId: c.id, meta: { from: c.stageId, to: stageId } });
  res.json({ ok: true });
}));

const admins = requireRole('OWNER', 'ADMIN');
const stageSchema = z.object({ name: z.string().trim().min(1).max(40), color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional() });

kanbanRouter.post('/stages', admins, ah(async (req, res) => {
  const body = stageSchema.parse(req.body);
  const orgId = orgOf(req);
  const count = await prisma.kanbanStage.count({ where: { orgId } });
  const st = await prisma.kanbanStage.create({ data: { orgId, name: body.name, color: body.color ?? '#64748b', position: count } });
  await audit(req, 'kanban.stage_create', { entity: 'stage', entityId: st.id });
  res.status(201).json(st);
}));

kanbanRouter.patch('/stages/:id', admins, ah(async (req, res) => {
  const body = stageSchema.partial().extend({ position: z.number().int().min(0).max(100).optional() }).parse(req.body);
  const orgId = orgOf(req);
  const st = await prisma.kanbanStage.findFirst({ where: { id: req.params.id, orgId } });
  if (!st) throw notFound('Etapa');
  const u = await prisma.kanbanStage.update({ where: { id: st.id }, data: body });
  res.json(u);
}));

kanbanRouter.delete('/stages/:id', admins, ah(async (req, res) => {
  const orgId = orgOf(req);
  const st = await prisma.kanbanStage.findFirst({ where: { id: req.params.id, orgId } });
  if (!st) throw notFound('Etapa');
  await prisma.contact.updateMany({ where: { orgId, stageId: st.id }, data: { stageId: null } });
  await prisma.kanbanStage.delete({ where: { id: st.id } });
  await audit(req, 'kanban.stage_delete', { entity: 'stage', entityId: st.id });
  res.json({ ok: true });
}));
