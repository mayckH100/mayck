import { prisma } from '../db.js';
import { FINAL_STAGE_RE, moveToMeetingStage } from '../agenda/service.js';
import { WAITING_STAGE } from '../lib/waiting.js';
import { kanbanTargetFor, STAGE_LABEL, type Stage } from './core.js';
import { getV2Config } from './v2config.js';

/**
 * SDR → Kanban do MCKBOT (v1.19.0). Quando a etapa do lead muda e ele tem contato de WhatsApp ligado, o contato
 * vai para a etapa do Kanban com o nome correspondente (Novo, Contatado, Respondeu, Qualificado, Reunião…, Ganho,
 * Perdido). Regras:
 *  - nunca cria etapa (exceto "Reunião agendada", que a Agenda já cria quando marca reunião);
 *  - automação só anda para a frente e nunca tira o contato de Ganho/Perdido nem de "Aguardando atendente";
 *  - mudança manual no SDR pode voltar etapa e trocar entre Ganho/Perdido;
 *  - desligável em SDR › Configuração (kanbanSync). Nunca lança.
 * Devolve o texto do histórico ("Kanban: A → B") ou null quando nada mudou.
 */
export async function syncSdrStageToKanban(lead: { orgId: string; contactId: string | null }, stage: Stage, opts: { manual?: boolean } = {}): Promise<string | null> {
  try {
    if (!lead.contactId) return null;
    if (!(await getV2Config(lead.orgId)).kanbanSync) return null;
    const contact = await prisma.contact.findFirst({ where: { id: lead.contactId, orgId: lead.orgId }, select: { id: true, stageId: true } });
    if (!contact) return null;
    const stages = await prisma.kanbanStage.findMany({ where: { orgId: lead.orgId }, orderBy: { position: 'asc' } });
    const cur = stages.find((s) => s.id === contact.stageId) ?? null;
    let target = kanbanTargetFor(stage, stages);
    if (!target && stage === 'REUNIAO') {
      // Mesma etapa que a Agenda usa quando marca reunião (criada no fim do funil se faltar).
      await moveToMeetingStage(lead.orgId, contact.id);
      const after = await prisma.contact.findFirst({ where: { id: contact.id }, select: { stageId: true } });
      if (after?.stageId === contact.stageId) return null;
      const t = await prisma.kanbanStage.findFirst({ where: { id: after?.stageId ?? '' }, select: { name: true } });
      return `Kanban: ${cur ? `"${cur.name}" → ` : ''}"${t?.name ?? STAGE_LABEL.REUNIAO}"`;
    }
    if (!target || target.id === cur?.id) return null;
    if (!opts.manual && cur) {
      if (FINAL_STAGE_RE.test(cur.name) || cur.name === WAITING_STAGE) return null;
      if (!FINAL_STAGE_RE.test(target.name) && target.position <= cur.position) return null;
    }
    await prisma.contact.updateMany({ where: { id: contact.id, orgId: lead.orgId }, data: { stageId: target.id } });
    return `Kanban: ${cur ? `"${cur.name}" → ` : ''}"${target.name}"`;
  } catch (e) {
    console.error('[sdr] falha ao sincronizar com o Kanban', { orgId: lead.orgId, error: (e as Error).message });
    return null;
  }
}
