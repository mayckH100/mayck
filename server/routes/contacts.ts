import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { ah, notFound, HttpError } from '../lib/http.js';
import { orgOf, requireRole } from '../auth/session.js';
import { audit } from '../lib/audit.js';
import { parseJson } from '../lib/json.js';

export const contactsRouter = Router();

export function normalizePhone(raw: string): string | null {
  let d = raw.replace(/\D/g, '');
  if (d.length === 10 || d.length === 11) d = '55' + d; // número brasileiro sem DDI
  return d.length >= 10 && d.length <= 15 ? d : null;
}

function view(c: import('@prisma/client').Contact) {
  return { ...c, tags: parseJson<string[]>(c.tags, []), vars: parseJson<Record<string, unknown>>(c.vars, {}) };
}

contactsRouter.get('/', ah(async (req, res) => {
  const q = z.object({ q: z.string().max(100).optional(), tag: z.string().max(50).optional(), stageId: z.string().optional(), page: z.coerce.number().int().min(1).default(1) }).parse(req.query);
  const orgId = orgOf(req);
  const where: any = { orgId };
  if (q.q) where.OR = [{ name: { contains: q.q } }, { phone: { contains: q.q.replace(/[^\d+]/g, '') || q.q } }, { email: { contains: q.q } }];
  if (q.tag) where.tags = { contains: JSON.stringify(q.tag) };
  if (q.stageId) where.stageId = q.stageId === 'none' ? null : q.stageId;
  const [items, total] = await Promise.all([
    prisma.contact.findMany({ where, orderBy: [{ lastMessageAt: 'desc' }, { createdAt: 'desc' }], take: 50, skip: (q.page - 1) * 50 }),
    prisma.contact.count({ where }),
  ]);
  res.json({ items: items.map(view), total, page: q.page, pageSize: 50 });
}));

const contactSchema = z.object({
  name: z.string().trim().max(100).optional().nullable(),
  phone: z.string().trim().min(8).max(30),
  email: z.string().trim().email().max(200).optional().nullable().or(z.literal('')),
  tags: z.array(z.string().trim().min(1).max(40)).max(30).optional(),
  notes: z.string().max(5000).optional().nullable(),
  stageId: z.string().optional().nullable(),
  optOut: z.boolean().optional(),
});

async function checkStage(orgId: string, stageId?: string | null) {
  if (!stageId) return;
  const st = await prisma.kanbanStage.findFirst({ where: { id: stageId, orgId } });
  if (!st) throw new HttpError(400, 'Etapa do Kanban inválida');
}

contactsRouter.post('/', ah(async (req, res) => {
  const body = contactSchema.parse(req.body);
  const orgId = orgOf(req);
  const waId = normalizePhone(body.phone);
  if (!waId) throw new HttpError(400, 'Telefone inválido. Use DDI + DDD + número, ex.: 5511999998888');
  await checkStage(orgId, body.stageId);
  const exists = await prisma.contact.findUnique({ where: { orgId_waId: { orgId, waId } } });
  if (exists) throw new HttpError(409, 'Já existe um contato com este telefone');
  const c = await prisma.contact.create({
    data: { orgId, waId, phone: '+' + waId, name: body.name || null, email: body.email || null, tags: JSON.stringify(body.tags ?? []), notes: body.notes ?? null, stageId: body.stageId ?? null, optOut: body.optOut ?? false },
  });
  await audit(req, 'contact.create', { entity: 'contact', entityId: c.id });
  res.status(201).json(view(c));
}));

contactsRouter.post('/import', requireRole('OWNER', 'ADMIN'), ah(async (req, res) => {
  const { text } = z.object({ text: z.string().max(200000) }).parse(req.body);
  const orgId = orgOf(req);
  let created = 0, updated = 0;
  const errors: string[] = [];
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (const [i, line] of lines.entries()) {
    if (i === 0 && /telefone|phone/i.test(line)) continue; // cabeçalho
    const [phone, name, email] = line.split(/[;,\t]/).map((s) => s?.trim());
    const waId = normalizePhone(phone ?? '');
    if (!waId) { errors.push(`Linha ${i + 1}: telefone inválido`); continue; }
    const ex = await prisma.contact.findUnique({ where: { orgId_waId: { orgId, waId } } });
    if (ex) {
      await prisma.contact.update({ where: { id: ex.id }, data: { name: ex.name ?? (name || null), email: ex.email ?? (email || null) } });
      updated++;
    } else {
      await prisma.contact.create({ data: { orgId, waId, phone: '+' + waId, name: name || null, email: email || null } });
      created++;
    }
  }
  await audit(req, 'contact.import', { meta: { created, updated, errors: errors.length } });
  res.json({ created, updated, errors: errors.slice(0, 50) });
}));

contactsRouter.get('/:id', ah(async (req, res) => {
  const orgId = orgOf(req);
  const c = await prisma.contact.findFirst({ where: { id: req.params.id, orgId } });
  if (!c) throw notFound('Contato');
  const conversations = await prisma.conversation.findMany({ where: { orgId, contactId: c.id }, orderBy: { createdAt: 'desc' }, take: 20 });
  res.json({ ...view(c), conversations });
}));

contactsRouter.patch('/:id', ah(async (req, res) => {
  const body = contactSchema.partial().parse(req.body);
  const orgId = orgOf(req);
  const c = await prisma.contact.findFirst({ where: { id: req.params.id, orgId } });
  if (!c) throw notFound('Contato');
  await checkStage(orgId, body.stageId);
  let waId: string | undefined;
  if (body.phone) {
    const n = normalizePhone(body.phone);
    if (!n) throw new HttpError(400, 'Telefone inválido');
    waId = n;
  }
  const u = await prisma.contact.update({
    where: { id: c.id },
    data: {
      name: body.name === undefined ? undefined : body.name || null,
      email: body.email === undefined ? undefined : body.email || null,
      notes: body.notes === undefined ? undefined : body.notes,
      tags: body.tags ? JSON.stringify(body.tags) : undefined,
      stageId: body.stageId === undefined ? undefined : body.stageId,
      optOut: body.optOut,
      ...(waId ? { waId, phone: '+' + waId } : {}),
    },
  });
  await audit(req, 'contact.update', { entity: 'contact', entityId: c.id, meta: { fields: Object.keys(body) } });
  res.json(view(u));
}));

/** LGPD — exporta todos os dados do titular (contato, conversas, mensagens, execuções). */
contactsRouter.get('/:id/export', requireRole('OWNER', 'ADMIN'), ah(async (req, res) => {
  const orgId = orgOf(req);
  const c = await prisma.contact.findFirst({ where: { id: req.params.id, orgId } });
  if (!c) throw notFound('Contato');
  const conversations = await prisma.conversation.findMany({ where: { orgId, contactId: c.id } });
  const messages = await prisma.message.findMany({ where: { orgId, conversationId: { in: conversations.map((x) => x.id) } }, orderBy: { createdAt: 'asc' } });
  const runs = await prisma.flowRun.findMany({ where: { orgId, contactId: c.id } });
  await audit(req, 'lgpd.export', { entity: 'contact', entityId: c.id });
  res.setHeader('Content-Disposition', `attachment; filename="contato-${c.id}.json"`);
  res.json({ exportedAt: new Date().toISOString(), contact: view(c), conversations, messages, flowRuns: runs });
}));

/** LGPD — apaga definitivamente o contato e tudo que se refere a ele. */
contactsRouter.delete('/:id', requireRole('OWNER', 'ADMIN'), ah(async (req, res) => {
  const orgId = orgOf(req);
  const c = await prisma.contact.findFirst({ where: { id: req.params.id, orgId } });
  if (!c) throw notFound('Contato');
  const convIds = (await prisma.conversation.findMany({ where: { orgId, contactId: c.id }, select: { id: true } })).map((x) => x.id);
  const runIds = (await prisma.flowRun.findMany({ where: { orgId, contactId: c.id }, select: { id: true } })).map((x) => x.id);
  await prisma.$transaction([
    prisma.flowRunStep.deleteMany({ where: { orgId, runId: { in: runIds } } }),
    prisma.flowRun.deleteMany({ where: { orgId, contactId: c.id } }),
    prisma.aiUsage.updateMany({ where: { orgId, conversationId: { in: convIds } }, data: { conversationId: null } }),
    prisma.message.deleteMany({ where: { orgId, conversationId: { in: convIds } } }),
    prisma.conversation.deleteMany({ where: { orgId, contactId: c.id } }),
    prisma.contact.delete({ where: { id: c.id } }),
  ]);
  await audit(req, 'lgpd.delete', { entity: 'contact', entityId: c.id, meta: { conversations: convIds.length } });
  res.json({ ok: true, deletedConversations: convIds.length });
}));
