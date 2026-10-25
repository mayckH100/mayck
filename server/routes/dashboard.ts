import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { ah } from '../lib/http.js';
import { orgOf } from '../auth/session.js';

export const dashboardRouter = Router();

const SENT = ['SENT', 'DELIVERED', 'READ'];
const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 3600e3);

function dayKey(d: Date, tz: string) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

dashboardRouter.get('/dashboard', ah(async (req, res) => {
  const orgId = orgOf(req);
  const since7 = daysAgo(7), since1 = daysAgo(1), since30 = daysAgo(30);
  const [convCounts, inToday, outToday, in7, out7, failed7, flowsActive, flowsTotal, runs7, failedRuns, failedMsgs, channels, ai, aiUsage, aiAgg, integrations, contacts, firstResp] = await Promise.all([
    prisma.conversation.groupBy({ by: ['status'], where: { orgId }, _count: { _all: true } }),
    prisma.message.count({ where: { orgId, direction: 'IN', createdAt: { gte: since1 } } }),
    prisma.message.count({ where: { orgId, direction: 'OUT', status: { in: SENT }, createdAt: { gte: since1 } } }),
    prisma.message.count({ where: { orgId, direction: 'IN', createdAt: { gte: since7 } } }),
    prisma.message.count({ where: { orgId, direction: 'OUT', status: { in: SENT }, createdAt: { gte: since7 } } }),
    prisma.message.count({ where: { orgId, direction: 'OUT', status: 'FAILED', createdAt: { gte: since7 } } }),
    prisma.flow.count({ where: { orgId, status: 'ACTIVE' } }),
    prisma.flow.count({ where: { orgId } }),
    prisma.flowRun.groupBy({ by: ['status'], where: { orgId, startedAt: { gte: since7 } }, _count: { _all: true } }),
    prisma.flowRun.findMany({ where: { orgId, status: 'FAILED' }, orderBy: { updatedAt: 'desc' }, take: 5, select: { id: true, flowId: true, error: true, updatedAt: true, conversationId: true } }),
    prisma.message.findMany({ where: { orgId, direction: 'OUT', status: 'FAILED' }, orderBy: { createdAt: 'desc' }, take: 5, select: { id: true, error: true, createdAt: true, conversationId: true, body: true } }),
    prisma.channel.findMany({ where: { orgId }, select: { id: true, name: true, status: true, displayPhone: true, lastError: true, lastWebhookAt: true } }),
    prisma.aiSettings.findUnique({ where: { orgId } }),
    prisma.aiUsage.groupBy({ by: ['success'], where: { orgId, createdAt: { gte: since30 } }, _count: { _all: true } }),
    prisma.aiUsage.aggregate({ where: { orgId, createdAt: { gte: since30 } }, _sum: { promptTokens: true, completionTokens: true } }),
    prisma.integration.findMany({ where: { orgId }, select: { id: true, name: true, lastTestStatus: true, lastTestAt: true } }),
    prisma.contact.count({ where: { orgId } }),
    prisma.conversation.findMany({ where: { orgId, createdAt: { gte: since7 }, firstResponseAt: { not: null } }, select: { createdAt: true, firstResponseAt: true } }),
  ]);
  const cc = (s: string) => convCounts.find((c) => c.status === s)?._count._all ?? 0;
  const rc = (s: string) => runs7.find((c) => c.status === s)?._count._all ?? 0;
  const finished = rc('COMPLETED') + rc('HANDOFF') + rc('FAILED');
  const flowNames = await prisma.flow.findMany({ where: { orgId, id: { in: failedRuns.map((r) => r.flowId) } }, select: { id: true, name: true } });
  const avgFirst = firstResp.length ? Math.round(firstResp.reduce((a, c) => a + (c.firstResponseAt!.getTime() - c.createdAt.getTime()), 0) / firstResp.length / 1000) : null;
  res.json({
    conversations: { open: cc('OPEN'), pending: cc('PENDING'), closed: cc('CLOSED') },
    messages: { receivedToday: inToday, sentToday: outToday, received7d: in7, sent7d: out7, failed7d: failed7 },
    flows: { active: flowsActive, total: flowsTotal },
    runs7d: { total: rc('COMPLETED') + rc('HANDOFF') + rc('FAILED') + rc('RUNNING') + rc('WAITING') + rc('CANCELLED'), completed: rc('COMPLETED'), handoff: rc('HANDOFF'), failed: rc('FAILED'), waiting: rc('WAITING'), successRate: finished ? Math.round(((rc('COMPLETED') + rc('HANDOFF')) / finished) * 1000) / 10 : null },
    recentFailures: {
      runs: failedRuns.map((r) => ({ ...r, flowName: flowNames.find((f) => f.id === r.flowId)?.name ?? '(fluxo excluído)' })),
      messages: failedMsgs,
    },
    integrations: {
      whatsapp: channels,
      ai: { enabled: !!ai?.enabled, autoReply: !!ai?.autoReply, provider: ai?.provider, model: ai?.model, configured: !!ai?.apiKeyEnc },
      partners: integrations,
    },
    aiUsage30d: { requests: aiUsage.reduce((a, u) => a + u._count._all, 0), errors: aiUsage.find((u) => !u.success)?._count._all ?? 0, tokens: (aiAgg._sum.promptTokens ?? 0) + (aiAgg._sum.completionTokens ?? 0) },
    contacts,
    avgFirstResponseSeconds: avgFirst,
  });
}));

dashboardRouter.get('/reports', ah(async (req, res) => {
  const { days } = z.object({ days: z.coerce.number().int().refine((d) => [7, 30, 90].includes(d)).default(30) }).parse(req.query);
  const orgId = orgOf(req);
  const org = await prisma.organization.findUniqueOrThrow({ where: { id: orgId } });
  const tz = org.timezone;
  const since = daysAgo(days);
  const [msgs, convs, runs, flows, ai, stages, contacts, agents] = await Promise.all([
    prisma.message.findMany({ where: { orgId, createdAt: { gte: since }, direction: { in: ['IN', 'OUT'] } }, select: { createdAt: true, direction: true, status: true, sender: true, authorUserId: true } }),
    prisma.conversation.findMany({ where: { orgId, OR: [{ createdAt: { gte: since } }, { closedAt: { gte: since } }] }, select: { createdAt: true, closedAt: true, firstResponseAt: true, mode: true } }),
    prisma.flowRun.groupBy({ by: ['flowId', 'status'], where: { orgId, startedAt: { gte: since } }, _count: { _all: true } }),
    prisma.flow.findMany({ where: { orgId }, select: { id: true, name: true, status: true } }),
    prisma.aiUsage.findMany({ where: { orgId, createdAt: { gte: since } }, select: { createdAt: true, success: true, handoff: true, promptTokens: true, completionTokens: true } }),
    prisma.kanbanStage.findMany({ where: { orgId }, orderBy: { position: 'asc' } }),
    prisma.contact.groupBy({ by: ['stageId'], where: { orgId }, _count: { _all: true } }),
    prisma.membership.findMany({ where: { orgId }, include: { user: { select: { id: true, name: true } } } }),
  ]);
  const series: Record<string, { date: string; received: number; sent: number; failed: number; newConversations: number; closed: number; aiRequests: number }> = {};
  for (let i = days - 1; i >= 0; i--) {
    const k = dayKey(daysAgo(i), tz);
    series[k] = { date: k, received: 0, sent: 0, failed: 0, newConversations: 0, closed: 0, aiRequests: 0 };
  }
  for (const m of msgs) {
    const s = series[dayKey(m.createdAt, tz)];
    if (!s) continue;
    if (m.direction === 'IN') s.received++;
    else if (m.status === 'FAILED') s.failed++;
    else if (SENT.includes(m.status)) s.sent++;
  }
  for (const c of convs) {
    if (c.createdAt >= since && series[dayKey(c.createdAt, tz)]) series[dayKey(c.createdAt, tz)].newConversations++;
    if (c.closedAt && c.closedAt >= since && series[dayKey(c.closedAt, tz)]) series[dayKey(c.closedAt, tz)].closed++;
  }
  for (const a of ai) if (series[dayKey(a.createdAt, tz)]) series[dayKey(a.createdAt, tz)].aiRequests++;
  const withResp = convs.filter((c) => c.firstResponseAt && c.createdAt >= since);
  const bySender = (s: string) => msgs.filter((m) => m.direction === 'OUT' && m.sender === s && SENT.includes(m.status)).length;
  res.json({
    days,
    series: Object.values(series),
    totals: {
      received: msgs.filter((m) => m.direction === 'IN').length,
      sent: msgs.filter((m) => m.direction === 'OUT' && SENT.includes(m.status)).length,
      failed: msgs.filter((m) => m.direction === 'OUT' && m.status === 'FAILED').length,
      sentByBot: bySender('bot'), sentByAi: bySender('ai'), sentByAgents: bySender('agent'),
      newConversations: convs.filter((c) => c.createdAt >= since).length,
      closedConversations: convs.filter((c) => c.closedAt && c.closedAt >= since).length,
      handedToHuman: convs.filter((c) => c.createdAt >= since && c.mode === 'HUMAN').length,
      avgFirstResponseSeconds: withResp.length ? Math.round(withResp.reduce((a, c) => a + (c.firstResponseAt!.getTime() - c.createdAt.getTime()), 0) / withResp.length / 1000) : null,
    },
    flows: flows.map((f) => {
      const mine = runs.filter((r) => r.flowId === f.id);
      const n = (s: string) => mine.find((r) => r.status === s)?._count._all ?? 0;
      const finished = n('COMPLETED') + n('HANDOFF') + n('FAILED');
      return { id: f.id, name: f.name, status: f.status, total: mine.reduce((a, r) => a + r._count._all, 0), completed: n('COMPLETED'), handoff: n('HANDOFF'), failed: n('FAILED'), successRate: finished ? Math.round(((n('COMPLETED') + n('HANDOFF')) / finished) * 1000) / 10 : null };
    }).sort((a, b) => b.total - a.total),
    ai: { requests: ai.length, errors: ai.filter((a) => !a.success).length, handoffs: ai.filter((a) => a.handoff).length, tokens: ai.reduce((a, u) => a + u.promptTokens + u.completionTokens, 0) },
    funnel: [{ id: null, name: 'Sem etapa', color: '#94a3b8' }, ...stages].map((s) => ({ id: s.id, name: s.name, color: s.color, count: contacts.find((c) => c.stageId === s.id)?._count._all ?? 0 })),
    agents: agents.map((a) => ({ id: a.user.id, name: a.user.name, role: a.role, sent: msgs.filter((m) => m.sender === 'agent' && m.authorUserId === a.user.id && SENT.includes(m.status)).length })),
  });
}));
