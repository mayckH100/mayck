import { prisma } from '../db.js';
import { channelInfo } from './channelLabel.js';
import { conversationUrl, deliverStaffAlert, handoffAlertText, MAX_NOTIFY_TRIES, notifyHandoffNow, orgNotifyPhones } from './handoffNotify.js';

const RETRY_GAP_MS = 2 * 60_000;

/**
 * Tick (a cada minuto) do "Aguardando atendente":
 *  1) repete o aviso IMEDIATO da transferência que falhou (até 3 tentativas, 2 min entre elas);
 *  2) lembrete para os números de aviso quando a conversa espera há mais de handoffAlertMinutes sem resposta
 *     do atendente. Um lembrete por espera; se o envio falhar em todos os números, tenta de novo (até 3 vezes).
 * Antes, o único aviso era este lembrete, com claim gravado antes do envio: uma falha nunca era repetida
 * e só ia para o console.
 */
export async function tickHandoffAlerts(now = new Date()) {
  let sent = 0;
  // 1) Aviso imediato que falhou: só conversas que já tentaram (tries ≥ 1); conversas antigas não disparam nada.
  const retry = await prisma.conversation.findMany({
    where: { waitingSince: { not: null }, handoffNotifyAt: null, handoffNotifyTries: { gte: 1, lt: MAX_NOTIFY_TRIES }, mode: 'HUMAN', status: { not: 'CLOSED' } },
    orderBy: { waitingSince: 'asc' }, take: 50,
  });
  for (const conv of retry) {
    if (!conv.waitingSince || now.getTime() - conv.waitingSince.getTime() < conv.handoffNotifyTries * RETRY_GAP_MS) continue;
    const r = await notifyHandoffNow(conv, undefined, now).catch(() => null);
    if (r?.ok) sent++;
  }

  // 2) Lembrete "aguardando há N min".
  const convs = await prisma.conversation.findMany({
    where: { waitingSince: { not: null, lte: new Date(now.getTime() - 60_000) }, handoffAlertSentAt: null, handoffAlertTries: { lt: MAX_NOTIFY_TRIES }, mode: 'HUMAN', status: { not: 'CLOSED' } },
    orderBy: { waitingSince: 'asc' }, take: 200,
  });
  if (!convs.length) return sent;
  const orgs = await prisma.organization.findMany({ where: { id: { in: [...new Set(convs.map((c) => c.orgId))] } } });
  for (const conv of convs) {
    const org = orgs.find((o) => o.id === conv.orgId);
    if (!org || org.alertHandoff === false || !orgNotifyPhones(org).length || !conv.waitingSince) continue;
    const waitedMs = now.getTime() - conv.waitingSince.getTime();
    if (waitedMs < org.handoffAlertMinutes * 60_000) continue;
    // Nova tentativa após falha: espera 2 min entre as tentativas.
    if (conv.handoffAlertTries > 0 && waitedMs < org.handoffAlertMinutes * 60_000 + conv.handoffAlertTries * RETRY_GAP_MS) continue;
    // Atendente já respondeu (mensagem enviada após a transferência)? Então não avisa.
    const replied = await prisma.message.count({ where: { conversationId: conv.id, sender: 'agent', direction: 'OUT', status: { not: 'FAILED' }, createdAt: { gte: conv.waitingSince } } });
    if (replied) continue;
    const claim = await prisma.conversation.updateMany({ where: { id: conv.id, handoffAlertSentAt: null, waitingSince: conv.waitingSince, handoffAlertTries: conv.handoffAlertTries }, data: { handoffAlertSentAt: now, handoffAlertTries: { increment: 1 } } });
    if (claim.count !== 1) continue;
    try {
      const contact = await prisma.contact.findFirst({ where: { id: conv.contactId, orgId: conv.orgId } });
      const who = contact ? (contact.name ? `${contact.name} (${contact.phone})` : contact.phone) : 'Um contato';
      const via = (await channelInfo(conv.orgId, conv.channelId).catch(() => null))?.via ?? '';
      const minutes = Math.floor(waitedMs / 60_000);
      const url = conversationUrl(conv.id);
      const r = await deliverStaffAlert({
        orgId: conv.orgId, channelId: conv.channelId, kind: 'reminder',
        text: handoffAlertText({ who, reason: 'sem resposta do atendente', channel: via, url, reminderMin: minutes }),
        email: conv.handoffAlertTries + 1 >= MAX_NOTIFY_TRIES ? { subject: `Atendimento aguardando: ${who}`, title: `${who} espera um atendente há ${minutes} min`, lines: via ? [`WhatsApp: ${via}`] : [], url } : undefined,
      });
      if (r.ok) { sent++; continue; }
      if (conv.handoffAlertTries + 1 < MAX_NOTIFY_TRIES) await prisma.conversation.updateMany({ where: { id: conv.id, handoffAlertSentAt: now }, data: { handoffAlertSentAt: null } });
      await prisma.message.create({ data: { orgId: conv.orgId, conversationId: conv.id, direction: 'INTERNAL', sender: 'system', type: 'note', body: `⚠️ Lembrete de atendimento aguardando NÃO entregue: ${r.detail}`.slice(0, 1000), status: 'NOTE' } });
    } catch (e) {
      console.error('[aguardando] lembrete falhou', conv.id, (e as Error).message);
    }
  }
  return sent;
}
