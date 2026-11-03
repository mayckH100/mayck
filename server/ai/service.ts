import { prisma } from '../db.js';
import { decryptOrNull } from '../lib/crypto.js';
import { parseJson } from '../lib/json.js';
import { createProvider, aiTimeoutMs, AiProviderError, type ChatMessage, type ChatResult } from './providers.js';
import { rank, chunkText } from './rag.js';
import { HANDOFF_TOKEN } from './guard.js';
import { normalize } from '../flows/logic.js';
import { aiNotesPromptSection, contactIdOfConversation } from './contactNotes.js';
import { agendaPromptSection, applyAgendaTag, cleanAiText, stripJsonMarkers, stripSystemLinks } from '../agenda/ai.js';
import { productsPromptSection } from './products.js';
import { applyOrderTag, intentFromText, ordersPromptSection, tagConversation } from '../agenda/orders.js';

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

export function buildSystemPrompt(s: { instructions: string; tone: string }, context: string, contactNotes = ''): string {
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
    // Notas para a IA do contato: por último e delimitadas — são dados, não instruções.
    contactNotes,
  ].filter(Boolean).join('\n');
}

const DEFAULT_FALLBACK = 'Vou transferir você para um atendente humano. Aguarde um momento, por favor.';

/** Rejeita se a promessa não terminar em `ms` (garante que nada fica esperando para sempre). */
export function withTimeout<T>(p: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  let t: NodeJS.Timeout;
  return Promise.race([p, new Promise<T>((_, rej) => { t = setTimeout(() => rej(onTimeout()), ms); })]).finally(() => clearTimeout(t));
}

/** Tempo total (ms) para as duas tentativas somadas. AI_TOTAL_TIMEOUT_MS; padrão 45 s. */
export function aiTotalBudgetMs(): number {
  const v = Number(process.env.AI_TOTAL_TIMEOUT_MS);
  return Number.isFinite(v) && v > 0 ? v : 45000;
}

/** Motivo legível (para o painel/teste e para o log) de uma falha do provedor. */
function failureReason(e: unknown): string {
  if (e instanceof AiProviderError) {
    if (e.code === 'blocked') return 'Resposta bloqueada pelo filtro de segurança do provedor';
    if (e.code === 'empty') return 'Provedor de IA devolveu resposta vazia';
    if (e.code === 'timeout') return 'Provedor de IA não respondeu a tempo';
  }
  return 'Falha no provedor de IA';
}

const startOfDay = (d = new Date()) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const startOfMonth = (d = new Date()) => new Date(d.getFullYear(), d.getMonth(), 1);

/**
 * Gera a resposta da IA para uma mensagem do contato, aplicando:
 * palavras de transferência, limites de uso, RAG, fallback e registro de uso.
 */
export async function generateAiReply(args: { orgId: string; conversationId: string; text: string; extraInstructions?: string }): Promise<AiReply> {
  // Nunca lança e nunca fica pendurada: qualquer erro inesperado (banco, montagem do prompt…) ou
  // estouro do tempo total vira transferência com a mensagem de fallback, e o motivo vai para o log.
  const hard = aiTotalBudgetMs() + 15000;
  let fallback = DEFAULT_FALLBACK;
  try {
    return await withTimeout(generateAiReplyInner(args, (f) => { fallback = f; }), hard, () => new Error(`IA excedeu ${Math.round(hard / 1000)} s no total`));
  } catch (e) {
    const msg = (e as Error).message;
    console.error('[ia] falha inesperada ao gerar resposta', { orgId: args.orgId, conversationId: args.conversationId || null, error: msg });
    await prisma.aiUsage.create({ data: { orgId: args.orgId, conversationId: args.conversationId || null, provider: '-', model: '-', success: false, handoff: true, error: msg.slice(0, 500) } }).catch(() => undefined);
    return { text: fallback, handoff: true, reason: 'Falha ao gerar a resposta da IA', error: msg, usedContext: false };
  }
}

async function generateAiReplyInner(args: { orgId: string; conversationId: string; text: string; extraInstructions?: string }, setFallback: (f: string) => void): Promise<AiReply> {
  const { orgId, conversationId, text } = args;
  const s = await prisma.aiSettings.findUnique({ where: { orgId } });
  if (s?.fallbackMessage) setFallback(s.fallbackMessage);
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
  // Produtos do catálogo que combinam com a mensagem (até 5, texto curto). Falha aqui nunca derruba a resposta.
  const prod = await productsPromptSection(orgId, text).catch(() => ({ context: '', rules: '', count: 0 }));
  const context = [hits.map((h) => `[${h.item.title}]\n${h.item.text}`).join('\n\n'), prod.context].filter(Boolean).join('\n\n');
  const usedContext = hits.length > 0 || prod.count > 0;


  const history = await prisma.message.findMany({
    where: { orgId, conversationId, direction: { in: ['IN', 'OUT'] }, status: { not: 'FAILED' } },
    orderBy: { createdAt: 'desc' }, take: 10,
  });
  // Agenda: horários livres + regra do marcador [AGENDAR:{...}] (só se a empresa ligou o agendamento pela IA).
  const agenda = await agendaPromptSection(orgId).catch(() => '');
  // Pedidos e classificação (Agenda › Configurações › "O que a IA atende": Reunião / Pedido / Os dois).
  const pedidos = await ordersPromptSection(orgId).catch(() => '');
  // Notas para a IA deixadas pelos vendedores neste contato (escopo da organização).
  const contactNotes = await contactIdOfConversation(orgId, conversationId).then((cid) => aiNotesPromptSection(orgId, cid)).catch(() => '');
  const messages: ChatMessage[] = [
    { role: 'system', content: buildSystemPrompt({ instructions: [s.instructions, args.extraInstructions, agenda, pedidos, prod.rules].filter(Boolean).join('\n'), tone: s.tone }, context, contactNotes) },
    // Links da agenda/Meet já enviados saem do histórico: a IA não deve copiá-los numa nova resposta.
    ...history.reverse().slice(0, -1).map((m) => ({ role: (m.direction === 'IN' ? 'user' : 'assistant') as 'user' | 'assistant', content: m.direction === 'IN' ? m.body ?? '' : stripSystemLinks(m.body ?? '') })),
    { role: 'user', content: text },
  ];

  const started = Date.now();
  const budget = aiTotalBudgetMs();
  let lastError = '';
  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const provider = createProvider(s.provider, decryptOrNull(s.apiKeyEnc), s.baseUrl);
      const remaining = budget - (Date.now() - started);
      if (remaining < 1000) throw new AiProviderError('timeout', `Provedor de IA não respondeu em ${Math.round(budget / 1000)} s`, false);
      const timeoutMs = Math.min(aiTimeoutMs(), remaining);
      // Timeout próprio além do do fetch: cobre qualquer provedor que não respeite o sinal.
      const r: ChatResult = await withTimeout(provider.chat(messages, { model: s.model, temperature: s.temperature, maxTokens: s.maxTokens, timeoutMs }), timeoutMs + 500,
        () => new AiProviderError('timeout', `Provedor de IA não respondeu em ${Math.round(timeoutMs / 1000)} s`, true));
      const base = { orgId, conversationId, provider: s.provider, model: s.model, promptTokens: r.promptTokens, completionTokens: r.completionTokens, latencyMs: Date.now() - started };
      if (!r.text?.trim()) throw new AiProviderError('empty', 'Provedor de IA devolveu resposta vazia', true);
      if (r.text.includes(HANDOFF_TOKEN)) {
        await prisma.aiUsage.create({ data: { ...base, success: true, handoff: true } });
        return { text: s.fallbackMessage, handoff: true, reason: 'IA não soube responder', usedContext };
      }
      await prisma.aiUsage.create({ data: { ...base, success: true } });
      // Classificação da conversa (reunião / pedido / os dois) pelo marcador [TIPO:...].
      const intent = intentFromText(r.text);
      if (intent) await tagConversation(orgId, conversationId, intent).catch(() => undefined);
      // Marcador de agendamento: cria o compromisso (com checagem de conflito) e troca pelo link da agenda.
      // O marcador de pedido sai antes (o JSON dele tem colchetes) e é processado depois.
      const noOrder = stripJsonMarkers(r.text, 'PEDIDO');
      let booked: { text: string; appointmentId?: string } = await applyAgendaTag({ orgId, conversationId, text: noOrder, clientText: text }).catch((e) => {
        console.error('[agenda-ia]', (e as Error).message);
        return { text: cleanAiText(r.text) };
      });
      if (booked.appointmentId) await tagConversation(orgId, conversationId, 'REUNIAO').catch(() => undefined);
      // Marcador de pedido: confirma com o cliente, exige dados de entrega conforme a configuração e registra.
      if (r.text !== noOrder) {
        booked = await applyOrderTag({ orgId, conversationId, text: r.text, cleanText: booked.text, clientText: text }).catch((e) => {
          console.error('[pedido-ia]', (e as Error).message);
          return { text: booked.text };
        });
      }
      const out = booked.text || cleanAiText(r.text);
      if (!out) {
        return { text: s.fallbackMessage, handoff: true, reason: 'IA não soube responder', usedContext };
      }
      return { text: out, handoff: false, usedContext };
    } catch (e) {
      lastErr = e;
      lastError = (e as Error).message;
      const code = e instanceof AiProviderError ? e.code : 'erro';
      console.warn('[ia] tentativa falhou', { orgId, conversationId: conversationId || null, attempt, code, detail: e instanceof AiProviderError ? e.detail : undefined, error: lastError });
      if (/não configurada|desconhecido|não pode ser usado/.test(lastError)) break; // erro de configuração: não adianta repetir
      if (e instanceof AiProviderError && !e.retryable) break;
    }
  }
  const reason = failureReason(lastErr);
  console.warn('[ia] sem resposta da IA, enviando fallback', { orgId, conversationId: conversationId || null, reason, error: lastError });
  await prisma.aiUsage.create({ data: { orgId, conversationId: conversationId || null, provider: s.provider, model: s.model, success: false, handoff: true, error: lastError.slice(0, 500), latencyMs: Date.now() - started } }).catch(() => undefined);
  return { text: s.fallbackMessage, handoff: true, reason, error: lastError, usedContext: false };
}
