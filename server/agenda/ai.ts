import { prisma } from '../db.js';
import type { Appointment } from '@prisma/client';
import { createAppointment, findConflicts, freeSlots, getSettings, orgTz, ConflictError, publicEventUrl, handlesMeetings } from './service.js';
import { humanPt, parseLocal, toLocalIso, zonedParts } from './time.js';

/** Marcador que a IA usa para pedir o agendamento ao combinar um horário com o cliente. */
export const AGENDAR_RE = /\[AGENDAR:\s*(\{[\s\S]*?\})\s*\]/i;
/** Todos os marcadores (a IA às vezes repete): só o primeiro é processado, os demais são descartados. */
export const AGENDAR_ALL_RE = /\[AGENDAR:[\s\S]*?\]/gi;

const DIAS = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];

/** Trecho do prompt com os horários livres e a regra de agendamento (só quando a empresa liga a opção). */
export async function agendaPromptSection(orgId: string, now = new Date()): Promise<string> {
  const s = await getSettings(orgId);
  // Modo "Pedido" (só pedidos): a IA não agenda reuniões.
  if (!s.aiBooking || !handlesMeetings(s)) return '';
  const tz = await orgTz(orgId);
  const slots = await freeSlots(orgId, { days: 10, max: 16, now });
  const p = zonedParts(now, tz);
  return [
    'AGENDAMENTO:',
    `- Agora é ${DIAS[p.weekday]}, ${toLocalIso(now, tz).replace('T', ' ')} (fuso ${tz}). Atendimento: ${s.workStart}–${s.workEnd}, duração padrão ${s.defaultDurationMin} min.`,
    '- Quando o cliente quiser marcar reunião/horário, ofereça somente os HORÁRIOS LIVRES abaixo. Nunca invente outro horário.',
    '- Antes de agendar, pergunte "Posso agendar para <dia> às <HH:MM>?" com o horário exato. Só depois que o cliente responder SIM a esse horário (ou escrever ele mesmo o horário completo, ex.: 14:30), escreva a confirmação e termine a resposta com o marcador, numa linha própria:',
    '  [AGENDAR:{"inicio":"AAAA-MM-DDTHH:MM","duracao":30,"titulo":"Reunião com <nome>","descricao":"<assunto>"}]',
    '- Não use o marcador se o cliente ainda estiver escolhendo. Se a resposta for ambígua (ex.: só um número como "45"), pergunte o que ele quis dizer (horário ou duração) antes de propor ou agendar.',
    '- Use o marcador no máximo UMA vez por resposta, só para o horário confirmado agora. Nunca repita o marcador de reuniões já agendadas.',
    '- Nunca escreva links (agenda, Google Meet ou outros): o sistema acrescenta automaticamente o link certo da reunião agendada.',
    'HORÁRIOS LIVRES:',
    slots.length ? slots.map((d) => `- ${toLocalIso(d, tz)} (${humanPt(d, tz)})`).join('\n') : '- (nenhum horário livre nos próximos dias: diga que a equipe vai entrar em contato)',
  ].join('\n');
}

/** Linhas que só o sistema escreve (links da agenda/Meet): se a IA copiar do histórico, saem da resposta. */
const SYSTEM_LINK_LINE_RE = /^.*(\/api\/public\/agenda\/|adicione à agenda|adicionar à agenda|link da reunião \(google meet\)|meet\.google\.com\/).*$/gimu;

/** Remove links da agenda/Meet que a IA tenha copiado das mensagens anteriores (o sistema põe o link certo). */
export function stripSystemLinks(text: string): string {
  return String(text ?? '').replace(SYSTEM_LINK_LINE_RE, '').replace(/\n{3,}/g, '\n\n').trim();
}

/** Marcador de classificação da conversa: [TIPO:reuniao|pedido|ambos] (processado em agenda/orders.ts). */
export const TIPO_ALL_RE = /\[TIPO:\s*[^\]\n]{0,30}\]/gi;

/**
 * Encontra marcadores [NOME:{json}] com o JSON balanceado (o JSON do pedido tem listas e objetos
 * aninhados, então uma regex simples cortaria no primeiro "}]"). Devolve o JSON bruto e a posição.
 */
export function findJsonMarkers(text: string, name: string): { json: string; start: number; end: number }[] {
  const out: { json: string; start: number; end: number }[] = [];
  const src = String(text ?? '');
  const re = new RegExp(`\\[${name}:\\s*`, 'gi');
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    let i = m.index + m[0].length;
    if (src[i] !== '{') continue;
    let depth = 0; let inStr = false; let esc = false; let j = i;
    for (; j < src.length; j++) {
      const c = src[j];
      if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
      if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) break; }
    }
    if (depth !== 0) { out.push({ json: '', start: m.index, end: src.length }); break; } // marcador quebrado: descarta até o fim
    let k = j + 1;
    while (k < src.length && /\s/.test(src[k])) k++;
    const end = src[k] === ']' ? k + 1 : j + 1;
    out.push({ json: src.slice(i, j + 1), start: m.index, end });
    re.lastIndex = end;
  }
  return out;
}

/** Remove os marcadores [NOME:{...}] do texto. */
export function stripJsonMarkers(text: string, name: string): string {
  const src = String(text ?? '');
  const ms = findJsonMarkers(src, name);
  if (!ms.length) return src;
  let out = ''; let last = 0;
  for (const mk of ms) { out += src.slice(last, mk.start); last = mk.end; }
  return out + src.slice(last);
}

/** Tira da resposta da IA os marcadores (agendar, pedido, tipo) e os links copiados (usado também quando o agendamento falha). */
export const cleanAiText = (text: string) => stripSystemLinks(stripJsonMarkers(String(text ?? '').replace(AGENDAR_ALL_RE, ''), 'PEDIDO').replace(TIPO_ALL_RE, ''));

const norm = (s: string) => (s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

/** O texto cita esse horário (14:30, 14h30, 14h 30, 14 e 30/meia; para hora cheia também "14h" e "às 14")? */
export function mentionsTime(text: string, hour: number, minute: number): boolean {
  const t = norm(text);
  const H = `0?${hour}`;
  const M = String(minute).padStart(2, '0');
  const pats = [`(?<!\\d)${H}\\s*(?::|h)\\s*${M}(?!\\d)`];
  if (minute === 30) pats.push(`(?<!\\d)${H}\\s*(?:h\\s*)?e\\s*(?:30|meia)(?!\\d)`);
  if (minute === 0) pats.push(`(?<!\\d)${H}\\s*(?:h|hs|hrs?|horas?)(?![a-z0-9])`, `\\bas ${H}(?![\\d:h])`);
  return pats.some((p) => new RegExp(p).test(t));
}

const AFFIRM_RE = /\b(sim|s|ss|pode|podemos|confirm[oa]?|confirmad[oa]|confirmar|ok|okay|isso|fechado|combinado|perfeito|beleza|blz|claro|certo|correto|bora|vamos|marca|marque|agenda|agende|show|top|otimo|exato|positivo|uhum|aham|quero)\b|👍|✅/;
const NEGATE_RE = /\b(nao|n|outro|outra|mudar|trocar|cancela|cancelar|depois|espera)\b/;

/** Resposta do cliente é um "sim" (sem negação)? */
export function isAffirmative(text: string): boolean {
  const t = norm(text);
  return !!t && AFFIRM_RE.test(t) && !NEGATE_RE.test(t);
}

/**
 * Trava de confirmação: só agenda se o cliente escreveu ele mesmo o horário, ou se respondeu "sim"
 * a uma mensagem anterior da IA que propôs exatamente esse horário. Respostas ambíguas ("45") não agendam.
 */
export function isConfirmed(args: { clientText: string; lastAssistant: string | null; hour: number; minute: number }): boolean {
  if (mentionsTime(args.clientText, args.hour, args.minute)) return true;
  return !!args.lastAssistant && isAffirmative(args.clientText) && mentionsTime(stripSystemLinks(args.lastAssistant), args.hour, args.minute);
}

/** Fila por contato: dois agendamentos simultâneos do mesmo cliente não passam juntos pela checagem. */
const locks = new Map<string, Promise<unknown>>();
async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  const run = prev.catch(() => undefined).then(fn);
  const tail = run.catch(() => undefined);
  locks.set(key, tail);
  try { return await run; } finally { if (locks.get(key) === tail) locks.delete(key); }
}

function confirmationText(a: Appointment, confirm: string) {
  return `${confirm}${a.meetLink ? `\n\n🎥 Link da reunião (Google Meet): ${a.meetLink}` : ''}\n\n📅 Adicione à agenda do seu celular: ${publicEventUrl(a.id)}`;
}

/**
 * Processa o marcador [AGENDAR:{...}] da resposta da IA: exige a confirmação do cliente, reaproveita
 * um agendamento igual já existente (idempotente), confere conflito, cria o compromisso (sincroniza com
 * Google Agenda se conectado) e troca o marcador pelo link "Adicionar à agenda" — sempre um só link,
 * o da reunião que esta mensagem confirma.
 */
export async function applyAgendaTag(args: { orgId: string; conversationId: string; text: string; clientText?: string }): Promise<{ text: string; appointmentId?: string; conflict?: boolean; reused?: boolean; needsConfirmation?: boolean }> {
  const m = AGENDAR_RE.exec(args.text);
  const clean = cleanAiText(args.text);
  if (!m) return { text: clean };
  const s = await getSettings(args.orgId);
  if (!s.aiBooking || !handlesMeetings(s) || !args.conversationId) return { text: clean };
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
  const confirm = clean || `Pronto! Agendado para ${humanPt(startAt, tz)}.`;
  return withLock(`${args.orgId}:${conv.contactId}`, async () => {
    // Idempotência: o mesmo cliente já tem reunião nesse horário → reaproveita (não cria outra nem avisa a equipe de novo).
    const same = await prisma.appointment.findFirst({ where: { orgId: args.orgId, contactId: conv.contactId, kind: 'MEETING', status: 'SCHEDULED', startAt } });
    if (same) return { text: confirmationText(same, confirm), appointmentId: same.id, reused: true };
    // Confirmação explícita do cliente antes de criar.
    const lastOut = await prisma.message.findFirst({ where: { orgId: args.orgId, conversationId: conv.id, direction: 'OUT', status: { not: 'FAILED' } }, orderBy: { createdAt: 'desc' }, select: { body: true } });
    const lastIn = args.clientText ?? (await prisma.message.findFirst({ where: { orgId: args.orgId, conversationId: conv.id, direction: 'IN' }, orderBy: { createdAt: 'desc' }, select: { body: true } }))?.body ?? '';
    const p = zonedParts(startAt, tz);
    if (!isConfirmed({ clientText: lastIn, lastAssistant: lastOut?.body ?? null, hour: p.hour, minute: p.minute })) {
      const busy = await findConflicts(args.orgId, startAt, durationMin, { assignedUserId: conv.assignedUserId });
      if (busy.length) return conflictReply(args.orgId, startAt, durationMin, tz);
      return { text: `Só para confirmar: posso agendar a reunião para ${humanPt(startAt, tz)} (${durationMin} min)? Responda *sim* para confirmar.`, needsConfirmation: true };
    }
    try {
      const a = await createAppointment({
        kind: 'MEETING', title, description: data.descricao ? String(data.descricao).slice(0, 1000) : 'Agendado pela IA no WhatsApp',
        startAt, durationMin, contactId: conv.contactId, conversationId: conv.id, assignedUserId: conv.assignedUserId,
      }, { orgId: args.orgId, source: 'AI' });
      return { text: confirmationText(a, confirm), appointmentId: a.id };
    } catch (e) {
      if (!(e instanceof ConflictError)) throw e;
      return conflictReply(args.orgId, startAt, durationMin, tz);
    }
  });
}

async function conflictReply(orgId: string, startAt: Date, durationMin: number, tz: string) {
  const alt = await freeSlots(orgId, { days: 10, max: 3, durationMin });
  const opts = alt.length ? ` Tenho livre: ${alt.map((d) => humanPt(d, tz)).join('; ')}. Qual prefere?` : ' A equipe vai entrar em contato para combinar outro horário.';
  return { text: `Esse horário (${humanPt(startAt, tz)}) acabou de ser ocupado.${opts}`, conflict: true };
}
