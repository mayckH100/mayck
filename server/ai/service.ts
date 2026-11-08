import { prisma } from '../db.js';
import { decryptOrNull } from '../lib/crypto.js';
import { parseJson } from '../lib/json.js';
import { createProvider, aiTimeoutMs, fallbackModelFor, AiProviderError, type ChatMessage, type ChatResult } from './providers.js';
import { rank, chunkText } from './rag.js';
import { HANDOFF_TOKEN } from './guard.js';
import { failureText, isExplicitHumanRequest, DEFAULT_FAILURE_TEXT } from './humanRequest.js';
import { failureTextFor } from './failurePolicy.js';
import { notifyAiFailureInBackground } from '../whatsapp/staffAlerts.js';
import { knowledgePromptSection } from './siteKnowledge.js';
import { MckIaProvider } from './mckIa.js';
import { mckQuotaStatus, mckQuotaHitToday, MCK_QUOTA_REASON } from './mckQuota.js';
import { kanbanPromptSection, applyKanbanTag } from './kanbanAuto.js';
import { normalize } from '../flows/logic.js';
import { aiNotesPromptSection, contactIdOfConversation } from './contactNotes.js';
import { agendaPromptSection, applyAgendaTag, cleanAiText, stripJsonMarkers, stripSystemLinks } from '../agenda/ai.js';
import { productsPromptSection } from './products.js';
import { productContextFor } from './productSource.js';
import { sdrPromptSection, sdrForcesBooking } from '../sdr/ai.js';
import { conversaAvancadaFor, conversaPromptSection, estiloFinal, HISTORICO_AVANCADO } from '../sdr/conversaService.js';
import { applyOrderTag, intentFromText, ordersPromptSection, tagConversation } from '../agenda/orders.js';
import { notAutoReply } from '../sdr/autoReply.js';
import { detectVoicePreference, decideWithPreference, historyContent, isVoicePreference, MARK_CLIENT_AUDIO, stripVoiceMarkers, voicePromptSection, type VoicePreference } from './voice/preference.js';
import { isAudioType } from './voice/spoken.js';

export interface AiReply {
  text: string | null; // texto a enviar ao contato (null = nada)
  /** true SOMENTE quando o cliente pediu explicitamente um humano (regra do dono; trava em código). */
  handoff: boolean;
  /** A IA não conseguiu responder (texto de falha enviado, sem transferir). */
  failed?: boolean;
  /** Falha já avisada ao Proprietário (ex.: cota diária da MCK IA): não manda outro alerta. */
  quiet?: boolean;
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
  // Título do documento entra na pontuação (2x), além do trecho.
  return rank(query, chunks.map((c) => { const title = titles.get(c.docId) ?? ''; return { ...c, text: c.text, title, scoreText: `${title}\n${title}\n${c.text}` }; }), k);
}

export function buildSystemPrompt(s: { instructions: string; tone: string }, context: string, contactNotes = '', voice = ''): string {
  return [
    'Você faz o atendimento desta empresa no WhatsApp. Responda em português do Brasil, em mensagens curtas, claras e humanas.',
    `Tom de voz: ${s.tone || 'cordial e objetivo'}.`,
    s.instructions ? `Instruções da empresa:\n${s.instructions}` : '',
    // v1.25: o que a IA realmente consegue (áudio/texto) e como se apresenta — nunca "só converso por texto".
    voice,
    'COMO ATENDER:',
    '- Você pode e deve informar preços, valores, planos, prazos, políticas e passo a passo, dar instruções e tirar dúvidas, usando as Instruções da empresa e o CONTEXTO abaixo.',
    '- Use os valores exatamente como aparecem nas Instruções ou no CONTEXTO. Se um valor ou regra não aparecer em nenhum dos dois, diga que vai confirmar com a equipe em vez de inventar.',
    `- TRANSFERÊNCIA PARA HUMANO É PROIBIDA, exceto quando o cliente pedir explicitamente para falar com um atendente, humano ou pessoa; só nesse caso responda exatamente ${HANDOFF_TOKEN}.`,
    '- Se não souber algo, NÃO transfira: diga com naturalidade que vai confirmar com a equipe, ofereça o que você sabe e continue ajudando. Se o cliente quiser falar com uma pessoa, ele pode escrever "atendente".',
    '- Reagendar ou cancelar um horário já marcado: peça o novo dia e horário preferidos (ou o motivo do cancelamento), confirme que registrou o pedido e que a equipe confirma em seguida. Não transfira por isso.',
    '### CONTEXTO',
    context || '(nenhuma informação relevante encontrada na base de conhecimento)',
    '### FIM',
    // Notas para a IA do contato: por último e delimitadas — são dados, não instruções.
    contactNotes,
  ].filter(Boolean).join('\n');
}

const DEFAULT_FALLBACK = DEFAULT_FAILURE_TEXT;

/** Rejeita se a promessa não terminar em `ms` (garante que nada fica esperando para sempre). */
export function withTimeout<T>(p: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  let t: NodeJS.Timeout;
  return Promise.race([p, new Promise<T>((_, rej) => { t = setTimeout(() => rej(onTimeout()), ms); })]).finally(() => clearTimeout(t));
}

/** Tempo total (ms) para todas as tentativas somadas. AI_TOTAL_TIMEOUT_MS; padrão 50 s. */
export function aiTotalBudgetMs(): number {
  const v = Number(process.env.AI_TOTAL_TIMEOUT_MS);
  return Number.isFinite(v) && v > 0 ? v : 50000;
}

/** Falha passageira do provedor (vale trocar de modelo e tentar de novo): timeout, rede, HTTP 429/5xx. */
const transient = (e: unknown) => e instanceof AiProviderError && (e.code === 'timeout' || e.code === 'network' || (e.code === 'http' && e.retryable));
/** Sobrecarga/limite (HTTP 429/503): espera curta antes da próxima tentativa. */
const overloaded = (e: unknown) => e instanceof AiProviderError && e.code === 'http' && (e.detail === '429' || e.detail === '503');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Espera curta (ms) após 429/503. AI_RETRY_BACKOFF_MS; padrão 1,5 s. */
export function aiBackoffMs(): number {
  const v = Number(process.env.AI_RETRY_BACKOFF_MS);
  return Number.isFinite(v) && v >= 0 ? v : 1500;
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

/** Modelos do Gemini com pesquisa Google grátis na camada gratuita (2.5 Flash/Flash-Lite: 500 pedidos/dia). */
export const freeSearchModel = (model: string) => /^gemini-2\.5-flash(-lite)?(\b|-)/.test(model);
/** O cliente está comparando com concorrentes / outra empresa? */
export function mentionsCompetitor(text: string): boolean {
  const t = normalize(text);
  return /\b(concorr\w*|outras? empresas?|outros? sistemas?|outras? plataformas?|outros? apps?|outros? aplicativos?|melhor(es)? que|pior(es)? que|mais barat\w* que|compar\w*|diferenca|diferencial|diferenciais|versus|vs|ja uso o|ja uso a|ja tenho o)\b/.test(t);
}

/**
 * Voz por conversa (automática): grava a preferência quando o cliente pede áudio ou texto e devolve a parte
 * do prompt com a capacidade real (voz ligada/desligada, esta resposta vai em áudio ou texto).
 */
async function voiceContext(orgId: string, conversationId: string, text: string, s: { voiceEnabled: boolean; voiceReplyMode: string }, inboundWasAudio: boolean): Promise<string> {
  let pref: VoicePreference | null = null;
  if (conversationId) {
    const conv = await prisma.conversation.findFirst({ where: { id: conversationId, orgId }, select: { voicePreference: true } });
    pref = isVoicePreference(conv?.voicePreference) ? conv.voicePreference : null;
    const asked = detectVoicePreference(text);
    if (asked && asked !== pref) {
      await prisma.conversation.update({ where: { id: conversationId }, data: { voicePreference: asked } });
      console.info('[voz] preferência do cliente nesta conversa', { orgId, conversationId, preferencia: asked });
      pref = asked;
    }
  }
  const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { name: true } });
  return voicePromptSection({ voiceEnabled: !!s.voiceEnabled, replyAsAudio: decideWithPreference(s, inboundWasAudio, pref), pref, company: org?.name });
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
  let r: AiReply;
  try {
    r = await withTimeout(generateAiReplyInner(args, (f) => { fallback = f; }), hard, () => new Error(`IA excedeu ${Math.round(hard / 1000)} s no total`));
  } catch (e) {
    const msg = (e as Error).message;
    console.error('[ia] falha inesperada ao gerar resposta', { orgId: args.orgId, conversationId: args.conversationId || null, error: msg });
    await prisma.aiUsage.create({ data: { orgId: args.orgId, conversationId: args.conversationId || null, provider: '-', model: '-', success: false, handoff: false, error: msg.slice(0, 500) } }).catch(() => undefined);
    r = { text: fallback, handoff: false, failed: true, reason: 'Falha ao gerar a resposta da IA', error: msg, usedContext: false };
  }
  // Falha numa conversa real (não no "Testar"): não repete o mesmo texto de falha e avisa o dono.
  if (r.failed && r.text && args.conversationId) {
    const text = await failureTextFor(args.orgId, args.conversationId, r.text);
    if (!r.quiet) notifyAiFailureInBackground({ orgId: args.orgId, conversationId: args.conversationId, reason: r.reason ?? 'IA não conseguiu responder', error: r.error, repeated: text !== r.text });
    r = { ...r, text };
  }
  return r;
}

async function generateAiReplyInner(args: { orgId: string; conversationId: string; text: string; extraInstructions?: string }, setFallback: (f: string) => void): Promise<AiReply> {
  const { orgId, conversationId, text } = args;
  const s = await prisma.aiSettings.findUnique({ where: { orgId } });
  if (s) setFallback(failureText(s));
  // IA desligada: não responde e não transfere (quem decide o que fazer é o fluxo/atendente).
  if (!s || !s.enabled) return { text: null, handoff: false, failed: true, reason: 'IA desativada', usedContext: false };
  const fail = failureText(s);
  // v1.26.0: IA conversacional avançada (SDR › Inteligência; só conversas com leads e o "Testar"). Desligada = null.
  const adv = await conversaAvancadaFor(orgId, conversationId, s).catch(() => null);

  // Única transferência permitida: pedido explícito do cliente (detector em código + palavras da empresa).
  const handoffWords = parseJson<string[]>(s.handoffKeywords, []).filter(Boolean);
  const askedHuman = isExplicitHumanRequest(text, handoffWords);
  if (askedHuman) {
    return { text: s.fallbackMessage, handoff: true, reason: 'Contato pediu atendimento humano', usedContext: false };
  }

  const [today, monthAgg] = await Promise.all([
    prisma.aiUsage.count({ where: { orgId, createdAt: { gte: startOfDay() } } }),
    prisma.aiUsage.aggregate({ where: { orgId, createdAt: { gte: startOfMonth() } }, _sum: { promptTokens: true, completionTokens: true } }),
  ]);
  const monthTokens = (monthAgg._sum.promptTokens ?? 0) + (monthAgg._sum.completionTokens ?? 0);
  if (today >= s.dailyLimit || monthTokens >= s.monthlyTokenLimit) {
    await prisma.aiUsage.create({ data: { orgId, conversationId, provider: s.provider, model: s.model, success: false, handoff: false, error: 'Limite de uso da IA atingido' } });
    console.warn('[ia] limite de uso atingido: texto de falha enviado, sem transferir', { orgId, conversationId: conversationId || null });
    return { text: fail, handoff: false, failed: true, reason: 'Limite de uso da IA atingido', usedContext: false };
  }

  // MCK IA: cota diária por plano. Estourou: não chama provedor nenhum e segue a política de falha.
  if (s.provider === 'mck') {
    const q = await mckQuotaStatus(orgId);
    if (q.reached) {
      const already = await mckQuotaHitToday(orgId).catch(() => false);
      await prisma.aiUsage.create({ data: { orgId, conversationId: conversationId || null, provider: 'mck', model: s.model, success: false, handoff: false, error: MCK_QUOTA_REASON } });
      console.warn('[ia] cota diária da MCK IA atingida: texto de falha enviado, sem chamar provedor', { orgId, conversationId: conversationId || null, tier: q.tier, limit: q.limit });
      return { text: fail, handoff: false, failed: true, quiet: already, reason: MCK_QUOTA_REASON, usedContext: false };
    }
  }

  const hits = await retrieve(orgId, text, 3);
  // Produtos do catálogo que combinam com a mensagem (até 5, texto curto). Falha aqui nunca derruba a resposta.
  // v1.24.0: a fonte (Produtos, ERP ou os dois) segue a configuração da empresa; ERP indisponível/falhou → catálogo.
  const prod = await productContextFor(orgId, text).catch(() => productsPromptSection(orgId, text)).catch(() => ({ context: '', rules: '', count: 0 }));
  const context = [hits.map((h) => `[${h.item.title}]\n${h.item.text}`).join('\n\n'), prod.context].filter(Boolean).join('\n\n');
  const usedContext = hits.length > 0 || prod.count > 0;


  const history = await prisma.message.findMany({
    where: { orgId, conversationId, direction: { in: ['IN', 'OUT'] }, status: { not: 'FAILED' }, ...notAutoReply },
    orderBy: { createdAt: 'desc' }, take: adv ? HISTORICO_AVANCADO : 10,
  });
  // Voz: preferência do cliente nesta conversa (pedido explícito de áudio/texto, detector por palavras) e
  // o que a IA de fato consegue fazer aqui. Falha aqui nunca derruba a resposta.
  const lastIn = history.find((m) => m.direction === 'IN');
  const inboundWasAudio = !!lastIn && history[0]?.id === lastIn.id && isAudioType(lastIn.type);
  const voice = await voiceContext(orgId, conversationId, text, s, inboundWasAudio).catch(() => '');
  // Agenda: horários livres + regra do marcador [AGENDAR:{...}] (só se a empresa ligou o agendamento pela IA).
  // SDR com IA: perguntas de qualificação que faltam e, no modo automático, agenda pela IA para o lead.
  const sdrBook = await sdrForcesBooking(orgId, conversationId).catch(() => false);
  const sdr = await sdrPromptSection(orgId, conversationId).catch(() => '');
  const agenda = await agendaPromptSection(orgId, new Date(), { force: sdrBook }).catch(() => '');
  // Pedidos e classificação (Agenda › Configurações › "O que a IA atende": Reunião / Pedido / Os dois).
  const pedidos = await ordersPromptSection(orgId).catch(() => '');
  // Notas para a IA deixadas pelos vendedores neste contato (escopo da organização).
  const contactNotes = await contactIdOfConversation(orgId, conversationId).then((cid) => aiNotesPromptSection(orgId, cid)).catch(() => '');
  // Site da empresa + preços atuais (só organizações que ligaram) e diferenciais frente a concorrentes.
  const site = await knowledgePromptSection(s, text).catch(() => '');
  // Kanban automático (desligado por padrão): etapas e o marcador [ETAPA:nome].
  const kanban = s.kanbanAuto ? await kanbanPromptSection(orgId, conversationId).catch(() => '') : '';
  const avancada = adv ? conversaPromptSection(adv) : '';
  const messages: ChatMessage[] = [
    { role: 'system', content: buildSystemPrompt({ instructions: [s.instructions, args.extraInstructions, agenda, pedidos, prod.rules, site, kanban, sdr, avancada].filter(Boolean).join('\n'), tone: s.tone }, context, contactNotes, voice) },
    // Links da agenda/Meet já enviados saem do histórico: a IA não deve copiá-los numa nova resposta.
    // Áudios ficam marcados: [enviado como áudio] (nota de voz da IA) e [áudio do cliente, transcrito].
    ...history.reverse().slice(0, -1).map((m) => ({ role: (m.direction === 'IN' ? 'user' : 'assistant') as 'user' | 'assistant', content: historyContent(m, stripSystemLinks) })),
    { role: 'user', content: inboundWasAudio ? `${MARK_CLIENT_AUDIO} ${text}` : text },
  ];

  const started = Date.now();
  const budget = aiTotalBudgetMs();
  let lastError = '';
  let lastErr: unknown = null;
  let firstErr: unknown = null;
  // Tentativas (falha de 2026-11-04: Gemini sobrecarregado, 503 + timeouts): 1ª no modelo configurado;
  // 2ª no modelo reserva (outro Flash grátis da mesma chave), se houver; 3ª de volta ao principal, só para
  // falha passageira (timeout/rede/429/5xx) e se ainda couber no tempo total. Após 429/503, espera curta.
  const apiKey = decryptOrNull(s.apiKeyEnc);
  const reserve = await fallbackModelFor(s.provider, s.model, apiKey).catch(() => null);
  const plan = reserve ? [s.model, reserve, s.model] : [s.model, s.model];
  for (let attempt = 1; attempt <= plan.length; attempt++) {
    const model = plan[attempt - 1];
    if (attempt === 3 && !transient(firstErr)) break;
    try {
      const provider = createProvider(s.provider, apiKey, s.baseUrl);
      if (attempt > 1 && overloaded(lastErr)) await sleep(Math.min(aiBackoffMs(), Math.max(0, budget - (Date.now() - started) - 2000)));
      const remaining = budget - (Date.now() - started);
      if (remaining < (attempt === 1 ? 1000 : Math.min(3000, aiTimeoutMs() / 2))) {
        if (attempt === 1) throw new AiProviderError('timeout', `Provedor de IA não respondeu em ${Math.round(budget / 1000)} s`, false);
        break; // sem tempo para outra tentativa útil: fica o erro anterior
      }
      const timeoutMs = Math.min(aiTimeoutMs(), remaining);
      // Timeout próprio além do do fetch: cobre qualquer provedor que não respeite o sinal.
      // Pesquisa no Google (grounding) só quando ligada, em modelo com cota grátis, e quando o cliente compara com concorrentes.
      const search = s.webSearch && s.provider === 'gemini' && freeSearchModel(model) && mentionsCompetitor(text) && attempt === 1;
      const r: ChatResult = await withTimeout(provider.chat(messages, { model, temperature: s.temperature, maxTokens: s.maxTokens, timeoutMs, googleSearch: search }), timeoutMs + 500,
        () => new AiProviderError('timeout', `Provedor de IA não respondeu em ${Math.round(timeoutMs / 1000)} s`, true));
      if (model !== s.model) console.warn('[ia] respondido pelo modelo reserva', { orgId, conversationId: conversationId || null, principal: s.model, reserva: model });
      // MCK IA: guarda qual provedor respondeu (só o Master vê; a tela do cliente mostra apenas "MCK IA").
      const usedModel = provider instanceof MckIaProvider && provider.lastUsed ? `${s.model}/${provider.lastUsed}` : model;
      const base = { orgId, conversationId, provider: s.provider, model: usedModel, promptTokens: r.promptTokens, completionTokens: r.completionTokens, latencyMs: Date.now() - started };
      if (!r.text?.trim()) throw new AiProviderError('empty', 'Provedor de IA devolveu resposta vazia', true);
      if (r.text.includes(HANDOFF_TOKEN)) {
        // A IA pediu transferência sem o cliente pedir: proibido. Manda o resto do texto (ou o texto de falha) e segue com a IA.
        await prisma.aiUsage.create({ data: { ...base, success: true, handoff: false } });
        const rest = cleanAiText(r.text.split(HANDOFF_TOKEN).join(' ')).trim();
        console.warn('[ia] IA pediu transferência sem pedido do cliente: bloqueada, segue com a IA', { orgId, conversationId: conversationId || null });
        return { text: rest.length >= 8 ? rest : fail, handoff: false, failed: rest.length < 8, reason: 'IA não soube responder (transferência bloqueada: o cliente não pediu humano)', usedContext };
      }
      await prisma.aiUsage.create({ data: { ...base, success: true } });
      // Classificação da conversa (reunião / pedido / os dois) pelo marcador [TIPO:...].
      const intent = intentFromText(r.text);
      if (intent) await tagConversation(orgId, conversationId, intent).catch(() => undefined);
      // Marcador de agendamento: cria o compromisso (com checagem de conflito) e troca pelo link da agenda.
      // O marcador de pedido sai antes (o JSON dele tem colchetes) e é processado depois.
      const noOrder = stripJsonMarkers(r.text, 'PEDIDO');
      let booked: { text: string; appointmentId?: string } = await applyAgendaTag({ orgId, conversationId, text: noOrder, clientText: text, force: sdrBook }).catch((e) => {
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
      // Kanban automático: marcador [ETAPA:nome] move o contato (sempre retirado do texto).
      if (s.kanbanAuto || /\[ETAPA:/i.test(booked.text)) booked = { ...booked, text: await applyKanbanTag(orgId, conversationId, booked.text, s.kanbanAuto).catch(() => booked.text.replace(/\[ETAPA:[^\]]*\]/gi, '').trim()) };
      let out = stripVoiceMarkers(booked.text || cleanAiText(r.text));
      if (adv && out) out = estiloFinal(adv, out, [...history].reverse()); // v1.26.0: estilo WhatsApp (sem custo)
      if (!out) {
        console.warn('[ia] resposta sem texto útil: texto de falha enviado, sem transferir', { orgId, conversationId: conversationId || null });
        return { text: fail, handoff: false, failed: true, reason: 'IA não soube responder', usedContext };
      }
      return { text: out, handoff: false, usedContext };
    } catch (e) {
      lastErr = e;
      if (attempt === 1) firstErr = e;
      lastError = (e as Error).message;
      const code = e instanceof AiProviderError ? e.code : 'erro';
      console.warn('[ia] tentativa falhou', { orgId, conversationId: conversationId || null, attempt, model, code, detail: e instanceof AiProviderError ? e.detail : undefined, error: lastError });
      if (/não configurada|desconhecido|não pode ser usado/.test(lastError)) break; // erro de configuração: não adianta repetir
      // Erro definitivo (chave/modelo, 4xx) no modelo principal: não adianta repetir. No reserva (ex.: modelo
      // inexistente para esta chave), ainda vale a 3ª tentativa no principal se a 1ª falha foi passageira.
      if (e instanceof AiProviderError && !e.retryable && model === s.model) break;
    }
  }
  const reason = failureReason(lastErr);
  console.warn('[ia] sem resposta da IA, enviando fallback', { orgId, conversationId: conversationId || null, reason, error: lastError });
  await prisma.aiUsage.create({ data: { orgId, conversationId: conversationId || null, provider: s.provider, model: s.model, success: false, handoff: false, error: lastError.slice(0, 500), latencyMs: Date.now() - started } }).catch(() => undefined);
  return { text: fail, handoff: false, failed: true, reason, error: lastError, usedContext: false };
}
