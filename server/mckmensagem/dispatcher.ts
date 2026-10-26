import { prisma } from '../db.js';
import { sendOutbound } from '../whatsapp/messaging.js';
import { TZ } from './constants.js';
import { isProductActive } from '../billing/service.js';
import type { Campaign, Lead } from '@prisma/client';

type Sender = typeof sendOutbound;
let sender: Sender = sendOutbound;
/** Permite substituir o envio (somente testes). */
export function setSender(fn: Sender | null) { sender = fn ?? sendOutbound; }

let random: () => number = Math.random;
export function setRandom(fn: (() => number) | null) { random = fn ?? Math.random; }

/** Próximo envio permitido por campanha (intervalo aleatório entre min e max). */
const nextAt = new Map<string, number>();
export function resetDispatcherState() { nextAt.clear(); }

/** Hora local (minutos desde 00:00) e início do dia local em America/Sao_Paulo. */
export function localClock(now: Date, tz = TZ): { minutes: number; dayStart: Date } {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const h = get('hour'), m = get('minute'), s = get('second');
  const dayStart = new Date(now.getTime() - ((h * 60 + m) * 60 + s) * 1000 - now.getMilliseconds());
  return { minutes: h * 60 + m, dayStart };
}

export function hhmmToMinutes(v: string): number {
  const [h, m] = v.split(':').map(Number);
  return h * 60 + m;
}

export function inWindow(c: Pick<Campaign, 'windowStart' | 'windowEnd'>, now: Date): boolean {
  const { minutes } = localClock(now);
  const s = hhmmToMinutes(c.windowStart), e = hhmmToMinutes(c.windowEnd);
  return s <= e ? minutes >= s && minutes < e : minutes >= s || minutes < e; // janela que vira a meia-noite
}

export function personalize(message: string, lead: Pick<Lead, 'name'>): string {
  const first = (lead.name ?? '').trim().split(/\s+/)[0] ?? '';
  return message.replace(/\{\s*nome\s*\}/gi, first).replace(/[ \t]+([,.!?])/g, '$1').replace(/[ \t]{2,}/g, ' ').trim();
}

export type TickResult = { campaignId: string; action: 'sent' | 'failed' | 'skipped' | 'outside_window' | 'daily_limit' | 'waiting_interval' | 'completed' | 'subscription_inactive' }[];

/** Um passo do disparador: no máximo um envio por campanha EM_ANDAMENTO por chamada. */
export async function tick(now = new Date()): Promise<TickResult> {
  const out: TickResult = [];
  const campaigns = await prisma.campaign.findMany({ where: { status: 'EM_ANDAMENTO' }, orderBy: { createdAt: 'asc' } });
  for (const c of campaigns) {
    try {
      out.push({ campaignId: c.id, action: await stepCampaign(c, now) });
    } catch (e) {
      console.error('[mckmensagem] erro na campanha', c.id, e);
    }
  }
  return out;
}

async function stepCampaign(c: Campaign, now: Date): Promise<TickResult[number]['action']> {
  // Assinatura do MCKMENSAGEM inativa: pausa sem consumir destinatários (retoma ao renovar).
  if (!(await isProductActive(c.orgId, 'MCKMENSAGEM'))) return 'subscription_inactive';
  if (!inWindow(c, now)) return 'outside_window';
  const { dayStart } = localClock(now);
  const sentToday = await prisma.campaignRecipient.count({ where: { campaignId: c.id, status: 'ENVIADA', sentAt: { gte: dayStart } } });
  if (sentToday >= c.dailyLimit) return 'daily_limit';

  let next = nextAt.get(c.id);
  if (next === undefined) {
    const last = await prisma.campaignRecipient.findFirst({ where: { campaignId: c.id, sentAt: { not: null } }, orderBy: { sentAt: 'desc' } });
    next = last?.sentAt ? last.sentAt.getTime() + c.minIntervalSec * 1000 : 0;
  }
  if (now.getTime() < next) return 'waiting_interval';

  // Pula (IGNORADA) quem não pode receber até achar alguém elegível.
  for (;;) {
    const r = await prisma.campaignRecipient.findFirst({ where: { campaignId: c.id, status: 'PENDENTE' }, orderBy: { id: 'asc' } });
    if (!r) {
      await prisma.campaign.update({ where: { id: c.id }, data: { status: 'CONCLUIDA' } });
      nextAt.delete(c.id);
      return 'completed';
    }
    const lead = await prisma.lead.findFirst({ where: { id: r.leadId, orgId: c.orgId } });
    const reason = !lead ? 'Lead não encontrado'
      : !lead.consentAt ? 'Lead sem consentimento registrado'
      : lead.optOutAt ? 'Lead pediu para não receber mensagens (opt-out)'
      : lead.status === 'DESCARTADO' ? 'Lead descartado'
      : null;
    if (reason || !lead) {
      await prisma.campaignRecipient.update({ where: { id: r.id }, data: { status: 'IGNORADA', error: reason } });
      continue;
    }
    const ok = await sendToLead(c, lead, r.id, now);
    const gap = c.minIntervalSec + random() * Math.max(0, c.maxIntervalSec - c.minIntervalSec);
    nextAt.set(c.id, now.getTime() + gap * 1000);
    return ok ? 'sent' : 'failed';
  }
}

async function sendToLead(c: Campaign, lead: Lead, recipientId: string, now: Date): Promise<boolean> {
  const waId = lead.phone.replace(/\D/g, '');
  let contact = lead.contactId ? await prisma.contact.findFirst({ where: { id: lead.contactId, orgId: c.orgId } }) : null;
  contact ??= await prisma.contact.findUnique({ where: { orgId_waId: { orgId: c.orgId, waId } } });
  if (!contact) {
    contact = await prisma.contact.create({ data: { orgId: c.orgId, waId, phone: lead.phone, name: lead.name ?? null, tags: lead.tags } });
  }
  if (contact.optOut) {
    await prisma.lead.update({ where: { id: lead.id }, data: { optOutAt: now, contactId: contact.id } });
    await prisma.campaignRecipient.update({ where: { id: recipientId }, data: { status: 'IGNORADA', error: 'Contato com opt-out no MCKBOT' } });
    return false;
  }
  let conv = await prisma.conversation.findFirst({ where: { orgId: c.orgId, contactId: contact.id, status: { not: 'CLOSED' } }, orderBy: { createdAt: 'desc' } });
  conv ??= await prisma.conversation.create({ data: { orgId: c.orgId, contactId: contact.id, channelId: c.channelId } });
  if (conv.channelId !== c.channelId) conv = await prisma.conversation.update({ where: { id: conv.id }, data: { channelId: c.channelId } });

  let msg;
  try {
    msg = await sender({ conversation: conv, contact, payload: { type: 'text', text: personalize(c.message, lead) }, sender: 'bot', product: 'MCKMENSAGEM' });
  } catch (e) {
    await prisma.campaignRecipient.update({ where: { id: recipientId }, data: { status: 'FALHOU', error: (e as Error).message?.slice(0, 500) || 'Erro no envio' } });
    return false;
  }
  if (msg.status === 'FAILED') {
    await prisma.campaignRecipient.update({ where: { id: recipientId }, data: { status: 'FALHOU', error: msg.error ?? 'Falha no envio' } });
    await prisma.lead.update({ where: { id: lead.id }, data: { contactId: contact.id } });
    return false;
  }
  await prisma.campaignRecipient.update({ where: { id: recipientId }, data: { status: 'ENVIADA', sentAt: now, error: null } });
  await prisma.lead.update({
    where: { id: lead.id },
    data: { contactId: contact.id, campaignId: lead.campaignId ?? c.id, ...(lead.status === 'NOVO' ? { status: 'CONTATADO' } : {}) },
  });
  return true;
}
