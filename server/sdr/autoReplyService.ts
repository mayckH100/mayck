import type { Conversation, SdrLead } from '@prisma/client';
import { prisma } from '../db.js';
import { leadPhoneOfWaId } from '../mckmensagem/contactSync.js';
import { detectAutoReply, normalizeText, notAutoReply, type AutoReplyResult } from './autoReply.js';
import { getAutoReplyConfig, type AutoReplyConfig } from './autoReplyConfig.js';

/**
 * Resposta automática (v1.22.0) — parte com banco: contexto (tempo desde o nosso envio, repetição), dúvida opcional
 * pela MCK IA e o registro (nota na conversa, evento no lead do SDR, pausa opcional da cadência).
 * Nunca lança: em qualquer erro a mensagem segue o caminho normal (como antes).
 */

const DIA = 86400e3;
/** Só olha mensagens que chegam depois de um envio nosso recente (campanha, cadência, IA ou fluxo). */
const JANELA_ENVIO_MS = 7 * DIA;

/**
 * Mensagem de texto recebida no WhatsApp: é resposta automática? Só analisa quando a empresa mandou algo para esta
 * conversa nos últimos 7 dias (quem chama primeiro nunca é marcado). Retorna null quando desligado ou sem envio nosso.
 */
export async function checkWhatsappAutoReply(args: { orgId: string; conversationId: string; contactId: string; text: string; now?: Date }): Promise<(AutoReplyResult & { iaConsultada?: boolean }) | null> {
  try {
    const { orgId, conversationId, contactId } = args;
    const text = (args.text ?? '').trim();
    if (!text) return null;
    const cfg = await getAutoReplyConfig(orgId);
    if (!cfg.enabled) return null;
    const now = args.now ?? new Date();
    const lastOut = await prisma.message.findFirst({
      where: { orgId, conversationId, direction: 'OUT', status: { not: 'FAILED' }, createdAt: { gte: new Date(now.getTime() - JANELA_ENVIO_MS), lte: new Date(now.getTime() + 5_000) } },
      orderBy: { createdAt: 'desc' }, select: { createdAt: true },
    });
    if (!lastOut) return null;
    const repetida = await isRepeated(orgId, contactId, text);
    // Conversa em andamento (o contato escreveu de verdade nos 30 min antes do nosso envio): responder rápido é normal,
    // então o sinal de tempo não vale (só o texto).
    const ativa = await prisma.message.findFirst({ where: { orgId, conversationId, direction: 'IN', createdAt: { gte: new Date(lastOut.createdAt.getTime() - 30 * 60_000), lte: lastOut.createdAt }, ...notAutoReply }, select: { id: true } });
    const msDesdeEnvio = ativa ? null : Math.max(0, now.getTime() - lastOut.createdAt.getTime());
    let det: AutoReplyResult & { iaConsultada?: boolean } = detectAutoReply(text, { msDesdeEnvio, repetida, frasesExtras: cfg.frases });
    if (cfg.iaDuvida && det.confianca === 'media' && !det.humano) {
      const ia = await askMckIa(orgId, conversationId, text).catch(() => null);
      if (ia !== null) det = { ...det, automatica: ia, iaConsultada: true, motivo: `${det.motivo}; confirmado pela MCK IA` };
    }
    return det;
  } catch (e) {
    console.error('[sdr] falha ao verificar resposta automática', { orgId: args.orgId, error: (e as Error).message });
    return null;
  }
}

/** Mesmo texto (sem acento/maiúsculas) já recebido antes deste contato, em qualquer WhatsApp da empresa. */
async function isRepeated(orgId: string, contactId: string, text: string): Promise<boolean> {
  const n = normalizeText(text);
  if (n.length < 15) return false;
  const convs = await prisma.conversation.findMany({ where: { orgId, contactId }, select: { id: true }, take: 20 });
  if (!convs.length) return false;
  const prev = await prisma.message.findMany({ where: { orgId, conversationId: { in: convs.map((c) => c.id) }, direction: 'IN' }, orderBy: { createdAt: 'desc' }, take: 50, select: { body: true } });
  return prev.some((m) => normalizeText(m.body ?? '') === n);
}

/**
 * Dúvida (confiança média): pergunta à MCK IA "automática ou pessoa?" — só quando a empresa ligou, respeitando a cota
 * diária da MCK IA. Retorna null se não deu para perguntar (cota, falha, resposta fora do formato).
 */
async function askMckIa(orgId: string, conversationId: string, text: string): Promise<boolean | null> {
  const { mckQuotaStatus } = await import('../ai/mckQuota.js');
  if ((await mckQuotaStatus(orgId)).reached) return null;
  const { createProvider } = await import('../ai/providers.js');
  const started = Date.now();
  try {
    const r = await createProvider('mck', null).chat([
      { role: 'system', content: 'Você classifica UMA mensagem recebida no WhatsApp logo depois que a empresa enviou uma mensagem. Responda só AUTO se for resposta automática (saudação/ausência de empresa, menu, horário de atendimento, "estou dirigindo", férias, não perturbe) ou HUMANO se for uma pessoa respondendo de verdade.' },
      { role: 'user', content: text.slice(0, 800) },
    ], { model: 'mck', temperature: 0, maxTokens: 5, timeoutMs: 8000 });
    await prisma.aiUsage.create({ data: { orgId, conversationId, provider: 'mck', model: 'mck-autoresposta', promptTokens: r.promptTokens, completionTokens: r.completionTokens, latencyMs: Date.now() - started, success: true } }).catch(() => undefined);
    const out = r.text.trim().toUpperCase();
    return out.startsWith('AUTO') ? true : out.startsWith('HUMANO') ? false : null;
  } catch (e) {
    await prisma.aiUsage.create({ data: { orgId, conversationId, provider: 'mck', model: 'mck-autoresposta', success: false, error: `Resposta automática: ${(e as Error).message}`.slice(0, 500), latencyMs: Date.now() - started } }).catch(() => undefined);
    return null;
  }
}

/** Texto da pausa para o histórico. */
const pausaTxt = (cfg: AutoReplyConfig) => (cfg.acao === 'PAUSAR' ? ` Cadência pausada por ${cfg.pausaHoras} h.` : ' A cadência segue normalmente.');

/** Aplica a opção "pausar X horas" a um lead do SDR com cadência em andamento (nunca adianta um passo). */
async function pauseIfConfigured(lead: SdrLead, cfg: AutoReplyConfig, now: Date): Promise<boolean> {
  if (cfg.acao !== 'PAUSAR' || !['ESPERA', 'ATIVA'].includes(lead.cadenceStatus)) return false;
  const until = new Date(now.getTime() + cfg.pausaHoras * 3600e3);
  if (lead.nextStepAt && lead.nextStepAt >= until) return false;
  await prisma.sdrLead.update({ where: { id: lead.id }, data: { nextStepAt: until } });
  return true;
}

/** Registra no lead do SDR (evento AUTORESPOSTA) e aplica a pausa opcional. Nunca muda etapa nem para a cadência. */
export async function logAutoReplyOnLead(lead: SdrLead, channel: 'WHATSAPP' | 'EMAIL', motivo: string, now = new Date()): Promise<void> {
  const { logEvent } = await import('./service.js');
  const cfg = await getAutoReplyConfig(lead.orgId);
  const paused = await pauseIfConfigured(lead, cfg, now);
  await logEvent(lead.orgId, lead.id, 'AUTORESPOSTA', channel, `${motivo}.${paused ? pausaTxt(cfg) : ' A cadência segue normalmente.'}`);
}

/**
 * Resposta automática recebida no WhatsApp: nota na conversa (a equipe vê o selo e o motivo) e evento nos leads do SDR
 * da mesma pessoa. Não mexe no lead do MCK Mensagens (continua "Contatado"), não qualifica, não responde. Nunca lança.
 */
export async function onWhatsappAutoReply(conv: Pick<Conversation, 'id' | 'orgId'>, contact: { id: string; waId: string }, det: AutoReplyResult, now = new Date()): Promise<void> {
  try {
    const cfg = await getAutoReplyConfig(conv.orgId);
    await prisma.message.create({ data: { orgId: conv.orgId, conversationId: conv.id, direction: 'INTERNAL', sender: 'system', type: 'note', body: `🤖 Resposta automática identificada (${det.motivo}). Não conta como resposta do contato: a IA não respondeu, nada foi qualificado e o funil não mudou.${pausaTxt(cfg)} Aguardando a próxima resposta de uma pessoa.`, status: 'NOTE' } });
    const phone = leadPhoneOfWaId(contact.waId);
    const leads = await prisma.sdrLead.findMany({ where: { orgId: conv.orgId, optOutAt: null, OR: [{ contactId: contact.id }, ...(phone ? [{ phone }] : [])] } });
    for (const l of leads) await logAutoReplyOnLead(l, 'WHATSAPP', det.motivo, now);
    console.info('[sdr] resposta automática ignorada', { orgId: conv.orgId, conversationId: conv.id, confianca: det.confianca, leads: leads.map((l) => l.id) });
  } catch (e) {
    console.error('[sdr] falha ao registrar resposta automática', { orgId: conv.orgId, error: (e as Error).message });
  }
}
