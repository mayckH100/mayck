import { prisma } from '../db.js';
import { decryptOrNull } from '../lib/crypto.js';
import { sendCloudMessage } from './cloudClient.js';
import { qrManager } from './qr/manager.js';
import { resolveChannel, isQrChannel } from './messaging.js';

/**
 * Aviso por WhatsApp para o número reserva da organização quando uma conversa fica
 * "Aguardando atendente" por mais de handoffAlertMinutes sem resposta. Um único aviso por espera.
 */
export async function tickHandoffAlerts(now = new Date()) {
  const convs = await prisma.conversation.findMany({
    where: { waitingSince: { not: null, lte: new Date(now.getTime() - 60_000) }, handoffAlertSentAt: null, mode: 'HUMAN', status: { not: 'CLOSED' } },
    orderBy: { waitingSince: 'asc' }, take: 200,
  });
  if (!convs.length) return 0;
  const orgs = await prisma.organization.findMany({ where: { id: { in: [...new Set(convs.map((c) => c.orgId))] }, backupPhone: { not: null } } });
  let sent = 0;
  for (const conv of convs) {
    const org = orgs.find((o) => o.id === conv.orgId);
    if (!org?.backupPhone || !conv.waitingSince) continue;
    const waitedMs = now.getTime() - conv.waitingSince.getTime();
    if (waitedMs < org.handoffAlertMinutes * 60_000) continue;
    // Atendente já respondeu (mensagem enviada após a transferência)? Então não avisa.
    const replied = await prisma.message.count({ where: { conversationId: conv.id, sender: 'agent', direction: 'OUT', status: { not: 'FAILED' }, createdAt: { gte: conv.waitingSince } } });
    if (replied) continue;
    const claim = await prisma.conversation.updateMany({ where: { id: conv.id, handoffAlertSentAt: null, waitingSince: conv.waitingSince }, data: { handoffAlertSentAt: now } });
    if (claim.count !== 1) continue;
    try {
      const contact = await prisma.contact.findFirst({ where: { id: conv.contactId, orgId: conv.orgId } });
      const who = contact ? (contact.name ? `${contact.name} (${contact.phone})` : contact.phone) : 'Um contato';
      const text = `⚠️ Atendimento aguardando: ${who} espera um atendente há ${Math.floor(waitedMs / 60_000)} min.`;
      const to = org.backupPhone.replace(/\D/g, '');
      const channel = await resolveChannel(conv);
      if (!channel) throw new Error('Nenhum canal WhatsApp na organização');
      if (isQrChannel(channel)) {
        if (!qrManager.canSend(channel.id)) throw new Error('WhatsApp (QR) não conectado');
        await qrManager.send(channel.id, to, { type: 'text', text });
      } else {
        const accessToken = decryptOrNull(channel.accessTokenEnc);
        if (channel.status !== 'CONNECTED' || !channel.phoneNumberId || !accessToken) throw new Error('Canal WhatsApp não conectado');
        await sendCloudMessage({ phoneNumberId: channel.phoneNumberId, accessToken }, to, { type: 'text', text });
      }
      sent++;
    } catch (e) {
      console.error('[aguardando] aviso ao número reserva falhou', conv.id, (e as Error).message);
    }
  }
  return sent;
}
