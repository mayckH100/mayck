import { prisma } from '../db.js';

/** Variações de telefone que podem identificar o lead a partir do waId do contato. */
function phoneOf(waId: string): string | null {
  if (waId.includes('@')) return null;
  return '+' + waId.replace(/\D/g, '');
}

/** Chamado pelo inbound: lead contatado que respondeu → RESPONDEU. Nunca derruba o fluxo do MCKBOT. */
export async function onLeadInbound(orgId: string, contact: { id: string; waId: string }): Promise<void> {
  try {
    const phone = phoneOf(contact.waId);
    const or: any[] = [{ contactId: contact.id }];
    if (phone) or.push({ phone });
    await prisma.lead.updateMany({ where: { orgId, status: 'CONTATADO', OR: or }, data: { status: 'RESPONDEU', contactId: contact.id } });
  } catch (e) {
    console.error('[mckmensagem] falha ao marcar resposta do lead', e);
  }
}

/** Chamado pelo inbound quando o contato manda palavra de opt-out (ex.: "SAIR"). */
export async function onLeadOptOut(orgId: string, contact: { id: string; waId: string }, at = new Date()): Promise<void> {
  try {
    const phone = phoneOf(contact.waId);
    const or: any[] = [{ contactId: contact.id }];
    if (phone) or.push({ phone });
    await prisma.lead.updateMany({ where: { orgId, optOutAt: null, OR: or }, data: { optOutAt: at, contactId: contact.id } });
  } catch (e) {
    console.error('[mckmensagem] falha ao registrar opt-out do lead', e);
  }
}
