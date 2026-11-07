import type { SdrLead } from '@prisma/client';
import { prisma } from '../db.js';
import { freeSlots, orgTz } from '../agenda/service.js';
import { humanPt, toLocalIso } from '../agenda/time.js';
import { channelAllowed, type Step } from './core.js';
import { logEvent, sendStep, setStage } from './service.js';

/**
 * SDR fase 2 (v1.21.0) — reunião: oferecer os horários livres já configurados na Agenda e recuperar quem não compareceu.
 * A Agenda não tem status "não compareceu" (sem migração): o vendedor marca no lead; o lead volta para Qualificado,
 * e, se a recuperação estiver ligada, recebe UMA mensagem oferecendo novos horários (respeita consentimento e opt-out).
 */
export const DEFAULT_NOSHOW_TEXT = 'Oi {primeiro_nome}, sentimos sua falta na nossa conversa. Quer remarcar? Tenho estes horários: {horarios}. É só responder com o melhor para você 😉';

/** Próximos horários livres (máx. 3) já no formato para o lead e para a tela. Nunca lança. */
export async function nextFreeSlots(orgId: string, now = new Date(), max = 3): Promise<{ inicio: string; texto: string }[]> {
  try {
    const tz = await orgTz(orgId);
    return (await freeSlots(orgId, { days: 7, max, now })).map((d) => ({ inicio: toLocalIso(d, tz), texto: humanPt(d, tz) }));
  } catch {
    return [];
  }
}

/** Linha do prompt da IA: propor horários concretos (só com a oferta ligada e lead morno/quente sem reunião). */
export function offerSlotsLine(slots: { texto: string }[]): string {
  if (!slots.length) return '';
  return `- Quando fizer sentido, convide para uma conversa propondo 2 ou 3 destes horários livres (sem inventar outros): ${slots.map((s) => s.texto).join('; ')}.`;
}

export function noShowMessage(tpl: string, slots: { texto: string }[]): string {
  const h = slots.length ? slots.map((s) => s.texto).join('; ') : 'é só me dizer o melhor dia e horário';
  return (tpl || DEFAULT_NOSHOW_TEXT).replace(/\{\s*horarios\s*\}/g, h);
}

/** Vendedor marca "não compareceu": registra, volta para Qualificado e (se ligado) envia a mensagem de recuperação. */
export async function markNoShow(lead: SdrLead, opts: { recover: boolean; texto: string; now?: Date }): Promise<{ lead: SdrLead; enviado: boolean; motivo?: string }> {
  let l = await prisma.sdrLead.update({ where: { id: lead.id }, data: { appointmentId: null } });
  await logEvent(l.orgId, l.id, 'NOSHOW', null, 'Não compareceu à reunião');
  if (l.stage === 'REUNIAO') l = await setStage(l, 'QUALIFICADO', { manual: true });
  if (!opts.recover) return { lead: l, enviado: false };
  const canal = channelAllowed(l, 'WHATSAPP').ok ? 'WHATSAPP' : channelAllowed(l, 'EMAIL').ok ? 'EMAIL' : null;
  if (!canal) return { lead: l, enviado: false, motivo: channelAllowed(l, 'WHATSAPP').reason ?? 'sem canal permitido' };
  const texto = noShowMessage(opts.texto, await nextFreeSlots(l.orgId, opts.now));
  const step: Step = { dia: 0, canal, ...(canal === 'EMAIL' ? { assunto: 'Vamos remarcar, {primeiro_nome}?' } : {}), texto };
  const r = await sendStep(l, step);
  await logEvent(l.orgId, l.id, 'NOSHOW', canal, r.ok ? 'Mensagem de recuperação enviada (novos horários)' : `Recuperação não enviada: ${r.reason}`);
  return { lead: await prisma.sdrLead.findUniqueOrThrow({ where: { id: l.id } }), enviado: r.ok, motivo: r.ok ? undefined : r.reason };
}
