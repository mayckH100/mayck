import { prisma } from '../db.js';
import { decryptOrNull } from '../lib/crypto.js';
import { createProvider, type ChatMessage } from '../ai/providers.js';
import { retrieve } from '../ai/service.js';
import { sendOutbound, handoffToHuman } from '../whatsapp/messaging.js';
import { isProductActive } from '../billing/service.js';
import { parseJson } from '../lib/json.js';
import { personalize, inWindow } from './dispatcher.js';
import type { Contact, Conversation, Lead, LeadAiSettings } from '@prisma/client';

/**
 * IA de qualificação de leads (MCK Mensagens).
 *
 * Quando um lead abordado por campanha responde, a IA lê a resposta e decide a intenção:
 *  - POSITIVO → lead QUALIFICADO; a IA confirma e apresenta o próximo passo (oferta) e a conversa segue
 *    a ação configurada: atendente humano (HANDOFF), um fluxo do MCKBOT (FLOW) ou o robô/IA normal (BOT).
 *  - NEGATIVO → lead AGUARDANDO; a IA agradece sem insistir e agenda nova tentativa em N dias.
 *    Depois de `maxAttempts` negativas o lead vira DESCARTADO e não é mais abordado.
 *  - DUVIDA   → a IA responde a dúvida (base de conhecimento) e conduz de volta para a qualificação.
 *  - SAIR     → opt-out: não recebe mais mensagens.
 */

export type Intent = 'POSITIVO' | 'NEGATIVO' | 'DUVIDA' | 'SAIR';
export const QUALIFYING_STATUSES = ['CONTATADO', 'RESPONDEU', 'AGUARDANDO'];

export const DEFAULT_LEAD_AI = {
  enabled: false,
  instructions: '',
  offer: '',
  positiveAction: 'HANDOFF',
  positiveFlowId: null as string | null,
  retryDays: 3,
  maxAttempts: 3,
  promptTemplate: null as string | null,
  positiveMessage: '',
  negativeAction: 'RETRY', // RETRY (aguardar e tentar de novo) | FLOW | HANDOFF | DISCARD
  negativeFlowId: null as string | null,
  doubtAction: 'AI', // AI (IA responde) | FLOW | HANDOFF
  doubtFlowId: null as string | null,
  tagPositive: 'lead-qualificado',
  tagWaiting: 'lead-aguardando',
  tagDiscarded: 'lead-descartado',
  retryMessage: 'Oi {nome}! Passando de novo por aqui 😊 Ainda posso te ajudar? Se quiser, te mando mais detalhes, sem compromisso.',
};

export async function getLeadAiSettings(orgId: string): Promise<typeof DEFAULT_LEAD_AI> {
  const row = await prisma.leadAiSettings.findUnique({ where: { orgId } });
  if (!row) return { ...DEFAULT_LEAD_AI };
  const { orgId: _o, updatedAt: _u, ...rest } = row as LeadAiSettings;
  return rest;
}

/**
 * Prompt editável pelo cliente (texto com variáveis). Vazio/nulo = este padrão.
 * Variáveis: {tom} {sobre_empresa} {como_abordar} {proximo_passo} {nome} {tentativas} {max_tentativas}
 */
export const DEFAULT_PROMPT_TEMPLATE = [
  'Você é a assistente de pré-vendas da empresa no WhatsApp. Seu trabalho é QUALIFICAR o lead: descobrir com leveza se ele tem interesse e levá-lo ao próximo passo.',
  'Este lead autorizou contato e recebeu uma mensagem da empresa. Agora ele respondeu.',
  'Tom de voz: {tom}. Português do Brasil, mensagens curtas (no máximo 3 frases), no máximo 1 emoji.',
  '',
  'Sobre a empresa:',
  '{sobre_empresa}',
  '',
  'Como abordar e qualificar:',
  '{como_abordar}',
  '',
  'Próximo passo para quem tem interesse: {proximo_passo}.',
  'Nome do lead: {nome}. Tentativas sem interesse até agora: {tentativas} de {max_tentativas}.',
  '',
  'COMO CLASSIFICAR A ÚLTIMA MENSAGEM DO LEAD:',
  '- POSITIVO: demonstra interesse ("quero", "sim", "quanto custa", "pode mandar", pergunta como contratar ou agendar).',
  '- NEGATIVO: recusa agora ("não", "agora não", "sem dinheiro", "já tenho", "depois eu vejo", "não tenho interesse").',
  '- DUVIDA: faz uma pergunta ou comentário sem decidir (sobre o produto, condições, prazos, como funciona).',
  '- SAIR: pede para não receber mais mensagens, reclama do contato ou pede para ser removido.',
  '',
  'COMO RESPONDER EM CADA CASO:',
  '- POSITIVO: comemore com naturalidade, confirme o interesse e apresente o próximo passo. Faça no máximo uma pergunta simples para avançar.',
  '- NEGATIVO: agradeça e respeite a decisão, sem insistir nem pressionar. Diga que fica à disposição. Nunca mencione que vai mandar outra mensagem.',
  '- DUVIDA: responda a dúvida usando a BASE e termine convidando para o próximo passo.',
  '- SAIR: peça desculpas pelo incômodo em uma frase e confirme que não vai mais enviar mensagens.',
  '- Ao falar do próximo passo, use exatamente as condições escritas acima (duração, quantidade, valores). Não troque nem misture números.',
  '- Use valores e regras exatamente como aparecem nas informações da empresa ou na BASE. Se não souber, diga que vai confirmar. Nunca invente preço.',
].join('\n');

export const PROMPT_VARIABLES = ['{tom}', '{sobre_empresa}', '{como_abordar}', '{proximo_passo}', '{nome}', '{tentativas}', '{max_tentativas}'];

/** Parte fixa (não editável): formato da saída que o sistema lê. Sem ela a classificação quebra. */
export function lockedPromptTail(knowledge: string): string {
  return [
    '',
    'FORMATO DA SUA SAÍDA (obrigatório): responda SOMENTE com um JSON válido em uma linha, sem texto antes ou depois:',
    '{"intencao":"POSITIVO|NEGATIVO|DUVIDA|SAIR","resposta":"mensagem para enviar ao lead","resumo":"até 15 palavras sobre o lead"}',
    'intencao: POSITIVO = tem interesse; NEGATIVO = não quer agora; DUVIDA = pergunta sem decidir; SAIR = não quer mais receber mensagens.',
    '',
    '### BASE',
    knowledge || '(sem informações relevantes)',
    '### FIM',
  ].join('\n');
}

/** Prompt de sistema da qualificação. Exportado para a tela mostrar e para os testes. */
export function buildQualifyPrompt(s: Pick<LeadAiSettings, 'instructions' | 'offer'> & { promptTemplate?: string | null }, ctx: { tone: string; companyInstructions: string; knowledge: string; leadName: string; attempts: number; maxAttempts: number }): string {
  const vars: Record<string, string> = {
    tom: ctx.tone || 'cordial, próximo e objetivo',
    sobre_empresa: ctx.companyInstructions || '(veja a BASE)',
    como_abordar: s.instructions || '(descubra o interesse com perguntas simples)',
    proximo_passo: s.offer || 'um atendente vai continuar o atendimento',
    nome: ctx.leadName || '(desconhecido)',
    tentativas: String(ctx.attempts),
    max_tentativas: String(ctx.maxAttempts),
  };
  const tpl = s.promptTemplate?.trim() || DEFAULT_PROMPT_TEMPLATE;
  const body = tpl.replace(/\{\s*(tom|sobre_empresa|como_abordar|proximo_passo|nome|tentativas|max_tentativas)\s*\}/g, (_m, k: string) => vars[k]);
  return body + '\n' + lockedPromptTail(ctx.knowledge);
}

const INTENTS: Intent[] = ['POSITIVO', 'NEGATIVO', 'DUVIDA', 'SAIR'];

/** Lê o JSON da IA de forma tolerante (cercas de código, texto em volta). */
export function parseQualifyOutput(raw: string): { intencao: Intent; resposta: string; resumo: string } | null {
  if (!raw) return null;
  const cleaned = raw.replace(/```(json)?/gi, '').trim();
  const start = cleaned.indexOf('{'), end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const j = JSON.parse(cleaned.slice(start, end + 1));
    const intencao = String(j.intencao ?? j.intent ?? '').toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '') as Intent;
    if (!INTENTS.includes(intencao)) return null;
    return { intencao, resposta: String(j.resposta ?? '').trim(), resumo: String(j.resumo ?? '').trim().slice(0, 200) };
  } catch {
    return null;
  }
}

export interface QualifyResult { intent: Intent; reply: string; summary: string; error?: string }

/** Chama o provedor de IA (mesma configuração da IA do MCKBOT) e classifica a mensagem. */
export async function classifyLeadMessage(orgId: string, lead: Pick<Lead, 'name' | 'qualifyAttempts'>, text: string, history: ChatMessage[] = [], conversationId?: string): Promise<QualifyResult> {
  const ai = await prisma.aiSettings.findUnique({ where: { orgId } });
  const s = await getLeadAiSettings(orgId);
  if (!ai) throw new Error('Configure a IA (provedor e chave) no MCKBOT > IA antes de usar a qualificação.');
  const hits = await retrieve(orgId, text, 3);
  const knowledge = hits.map((h) => `[${h.item.title}]\n${h.item.text}`).join('\n\n');
  const system = buildQualifyPrompt(s as any, {
    tone: ai.tone, companyInstructions: ai.instructions, knowledge,
    leadName: (lead.name ?? '').split(/\s+/)[0] ?? '', attempts: lead.qualifyAttempts ?? 0, maxAttempts: s.maxAttempts,
  });
  // Histórico precisa terminar com o usuário (Gemini recusa conversa terminando em "model").
  const msgs: ChatMessage[] = [{ role: 'system', content: system }, ...history.filter((m) => m.content), { role: 'user', content: text }];
  const started = Date.now();
  let lastError = '';
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const provider = createProvider(ai.provider, decryptOrNull(ai.apiKeyEnc), ai.baseUrl);
      const r = await provider.chat(msgs, { model: ai.model, temperature: 0.3, maxTokens: Math.max(300, ai.maxTokens) });
      await prisma.aiUsage.create({ data: { orgId, conversationId: conversationId ?? null, provider: ai.provider, model: ai.model, promptTokens: r.promptTokens, completionTokens: r.completionTokens, latencyMs: Date.now() - started, success: true } });
      const parsed = parseQualifyOutput(r.text);
      if (parsed) return { intent: parsed.intencao, reply: parsed.resposta, summary: parsed.resumo };
      lastError = 'Resposta da IA fora do formato esperado';
      // Sem JSON: trata como dúvida e usa o texto, se houver.
      if (r.text && !r.text.trim().startsWith('{')) return { intent: 'DUVIDA', reply: r.text.trim(), summary: '', error: lastError };
    } catch (e) {
      lastError = (e as Error).message;
      await prisma.aiUsage.create({ data: { orgId, conversationId: conversationId ?? null, provider: ai.provider, model: ai.model, success: false, error: lastError.slice(0, 500), latencyMs: Date.now() - started } }).catch(() => undefined);
      if (/não configurada|desconhecido|não pode ser usado/.test(lastError)) break;
    }
  }
  throw new Error(lastError || 'Falha na IA de qualificação');
}

function phoneOf(waId: string): string | null {
  return waId.includes('@') ? null : '+' + waId.replace(/\D/g, '');
}

async function findQualifyingLead(orgId: string, contact: Pick<Contact, 'id' | 'waId'>) {
  const phone = phoneOf(contact.waId);
  const or: any[] = [{ contactId: contact.id }];
  if (phone) or.push({ phone });
  return prisma.lead.findFirst({ where: { orgId, optOutAt: null, status: { in: QUALIFYING_STATUSES }, OR: or }, orderBy: { updatedAt: 'desc' } });
}

async function note(conv: Conversation, body: string) {
  await prisma.message.create({ data: { orgId: conv.orgId, conversationId: conv.id, direction: 'INTERNAL', sender: 'system', type: 'note', body, status: 'NOTE' } });
}

/**
 * Chamado pelo inbound (modo robô). Retorna true quando a IA de qualificação cuidou da mensagem
 * (aí o MCKBOT não roda fluxos/IA normal para ela).
 */
export async function qualifyLeadInbound(conv: Conversation, contact: Contact, text: string): Promise<boolean> {
  if (!text?.trim()) return false;
  const s = await getLeadAiSettings(conv.orgId);
  if (!s.enabled) return false;
  if (!(await isProductActive(conv.orgId, 'MCKMENSAGEM'))) return false;
  const lead = await findQualifyingLead(conv.orgId, contact);
  if (!lead) return false;

  const recent = await prisma.message.findMany({
    where: { orgId: conv.orgId, conversationId: conv.id, direction: { in: ['IN', 'OUT'] }, status: { not: 'FAILED' } },
    orderBy: { createdAt: 'desc' }, take: 9,
  });
  // Remove a mensagem atual (já gravada) e garante que o histórico termine em "assistant" antes do texto do usuário.
  const hist = recent.reverse().slice(0, -1).map((m) => ({ role: (m.direction === 'IN' ? 'user' : 'assistant') as 'user' | 'assistant', content: m.body ?? '' }));

  let r: QualifyResult;
  try {
    r = await classifyLeadMessage(conv.orgId, lead, text, hist, conv.id);
  } catch (e) {
    await note(conv, `IA de qualificação falhou (${(e as Error).message.slice(0, 200)}). A mensagem seguiu para o atendimento normal.`);
    return false;
  }

  const now = new Date();
  const send = async (t: string) => { if (t) await sendOutbound({ conversation: conv, contact, payload: { type: 'text', text: t }, sender: 'ai', product: 'MCKMENSAGEM' } as any); };
  const tags = new Set(parseJson<string[]>(contact.tags, []));
  const setTag = async (add: string, remove: string[] = []) => {
    remove.forEach((x) => tags.delete(x)); tags.add(add);
    await prisma.contact.update({ where: { id: contact.id }, data: { tags: JSON.stringify([...tags]) } });
  };

  const runAction = async (action: string, flowId: string | null, reason: string) => {
    if (action === 'HANDOFF') return handoffToHuman(conv, reason);
    if (action === 'FLOW' && flowId) {
      const { startFlow } = await import('../flows/engine.js');
      try { await startFlow(flowId, conv, contact, { lastMessage: text }); } catch (e) { await note(conv, `Não foi possível iniciar o fluxo (${reason}): ${(e as Error).message}`); }
    }
  };
  const allTags = [s.tagPositive, s.tagWaiting, s.tagDiscarded].filter(Boolean);

  switch (r.intent) {
    case 'POSITIVO': {
      await prisma.lead.update({ where: { id: lead.id }, data: { status: 'QUALIFICADO', qualifiedAt: now, lastIntent: 'POSITIVO', aiSummary: r.summary || lead.aiSummary, nextAttemptAt: null, contactId: contact.id } });
      if (s.tagPositive) await setTag(s.tagPositive, allTags);
      await send(r.reply);
      if (s.positiveMessage?.trim()) await send(personalize(s.positiveMessage, lead));
      await note(conv, `Lead qualificado pela IA (interessado).${r.summary ? ' Resumo: ' + r.summary : ''}`);
      await runAction(s.positiveAction, s.positiveFlowId, 'Lead qualificado: interessado');
      return true;
    }
    case 'NEGATIVO': {
      const attempts = (lead.qualifyAttempts ?? 0) + 1;
      const discard = s.negativeAction === 'DISCARD' || (s.negativeAction === 'RETRY' && attempts >= s.maxAttempts);
      const next = s.negativeAction === 'RETRY' && !discard ? new Date(now.getTime() + s.retryDays * 86400e3) : null;
      const status = discard ? 'DESCARTADO' : s.negativeAction === 'RETRY' ? 'AGUARDANDO' : 'RESPONDEU';
      await prisma.lead.update({ where: { id: lead.id }, data: { status, qualifyAttempts: attempts, nextAttemptAt: next, lastIntent: 'NEGATIVO', aiSummary: r.summary || lead.aiSummary, contactId: contact.id } });
      const tag = discard ? s.tagDiscarded : s.negativeAction === 'RETRY' ? s.tagWaiting : '';
      if (tag) await setTag(tag, allTags);
      await send(r.reply);
      await note(conv, discard
        ? `Lead sem interesse (${attempts}ª vez): marcado como Descartado (não será mais abordado).`
        : next ? `Lead sem interesse agora (${attempts}/${s.maxAttempts}). Em aguardo: nova tentativa em ${next.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' })}.`
        : 'Lead sem interesse agora.');
      if (s.negativeAction === 'FLOW' || s.negativeAction === 'HANDOFF') await runAction(s.negativeAction, s.negativeFlowId, 'Lead sem interesse');
      return true;
    }
    case 'SAIR': {
      const { onLeadOptOut } = await import('./hooks.js');
      await send(r.reply || 'Tudo bem, desculpe o incômodo. Não vamos mais te enviar mensagens.');
      await prisma.contact.update({ where: { id: contact.id }, data: { optOut: true } });
      await onLeadOptOut(conv.orgId, contact, now);
      await prisma.lead.update({ where: { id: lead.id }, data: { status: 'DESCARTADO', lastIntent: 'SAIR', nextAttemptAt: null } });
      await note(conv, 'Lead pediu para não receber mais mensagens (opt-out pela IA de qualificação).');
      return true;
    }
    default: {
      await prisma.lead.update({ where: { id: lead.id }, data: { status: 'RESPONDEU', lastIntent: 'DUVIDA', aiSummary: r.summary || lead.aiSummary, contactId: contact.id } });
      if (s.doubtAction === 'AI') { await send(r.reply); return true; }
      await runAction(s.doubtAction, s.doubtFlowId, 'Lead com dúvida');
      return true;
    }
  }
}

/** Agendador: reaborda leads em AGUARDANDO cuja data chegou (dentro da janela da campanha). Um envio por chamada por org. */
export async function tickLeadRetries(now = new Date()): Promise<number> {
  const due = await prisma.lead.findMany({ where: { status: 'AGUARDANDO', nextAttemptAt: { lte: now }, optOutAt: null }, orderBy: { nextAttemptAt: 'asc' }, take: 20 });
  let sent = 0;
  const doneOrgs = new Set<string>();
  for (const lead of due) {
    if (doneOrgs.has(lead.orgId)) continue;
    const s = await getLeadAiSettings(lead.orgId);
    if (!s.enabled || !(await isProductActive(lead.orgId, 'MCKMENSAGEM'))) continue;
    const camp = lead.campaignId ? await prisma.campaign.findFirst({ where: { id: lead.campaignId, orgId: lead.orgId } }) : null;
    if (!inWindow(camp ?? { windowStart: '09:00', windowEnd: '20:00' }, now)) continue;
    const contact = lead.contactId ? await prisma.contact.findFirst({ where: { id: lead.contactId, orgId: lead.orgId } }) : null;
    if (!contact || contact.optOut) {
      await prisma.lead.update({ where: { id: lead.id }, data: { nextAttemptAt: null } });
      continue;
    }
    let conv = await prisma.conversation.findFirst({ where: { orgId: lead.orgId, contactId: contact.id, status: { not: 'CLOSED' } }, orderBy: { createdAt: 'desc' } });
    const channelId = camp?.channelId ?? conv?.channelId ?? null;
    if (!channelId) continue;
    conv ??= await prisma.conversation.create({ data: { orgId: lead.orgId, contactId: contact.id, channelId } });
    if (conv.mode === 'HUMAN') { // um atendente está cuidando: não reaborda
      await prisma.lead.update({ where: { id: lead.id }, data: { nextAttemptAt: null } });
      continue;
    }
    // Claim atômico para não enviar duas vezes.
    const claimed = await prisma.lead.updateMany({ where: { id: lead.id, status: 'AGUARDANDO', nextAttemptAt: lead.nextAttemptAt }, data: { status: 'CONTATADO', nextAttemptAt: null } });
    if (claimed.count !== 1) continue;
    const msg = await sendOutbound({ conversation: conv, contact, payload: { type: 'text', text: personalize(s.retryMessage, lead) }, sender: 'bot', product: 'MCKMENSAGEM' } as any);
    if (msg.status === 'FAILED') {
      await prisma.lead.update({ where: { id: lead.id }, data: { status: 'AGUARDANDO', nextAttemptAt: new Date(now.getTime() + 3600e3) } });
      continue;
    }
    await note(conv, `Nova tentativa automática enviada ao lead (IA de qualificação, tentativa ${lead.qualifyAttempts + 1}).`);
    doneOrgs.add(lead.orgId);
    sent++;
  }
  return sent;
}
