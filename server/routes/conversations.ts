import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { ah, notFound, HttpError } from '../lib/http.js';
import { orgOf } from '../auth/session.js';
import { audit } from '../lib/audit.js';
import { sendOutbound, isWithinWindow, resolveChannel, windowApplies } from '../whatsapp/messaging.js';
import { parseJson } from '../lib/json.js';
import { clearWaiting, WAITING_LABEL } from '../lib/waiting.js';

export const conversationsRouter = Router();

conversationsRouter.get('/', ah(async (req, res) => {
  const q = z.object({ status: z.enum(['open', 'pending', 'closed', 'all']).default('open'), q: z.string().max(100).optional(), mine: z.coerce.boolean().optional() }).parse(req.query);
  const orgId = orgOf(req);
  const where: any = { orgId };
  if (q.status === 'open') where.status = 'OPEN';
  if (q.status === 'pending') where.status = 'PENDING';
  if (q.status === 'closed') where.status = 'CLOSED';
  if (q.mine) where.assignedUserId = req.auth!.userId;
  if (q.q) {
    const ids = await prisma.contact.findMany({ where: { orgId, OR: [{ name: { contains: q.q } }, { phone: { contains: q.q } }] }, select: { id: true } });
    where.contactId = { in: ids.map((i) => i.id) };
  }
  const convs = await prisma.conversation.findMany({ where, orderBy: { lastMessageAt: 'desc' }, take: 100 });
  const contacts = await prisma.contact.findMany({ where: { orgId, id: { in: convs.map((c) => c.contactId) } } });
  const lastMsgs = await Promise.all(convs.map((c) => prisma.message.findFirst({ where: { orgId, conversationId: c.id, direction: { in: ['IN', 'OUT'] } }, orderBy: { createdAt: 'desc' } })));
  const qrIds = new Set((await prisma.channel.findMany({ where: { orgId, provider: 'whatsapp_qr' }, select: { id: true } })).map((c) => c.id));
  const counts = await prisma.conversation.groupBy({ by: ['status'], where: { orgId }, _count: { _all: true } });
  res.json({
    counts: Object.fromEntries(counts.map((c) => [c.status, c._count._all])),
    items: convs.map((c, i) => {
      const ct = contacts.find((x) => x.id === c.contactId);
      return { ...c, waitingLabel: c.waitingSince ? WAITING_LABEL : null, contact: ct ? { id: ct.id, name: ct.name, phone: ct.phone, stageId: ct.stageId, tags: parseJson<string[]>(ct.tags, []) } : null, lastMessage: lastMsgs[i] ? { body: lastMsgs[i]!.body, direction: lastMsgs[i]!.direction, createdAt: lastMsgs[i]!.createdAt } : null, withinWindow: (c.channelId && qrIds.has(c.channelId)) || isWithinWindow(c) };
    }),
  });
}));

// Conversas "Aguardando atendente" (transferidas pela IA/fluxo, sem resposta do atendente) — aviso no app web.
conversationsRouter.get('/waiting', ah(async (req, res) => {
  const orgId = orgOf(req);
  const convs = await prisma.conversation.findMany({ where: { orgId, waitingSince: { not: null }, status: { not: 'CLOSED' } }, orderBy: { waitingSince: 'asc' }, take: 50 });
  const contacts = await prisma.contact.findMany({ where: { orgId, id: { in: convs.map((c) => c.contactId) } }, select: { id: true, name: true, phone: true } });
  const now = Date.now();
  res.json({
    label: WAITING_LABEL,
    items: convs.map((c) => {
      const ct = contacts.find((x) => x.id === c.contactId);
      return { id: c.id, waitingSince: c.waitingSince, waitingMinutes: Math.floor((now - c.waitingSince!.getTime()) / 60_000), label: WAITING_LABEL, contact: ct ? { id: ct.id, name: ct.name, phone: ct.phone } : null };
    }),
  });
}));

async function getConv(req: import('express').Request) {
  const c = await prisma.conversation.findFirst({ where: { id: req.params.id, orgId: orgOf(req) } });
  if (!c) throw notFound('Conversa');
  return c;
}

conversationsRouter.get('/:id', ah(async (req, res) => {
  const conv = await getConv(req);
  const contact = await prisma.contact.findFirst({ where: { id: conv.contactId, orgId: conv.orgId } });
  const messages = await prisma.message.findMany({ where: { orgId: conv.orgId, conversationId: conv.id }, orderBy: { createdAt: 'asc' }, take: 500 });
  const authors = await prisma.user.findMany({ where: { id: { in: messages.map((m) => m.authorUserId).filter(Boolean) as string[] } }, select: { id: true, name: true } });
  const activeRun = await prisma.flowRun.findFirst({ where: { conversationId: conv.id, status: { in: ['RUNNING', 'WAITING'] } } });
  if (conv.unreadCount) await prisma.conversation.update({ where: { id: conv.id }, data: { unreadCount: 0 } });
  res.json({
    conversation: { ...conv, unreadCount: 0, withinWindow: !windowApplies(await resolveChannel(conv)) || isWithinWindow(conv) },
    contact: contact ? { ...contact, tags: parseJson<string[]>(contact.tags, []), vars: parseJson(contact.vars, {}) } : null,
    messages: messages.map((m) => ({ ...m, authorName: authors.find((a) => a.id === m.authorUserId)?.name })),
    activeRun,
  });
}));

conversationsRouter.post('/:id/messages', ah(async (req, res) => {
  const body = z.discriminatedUnion('type', [
    z.object({ type: z.literal('text'), text: z.string().trim().min(1).max(4096) }),
    z.object({ type: z.literal('template'), name: z.string().trim().regex(/^[a-z0-9_]+$/, 'Nome de modelo inválido'), language: z.string().trim().min(2).max(10) }),
    z.object({ type: z.enum(['image', 'document', 'video', 'audio']), link: z.string().url(), caption: z.string().max(1000).optional() }),
  ]).parse(req.body);
  const conv = await getConv(req);
  if (conv.status === 'CLOSED') throw new HttpError(400, 'Reabra a conversa para enviar mensagens');
  const contact = await prisma.contact.findFirstOrThrow({ where: { id: conv.contactId, orgId: conv.orgId } });
  // Atendente assumindo: a automação para nesta conversa.
  if (conv.mode !== 'HUMAN') {
    await prisma.conversation.update({ where: { id: conv.id }, data: { mode: 'HUMAN', assignedUserId: conv.assignedUserId ?? req.auth!.userId } });
    await prisma.flowRun.updateMany({ where: { conversationId: conv.id, status: { in: ['RUNNING', 'WAITING'] } }, data: { status: 'CANCELLED', finishedAt: new Date() } });
  }
  const payload = body.type === 'text' ? { type: 'text' as const, text: body.text } : body;
  const msg = await sendOutbound({ conversation: conv, contact, payload, sender: 'agent', authorUserId: req.auth!.userId });
  // Atendente respondeu: sai de "Aguardando atendente".
  if (msg.status !== 'FAILED') await clearWaiting(conv);
  await audit(req, 'inbox.send', { entity: 'message', entityId: msg.id, meta: { status: msg.status } });
  res.status(msg.status === 'FAILED' ? 502 : 201).json(msg);
}));

conversationsRouter.post('/:id/action', ah(async (req, res) => {
  const { action, userId } = z.object({ action: z.enum(['close', 'reopen', 'assign', 'to_bot', 'take']), userId: z.string().optional() }).parse(req.body);
  const conv = await getConv(req);
  let data: any = {};
  if (action === 'close') data = { status: 'CLOSED', closedAt: new Date(), waitingSince: null };
  if (action === 'reopen') data = { status: 'OPEN', closedAt: null };
  if (action === 'take') data = { mode: 'HUMAN', status: 'OPEN', assignedUserId: req.auth!.userId };
  if (action === 'to_bot') data = { mode: 'BOT', status: 'OPEN', assignedUserId: null, waitingSince: null };
  if (action === 'assign') {
    if (!userId) throw new HttpError(400, 'Informe o atendente');
    const m = await prisma.membership.findUnique({ where: { userId_orgId: { userId, orgId: conv.orgId } } });
    if (!m) throw notFound('Atendente');
    data = { assignedUserId: userId, mode: 'HUMAN' };
  }
  if (action === 'close' || action === 'take') {
    await prisma.flowRun.updateMany({ where: { conversationId: conv.id, status: { in: ['RUNNING', 'WAITING'] } }, data: { status: 'CANCELLED', finishedAt: new Date() } });
  }
  const u = await prisma.conversation.update({ where: { id: conv.id }, data });
  await audit(req, `inbox.${action}`, { entity: 'conversation', entityId: conv.id });
  res.json(u);
}));

conversationsRouter.post('/:id/notes', ah(async (req, res) => {
  const { text } = z.object({ text: z.string().trim().min(1).max(2000) }).parse(req.body);
  const conv = await getConv(req);
  const m = await prisma.message.create({ data: { orgId: conv.orgId, conversationId: conv.id, direction: 'INTERNAL', sender: 'agent', type: 'note', body: text, status: 'NOTE', authorUserId: req.auth!.userId } });
  res.status(201).json(m);
}));
