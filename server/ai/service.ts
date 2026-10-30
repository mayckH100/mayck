import { prisma } from '../db.js';
import { decryptOrNull } from '../lib/crypto.js';
import { parseJson } from '../lib/json.js';
import { createProvider, type ChatMessage } from './providers.js';
import { rank, chunkText } from './rag.js';
import { HANDOFF_TOKEN } from './guard.js';
import { normalize } from '../flows/logic.js';
import { agendaPromptSection, applyAgendaTag } from '../agenda/ai.js';

export interface AiReply {
  text: string | null; // texto a enviar ao contato (null = nada)
  handoff: boolean;
  reason?: string;
  error?: string;
  usedContext: boolean;
}

export async function reindexDoc(orgId: string, docId: string, content: string) {
  await prisma.knowledgeChunk.deleteMany({ where: { orgId, docId } });
  const chunks = chunkText(content);
  if (chunks.length) await prisma.knowledgeChunk.createMany({ data: chunks.map((text, idx) => ({ orgId, docId, idx, text })) });
  return chunks.length;
}

export async function retrieve(orgId: string, query: string, k = 3) {
  const chunks = await prisma.knowledgeChunk.findMany({ where: { orgId }, take: 2000 });
  const docs = await prisma.knowledgeDoc.findMany({ where: { orgId }, select: { id: true, title: true } });
  const titles = new Map(docs.map((d) => [d.id, d.title]));
  return rank(query, chunks.map((c) => ({ ...c, text: c.text, title: titles.get(c.docId) ?? '' })), k);
}

export function buildSystemPrompt(s: { instructions: string; tone: string }, context: string): string {
  return [
    'Você é o assistente virtual de atendimento no WhatsApp desta empresa. Responda em português do Brasil, em mensagens curtas e claras.',
    `Tom de voz: ${s.tone || 'cordial e objetivo'}.`,
    s.instructions ? `Instruções da empresa:\n${s.instructions}` : '',
    'COMO ATENDER:',
    '- Você pode e deve informar preços, valores, planos, prazos, políticas e passo a passo, dar instruções e tirar dúvidas, usando as Instruções da empresa e o CONTEXTO abaixo.',
    '- Use os valores exatamente como aparecem nas Instruções ou no CONTEXTO. Se um valor ou regra não aparecer em nenhum dos dois, diga que vai confirmar com a equipe em vez de inventar.',
    `- Se não souber responder, se o cliente pedir um humano ou se o assunto exigir uma pessoa, responda exatamente ${HANDOFF_TOKEN}.`,
    '### CONTEXTO',
    context || '(nenhuma informação relevante encontrada na base de conhecimento)',
    '### FIM',
  ].filter(Boolean).join('\n');
}

const startOfDay = (d = new Date()) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const startOfMonth = (d = new Date()) => new Date(d.getFullYear(), d.getMonth(), 1);

/**
 * Gera a resposta da IA para uma mensagem do contato, aplicando:
 * palavras de transferência, limites de uso, RAG, fallback e registro de uso.
 */
export async function generateAiReply(args: { orgId: string; conversationId: string; text: string; extraInstructions?: string }): Promise<AiReply> {
  const { orgId, conversationId, text } = args;
  const s = await prisma.aiSettings.findUnique({ where: { orgId } });
  if (!s || !s.enabled) return { text: null, handoff: true, reason: 'IA desativada', usedContext: false };

  const handoffWords = parseJson<string[]>(s.handoffKeywords, []).map(normalize).filter(Boolean);
  const nt = normalize(text);
  if (handoffWords.some((w) => nt.includes(w))) {
    return { text: s.fallbackMessage, handoff: true, reason: 'Contato pediu atendimento humano', usedContext: false };
  }

  const [today, monthAgg] = await Promise.all([
    prisma.aiUsage.count({ where: { orgId, createdAt: { gte: startOfDay() } } }),
    prisma.aiUsage.aggregate({ where: { orgId, createdAt: { gte: startOfMonth() } }, _sum: { promptTokens: true, completionTokens: true } }),
  ]);
  const monthTokens = (monthAgg._sum.promptTokens ?? 0) + (monthAgg._sum.completionTokens ?? 0);
  if (today >= s.dailyLimit || monthTokens >= s.monthlyTokenLimit) {
    await prisma.aiUsage.create({ data: { orgId, conversationId, provider: s.provider, model: s.model, success: false, handoff: true, error: 'Limite de uso da IA atingido' } });
    return { text: s.fallbackMessage, handoff: true, reason: 'Limite de uso da IA atingido', usedContext: false };
  }

  const hits = await retrieve(orgId, text, 3);
  const context = hits.map((h) => `[${h.item.title}]\n${h.item.text}`).join('\n\n');


  const history = await prisma.message.findMany({
    where: { orgId, conversationId, direction: { in: ['IN', 'OUT'] }, status: { not: 'FAILED' } },
    orderBy: { createdAt: 'desc' }, take: 10,
  });
  // Agenda: horários livres + regra do marcador [AGENDAR:{...}] (só se a empresa ligou o agendamento pela IA).
  const agenda = await agendaPromptSection(orgId).catch(() => '');
  const messages: ChatMessage[] = [
    { role: 'system', content: buildSystemPrompt({ instructions: [s.instructions, args.extraInstructions, agenda].filter(Boolean).join('\n'), tone: s.tone }, context) },
    ...history.reverse().slice(0, -1).map((m) => ({ role: (m.direction === 'IN' ? 'user' : 'assistant') as 'user' | 'assistant', content: m.body ?? '' })),
    { role: 'user', content: text },
  ];

  const started = Date.now();
  let lastError = '';
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const provider = createProvider(s.provider, decryptOrNull(s.apiKeyEnc), s.baseUrl);
      const r = await provider.chat(messages, { model: s.model, temperature: s.temperature, maxTokens: s.maxTokens });
      const base = { orgId, conversationId, provider: s.provider, model: s.model, promptTokens: r.promptTokens, completionTokens: r.completionTokens, latencyMs: Date.now() - started };
      if (!r.text || r.text.includes(HANDOFF_TOKEN)) {
        await prisma.aiUsage.create({ data: { ...base, success: true, handoff: true } });
        return { text: s.fallbackMessage, handoff: true, reason: 'IA não soube responder', usedContext: !!hits.length };
      }
      await prisma.aiUsage.create({ data: { ...base, success: true } });
      // Marcador de agendamento: cria o compromisso (com checagem de conflito) e troca pelo link da agenda.
      const booked = await applyAgendaTag({ orgId, conversationId, text: r.text }).catch((e) => {
        console.error('[agenda-ia]', (e as Error).message);
        return { text: r.text.replace(/\[AGENDAR:[\s\S]*?\]/i, '').trim() };
      });
      return { text: booked.text || r.text, handoff: false, usedContext: !!hits.length };
    } catch (e) {
      lastError = (e as Error).message;
      if (/não configurada|desconhecido|não pode ser usado/.test(lastError)) break; // erro de configuração: não adianta repetir
    }
  }
  await prisma.aiUsage.create({ data: { orgId, conversationId, provider: s.provider, model: s.model, success: false, handoff: true, error: lastError, latencyMs: Date.now() - started } });
  return { text: s.fallbackMessage, handoff: true, reason: 'Falha no provedor de IA', error: lastError, usedContext: false };
}
