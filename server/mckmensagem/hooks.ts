import { prisma } from '../db.js';
import { onSdrOptOut } from '../sdr/service.js';
import { marcarRespostaCampanhas } from './repescagem.js';

/** Variações de telefone que podem identificar o lead a partir do waId do contato. */
function phoneOf(waId: string): string | null {
  if (waId.includes('@')) return null;
  return '+' + waId.replace(/\D/g, '');
}

/**
 * Chamado pelo inbound: lead contatado (ou "Sem resposta" depois da repescagem) que respondeu → RESPONDEU.
 * v1.43.0: também marca "respondeu" nos destinatários das campanhas (para a separação por grupos e para a repescagem
 * nunca mais mandar mensagem a quem respondeu). Nunca derruba o fluxo do MCKBOT.
 */
export async function onLeadInbound(orgId: string, contact: { id: string; waId: string }, at = new Date()): Promise<void> {
  try {
    const phone = phoneOf(contact.waId);
    const or: any[] = [{ contactId: contact.id }];
    if (phone) or.push({ phone });
    const ids = (await prisma.lead.findMany({ where: { orgId, OR: or }, select: { id: true } })).map((l) => l.id);
    await marcarRespostaCampanhas(ids, at);
    await prisma.lead.updateMany({ where: { orgId, status: { in: ['CONTATADO', 'SEM_RESPOSTA'] }, OR: or }, data: { status: 'RESPONDEU', contactId: contact.id } });
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
    // Automações: o mesmo pedido vale como opt-out de marketing do cliente.
    const orCli: any[] = [{ contactId: contact.id }];
    if (phone) orCli.push({ whatsapp: phone }, { telefone: phone });
    await prisma.cliente.updateMany({ where: { orgId, marketingOptOutAt: null, OR: orCli }, data: { marketingOptOutAt: at } });
    // SDR com IA: para a cadência e nunca mais envia (WhatsApp nem e-mail).
    await onSdrOptOut(orgId, contact, at);
  } catch (e) {
    console.error('[mckmensagem] falha ao registrar opt-out do lead', e);
  }
}
