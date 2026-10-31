import { prisma } from '../db.js';
import type { Conversation } from '@prisma/client';

/** Rótulo exibido para conversas transferidas para humano que ainda não tiveram resposta do atendente. */
export const WAITING_LABEL = 'Aguardando atendente';
export const WAITING_STAGE = 'Aguardando atendente';
export const IN_SERVICE_STAGE = 'Em atendimento';

/** Etapa do Kanban com o nome dado; cria no fim do funil se não existir. */
export async function ensureStage(orgId: string, name: string, color = '#f97316') {
  const found = await prisma.kanbanStage.findFirst({ where: { orgId, name } });
  if (found) return found;
  const last = await prisma.kanbanStage.findFirst({ where: { orgId }, orderBy: { position: 'desc' } });
  return prisma.kanbanStage.create({ data: { orgId, name, color, position: (last?.position ?? -1) + 1 } });
}

/** Marca a conversa como "Aguardando atendente" e move o contato para a etapa correspondente. */
export async function markWaiting(conversation: Conversation) {
  const now = new Date();
  // Já aguardando: mantém o horário original (o aviso conta desde a primeira transferência).
  if (!conversation.waitingSince) {
    await prisma.conversation.update({ where: { id: conversation.id }, data: { waitingSince: now, handoffAlertSentAt: null } });
    conversation.waitingSince = now;
    conversation.handoffAlertSentAt = null;
  }
  try {
    const st = await ensureStage(conversation.orgId, WAITING_STAGE);
    await prisma.contact.updateMany({ where: { id: conversation.contactId, orgId: conversation.orgId }, data: { stageId: st.id } });
  } catch (e) {
    console.error('[aguardando] falha ao mover contato para a etapa', (e as Error).message);
  }
}

/** O atendente respondeu: sai de "Aguardando atendente" e o contato vai para "Em atendimento" (se a etapa existir). */
export async function clearWaiting(conversation: Pick<Conversation, 'id' | 'orgId' | 'contactId' | 'waitingSince'>, moveStage = true) {
  if (!conversation.waitingSince) return;
  await prisma.conversation.update({ where: { id: conversation.id }, data: { waitingSince: null } });
  conversation.waitingSince = null;
  if (!moveStage) return;
  try {
    const st = await prisma.kanbanStage.findFirst({ where: { orgId: conversation.orgId, name: IN_SERVICE_STAGE } });
    if (st) await prisma.contact.updateMany({ where: { id: conversation.contactId, orgId: conversation.orgId }, data: { stageId: st.id } });
  } catch (e) {
    console.error('[aguardando] falha ao mover contato para "Em atendimento"', (e as Error).message);
  }
}

/** Telefone BR em E.164 (+55 DDD número). Aceita espaços, traços e parênteses; devolve null se inválido. */
export function normalizeBrPhone(raw: string): string | null {
  const s = raw.trim().replace(/[\s().-]/g, '');
  if (!/^\+55[1-9][1-9]\d{8,9}$/.test(s)) return null;
  return s;
}
