import type { SdrLead } from '@prisma/client';
import { prisma } from '../db.js';
import { notAutoReply } from './autoReply.js';

/** Quando o lead respondeu (mensagens recebidas do contato + respostas registradas no SDR), mais recentes primeiro. Respostas automáticas não contam (v1.22.0). */
export async function replyDatesOf(lead: Pick<SdrLead, 'id' | 'orgId' | 'contactId'>): Promise<Date[]> {
  const ev = await prisma.sdrEvent.findMany({ where: { orgId: lead.orgId, leadId: lead.id, type: 'RESPOSTA' }, orderBy: { createdAt: 'desc' }, take: 50, select: { createdAt: true } });
  let msgs: { createdAt: Date }[] = [];
  if (lead.contactId) {
    const convs = await prisma.conversation.findMany({ where: { orgId: lead.orgId, contactId: lead.contactId }, select: { id: true }, take: 20 });
    if (convs.length) msgs = await prisma.message.findMany({ where: { orgId: lead.orgId, conversationId: { in: convs.map((c) => c.id) }, direction: 'IN', ...notAutoReply }, orderBy: { createdAt: 'desc' }, take: 50, select: { createdAt: true } });
  }
  return msgs.length ? msgs.map((m) => m.createdAt) : ev.map((e) => e.createdAt);
}
