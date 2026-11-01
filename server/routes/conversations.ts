import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { ah, notFound, HttpError } from '../lib/http.js';
import { orgOf } from '../auth/session.js';
import { audit } from '../lib/audit.js';
import { sendOutbound, isWithinWindow, resolveChannel, windowApplies } from '../whatsapp/messaging.js';
import { parseJson } from '../lib/json.js';
import { clearWaiting, WAITING_LABEL } from '../lib/waiting.js';
import { listContactAiNotes, AI_NOTE_MAX_LEN } from '../ai/contactNotes.js';
import { createContactAiNote } from './contacts.js';
import { isProductActive } from '../billing/service.js';
import { channelLabels, type ChannelLabelInfo } from '../whatsapp/channelLabel.js';

/** Rótulo do WhatsApp da conversa para a tela ("WhatsApp 2 · Amanda" + número). */
const channelOf = (labels: Map<string, ChannelLabelInfo>, id: string | null) => {
  const i = id ? labels.get(id) : undefined;
  return i ? { id: i.id, label: i.label, phone: i.phone, via: i.via } : null;
};

export const conversationsRouter = Router();

conversationsRouter.get('/', ah(async (req, res) => {
  const q = z.object({ status: z.enum(['open', 'pending', 'closed', 'all']).default('open'), q: z.string().max(100).optional(), mine: z.coerce.boolean().optional(), channelId: z.string().max(40).optional() }).parse(req.query);
  const orgId = orgOf(req);
  const where: any = { orgId };
  if (q.status === 'open') where.status = 'OPEN';
  if (q.status === 'pending') where.status = 'PENDING';
  if (q.status === 'closed') where.status = 'CLOSED';
  if (q.mine) where.assignedUserId = req.auth!.userId;
  // Filtro por WhatsApp (só canais da própria organização entram no where — orgId já restringe).
  if (q.channelId) where.channelId = q.channelId;
  if (q.q) {
    const ids = await prisma.contact.findMany({ where: { orgId, OR: [{ name: { contains: q.q } }, { phone: { contains: q.q } }] }, select: { id: true } });
    where.contactId = { in: ids.map((i) => i.id) };
  }
  const convs = await prisma.conversation.findMany({ where, orderBy: { lastMessageAt: 'desc' }, take: 100 });
  const contacts = await prisma.contact.findMany({ where: { orgId, id: { in: convs.map((c) => c.contactId) } } });
  const lastMsgs = await Promise.all(convs.map((c) => prisma.message.findFirst({ where: { orgId, conversationId: c.id, direction: { in: ['IN', 'OUT'] } }, orderBy: { createdAt: 'desc' } })));
  const qrIds = new Set((await prisma.channel.findMany({ where: { orgId, provider: 'whatsapp_qr' }, select: { id: true } })).map((c) => c.id));
  const counts = await prisma.conversation.groupBy({ by: ['status'], where: { orgId }, _count: { _all: true } });
  const labels = await channelLabels(orgId);
  res.json({
    counts: Object.fromEntries(counts.map((c) => [c.status, c._count._all])),
    items: convs.map((c, i) => {
      const ct = contacts.find((x) => x.id === c.contactId);
      return { ...c, channel: channelOf(labels, c.channelId), waitingLabel: c.waitingSince ? WAITING_LABEL : null, contact: ct ? { id: ct.id, name: ct.name, phone: ct.phone, stageId: ct.stageId, tags: parseJson<string[]>(ct.tags, []) } : null, lastMessage: lastMsgs[i] ? { body: lastMsgs[i]!.body, direction: lastMsgs[i]!.direction, createdAt: lastMsgs[i]!.createdAt } : null, withinWindow: (c.channelId && qrIds.has(c.channelId)) || isWithinWindow(c) };
    }),
  });
}));

// Conversas "Aguardando atendente" (transferidas pela IA/fluxo, sem resposta do atendente) — aviso no app web.
conversationsRouter.get('/waiting', ah(async (req, res) => {
  const orgId = orgOf(req);
  const convs = await prisma.conversation.findMany({ where: { orgId, waitingSince: { not: null }, status: { not: 'CLOSED' } }, orderBy: { waitingSince: 'asc' }, take: 50 });
  const contacts = await prisma.contact.findMany({ where: { orgId, id: { in: convs.map((c) => c.contactId) } }, select: { id: true, name: true, phone: true } });
  const now = Date.now();
  const labels = await channelLabels(orgId);
  res.json({
    label: WAITING_LABEL,
    items: convs.map((c) => {
      const ct = contacts.find((x) => x.id === c.contactId);
      return { id: c.id, waitingSince: c.waitingSince, waitingMinutes: Math.floor((now - c.waitingSince!.getTime()) / 60_000), label: WAITING_LABEL, channel: channelOf(labels, c.channelId), contact: ct ? { id: ct.id, name: ct.name, phone: ct.phone } : null };
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
    conversation: { ...conv, unreadCount: 0, channel: channelOf(await channelLabels(conv.orgId), conv.channelId), withinWindow: !windowApplies(await resolveChannel(conv)) || isWithinWindow(conv) },
    contact: contact ? { ...contact, tags: parseJson<string[]>(contact.tags, []), vars: parseJson(contact.vars, {}) } : null,
    messages: messages.map((m) => ({ ...m, authorName: authors.find((a) => a.id === m.authorUserId)?.name })),
    // Notas para a IA do CONTATO (valem em todas as conversas dele); a tela as intercala na linha do tempo.
    aiNotes: contact ? await listContactAiNotes(conv.orgId, contact.id) : [],
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
  const { text, ai } = z.object({ text: z.string().trim().min(1).max(2000), ai: z.boolean().optional() }).parse(req.body);
  const conv = await getConv(req);
  if (ai) {
    // "Nota para a IA": fica no contato (não na conversa), nunca é enviada ao cliente e entra no prompt da IA.
    if (text.length > AI_NOTE_MAX_LEN) throw new HttpError(400, `A nota para a IA pode ter no máximo ${AI_NOTE_MAX_LEN} caracteres`);
    if (!(await isProductActive(conv.orgId, 'MCKBOT'))) throw new HttpError(402, 'Assinatura MCKBOT inativa. Renove o plano para continuar.');
    const n = await createContactAiNote(req, conv.contactId, text);
    return void res.status(201).json({ ...n, kind: 'ai_note' });
  }
  const m = await prisma.message.create({ data: { orgId: conv.orgId, conversationId: conv.id, direction: 'INTERNAL', sender: 'agent', type: 'note', body: text, status: 'NOTE', authorUserId: req.auth!.userId } });
  res.status(201).json(m);
}));
