import { Router } from 'express';
import { assertPublicUrl } from '../lib/ssrf.js';
import { z } from 'zod';
import { prisma } from '../db.js';
import { HttpError, ah, notFound, badRequest } from '../lib/http.js';
import { orgOf, requireRole } from '../auth/session.js';
import { encrypt, decryptOrNull, maskSecret } from '../lib/crypto.js';
import { audit } from '../lib/audit.js';
import { parseJson } from '../lib/json.js';
import { generateAiReply, reindexDoc, retrieve } from '../ai/service.js';
import { productsRouter } from './products.js';
import { mckIaReady } from '../ai/mckIa.js';
import { CORRECTION_PREFIX } from '../ai/rag.js';
import { PURPOSE_LABEL } from '../ai/prompts.js';
import { mckQuotaStatus, clientUsageRow } from '../ai/mckQuota.js';
import { synthesizeReply } from '../ai/voice/service.js';
import { ElevenLabsVoice, mckVoiceReady, VOICE_ENGINES, TRANSCRIBE_ENGINES, ELEVEN_MODELS, type VoiceOption } from '../ai/voice/providers.js';
import { GEMINI_VOICES, OPENAI_VOICES, REPLY_MODES, DEFAULT_VOICE_BY_ENGINE } from '../ai/voice/spoken.js';

export const aiRouter = Router();
const admins = requireRole('OWNER', 'ADMIN');

// Produtos (catálogo): mesmas proteções da base de conhecimento (módulo IA, MCKBOT ativo para escrita).
aiRouter.use('/products', productsRouter);

async function settingsView(orgId: string) {
  const s = await prisma.aiSettings.upsert({ where: { orgId }, create: { orgId }, update: {} });
  const { apiKeyEnc, voiceApiKeyEnc, handoffKeywords, ...rest } = s;
  // Cota diária da MCK IA (só quando a organização usa a MCK IA): o Proprietário vê o uso de hoje e o aviso ao atingir.
  const mckQuota = s.provider === 'mck' ? await mckQuotaStatus(orgId).catch(() => null) : null;
  return { ...rest, mckIaReady: mckIaReady(), mckQuota, hasApiKey: !!apiKeyEnc, apiKeyPreview: maskSecret(decryptOrNull(apiKeyEnc)),
    // Voz: a chave da ElevenLabs nunca volta ao navegador (só "configurada").
    hasVoiceApiKey: !!voiceApiKeyEnc, mckVoiceReady: mckVoiceReady(), handoffKeywords: parseJson<string[]>(handoffKeywords, []) };
}

aiRouter.get('/settings', ah(async (req, res) => res.json(await settingsView(orgOf(req)))));

aiRouter.put('/settings', admins, ah(async (req, res) => {
  const providers = process.env.NODE_ENV === 'test' ? (['openai', 'gemini', 'mck', 'fake'] as const) : (['openai', 'gemini', 'mck'] as const);
  const body = z.object({
    enabled: z.boolean().optional(), autoReply: z.boolean().optional(),
    provider: z.enum(providers as unknown as [string, ...string[]]).optional(),
    model: z.string().trim().min(1).max(100).optional(),
    baseUrl: z.string().trim().url().max(300).optional().nullable().or(z.literal('')),
    apiKey: z.string().trim().min(8).max(500).optional(),
    clearApiKey: z.boolean().optional(),
    instructions: z.string().max(8000).optional(), tone: z.string().max(200).optional(),
    temperature: z.number().min(0).max(2).optional(), maxTokens: z.number().int().min(50).max(4000).optional(),
    usageLimitEnabled: z.boolean().optional(),
    dailyLimit: z.number().int().min(0).max(100000).optional(), monthlyTokenLimit: z.number().int().min(0).max(100000000).optional(),
    handoffKeywords: z.array(z.string().trim().min(1).max(50)).max(30).optional(),
    fallbackMessage: z.string().trim().min(1).max(1000).optional(),
    failureMessage: z.string().trim().max(1000).optional(),
    competitorNotes: z.string().max(3000).optional(),
    useMckSite: z.boolean().optional(),
    webSearch: z.boolean().optional(),
    kanbanAuto: z.boolean().optional(),
    // v1.35.0: bloquear valores fora da base (padrão desligado).
    guardValues: z.boolean().optional(),
    // v1.23.0 Voz
    voiceEnabled: z.boolean().optional(),
    voiceReplyMode: z.enum(REPLY_MODES as unknown as [string, ...string[]]).optional(),
    voiceProvider: z.enum(VOICE_ENGINES as unknown as [string, ...string[]]).optional(),
    voiceName: z.string().trim().max(64).regex(/^[\w-]*$/, 'Voz inválida').optional(),
    voiceModel: z.enum(['', ...ELEVEN_MODELS] as [string, ...string[]]).optional(),
    voiceStyle: z.string().trim().max(500).optional(),
    voiceMaxSeconds: z.number().int().min(10).max(120).optional(),
    transcribeAudio: z.boolean().optional(),
    transcribeProvider: z.enum(TRANSCRIBE_ENGINES as unknown as [string, ...string[]]).optional(),
    voiceApiKey: z.string().trim().min(8).max(300).optional(),
    clearVoiceApiKey: z.boolean().optional(),
  }).parse(req.body);
  const orgId = orgOf(req);
  // O site da MCK DESENVOLVIMENTO como conhecimento é só da organização da MCK: quem liga é o superadmin.
  if (body.useMckSite !== undefined && !req.auth!.isSuperAdmin) throw new HttpError(403, 'Só o administrador da plataforma pode ligar o conhecimento do site da MCK.');
  const { apiKey, clearApiKey, handoffKeywords, baseUrl, voiceApiKey, clearVoiceApiKey, ...rest } = body;
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
      voiceApiKeyEnc: clearVoiceApiKey ? null : voiceApiKey ? encrypt(voiceApiKey) : undefined,
    },
  });
  await audit(req, 'ai.settings_update', { entity: 'ai_settings', meta: { fields: Object.keys(body).filter((k) => k !== 'apiKey' && k !== 'voiceApiKey'), apiKeyChanged: !!apiKey || !!clearApiKey, voiceApiKeyChanged: !!voiceApiKey || !!clearVoiceApiKey } });
  res.json(await settingsView(orgId));
}));

// ---- Voz (v1.23.0) ----
/** Vozes do motor escolhido. Gemini/OpenAI: lista fixa; ElevenLabs: vozes da conta do cliente (chave salva). */
aiRouter.get('/voice/voices', admins, ah(async (req, res) => {
  const provider = z.enum(VOICE_ENGINES as unknown as [string, ...string[]]).parse(req.query.provider ?? 'gemini');
  const orgId = orgOf(req);
  let voices: VoiceOption[];
  if (provider === 'gemini') voices = GEMINI_VOICES.map((v) => ({ id: v.id, label: v.label, genero: v.genero }));
  else if (provider === 'openai') voices = OPENAI_VOICES.map((v) => ({ id: v.id, label: v.label, genero: v.genero }));
  else {
    const s = await prisma.aiSettings.findUnique({ where: { orgId } });
    const key = decryptOrNull(s?.voiceApiKeyEnc);
    if (!key) return res.json({ provider, voices: [], needsKey: true, defaultVoice: '' });
    if (s?.provider === 'fake' && process.env.NODE_ENV === 'test') voices = [{ id: 'voz-teste-eleven-1', label: 'Voz de teste — feminina', genero: 'feminina' }];
    else {
      try {
        voices = await new ElevenLabsVoice(key).voices();
      } catch (e) {
        throw new HttpError(502, `Não foi possível carregar as vozes da ElevenLabs: ${(e as Error).message}`);
      }
    }
  }
  res.json({ provider, voices, needsKey: false, defaultVoice: DEFAULT_VOICE_BY_ENGINE[provider] || voices[0]?.id || '' });
}));

/**
 * "Ouvir prévia": gera um áudio curto com o motor/voz/estilo escolhidos na tela (mesmo antes de salvar) e
 * devolve audio/ogg (Opus) para tocar no navegador. Usa as chaves salvas e conta no uso da IA.
 */
aiRouter.post('/voice/preview', admins, ah(async (req, res) => {
  const body = z.object({
    voiceProvider: z.enum(VOICE_ENGINES as unknown as [string, ...string[]]).optional(),
    voiceName: z.string().trim().max(64).regex(/^[\w-]*$/).optional(),
    voiceModel: z.enum(['', ...ELEVEN_MODELS] as [string, ...string[]]).optional(),
    voiceStyle: z.string().trim().max(500).optional(),
    text: z.string().trim().min(2).max(300).optional(),
  }).parse(req.body ?? {});
  const orgId = orgOf(req);
  const s = await prisma.aiSettings.upsert({ where: { orgId }, create: { orgId }, update: {} });
  const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { name: true } });
  const text = body.text ?? `Oi! Aqui é do atendimento${org?.name ? ` da ${org.name}` : ''}. Tudo bem? Me conta como eu posso te ajudar hoje.`;
  const settings = {
    ...s,
    voiceProvider: body.voiceProvider ?? s.voiceProvider,
    voiceName: body.voiceName ?? s.voiceName,
    voiceModel: body.voiceModel ?? s.voiceModel,
    voiceStyle: body.voiceStyle ?? s.voiceStyle,
    voiceMaxSeconds: Math.max(s.voiceMaxSeconds, 20),
  };
  const v = await synthesizeReply({ orgId, conversationId: null, text, settings, rewrite: false, requireEnabled: false });
  if (!v.ok) throw badRequest(v.reason);
  res.setHeader('Content-Type', 'audio/ogg');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Audio-Seconds', String(Math.round(v.audio.seconds * 10) / 10));
  res.send(v.audio.ogg);
}));

aiRouter.post('/test', admins, ah(async (req, res) => {
  const { message } = z.object({ message: z.string().trim().min(1).max(2000) }).parse(req.body);
  const orgId = orgOf(req);
  const hits = await retrieve(orgId, message, 3).catch(() => []);
  // generateAiReply nunca lança e tem tempo máximo: o simulador sempre recebe uma resposta (ou o motivo da falha).
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
  // Na MCK IA o cliente nunca vê qual provedor/modelo respondeu (só o Master, no painel de uso).
  const rows = req.auth?.isSuperAdmin ? recent : recent.map(clientUsageRow);
  res.json({ total, failed, handoffs, promptTokens: agg._sum.promptTokens ?? 0, completionTokens: agg._sum.completionTokens ?? 0, avgLatencyMs: Math.round(agg._avg.latencyMs ?? 0), recent: rows });
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

// ---- v1.35.0: "IA respondeu mal" (correção vira item da base) e Qualidade ----
const clipTxt = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Monta o documento da base criado a partir de uma correção. Puro. */
export function correctionDoc(question: string, correction: string): { title: string; content: string } {
  const q = question.replace(/\s+/g, ' ').trim();
  return {
    title: `${CORRECTION_PREFIX} ${clipTxt(q || 'resposta da IA', 80)}`,
    content: `Pergunta do cliente: ${q || '(não informada)'}\n\nResposta certa (escrita pela equipe): ${correction.trim()}`,
  };
}

aiRouter.post('/feedback', admins, ah(async (req, res) => {
  const body = z.object({ messageId: z.string().min(1).max(100), correction: z.string().trim().min(3).max(2000), question: z.string().trim().max(500).optional() }).parse(req.body);
  const orgId = orgOf(req);
  const msg = await prisma.message.findFirst({ where: { id: body.messageId, orgId, direction: 'OUT', sender: 'ai' } });
  if (!msg) throw notFound('Resposta da IA');
  // Pergunta = última mensagem do cliente antes da resposta (texto ou transcrição do áudio).
  const prev = await prisma.message.findFirst({ where: { orgId, conversationId: msg.conversationId, direction: 'IN', createdAt: { lte: msg.createdAt } }, orderBy: { createdAt: 'desc' } });
  const question = body.question || (prev ? (prev.transcript || prev.body || '') : '');
  const d = correctionDoc(question, body.correction);
  const doc = await prisma.knowledgeDoc.create({ data: { orgId, ...d } });
  await reindexDoc(orgId, doc.id, doc.content);
  const fb = await prisma.aiFeedback.create({ data: { orgId, conversationId: msg.conversationId, messageId: msg.id, question: clipTxt(question, 500), badAnswer: clipTxt(msg.transcript || msg.body || '', 2000), correction: body.correction, knowledgeDocId: doc.id, createdById: req.auth?.userId ?? null } });
  await prisma.message.create({ data: { orgId, conversationId: msg.conversationId, direction: 'INTERNAL', sender: 'system', type: 'note', status: 'NOTE', body: `Correção da IA salva na base de conhecimento ("${d.title}"). A IA passa a usar essa resposta.` } }).catch(() => undefined);
  await audit(req, 'ai.feedback_create', { entity: 'ai_feedback', entityId: fb.id });
  res.status(201).json({ ...fb, knowledgeTitle: d.title });
}));

aiRouter.get('/feedback', ah(async (req, res) => {
  const orgId = orgOf(req);
  res.json(await prisma.aiFeedback.findMany({ where: { orgId }, orderBy: { createdAt: 'desc' }, take: 100 }));
}));

aiRouter.delete('/feedback/:id', admins, ah(async (req, res) => {
  const orgId = orgOf(req);
  const fb = await prisma.aiFeedback.findFirst({ where: { id: req.params.id, orgId } });
  if (!fb) throw notFound('Correção');
  if (fb.knowledgeDocId) {
    await prisma.knowledgeChunk.deleteMany({ where: { orgId, docId: fb.knowledgeDocId } });
    await prisma.knowledgeDoc.deleteMany({ where: { id: fb.knowledgeDocId, orgId } });
  }
  await prisma.aiFeedback.delete({ where: { id: fb.id } });
  await audit(req, 'ai.feedback_delete', { entity: 'ai_feedback', entityId: fb.id });
  res.json({ ok: true });
}));

/** Qualidade e consumo dos últimos 30 dias, por finalidade (o cliente nunca vê o provedor da MCK IA). */
aiRouter.get('/quality', ah(async (req, res) => {
  const orgId = orgOf(req);
  const since = new Date(Date.now() - 30 * 24 * 3600e3);
  const [groups, fails, valores, bloqueados, correcoes] = await Promise.all([
    prisma.aiUsage.groupBy({ by: ['purpose'], where: { orgId, createdAt: { gte: since } }, _count: { _all: true }, _sum: { promptTokens: true, completionTokens: true }, _avg: { latencyMs: true } }),
    prisma.aiUsage.groupBy({ by: ['purpose'], where: { orgId, createdAt: { gte: since }, success: false }, _count: { _all: true } }),
    prisma.aiUsage.count({ where: { orgId, createdAt: { gte: since }, quality: { startsWith: 'valor_fora_base' } } }),
    prisma.aiUsage.count({ where: { orgId, createdAt: { gte: since }, quality: 'valor_fora_base_bloqueado' } }),
    prisma.aiFeedback.count({ where: { orgId, createdAt: { gte: since } } }),
  ]);
  const porFinalidade = groups.map((g) => {
    const key = g.purpose ?? 'outros';
    const falhas = fails.find((f) => f.purpose === g.purpose)?._count._all ?? 0;
    return { finalidade: key, nome: PURPOSE_LABEL[key] ?? key, chamadas: g._count._all, falhas, taxaFalha: g._count._all ? Math.round((falhas / g._count._all) * 100) : 0, tokens: (g._sum.promptTokens ?? 0) + (g._sum.completionTokens ?? 0), latenciaMedia: Math.round(g._avg.latencyMs ?? 0) };
  }).sort((a, b) => b.chamadas - a.chamadas);
  const s = await prisma.aiSettings.findUnique({ where: { orgId }, select: { guardValues: true } });
  res.json({ porFinalidade, valoresForaDaBase: valores, valoresBloqueados: bloqueados, correcoes30d: correcoes, guardValues: !!s?.guardValues });
}));
