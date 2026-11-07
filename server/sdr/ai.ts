import type { Contact, Conversation, SdrLead, SdrSettings } from '@prisma/client';
import { prisma } from '../db.js';
import { parseJson } from '../lib/json.js';
import { decryptOrNull } from '../lib/crypto.js';
import { createProvider, type ChatMessage } from '../ai/providers.js';
import { mckQuotaStatus } from '../ai/mckQuota.js';
import { leadPhoneOfWaId } from '../mckmensagem/contactSync.js';
import { answeredCount, computeScore, mergeAnswers, parseExtraction, temperatureOf, OPT_OUT_WORDS, type Answers, type Question } from './core.js';
import { sdrLiberadoCached } from './access.js';
import { getQualificacao, qualiPromptLines } from './qualificacao.js';
import { alertHot, getSdrSettings, questionsOf, registerReply, setStage, upsertLead, logEvent } from './service.js';

/**
 * SDR com IA no WhatsApp. Não substitui a IA do MCKBOT (que continua respondendo com Instruções, base, agenda e a
 * regra de nunca transferir sem pedido do cliente): acrescenta ao prompt as perguntas de qualificação que faltam e,
 * depois de cada mensagem do lead, uma extração em segundo plano lê a conversa, grava as respostas, calcula a pontuação
 * (0–100), a temperatura (frio/morno/quente), anda o funil e avisa a empresa quando o lead fica quente.
 */

async function activeLeadFor(orgId: string, contact: Pick<Contact, 'id' | 'waId'>): Promise<SdrLead | null> {
  const phone = leadPhoneOfWaId(contact.waId);
  return prisma.sdrLead.findFirst({ where: { orgId, OR: [{ contactId: contact.id }, ...(phone ? [{ phone }] : [])] }, orderBy: { createdAt: 'asc' } });
}

async function ctxFor(orgId: string, conversationId: string): Promise<{ lead: SdrLead; s: SdrSettings } | null> {
  if (!conversationId || !(await sdrLiberadoCached(orgId))) return null;
  const s = await getSdrSettings(orgId);
  if (!s.enabled) return null;
  const conv = await prisma.conversation.findFirst({ where: { id: conversationId, orgId }, select: { contactId: true } });
  if (!conv) return null;
  const contact = await prisma.contact.findFirst({ where: { id: conv.contactId, orgId }, select: { id: true, waId: true } });
  const lead = contact ? await activeLeadFor(orgId, contact) : null;
  if (!lead || lead.optOutAt || ['GANHO', 'PERDIDO'].includes(lead.stage)) return null;
  return { lead, s };
}

/** Trecho do prompt da IA do MCKBOT para leads do SDR (vazio quando não se aplica). Nunca lança. */
export async function sdrPromptSection(orgId: string, conversationId: string): Promise<string> {
  try {
    const c = await ctxFor(orgId, conversationId);
    if (!c) return '';
    const qs = questionsOf(c.s);
    const answers = parseJson<Answers>(c.lead.answersJson, {});
    const missing = qs.filter((q) => !answers[q.id]?.resposta);
    const lines = [
      'QUALIFICAÇÃO (pré-vendas):',
      '- Primeiro responda o que o cliente perguntou. Depois, de forma natural e sem interrogatório, descubra UMA das informações que ainda faltam (no máximo uma pergunta por resposta).',
      '- Nunca diga que está "qualificando" nem fale de pontuação. Nunca transfira para um atendente por causa disso.',
    ];
    // v1.20.0: abordagem e próximo passo da etapa de qualificação (antiga IA de qualificação do MCK Mensagens).
    lines.push(...qualiPromptLines((await getQualificacao(orgId)).config));
    if (missing.length) lines.push('Ainda falta saber:', ...missing.map((q) => `- ${q.pergunta}`));
    else lines.push('- Todas as informações já foram coletadas: foque em ajudar e no próximo passo.');
    if (c.s.autoMode && c.s.autoBook && c.lead.stage !== 'REUNIAO' && c.lead.temperature !== 'FRIO') {
      lines.push('- O cliente já mostrou interesse: ofereça marcar uma conversa/demonstração usando os HORÁRIOS LIVRES da agenda (se houver).');
    }
    return lines.join('\n');
  } catch {
    return '';
  }
}

/** Modo automático + "IA marca a reunião sozinha": a agenda pela IA vale para este lead mesmo se a empresa não ligou na Agenda. */
export async function sdrForcesBooking(orgId: string, conversationId: string): Promise<boolean> {
  try {
    const c = await ctxFor(orgId, conversationId);
    return !!c && c.s.autoMode && c.s.autoBook && c.lead.stage !== 'REUNIAO';
  } catch {
    return false;
  }
}

export function extractionPrompt(questions: Question[], answers: Answers): string {
  return [
    'Você analisa uma conversa de WhatsApp entre uma empresa (assistente) e um possível cliente (lead).',
    'Extraia SOMENTE o que o LEAD disse sobre cada pergunta abaixo. Não invente: sem informação, deixe a resposta vazia.',
    'Para cada resposta dê uma nota de 0 a 100 de quanto ela indica um bom cliente agora (necessidade clara, porte compatível, prazo curto, orçamento compatível = notas altas; sem interesse, sem prazo, sem orçamento = notas baixas).',
    'Perguntas (id: pergunta):',
    ...questions.map((q) => `- ${q.id}: ${q.pergunta}`),
    `Respostas já registradas (mantenha se a conversa não mudar): ${JSON.stringify(answers)}`,
    'Responda SOMENTE com JSON válido em uma linha:',
    '{"respostas":{"<id>":{"resposta":"texto curto","nota":0}},"resumo":"até 15 palavras sobre o lead e o que ele quer"}',
  ].join('\n');
}

/** Chama a IA configurada da empresa para extrair as respostas. Retorna null se não houver IA ou se falhar. */
export async function extractAnswers(orgId: string, conversationId: string, questions: Question[], answers: Answers): Promise<{ respostas: Record<string, unknown>; resumo: string } | null> {
  const ai = await prisma.aiSettings.findUnique({ where: { orgId } });
  if (!ai || !ai.enabled) return null;
  if (ai.provider === 'mck' && (await mckQuotaStatus(orgId)).reached) return null;
  const history = await prisma.message.findMany({ where: { orgId, conversationId, direction: { in: ['IN', 'OUT'] }, status: { not: 'FAILED' } }, orderBy: { createdAt: 'desc' }, take: 16 });
  const transcript = history.reverse().map((m) => `${m.direction === 'IN' ? 'LEAD' : 'EMPRESA'}: ${(m.body ?? '').slice(0, 500)}`).join('\n');
  if (!transcript) return null;
  const msgs: ChatMessage[] = [{ role: 'system', content: extractionPrompt(questions, answers) }, { role: 'user', content: `CONVERSA:\n${transcript}` }];
  const started = Date.now();
  try {
    const provider = createProvider(ai.provider, decryptOrNull(ai.apiKeyEnc), ai.baseUrl);
    const r = await provider.chat(msgs, { model: ai.model, temperature: 0.1, maxTokens: 400, timeoutMs: 20000 });
    await prisma.aiUsage.create({ data: { orgId, conversationId, provider: ai.provider, model: ai.model, promptTokens: r.promptTokens, completionTokens: r.completionTokens, latencyMs: Date.now() - started, success: true } }).catch(() => undefined);
    return parseExtraction(r.text);
  } catch (e) {
    await prisma.aiUsage.create({ data: { orgId, conversationId, provider: ai.provider, model: ai.model, success: false, error: `SDR: ${(e as Error).message}`.slice(0, 500), latencyMs: Date.now() - started } }).catch(() => undefined);
    return null;
  }
}

/** Aplica a extração: respostas, pontuação, temperatura, funil e aviso de lead quente. */
export async function applyExtraction(lead: SdrLead, s: SdrSettings, ex: { respostas: Record<string, unknown>; resumo: string }): Promise<SdrLead> {
  const qs = questionsOf(s);
  const old = parseJson<Answers>(lead.answersJson, {});
  const answers = mergeAnswers(qs, old, ex.respostas);
  const score = computeScore(qs, answers);
  const temperature = temperatureOf(score, s.warmScore, s.hotScore);
  let upd = await prisma.sdrLead.update({ where: { id: lead.id }, data: { answersJson: JSON.stringify(answers), score, temperature, aiSummary: ex.resumo || lead.aiSummary } });
  if (score !== lead.score || temperature !== lead.temperature) await logEvent(lead.orgId, lead.id, 'QUALIFICACAO', 'WHATSAPP', `Pontuação ${lead.score} → ${score} (${temperature.toLowerCase()})`);
  if (temperature !== 'FRIO' && answeredCount(qs, answers) >= 2) upd = await setStage(upd, 'QUALIFICADO');
  if (temperature === 'QUENTE') await alertHot(upd, s);
  return upd;
}

// ---------- Mensagem recebida no WhatsApp ----------
const pending = new Set<Promise<unknown>>();
/** Testes: espera o trabalho do SDR em segundo plano. */
export async function flushSdr() { while (pending.size) await Promise.all([...pending]); }

/**
 * Chamado pelo inbound depois de gravar a mensagem (segundo plano: não atrasa a resposta ao cliente). Cria o lead de
 * quem chamou pela primeira vez (captura automática), registra a resposta (para a cadência) e qualifica pela IA.
 */
export function sdrOnInboundInBackground(args: { conv: Conversation; contact: Contact; text: string; isFirst: boolean; autoReplySkipped: boolean }) {
  const p = sdrOnInbound(args).catch((e) => console.error('[sdr] falha ao processar mensagem recebida', { orgId: args.conv.orgId, error: (e as Error).message }));
  pending.add(p);
  p.finally(() => pending.delete(p));
}

export async function sdrOnInbound(args: { conv: Conversation; contact: Contact; text: string; isFirst: boolean; autoReplySkipped: boolean }, now = new Date()): Promise<SdrLead | null> {
  const { conv, contact } = args;
  const orgId = conv.orgId;
  if (OPT_OUT_WORDS.test(args.text || '')) return null; // opt-out é tratado pelo hook do inbound
  if (!(await sdrLiberadoCached(orgId))) return null;
  const s = await getSdrSettings(orgId);
  if (!s.enabled) return null;
  let lead = await activeLeadFor(orgId, contact);
  if (!lead) {
    const phone = leadPhoneOfWaId(contact.waId);
    if (!s.captureWhatsapp || !args.isFirst || args.autoReplySkipped || contact.optOut || !phone) return null;
    lead = (await upsertLead(orgId, { name: contact.name, phone, email: contact.email }, 'WHATSAPP', { contactId: contact.id, now })).lead;
    lead = await prisma.sdrLead.update({ where: { id: lead.id }, data: { lastReplyAt: now } });
    if (lead.cadenceStatus === 'ESPERA') lead = await prisma.sdrLead.update({ where: { id: lead.id }, data: { nextStepAt: new Date(now.getTime() + s.silenceHours * 3600e3) } });
  } else {
    if (!lead.contactId) lead = await prisma.sdrLead.update({ where: { id: lead.id }, data: { contactId: contact.id } });
    lead = await registerReply(lead, 'WHATSAPP', s, now);
  }
  if (lead.optOutAt || ['GANHO', 'PERDIDO'].includes(lead.stage) || conv.mode === 'HUMAN' || !args.text?.trim()) return lead;
  // Economia de IA: tudo respondido e lead já quente → não precisa extrair de novo.
  const qs = questionsOf(s);
  const cur = parseJson<Answers>(lead.answersJson, {});
  if (answeredCount(qs, cur) >= qs.length && lead.temperature === 'QUENTE') return lead;
  const ex = await extractAnswers(orgId, conv.id, qs, cur);
  if (ex) lead = await applyExtraction(lead, s, ex);
  return lead;
}
