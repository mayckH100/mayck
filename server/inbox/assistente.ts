/**
 * v1.44.0 — Assistente do atendente no Inbox: "Resumo" da conversa e "Sugerir resposta".
 * Usa a IA da própria empresa (aiChat), respeitando a cota da MCK IA e o limite de uso da IA.
 * Nada aqui envia mensagem ao cliente: a sugestão volta como rascunho para o atendente editar e enviar.
 */
import type { AiSettings } from '@prisma/client';
import { prisma } from '../db.js';
import { aiChat } from '../ai/core.js';
import { mckQuotaStatus, MCK_QUOTA_REASON } from '../ai/mckQuota.js';
import { retrieve } from '../ai/service.js';
import { HANDOFF_TOKEN } from '../ai/guard.js';
import { localClock } from '../mckmensagem/dispatcher.js';

export const ASSISTENTE_SEM_IA = 'Configure a IA (menu IA) com um provedor e chave para usar o assistente.';
const LIMITE_IA = 'Limite diário de uso da IA atingido. Volta amanhã ou aumente o limite em IA › Configurações.';

export interface LinhaConversa { direction: string; sender: string; type: string; body: string | null; transcript?: string | null; createdAt: Date }

const QUEM: Record<string, string> = { contact: 'Cliente', bot: 'Automação', ai: 'IA', agent: 'Atendente', system: 'Sistema' };

/** Texto da conversa para a IA (só mensagens trocadas, sem notas internas). Puro. */
export function transcricao(msgs: LinhaConversa[], maxChars = 6000): string {
  const linhas = msgs
    .filter((m) => m.direction === 'IN' || m.direction === 'OUT')
    .map((m) => {
      const texto = (m.transcript || m.body || '').replace(/\s+/g, ' ').trim();
      if (!texto) return null;
      return `${m.direction === 'IN' ? 'Cliente' : QUEM[m.sender] ?? 'Empresa'}: ${texto.slice(0, 600)}`;
    })
    .filter(Boolean) as string[];
  // Mantém o fim da conversa (o mais recente importa mais) dentro do limite.
  const out: string[] = [];
  let total = 0;
  for (let i = linhas.length - 1; i >= 0; i--) {
    total += linhas[i].length + 1;
    if (total > maxChars) break;
    out.unshift(linhas[i]);
  }
  return out.join('\n');
}

/** Limpa a resposta da IA: sem aspas em volta, sem "Resposta:", sem marcador de transferência. Puro. */
export function limparSaida(texto: string, maxLinhas?: number): string {
  let t = (texto || '').replace(HANDOFF_TOKEN, '').trim();
  t = t.replace(/^(sugest[aã]o( de resposta)?|resposta|resumo)\s*:\s*/i, '').trim();
  if (/^["“].*["”]$/s.test(t)) t = t.slice(1, -1).trim();
  if (maxLinhas) t = t.split('\n').map((l) => l.trimEnd()).filter((l) => l.trim()).slice(0, maxLinhas).join('\n');
  return t.slice(0, 2000);
}

export type IaAssistente = { ok: true; ai: AiSettings } | { ok: false; motivo: string };

/** A IA da empresa pode ser usada agora pelo assistente? (sem IA/chave, cota da MCK IA, limite diário) */
export async function iaDoAssistente(orgId: string, now = new Date()): Promise<IaAssistente> {
  const ai = await prisma.aiSettings.findUnique({ where: { orgId } }).catch(() => null);
  if (!ai) return { ok: false, motivo: ASSISTENTE_SEM_IA };
  if (ai.provider !== 'mck' && ai.provider !== 'fake' && !ai.apiKeyEnc) return { ok: false, motivo: ASSISTENTE_SEM_IA };
  if (ai.provider === 'mck' && (await mckQuotaStatus(orgId, now)).reached) return { ok: false, motivo: MCK_QUOTA_REASON };
  if (ai.usageLimitEnabled !== false) {
    const hoje = await prisma.aiUsage.count({ where: { orgId, createdAt: { gte: localClock(now).dayStart } } });
    if (hoje >= ai.dailyLimit) return { ok: false, motivo: LIMITE_IA };
  }
  return { ok: true, ai };
}

async function mensagensDa(orgId: string, conversationId: string): Promise<LinhaConversa[]> {
  const ult = await prisma.message.findMany({ where: { orgId, conversationId }, orderBy: { createdAt: 'desc' }, take: 60, select: { direction: true, sender: true, type: true, body: true, transcript: true, createdAt: true } });
  return ult.reverse();
}

export class AssistenteIndisponivel extends Error {}

/** Resumo da conversa em 3 a 5 linhas (com próximo passo). */
export async function resumirConversa(orgId: string, conversationId: string): Promise<string> {
  const ia = await iaDoAssistente(orgId);
  if (!ia.ok) throw new AssistenteIndisponivel(ia.motivo);
  const conversa = transcricao(await mensagensDa(orgId, conversationId));
  if (!conversa) throw new AssistenteIndisponivel('Ainda não há mensagens para resumir nesta conversa.');
  const system = [
    'Você ajuda o atendente de uma empresa a entender rapidamente uma conversa de WhatsApp com um cliente.',
    'Escreva um resumo em português do Brasil com 3 a 5 linhas curtas, cada uma começando com "• ".',
    'Inclua: o que o cliente quer, o que já foi informado ou combinado (valores, prazos, dados), o que está pendente e o próximo passo sugerido para o atendente.',
    'Use só o que está na conversa; não invente. Não cite empresas concorrentes. Não escreva nada além do resumo.',
  ].join('\n');
  const r = await aiChat({
    orgId, conversationId, purpose: 'assistente-resumo', settings: ia.ai,
    messages: [{ role: 'system', content: system }, { role: 'user', content: `CONVERSA:\n${conversa}` }],
    temperature: 0.2, maxTokens: 350, timeoutMs: 20000, retries: 1,
  });
  const t = limparSaida(r.text, 5);
  if (!t) throw new AssistenteIndisponivel('A IA não devolveu um resumo. Tente de novo.');
  return t;
}

/** Rascunho de resposta para o atendente (nunca é enviado sozinho). */
export async function sugerirResposta(orgId: string, conversationId: string, atendente?: string | null): Promise<string> {
  const ia = await iaDoAssistente(orgId);
  if (!ia.ok) throw new AssistenteIndisponivel(ia.motivo);
  const msgs = await mensagensDa(orgId, conversationId);
  const conversa = transcricao(msgs);
  if (!conversa) throw new AssistenteIndisponivel('Ainda não há mensagens nesta conversa para sugerir uma resposta.');
  const ultimasDoCliente = msgs.filter((m) => m.direction === 'IN').slice(-3).map((m) => m.transcript || m.body || '').join('\n');
  const trechos = ultimasDoCliente.trim() ? await retrieve(orgId, ultimasDoCliente, 4).catch(() => []) : [];
  const contexto = trechos.map((t) => t.item.text).join('\n---\n').slice(0, 3500);
  const s = ia.ai;
  const system = [
    'Você escreve um RASCUNHO de resposta para o atendente humano de uma empresa enviar ao cliente no WhatsApp. O atendente vai revisar antes de enviar.',
    `Português do Brasil, tom ${s.tone || 'cordial e objetivo'}, mensagem curta e humana (até 4 frases), no máximo 1 emoji.`,
    'Responda ao que o cliente perguntou por último, considerando a conversa toda.',
    'Use valores, prazos e regras SOMENTE se aparecerem nas instruções da empresa, no CONTEXTO ou na conversa. Se faltar uma informação, escreva que vai confirmar.',
    'Não cite empresas concorrentes. Não diga que é uma IA. Não assine com nome, a não ser que o atendente se chame como indicado abaixo.',
    atendente ? `O atendente se chama ${atendente.split(/\s+/)[0]}.` : '',
    'Responda SOMENTE com o texto da mensagem, sem aspas e sem explicações.',
    s.instructions?.trim() ? `\n### INSTRUÇÕES DA EMPRESA\n${s.instructions.slice(0, 3000)}` : '',
    contexto ? `\n### CONTEXTO (base de conhecimento; não cite o nome das fontes)\n${contexto}` : '',
  ].filter(Boolean).join('\n');
  const r = await aiChat({
    orgId, conversationId, purpose: 'assistente-sugestao', settings: s,
    messages: [{ role: 'system', content: system }, { role: 'user', content: `CONVERSA:\n${conversa}\n\nEscreva a resposta do atendente agora.` }],
    temperature: 0.4, maxTokens: 350, timeoutMs: 20000, retries: 1,
  });
  const t = limparSaida(r.text);
  if (!t) throw new AssistenteIndisponivel('A IA não devolveu uma sugestão. Tente de novo.');
  return t;
}
