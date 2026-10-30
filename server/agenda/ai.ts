import { prisma } from '../db.js';
import { createAppointment, freeSlots, getSettings, orgTz, ConflictError, publicEventUrl } from './service.js';
import { humanPt, parseLocal, toLocalIso, zonedParts } from './time.js';

/** Marcador que a IA usa para pedir o agendamento ao combinar um horário com o cliente. */
export const AGENDAR_RE = /\[AGENDAR:\s*(\{[\s\S]*?\})\s*\]/i;

const DIAS = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];

/** Trecho do prompt com os horários livres e a regra de agendamento (só quando a empresa liga a opção). */
export async function agendaPromptSection(orgId: string, now = new Date()): Promise<string> {
  const s = await getSettings(orgId);
  if (!s.aiBooking) return '';
  const tz = await orgTz(orgId);
  const slots = await freeSlots(orgId, { days: 10, max: 16, now });
  const p = zonedParts(now, tz);
  return [
    'AGENDAMENTO:',
    `- Agora é ${DIAS[p.weekday]}, ${toLocalIso(now, tz).replace('T', ' ')} (fuso ${tz}). Atendimento: ${s.workStart}–${s.workEnd}, duração padrão ${s.defaultDurationMin} min.`,
    '- Quando o cliente quiser marcar reunião/horário, ofereça somente os HORÁRIOS LIVRES abaixo. Nunca invente outro horário.',
    '- Só depois que o cliente CONFIRMAR um horário específico, escreva a confirmação e termine a resposta com o marcador, numa linha própria:',
    '  [AGENDAR:{"inicio":"AAAA-MM-DDTHH:MM","duracao":30,"titulo":"Reunião com <nome>","descricao":"<assunto>"}]',
    '- Não use o marcador se o cliente ainda estiver escolhendo.',
    'HORÁRIOS LIVRES:',
    slots.length ? slots.map((d) => `- ${toLocalIso(d, tz)} (${humanPt(d, tz)})`).join('\n') : '- (nenhum horário livre nos próximos dias: diga que a equipe vai entrar em contato)',
  ].join('\n');
}

/**
 * Processa o marcador [AGENDAR:{...}] da resposta da IA: confere conflito, cria o compromisso
 * (sincroniza com Google Agenda se conectado) e troca o marcador pelo link "Adicionar à agenda".
 */
export async function applyAgendaTag(args: { orgId: string; conversationId: string; text: string }): Promise<{ text: string; appointmentId?: string; conflict?: boolean }> {
  const m = AGENDAR_RE.exec(args.text);
  if (!m) return { text: args.text };
  const clean = args.text.replace(AGENDAR_RE, '').trim();
  const s = await getSettings(args.orgId);
  if (!s.aiBooking || !args.conversationId) return { text: clean };
  const conv = await prisma.conversation.findFirst({ where: { id: args.conversationId, orgId: args.orgId } });
  if (!conv) return { text: clean };
  let data: any;
  try { data = JSON.parse(m[1]); } catch { return { text: clean }; }
  const tz = await orgTz(args.orgId);
  const startAt = parseLocal(String(data.inicio ?? ''), tz);
  const durationMin = Math.min(480, Math.max(5, Number(data.duracao) || s.defaultDurationMin));
  if (!startAt || startAt.getTime() < Date.now()) return { text: clean };
  const contact = await prisma.contact.findFirst({ where: { id: conv.contactId, orgId: args.orgId } });
  const title = String(data.titulo || `Reunião com ${contact?.name ?? contact?.phone ?? 'cliente'}`).slice(0, 120);
  try {
    const a = await createAppointment({
      kind: 'MEETING', title, description: data.descricao ? String(data.descricao).slice(0, 1000) : 'Agendado pela IA no WhatsApp',
      startAt, durationMin, contactId: conv.contactId, conversationId: conv.id, assignedUserId: conv.assignedUserId,
    }, { orgId: args.orgId, source: 'AI' });
    const link = publicEventUrl(a.id);
    const confirm = clean || `Pronto! Agendado para ${humanPt(startAt, tz)}.`;
    return { text: `${confirm}\n\n📅 Adicione à agenda do seu celular: ${link}`, appointmentId: a.id };
  } catch (e) {
    if (!(e instanceof ConflictError)) throw e;
    const alt = await freeSlots(args.orgId, { days: 10, max: 3, durationMin });
    const opts = alt.length ? ` Tenho livre: ${alt.map((d) => humanPt(d, tz)).join('; ')}. Qual prefere?` : ' A equipe vai entrar em contato para combinar outro horário.';
    return { text: `Esse horário (${humanPt(startAt, tz)}) acabou de ser ocupado.${opts}`, conflict: true };
  }
}
