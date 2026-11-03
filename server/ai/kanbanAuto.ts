import { prisma } from '../db.js';
import { FINAL_STAGE_RE } from '../agenda/service.js';
import { WAITING_STAGE, IN_SERVICE_STAGE } from '../lib/waiting.js';

/**
 * Kanban automático pela IA (AiSettings.kanbanAuto, padrão DESLIGADO).
 * A IA recebe as etapas do funil e, quando a conversa mostra claramente que o contato avançou, coloca no fim
 * da resposta o marcador [ETAPA:Nome da etapa]. O sistema tira o marcador do texto e move o contato se:
 *  - a etapa existe na organização (nunca cria etapa);
 *  - é uma etapa À FRENTE da atual (posição maior) — nunca volta;
 *  - não é etapa final (Ganho/Perdido/Fechado/Cancelado) nem as etapas automáticas de atendimento;
 *  - o contato não está numa etapa final.
 * Toda mudança vira nota interna na conversa.
 */

const SYSTEM_STAGES = new Set([WAITING_STAGE, IN_SERVICE_STAGE]);
const TAG_RE = /\[ETAPA:\s*([^\]]{1,60})\]/gi;
const norm = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();

async function contactOf(orgId: string, conversationId: string) {
  if (!conversationId) return null;
  const conv = await prisma.conversation.findFirst({ where: { id: conversationId, orgId }, select: { contactId: true } });
  return conv ? prisma.contact.findFirst({ where: { id: conv.contactId, orgId }, select: { id: true, stageId: true } }) : null;
}

export async function kanbanPromptSection(orgId: string, conversationId: string): Promise<string> {
  const stages = await prisma.kanbanStage.findMany({ where: { orgId }, orderBy: { position: 'asc' } });
  const usable = stages.filter((s) => !FINAL_STAGE_RE.test(s.name) && !SYSTEM_STAGES.has(s.name));
  if (!usable.length) return '';
  const c = await contactOf(orgId, conversationId);
  const cur = stages.find((s) => s.id === c?.stageId);
  return [
    'FUNIL (KANBAN): etapas, em ordem: ' + usable.map((s) => `"${s.name}"`).join(' → ') + '.',
    `Etapa atual do contato: ${cur ? `"${cur.name}"` : 'nenhuma'}.`,
    'Só quando a conversa mostrar CLARAMENTE que o contato avançou para uma etapa seguinte, acrescente no fim da resposta, sozinho numa linha, o marcador [ETAPA:Nome exato da etapa]. Na dúvida, não coloque. Nunca mostre ou explique o marcador ao cliente.',
  ].join('\n');
}

/** Tira o marcador do texto e, se `enabled`, aplica a mudança de etapa permitida. Devolve o texto limpo. */
export async function applyKanbanTag(orgId: string, conversationId: string, text: string, enabled: boolean): Promise<string> {
  const tags = [...text.matchAll(TAG_RE)].map((m) => m[1].trim());
  const clean = text.replace(TAG_RE, '').replace(/\n{3,}/g, '\n\n').trim();
  if (!enabled || !tags.length) return clean;
  const wanted = norm(tags[tags.length - 1]);
  const stages = await prisma.kanbanStage.findMany({ where: { orgId }, orderBy: { position: 'asc' } });
  const target = stages.find((s) => norm(s.name) === wanted);
  const c = await contactOf(orgId, conversationId);
  if (!target || !c || FINAL_STAGE_RE.test(target.name) || SYSTEM_STAGES.has(target.name)) return clean;
  const cur = stages.find((s) => s.id === c.stageId);
  if (cur && (FINAL_STAGE_RE.test(cur.name) || cur.position >= target.position)) return clean;
  await prisma.contact.updateMany({ where: { id: c.id, orgId }, data: { stageId: target.id } });
  await prisma.message.create({ data: { orgId, conversationId, direction: 'INTERNAL', sender: 'system', type: 'note', body: `IA moveu o contato no Kanban: ${cur ? `"${cur.name}" → ` : ''}"${target.name}" (análise da conversa).`, status: 'NOTE' } });
  return clean;
}
