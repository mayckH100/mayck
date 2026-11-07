import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { ah, HttpError, forbidden } from '../lib/http.js';
import { orgOf } from '../auth/session.js';
import { audit } from '../lib/audit.js';
import { hasModule } from '../lib/permissions.js';
import { mckIaReady } from '../ai/mckIa.js';
import { classifyLeadMessage, buildQualifyPrompt, DEFAULT_PROMPT_TEMPLATE, PROMPT_VARIABLES, lockedPromptTail } from '../mckmensagem/qualificacao.js';
import { getQualificacao, saveQualificacao, toLegacy, type LegacyLeadAi } from './qualificacao.js';
import { qualificacaoAccess } from './access.js';

/**
 * Etapa de qualificação do SDR com IA (v1.20.0). Uma só tela/configuração, usada pelo MCKBOT (/sdr) e pelo
 * MCK Mensagens (/mensagem/sdr). A API antiga do MCK Mensagens (/api/mckmensagem/ia-leads) usa as mesmas funções.
 */
export const qualiSchema = z.object({
  enabled: z.boolean().optional(),
  instructions: z.string().max(4000).optional(),
  offer: z.string().max(1000).optional(),
  positiveAction: z.enum(['HANDOFF', 'FLOW', 'BOT']).optional(),
  positiveFlowId: z.string().max(40).nullable().optional(),
  retryDays: z.number().int().min(1).max(60).optional(),
  maxAttempts: z.number().int().min(1).max(10).optional(),
  retryMessage: z.string().trim().min(1).max(1000).optional(),
  promptTemplate: z.string().max(8000).nullable().optional(),
  positiveMessage: z.string().max(1000).optional(),
  negativeAction: z.enum(['RETRY', 'FLOW', 'HANDOFF', 'DISCARD']).optional(),
  negativeFlowId: z.string().max(40).nullable().optional(),
  doubtAction: z.enum(['AI', 'FLOW', 'HANDOFF']).optional(),
  doubtFlowId: z.string().max(40).nullable().optional(),
  tagPositive: z.string().trim().max(40).optional(),
  tagWaiting: z.string().trim().max(40).optional(),
  tagDiscarded: z.string().trim().max(40).optional(),
});

/** Tela da qualificação (mesmo formato da antiga tela do MCK Mensagens, mais a origem da configuração). */
export async function qualiView(orgId: string) {
  const [{ config, origem }, flows, ai, aguardando, qualificados] = await Promise.all([
    getQualificacao(orgId),
    prisma.flow.findMany({ where: { orgId, status: 'ACTIVE' }, select: { id: true, name: true }, orderBy: { name: 'asc' } }),
    prisma.aiSettings.findUnique({ where: { orgId } }),
    prisma.lead.count({ where: { orgId, status: 'AGUARDANDO' } }),
    prisma.lead.count({ where: { orgId, status: 'QUALIFICADO' } }),
  ]);
  const settings = toLegacy(config);
  return {
    settings, origem, flows, aiReady: !!(ai?.apiKeyEnc || ai?.provider === 'fake' || (ai?.provider === 'mck' && mckIaReady())), aiProvider: ai?.provider ?? null, aiModel: ai?.model ?? null,
    counts: { aguardando, qualificados },
    defaultPromptTemplate: DEFAULT_PROMPT_TEMPLATE, promptVariables: PROMPT_VARIABLES, lockedPrompt: lockedPromptTail('(trechos da base de conhecimento)').trim(),
    prompt: buildQualifyPrompt(settings, { tone: ai?.tone ?? '', companyInstructions: ai?.instructions ?? '', knowledge: '(trechos da base de conhecimento encontrados para a mensagem do lead)', leadName: '{nome}', attempts: 0, maxAttempts: settings.maxAttempts }),
  };
}

/** Valida e salva (fonte de verdade: SDR; espelho na tabela antiga). */
export async function saveQualiFromRequest(req: Request): Promise<void> {
  const orgId = orgOf(req);
  const data = qualiSchema.parse(req.body) as Partial<LegacyLeadAi>;
  if (data.promptTemplate !== undefined) {
    const t = data.promptTemplate?.trim() ?? '';
    data.promptTemplate = !t || t === DEFAULT_PROMPT_TEMPLATE.trim() ? null : t;
  }
  const cur = toLegacy((await getQualificacao(orgId)).config);
  const checkFlow = async (action: string | undefined, flowId: string | null | undefined, fallback: string | null, label: string) => {
    if (action !== 'FLOW') return;
    const id = flowId === undefined ? fallback : flowId;
    if (!id || !(await prisma.flow.findFirst({ where: { id, orgId } }))) throw new HttpError(400, `Escolha o fluxo para ${label}`);
  };
  await checkFlow(data.positiveAction, data.positiveFlowId, cur.positiveFlowId, 'o lead interessado');
  await checkFlow(data.negativeAction, data.negativeFlowId, cur.negativeFlowId, 'o lead sem interesse');
  await checkFlow(data.doubtAction, data.doubtFlowId, cur.doubtFlowId, 'o lead com dúvida');
  await saveQualificacao(orgId, data, { userId: req.auth?.userId, ip: req.ip });
  await audit(req, 'sdr.qualificacao.update', { entity: 'sdr_settings', entityId: orgId });
}

/** Simula a resposta de um lead (nada é enviado e nenhum lead é alterado). */
export async function testQuali(req: Request) {
  const q = z.object({ texto: z.string().trim().min(1).max(1000), nome: z.string().max(80).optional() }).parse(req.body);
  try {
    return await classifyLeadMessage(orgOf(req), { name: q.nome ?? 'Cliente', qualifyAttempts: 0 }, q.texto);
  } catch (e) {
    throw new HttpError(400, (e as Error).message);
  }
}

// ---------- /api/sdr/qualificacao ----------
export const sdrQualificacaoRouter = Router();

/** Proprietário/Admin com o módulo do SDR ou do MCK Mensagens (quem já mexia na IA de qualificação continua). */
function guard(req: Request, res: Response, next: NextFunction) {
  const role = req.auth?.role;
  if (role !== 'OWNER' && role !== 'ADMIN') return next(forbidden('Só o proprietário ou um administrador configura a qualificação.'));
  if (!hasModule(req, 'sdr') && !hasModule(req, 'mensagens')) return next(forbidden('Você não tem acesso ao SDR com IA. Peça ao administrador da equipe.'));
  qualificacaoAccess(orgOf(req), !!req.auth?.isSuperAdmin).then((a) => {
    const read = req.method === 'GET' || req.method === 'HEAD';
    if (a.liberado || (read && a.leitura)) return next();
    if (a.leitura) return res.status(402).json({ error: 'Assinatura MCK Mensagens inativa' });
    res.status(402).json({ error: 'A qualificação do SDR com IA vem com o MCK Mensagens ou com o Plano Completo.', code: 'SDR_PLANO' });
  }).catch(next);
}
sdrQualificacaoRouter.use(guard);
sdrQualificacaoRouter.get('/', ah(async (req, res) => res.json(await qualiView(orgOf(req)))));
sdrQualificacaoRouter.put('/', ah(async (req, res) => { await saveQualiFromRequest(req); res.json(await qualiView(orgOf(req))); }));
sdrQualificacaoRouter.post('/testar', ah(async (req, res) => res.json(await testQuali(req))));
