import { Router } from 'express';
import { assertPublicUrl } from '../lib/ssrf.js';
import { z } from 'zod';
import { prisma } from '../db.js';
import { ah, notFound, badRequest } from '../lib/http.js';
import { orgOf, requireRole } from '../auth/session.js';
import { encrypt, decryptOrNull, maskSecret } from '../lib/crypto.js';
import { audit } from '../lib/audit.js';
import { parseJson } from '../lib/json.js';
import { generateAiReply, reindexDoc, retrieve } from '../ai/service.js';

export const aiRouter = Router();
const admins = requireRole('OWNER', 'ADMIN');

async function settingsView(orgId: string) {
  const s = await prisma.aiSettings.upsert({ where: { orgId }, create: { orgId }, update: {} });
  const { apiKeyEnc, handoffKeywords, ...rest } = s;
  return { ...rest, hasApiKey: !!apiKeyEnc, apiKeyPreview: maskSecret(decryptOrNull(apiKeyEnc)), handoffKeywords: parseJson<string[]>(handoffKeywords, []) };
}

aiRouter.get('/settings', ah(async (req, res) => res.json(await settingsView(orgOf(req)))));

aiRouter.put('/settings', admins, ah(async (req, res) => {
  const providers = process.env.NODE_ENV === 'test' ? (['openai', 'gemini', 'fake'] as const) : (['openai', 'gemini'] as const);
  const body = z.object({
    enabled: z.boolean().optional(), autoReply: z.boolean().optional(),
    provider: z.enum(providers as unknown as [string, ...string[]]).optional(),
    model: z.string().trim().min(1).max(100).optional(),
    baseUrl: z.string().trim().url().max(300).optional().nullable().or(z.literal('')),
    apiKey: z.string().trim().min(8).max(500).optional(),
    clearApiKey: z.boolean().optional(),
    instructions: z.string().max(8000).optional(), tone: z.string().max(200).optional(),
    temperature: z.number().min(0).max(2).optional(), maxTokens: z.number().int().min(50).max(4000).optional(),
    dailyLimit: z.number().int().min(0).max(100000).optional(), monthlyTokenLimit: z.number().int().min(0).max(100000000).optional(),
    handoffKeywords: z.array(z.string().trim().min(1).max(50)).max(30).optional(),
    fallbackMessage: z.string().trim().min(1).max(1000).optional(),
  }).parse(req.body);
  const orgId = orgOf(req);
  const { apiKey, clearApiKey, handoffKeywords, baseUrl, ...rest } = body;
  if (baseUrl) {
    try { await assertPublicUrl(baseUrl); } catch (e) { throw badRequest(`URL da IA recusada: ${(e as Error).message}`); }
  }
  await prisma.aiSettings.upsert({
    where: { orgId },
    create: { orgId },
    update: {
      ...rest,
      baseUrl: baseUrl === '' ? null : baseUrl ?? undefined,
      handoffKeywords: handoffKeywords ? JSON.stringify(handoffKeywords) : undefined,
      apiKeyEnc: clearApiKey ? null : apiKey ? encrypt(apiKey) : undefined,
    },
  });
  await audit(req, 'ai.settings_update', { entity: 'ai_settings', meta: { fields: Object.keys(body).filter((k) => k !== 'apiKey'), apiKeyChanged: !!apiKey || !!clearApiKey } });
  res.json(await settingsView(orgId));
}));

aiRouter.post('/test', admins, ah(async (req, res) => {
  const { message } = z.object({ message: z.string().trim().min(1).max(2000) }).parse(req.body);
  const orgId = orgOf(req);
  const hits = await retrieve(orgId, message, 3);
  const r = await generateAiReply({ orgId, conversationId: '', text: message });
  res.json({ ...r, sources: hits.map((h) => ({ title: (h.item as { title: string }).title, score: Number(h.score.toFixed(2)), text: h.item.text.slice(0, 300) })) });
}));

aiRouter.get('/usage', ah(async (req, res) => {
  const orgId = orgOf(req);
  const since = new Date(Date.now() - 30 * 24 * 3600e3);
  const [agg, total, failed, handoffs, recent] = await Promise.all([
    prisma.aiUsage.aggregate({ where: { orgId, createdAt: { gte: since } }, _sum: { promptTokens: true, completionTokens: true }, _avg: { latencyMs: true } }),
    prisma.aiUsage.count({ where: { orgId, createdAt: { gte: since } } }),
    prisma.aiUsage.count({ where: { orgId, createdAt: { gte: since }, success: false } }),
    prisma.aiUsage.count({ where: { orgId, createdAt: { gte: since }, handoff: true } }),
    prisma.aiUsage.findMany({ where: { orgId }, orderBy: { createdAt: 'desc' }, take: 20 }),
  ]);
  res.json({ total, failed, handoffs, promptTokens: agg._sum.promptTokens ?? 0, completionTokens: agg._sum.completionTokens ?? 0, avgLatencyMs: Math.round(agg._avg.latencyMs ?? 0), recent });
}));

// ---- Base de conhecimento ----
aiRouter.get('/knowledge', ah(async (req, res) => {
  const orgId = orgOf(req);
  const docs = await prisma.knowledgeDoc.findMany({ where: { orgId }, orderBy: { updatedAt: 'desc' } });
  const counts = await prisma.knowledgeChunk.groupBy({ by: ['docId'], where: { orgId }, _count: { _all: true } });
  res.json(docs.map((d) => ({ ...d, chunks: counts.find((c) => c.docId === d.id)?._count._all ?? 0 })));
}));

const docSchema = z.object({ title: z.string().trim().min(1).max(200), content: z.string().trim().min(1).max(200000) });

aiRouter.post('/knowledge', admins, ah(async (req, res) => {
  const body = docSchema.parse(req.body);
  const orgId = orgOf(req);
  const doc = await prisma.knowledgeDoc.create({ data: { orgId, ...body } });
  const chunks = await reindexDoc(orgId, doc.id, doc.content);
  await audit(req, 'ai.knowledge_create', { entity: 'knowledge_doc', entityId: doc.id });
  res.status(201).json({ ...doc, chunks });
}));

aiRouter.put('/knowledge/:id', admins, ah(async (req, res) => {
  const body = docSchema.parse(req.body);
  const orgId = orgOf(req);
  const doc = await prisma.knowledgeDoc.findFirst({ where: { id: req.params.id, orgId } });
  if (!doc) throw notFound('Documento');
  const updated = await prisma.knowledgeDoc.update({ where: { id: doc.id }, data: body });
  const chunks = await reindexDoc(orgId, doc.id, updated.content);
  await audit(req, 'ai.knowledge_update', { entity: 'knowledge_doc', entityId: doc.id });
  res.json({ ...updated, chunks });
}));

aiRouter.delete('/knowledge/:id', admins, ah(async (req, res) => {
  const orgId = orgOf(req);
  const doc = await prisma.knowledgeDoc.findFirst({ where: { id: req.params.id, orgId } });
  if (!doc) throw notFound('Documento');
  await prisma.knowledgeChunk.deleteMany({ where: { orgId, docId: doc.id } });
  await prisma.knowledgeDoc.delete({ where: { id: doc.id } });
  await audit(req, 'ai.knowledge_delete', { entity: 'knowledge_doc', entityId: doc.id });
  res.json({ ok: true });
}));
