import type { SdrLead } from '@prisma/client';
import { prisma } from '../db.js';
import { type ChatMessage } from '../ai/providers.js';
import { aiChat } from '../ai/core.js';
import { mckQuotaStatus } from '../ai/mckQuota.js';
import type { Step } from './core.js';
import { notAutoReply } from './autoReply.js';

/**
 * SDR fase 2 (v1.21.0) — follow-up personalizado pela IA (opcional, desligado por padrão). Reescreve o texto do passo
 * da cadência usando o histórico da conversa e o resumo do lead, mantendo o objetivo do passo. Respeita a cota diária
 * da MCK IA; qualquer falha (sem IA, cota, provedor fora, resposta ruim) devolve null e o passo sai com o texto padrão.
 * O lead nunca vê erro, e nada sobre provedores é mostrado à empresa (só fica no registro de uso, como as demais chamadas).
 */
export function followupPrompt(step: Step, baseText: string, lead: Pick<SdrLead, 'name' | 'company' | 'aiSummary'>, transcript: string): ChatMessage[] {
  const canal = step.canal === 'EMAIL' ? 'e-mail' : 'WhatsApp';
  return [
    { role: 'system', content: [
      `Você escreve uma mensagem de acompanhamento (follow-up) de vendas por ${canal}, em português do Brasil.`,
      'Reescreva a MENSAGEM BASE personalizando com o que o cliente já disse na conversa (dor, interesse, dúvidas). Mantenha o objetivo, o tom cordial e o tamanho parecido.',
      'Regras: não invente preço, desconto, prazo, condição ou fato que não esteja na mensagem base ou na conversa; não mencione que é IA nem que está personalizando; não use placeholders; não inclua assinatura de pessoa.',
      step.canal === 'WHATSAPP' ? 'Para WhatsApp: no máximo 400 caracteres, sem assunto.' : 'Para e-mail: só o corpo do e-mail (sem assunto), até 900 caracteres.',
      'Responda SOMENTE com o texto final da mensagem.',
    ].join('\n') },
    { role: 'user', content: `LEAD: ${lead.name ?? 'sem nome'}${lead.company ? ` (${lead.company})` : ''}\nRESUMO: ${lead.aiSummary ?? '—'}\nCONVERSA (mais recente por último):\n${transcript || '(sem conversa)'}\n\nMENSAGEM BASE:\n${baseText}` },
  ];
}

/** Limpa e valida o texto da IA; null quando não serve (vazio, placeholder, longo demais). */
export function cleanFollowup(raw: string | null | undefined, step: Step): string | null {
  let t = String(raw ?? '').replace(/^```[a-z]*\n?|```$/gi, '').trim().replace(/^["“]|["”]$/g, '').trim();
  if (!t || t.length < 10) return null;
  if (/\{[a-z_]+\}|\[(nome|empresa|seu nome)[^\]]*\]/i.test(t)) return null;
  // v1.35.0: marcador interno (transferência, plano, agenda) nunca vai para o lead.
  if (/\[(TRANSFERIR|PLANO|AGENDAR|PEDIDO|ETAPA|TIPO)\b/i.test(t)) return null;
  if (t.length > (step.canal === 'WHATSAPP' ? 600 : 1500)) return null;
  t = t.replace(/^assunto:.*\n+/i, '');
  return t;
}

export async function personalizeStep(lead: SdrLead, step: Step, baseText: string): Promise<string | null> {
  let ai: Awaited<ReturnType<typeof prisma.aiSettings.findUnique>> = null;
  try {
    ai = await prisma.aiSettings.findUnique({ where: { orgId: lead.orgId } });
    if (!ai || !ai.enabled) return null;
    if (ai.provider === 'mck' && (await mckQuotaStatus(lead.orgId)).reached) return null;
    let transcript = '';
    if (lead.contactId) {
      const convs = await prisma.conversation.findMany({ where: { orgId: lead.orgId, contactId: lead.contactId }, select: { id: true }, take: 20 });
      const msgs = await prisma.message.findMany({ where: { orgId: lead.orgId, conversationId: { in: convs.map((c) => c.id) }, direction: { in: ['IN', 'OUT'] }, status: { not: 'FAILED' }, ...notAutoReply }, orderBy: { createdAt: 'desc' }, take: 12 });
      transcript = msgs.reverse().map((m) => `${m.direction === 'IN' ? 'CLIENTE' : 'EMPRESA'}: ${(m.body ?? '').slice(0, 400)}`).join('\n');
    }
    // v1.35.0: camada única (modelo reserva, timeout, registro com finalidade).
    const r = await aiChat({ orgId: lead.orgId, purpose: 'sdr-followup', settings: ai, messages: followupPrompt(step, baseText, lead, transcript), temperature: 0.4, maxTokens: 400, timeoutMs: 20000, errorPrefix: 'SDR follow-up' });
    return cleanFollowup(r.text, step);
  } catch {
    return null;
  }
}
