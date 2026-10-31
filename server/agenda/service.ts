import type { Request } from 'express';
import type { Appointment } from '@prisma/client';
import { prisma } from '../db.js';
import { audit } from '../lib/audit.js';
import { HttpError, notFound } from '../lib/http.js';
import { appUrl, sendMail, smtpConfigured } from '../lib/mailer.js';
import { sendOutbound, resolveChannel, isQrChannel } from '../whatsapp/messaging.js';
import { sendCloudMessage } from '../whatsapp/cloudClient.js';
import { qrManager } from '../whatsapp/qr/manager.js';
import { decryptOrNull } from '../lib/crypto.js';
import { isProductActive } from '../billing/service.js';
import { normalizePhone } from '../routes/contacts.js';
import { parseJson } from '../lib/json.js';
import { buildIcs, googleAddLink, outlookAddLink, publicEventToken } from './ics.js';
import { googleBusy, upsertGoogleEvent, deleteGoogleEvent, googleConfigured, type GoogleAccountRow } from './google.js';
import { humanPt, safeTz, zonedParts, zonedToUtc, hhmmToMin, toLocalIso } from './time.js';

export const KIND_LABEL: Record<string, string> = { MEETING: 'Reunião', TASK: 'Tarefa' };

export interface AgendaSettingsView {
  aiBooking: boolean; workStart: string; workEnd: string; workDays: number[];
  defaultDurationMin: number; minNoticeMin: number; notifyContact: boolean; reminderMin: number;
  /** Padrões dos destinatários: responsável (atendente) e contatos adicionais. */
  notifyAssignee: boolean; notifyExtras: boolean;
}

export async function getSettings(orgId: string): Promise<AgendaSettingsView> {
  const s = await prisma.agendaSettings.findUnique({ where: { orgId } });
  return {
    aiBooking: s?.aiBooking ?? false,
    workStart: s?.workStart ?? '09:00',
    workEnd: s?.workEnd ?? '18:00',
    workDays: (s?.workDays ?? '1,2,3,4,5').split(',').map(Number).filter((n) => n >= 0 && n <= 6),
    defaultDurationMin: s?.defaultDurationMin ?? 30,
    minNoticeMin: s?.minNoticeMin ?? 60,
    notifyContact: s?.notifyContact ?? true,
    notifyAssignee: s?.notifyAssignee ?? false,
    notifyExtras: s?.notifyExtras ?? true,
    reminderMin: s?.reminderMin ?? 60,
  };
}

export async function orgTz(orgId: string) {
  const o = await prisma.organization.findUnique({ where: { id: orgId }, select: { timezone: true } });
  return safeTz(o?.timezone);
}

const endOf = (a: { startAt: Date; durationMin: number }) => new Date(a.startAt.getTime() + a.durationMin * 60_000);
const overlaps = (s1: Date, e1: Date, s2: Date, e2: Date) => s1 < e2 && s2 < e1;

async function googleAccountsFor(orgId: string, assignedUserId?: string | null) {
  if (!googleConfigured()) return [];
  return prisma.googleCalendarAccount.findMany({ where: assignedUserId ? { orgId, userId: assignedUserId } : { orgId }, take: 5 });
}

export interface Busy { start: Date; end: Date; title?: string; source: 'agenda' | 'google' }

/** Horários ocupados: agenda interna (reuniões/tarefas agendadas) + Google Agenda conectado. */
export async function busyIntervals(orgId: string, from: Date, to: Date, opts: { excludeId?: string; assignedUserId?: string | null } = {}): Promise<Busy[]> {
  const where: any = { orgId, status: 'SCHEDULED', startAt: { lt: to, gte: new Date(from.getTime() - 24 * 3600e3) } };
  if (opts.excludeId) where.id = { not: opts.excludeId };
  if (opts.assignedUserId) where.OR = [{ assignedUserId: opts.assignedUserId }, { assignedUserId: null }];
  const own = await prisma.appointment.findMany({ where, take: 1000 });
  const out: Busy[] = own.filter((a) => overlaps(a.startAt, endOf(a), from, to)).map((a) => ({ start: a.startAt, end: endOf(a), title: a.title, source: 'agenda' as const }));
  const excluded = opts.excludeId ? await prisma.appointment.findUnique({ where: { id: opts.excludeId } }) : null;
  for (const acc of await googleAccountsFor(orgId, opts.assignedUserId)) {
    try {
      for (const b of await googleBusy(acc, from, to)) {
        // O próprio evento (que está sendo remarcado) aparece como ocupado no Google: ignora.
        if (excluded && b.start.getTime() === excluded.startAt.getTime() && b.end.getTime() === endOf(excluded).getTime()) continue;
        out.push({ start: b.start, end: b.end, source: 'google' });
      }
    } catch (e) {
      await audit(null, 'agenda.google_falha', { orgId, entity: 'google', entityId: acc.id, meta: { op: 'freebusy', error: (e as Error).message } }).catch(() => undefined);
    }
  }
  return out;
}

export async function findConflicts(orgId: string, startAt: Date, durationMin: number, opts: { excludeId?: string; assignedUserId?: string | null } = {}) {
  const end = new Date(startAt.getTime() + durationMin * 60_000);
  return (await busyIntervals(orgId, startAt, end, opts)).filter((b) => overlaps(b.start, b.end, startAt, end));
}

/** Próximos horários livres dentro do horário de atendimento. */
export async function freeSlots(orgId: string, opts: { days?: number; max?: number; durationMin?: number; now?: Date } = {}): Promise<Date[]> {
  const s = await getSettings(orgId);
  const tz = await orgTz(orgId);
  const dur = opts.durationMin ?? s.defaultDurationMin;
  const now = opts.now ?? new Date();
  const earliest = new Date(now.getTime() + s.minNoticeMin * 60_000);
  const horizon = new Date(now.getTime() + (opts.days ?? 7) * 24 * 3600e3);
  const busy = await busyIntervals(orgId, now, horizon);
  const startMin = hhmmToMin(s.workStart);
  const endMin = hhmmToMin(s.workEnd);
  const step = 30;
  const out: Date[] = [];
  for (let i = 0; i <= (opts.days ?? 7) && out.length < (opts.max ?? 12); i++) {
    const day = zonedParts(new Date(now.getTime() + i * 24 * 3600e3), tz);
    if (!s.workDays.includes(day.weekday)) continue;
    for (let m = startMin; m + dur <= endMin && out.length < (opts.max ?? 12); m += step) {
      const t = zonedToUtc(day.year, day.month, day.day, Math.floor(m / 60), m % 60, tz);
      if (t < earliest) continue;
      const e = new Date(t.getTime() + dur * 60_000);
      if (busy.some((b) => overlaps(b.start, b.end, t, e))) continue;
      out.push(t);
    }
  }
  return out;
}

// ---------------- Links e visualização ----------------

export const publicEventUrl = (id: string, req?: Request) => `${appUrl(req)}/api/public/agenda/e/${publicEventToken(id)}`;
export const publicIcsUrl = (id: string, req?: Request) => `${publicEventUrl(id, req)}.ics`;

export function icsOf(a: Appointment, req?: Request) {
  return buildIcs([{ ...a, url: publicEventUrl(a.id, req) }]);
}

export function viewAppointment(a: Appointment, tz: string, maps: { contacts?: Map<string, { id: string; name: string | null; phone: string }>; users?: Map<string, { id: string; name: string }> } = {}, req?: Request) {
  const c = a.contactId ? maps.contacts?.get(a.contactId) : undefined;
  const u = a.assignedUserId ? maps.users?.get(a.assignedUserId) : undefined;
  return {
    id: a.id, kind: a.kind, title: a.title, description: a.description, location: a.location,
    startAt: a.startAt, endAt: endOf(a), localStart: toLocalIso(a.startAt, tz), durationMin: a.durationMin, reminderMin: a.reminderMin,
    status: a.status, source: a.source, notifyContact: a.notifyContact,
    notifyAssignee: a.notifyAssignee, notifyExtras: a.notifyExtras, extraContacts: extraContactsOf(a),
    contactId: a.contactId, contact: c ? { id: c.id, name: c.name, phone: c.phone } : null,
    assignedUserId: a.assignedUserId, assignedUser: u ? { id: u.id, name: u.name } : null,
    createdById: a.createdById, googleSynced: !!a.googleEventId, meetLink: a.meetLink ?? null, createdAt: a.createdAt, updatedAt: a.updatedAt,
    links: { page: publicEventUrl(a.id, req), ics: publicIcsUrl(a.id, req), google: googleAddLink(a), outlook: outlookAddLink(a) },
  };
}

export async function viewMany(orgId: string, list: Appointment[], req?: Request) {
  const tz = await orgTz(orgId);
  const cIds = [...new Set(list.map((a) => a.contactId).filter(Boolean))] as string[];
  const uIds = [...new Set(list.map((a) => a.assignedUserId).filter(Boolean))] as string[];
  const contacts: { id: string; name: string | null; phone: string }[] = cIds.length ? await prisma.contact.findMany({ where: { orgId, id: { in: cIds } }, select: { id: true, name: true, phone: true } }) : [];
  const users: { id: string; name: string }[] = uIds.length ? await prisma.user.findMany({ where: { id: { in: uIds } }, select: { id: true, name: true } }) : [];
  const maps = { contacts: new Map(contacts.map((c) => [c.id, c] as const)), users: new Map(users.map((u) => [u.id, u] as const)) };
  return list.map((a) => viewAppointment(a, tz, maps, req));
}

// ---------------- Criação / alteração ----------------

export interface AppointmentInput {
  kind?: 'MEETING' | 'TASK';
  title: string;
  description?: string | null;
  location?: string | null;
  startAt: Date;
  durationMin?: number;
  reminderMin?: number;
  contactId?: string | null;
  conversationId?: string | null;
  assignedUserId?: string | null;
  notifyContact?: boolean;
  /** "Gerar link do Google Meet": padrão = ligado para reuniões quando há Google conectado. */
  generateMeet?: boolean;
  /** Contatos adicionais (equipe) que recebem o aviso por WhatsApp — máx. 5, telefone obrigatório. */
  extraContacts?: { name?: string | null; phone: string }[];
  notifyAssignee?: boolean;
  notifyExtras?: boolean;
}

export const MAX_EXTRA_CONTACTS = 5;
export interface ExtraContact { name: string | null; phone: string }

export const extraContactsOf = (a: Pick<Appointment, 'extraContacts'>): ExtraContact[] =>
  parseJson<ExtraContact[]>(a.extraContacts, []).filter((c) => c && typeof c.phone === 'string');

/** Valida e normaliza os contatos adicionais (telefone obrigatório e válido, sem repetidos, máx. 5). */
export function normalizeExtraContacts(list: { name?: string | null; phone: string }[] | undefined | null): ExtraContact[] {
  const arr = list ?? [];
  if (arr.length > MAX_EXTRA_CONTACTS) throw new HttpError(400, `No máximo ${MAX_EXTRA_CONTACTS} contatos adicionais por compromisso`);
  const out: ExtraContact[] = [];
  for (const [i, c] of arr.entries()) {
    const phone = normalizePhone(String(c?.phone ?? ''));
    if (!phone) throw new HttpError(400, `Contato adicional ${i + 1}: telefone inválido`);
    if (out.some((o) => o.phone === phone)) throw new HttpError(400, `Contato adicional ${i + 1}: telefone repetido`);
    const name = String(c?.name ?? '').trim().slice(0, 80);
    out.push({ name: name || null, phone });
  }
  return out;
}

interface Ctx { orgId: string; userId?: string | null; req?: Request | null; source?: 'MANUAL' | 'AI' | 'KANBAN'; force?: boolean }

async function checkRefs(orgId: string, input: Partial<AppointmentInput>) {
  if (input.contactId && !(await prisma.contact.findFirst({ where: { id: input.contactId, orgId }, select: { id: true } }))) throw notFound('Contato');
  if (input.assignedUserId && !(await prisma.membership.findUnique({ where: { userId_orgId: { userId: input.assignedUserId, orgId } } }))) throw new HttpError(400, 'Responsável não faz parte da equipe');
  if (input.conversationId && !(await prisma.conversation.findFirst({ where: { id: input.conversationId, orgId }, select: { id: true } }))) throw notFound('Conversa');
}

export class ConflictError extends HttpError {
  constructor(public conflicts: Busy[]) {
    super(409, 'Conflito de horário: já existe compromisso nesse período.', { conflicts: conflicts.map((c) => ({ start: c.start, end: c.end, title: c.title ?? 'Ocupado (Google Agenda)', source: c.source })) });
  }
}

export async function createAppointment(input: AppointmentInput, ctx: Ctx): Promise<Appointment> {
  const s = await getSettings(ctx.orgId);
  await checkRefs(ctx.orgId, input);
  const extras = normalizeExtraContacts(input.extraContacts);
  const durationMin = input.durationMin ?? s.defaultDurationMin;
  const kind = input.kind ?? 'MEETING';
  // Tarefas não bloqueiam a agenda; reuniões checam conflito (a menos que o usuário force).
  if (kind === 'MEETING' && !ctx.force) {
    const conflicts = await findConflicts(ctx.orgId, input.startAt, durationMin, { assignedUserId: input.assignedUserId });
    if (conflicts.length) throw new ConflictError(conflicts);
  }
  const a = await prisma.appointment.create({
    data: {
      orgId: ctx.orgId, kind, title: input.title, description: input.description || null, location: input.location || null,
      startAt: input.startAt, durationMin, reminderMin: input.reminderMin ?? s.reminderMin,
      contactId: input.contactId || null, conversationId: input.conversationId || null,
      assignedUserId: input.assignedUserId || null, createdById: ctx.userId ?? null,
      notifyContact: input.notifyContact ?? s.notifyContact, source: ctx.source ?? 'MANUAL',
      notifyAssignee: input.notifyAssignee ?? s.notifyAssignee, notifyExtras: input.notifyExtras ?? s.notifyExtras,
      extraContacts: JSON.stringify(extras),
    },
  });
  await audit(ctx.req ?? null, ctx.source === 'AI' ? 'agenda.ai_create' : 'agenda.create', { orgId: ctx.orgId, userId: ctx.userId ?? null, entity: 'appointment', entityId: a.id, meta: { kind, startAt: a.startAt, contactId: a.contactId, source: a.source } });
  const wantMeet = input.generateMeet ?? kind === 'MEETING';
  const synced = await syncGoogle(a, { meet: wantMeet });
  if (wantMeet && !synced.meetLink) console.warn(`[agenda] compromisso ${a.id} criado sem link do Google Meet (${synced.googleEventId ? 'o Google não devolveu o link' : 'Google Agenda não conectado ou falhou'})`);
  await notifyCreated(synced, ctx.req ?? undefined);
  return synced;
}

export async function updateAppointment(id: string, patch: Partial<AppointmentInput> & { status?: 'SCHEDULED' | 'DONE' | 'CANCELLED' }, ctx: Ctx): Promise<Appointment> {
  const cur = await prisma.appointment.findFirst({ where: { id, orgId: ctx.orgId } });
  if (!cur) throw notFound('Compromisso');
  await checkRefs(ctx.orgId, patch);
  const extras = patch.extraContacts !== undefined ? normalizeExtraContacts(patch.extraContacts) : undefined;
  const startAt = patch.startAt ?? cur.startAt;
  const durationMin = patch.durationMin ?? cur.durationMin;
  const moved = startAt.getTime() !== cur.startAt.getTime() || durationMin !== cur.durationMin;
  const status = patch.status ?? cur.status;
  if (moved && status === 'SCHEDULED' && (patch.kind ?? cur.kind) === 'MEETING' && !ctx.force) {
    const conflicts = await findConflicts(ctx.orgId, startAt, durationMin, { excludeId: cur.id, assignedUserId: patch.assignedUserId !== undefined ? patch.assignedUserId : cur.assignedUserId });
    if (conflicts.length) throw new ConflictError(conflicts);
  }
  const data: any = { sequence: cur.sequence + 1 };
  for (const k of ['kind', 'title', 'description', 'location', 'startAt', 'durationMin', 'reminderMin', 'contactId', 'assignedUserId', 'notifyContact', 'notifyAssignee', 'notifyExtras', 'status'] as const) {
    if ((patch as any)[k] !== undefined) data[k] = (patch as any)[k] === '' ? null : (patch as any)[k];
  }
  if (extras) data.extraContacts = JSON.stringify(extras);
  if (moved) data.reminderSentAt = null;
  const a = await prisma.appointment.update({ where: { id: cur.id }, data });
  const action = status === 'CANCELLED' && cur.status !== 'CANCELLED' ? 'agenda.cancel' : status === 'DONE' && cur.status !== 'DONE' ? 'agenda.done' : 'agenda.update';
  await audit(ctx.req ?? null, action, { orgId: ctx.orgId, userId: ctx.userId ?? null, entity: 'appointment', entityId: a.id, meta: { moved, from: moved ? cur.startAt : undefined, to: moved ? a.startAt : undefined } });
  const synced = await syncGoogle(a);
  if (a.status === 'SCHEDULED' && moved) await notifyRecipients(synced, 'remarcado', { req: ctx.req ?? undefined });
  if (action === 'agenda.cancel') await notifyRecipients(synced, 'cancelado', { req: ctx.req ?? undefined });
  return synced;
}

/**
 * Exclusão definitiva: só de compromissos CANCELADOS (os demais devem ser cancelados antes — 409).
 * `confirmar` roda depois das checagens e antes de apagar (a rota confere a senha do usuário ali).
 */
export async function deleteAppointment(id: string, ctx: Ctx, confirmar?: () => Promise<void>) {
  const cur = await prisma.appointment.findFirst({ where: { id, orgId: ctx.orgId } });
  if (!cur) throw notFound('Compromisso');
  if (cur.status !== 'CANCELLED') throw new HttpError(409, 'Só compromissos cancelados podem ser excluídos. Cancele o compromisso antes de excluir.');
  if (confirmar) await confirmar();
  if (cur.googleEventId && cur.googleAccountId) {
    const acc = await prisma.googleCalendarAccount.findFirst({ where: { id: cur.googleAccountId, orgId: ctx.orgId } });
    if (acc) await deleteGoogleEvent(acc, cur.googleEventId).catch(() => undefined);
  }
  const r = await prisma.appointment.deleteMany({ where: { id: cur.id, orgId: ctx.orgId, status: 'CANCELLED' } });
  if (!r.count) throw new HttpError(409, 'O compromisso mudou de status e não foi excluído.');
  await audit(ctx.req ?? null, 'agenda.delete', { orgId: ctx.orgId, userId: ctx.userId ?? null, entity: 'appointment', entityId: cur.id });
}

// ---------------- Google Agenda (sincronização, se conectado) ----------------

async function accountFor(a: Appointment): Promise<GoogleAccountRow | null> {
  if (!googleConfigured()) return null;
  if (a.googleAccountId) {
    const acc = await prisma.googleCalendarAccount.findFirst({ where: { id: a.googleAccountId, orgId: a.orgId } });
    if (acc) return acc;
  }
  for (const userId of [a.assignedUserId, a.createdById]) {
    if (!userId) continue;
    const acc = await prisma.googleCalendarAccount.findUnique({ where: { orgId_userId: { orgId: a.orgId, userId } } });
    if (acc) return acc;
  }
  return null;
}

export async function syncGoogle(a: Appointment, opts: { meet?: boolean } = {}): Promise<Appointment> {
  const acc = await accountFor(a);
  if (!acc) return a;
  try {
    if (a.status === 'CANCELLED') {
      if (a.googleEventId) await deleteGoogleEvent(acc, a.googleEventId);
      return a.googleEventId ? prisma.appointment.update({ where: { id: a.id }, data: { googleEventId: null } }) : a;
    }
    const tz = await orgTz(a.orgId);
    const title = a.status === 'DONE' ? `✔ ${a.title}` : a.title;
    // Pede o Meet na criação (opção marcada) ou se o evento tinha Meet e precisou ser recriado no Google.
    const meet = opts.meet ?? (!!a.meetLink && !a.googleEventId);
    const ev = await upsertGoogleEvent(acc, a.googleEventId, { ...a, title }, tz, { meet });
    const meetLink = ev.meetLink ?? a.meetLink ?? null;
    if (ev.id !== a.googleEventId || a.googleAccountId !== acc.id || meetLink !== (a.meetLink ?? null)) {
      return prisma.appointment.update({ where: { id: a.id }, data: { googleEventId: ev.id, googleAccountId: acc.id, meetLink } });
    }
    return a;
  } catch (e) {
    console.warn(`[agenda] falha ao sincronizar com o Google Agenda (${a.id}): ${(e as Error).message}`);
    await audit(null, 'agenda.google_falha', { orgId: a.orgId, entity: 'appointment', entityId: a.id, meta: { error: (e as Error).message } }).catch(() => undefined);
    return a;
  }
}

// ---------------- Avisos (contato por WhatsApp, equipe por e-mail) ----------------

async function conversationFor(a: Appointment) {
  if (!a.contactId) return null;
  if (a.conversationId) {
    const c = await prisma.conversation.findFirst({ where: { id: a.conversationId, orgId: a.orgId } });
    if (c) return c;
  }
  const last = await prisma.conversation.findFirst({ where: { orgId: a.orgId, contactId: a.contactId }, orderBy: { createdAt: 'desc' } });
  return last ?? prisma.conversation.create({ data: { orgId: a.orgId, contactId: a.contactId, status: 'CLOSED', closedAt: new Date() } });
}

export function contactMessage(a: Appointment, tz: string, kind: 'criado' | 'remarcado' | 'cancelado' | 'lembrete', req?: Request) {
  const when = humanPt(a.startAt, tz);
  const label = KIND_LABEL[a.kind] ?? 'Compromisso';
  if (kind === 'cancelado') return `❌ ${label} cancelado: *${a.title}* (${when}).`;
  const head = kind === 'lembrete' ? `⏰ Lembrete: *${a.title}*` : kind === 'remarcado' ? `🔁 ${label} remarcado: *${a.title}*` : `📅 ${label} agendado: *${a.title}*`;
  const lines = [head, `🗓 ${when.charAt(0).toUpperCase() + when.slice(1)} (${a.durationMin} min)`];
  if (a.location) lines.push(`📍 ${a.location}`);
  if (a.description) lines.push(`📝 ${a.description}`);
  if (a.meetLink) lines.push(`🎥 Link da reunião (Google Meet): ${a.meetLink}`);
  if (kind !== 'lembrete') lines.push('', `Adicione à agenda do seu celular (Google, iPhone ou Outlook): ${publicEventUrl(a.id, req)}`);
  return lines.join('\n');
}

/** Variante para a equipe (responsável e contatos adicionais): "Reunião com <cliente>". */
export function teamMessage(a: Appointment, tz: string, kind: 'criado' | 'remarcado' | 'cancelado' | 'lembrete', clientName: string | null, req?: Request) {
  const when = humanPt(a.startAt, tz);
  const label = KIND_LABEL[a.kind] ?? 'Compromisso';
  const com = clientName ? ` com ${clientName}` : '';
  if (kind === 'cancelado') return `❌ ${label}${com} cancelada: *${a.title}* (${when}).`;
  const head = kind === 'lembrete' ? `⏰ Lembrete — ${label}${com}: *${a.title}*` : kind === 'remarcado' ? `🔁 ${label}${com} remarcada: *${a.title}*` : `📅 ${label}${com}: *${a.title}*`;
  const lines = [head, `🗓 ${when.charAt(0).toUpperCase() + when.slice(1)} (${a.durationMin} min)`];
  if (a.location) lines.push(`📍 ${a.location}`);
  if (a.description) lines.push(`📝 ${a.description}`);
  if (a.meetLink) lines.push(`🎥 Link da reunião (Google Meet): ${a.meetLink}`);
  if (kind !== 'lembrete') lines.push('', `Adicionar à agenda: ${publicEventUrl(a.id, req)}`);
  return lines.join('\n');
}

type NotifyKind = 'criado' | 'remarcado' | 'cancelado' | 'lembrete';
interface NotifyOpts { req?: Request; sender?: 'system' | 'agent'; authorUserId?: string }

async function notifyContact(a: Appointment, kind: NotifyKind, req?: Request, opts: NotifyOpts = {}) {
  if (!a.notifyContact || !a.contactId) return false;
  try {
    const contact = await prisma.contact.findFirst({ where: { id: a.contactId, orgId: a.orgId } });
    if (!contact || contact.optOut) return false;
    const conv = await conversationFor(a);
    if (!conv) return false;
    const tz = await orgTz(a.orgId);
    const m = await sendOutbound({ conversation: conv, contact, payload: { type: 'text', text: contactMessage(a, tz, kind, req), previewUrl: true }, sender: opts.sender ?? 'system', authorUserId: opts.authorUserId });
    if (m.status === 'FAILED') console.warn(`[agenda] aviso ao cliente falhou (${a.id}): ${m.error ?? 'erro'}`);
    return m.status !== 'FAILED';
  } catch (e) {
    console.error('[agenda] aviso ao contato falhou', (e as Error).message);
    return false;
  }
}

export interface RecipientResult { target: 'cliente' | 'atendente' | 'adicional'; phone?: string; name?: string | null; ok: boolean; error?: string }

/** Telefone (WhatsApp) do responsável, normalizado; nulo se ele não cadastrou no perfil. */
async function assigneePhone(a: Appointment) {
  if (!a.assignedUserId) return null;
  const u = await prisma.user.findUnique({ where: { id: a.assignedUserId }, select: { name: true, phone: true } });
  const phone = u?.phone ? normalizePhone(u.phone) : null;
  return phone ? { name: u!.name, phone } : null;
}

/** Envia texto por WhatsApp a um número da equipe (sem criar contato/conversa no CRM), pelo canal da empresa. */
async function sendToPhone(a: Appointment, to: string, text: string) {
  if (!(await isProductActive(a.orgId, 'MCKBOT'))) throw new Error('Assinatura inativa');
  const conv = a.conversationId ? await prisma.conversation.findFirst({ where: { id: a.conversationId, orgId: a.orgId }, select: { channelId: true } }) : null;
  const channel = await resolveChannel({ orgId: a.orgId, channelId: conv?.channelId ?? null });
  if (!channel) throw new Error('Nenhum canal WhatsApp na organização');
  if (isQrChannel(channel)) {
    if (!qrManager.canSend(channel.id)) throw new Error('WhatsApp (QR) não conectado');
    await qrManager.send(channel.id, to, { type: 'text', text });
    return;
  }
  const accessToken = decryptOrNull(channel.accessTokenEnc);
  if (channel.status !== 'CONNECTED' || !channel.phoneNumberId || !accessToken) throw new Error('Canal WhatsApp não conectado');
  await sendCloudMessage({ phoneNumberId: channel.phoneNumberId, accessToken }, to, { type: 'text', text, previewUrl: true });
}

/**
 * Avisa por WhatsApp cada destinatário marcado no compromisso (cliente / responsável / contatos adicionais).
 * Cada envio é independente: a falha de um é registrada e não impede os demais. Telefones repetidos recebem uma vez só.
 */
export async function notifyRecipients(a: Appointment, kind: NotifyKind, opts: NotifyOpts & { skipClient?: boolean } = {}): Promise<RecipientResult[]> {
  const results: RecipientResult[] = [];
  const seen = new Set<string>();
  let client: { name: string | null; phone: string } | null = null;
  if (a.contactId) {
    const c = await prisma.contact.findFirst({ where: { id: a.contactId, orgId: a.orgId }, select: { name: true, phone: true } });
    if (c) client = { name: c.name, phone: normalizePhone(c.phone) ?? c.phone.replace(/\D/g, '') };
  }
  if (a.notifyContact && client && !opts.skipClient) {
    seen.add(client.phone);
    const ok = await notifyContact(a, kind, opts.req, opts);
    results.push({ target: 'cliente', phone: client.phone, name: client.name, ok, ...(ok ? {} : { error: 'Falha no envio ao cliente' }) });
  } else if (client) seen.add(client.phone); // o cliente nunca recebe a variante da equipe
  const team: { target: 'atendente' | 'adicional'; name: string | null; phone: string }[] = [];
  if (a.notifyAssignee) {
    const ap = await assigneePhone(a);
    if (ap) team.push({ target: 'atendente', ...ap });
    else if (a.assignedUserId) results.push({ target: 'atendente', ok: false, error: 'Responsável sem WhatsApp cadastrado no perfil' });
  }
  if (a.notifyExtras) for (const c of extraContactsOf(a)) team.push({ target: 'adicional', ...c });
  if (!team.length) return results;
  const tz = await orgTz(a.orgId);
  const text = teamMessage(a, tz, kind, client ? client.name ?? client.phone : null, opts.req);
  for (const r of team) {
    if (seen.has(r.phone)) continue;
    seen.add(r.phone);
    try {
      await sendToPhone(a, r.phone, text);
      results.push({ target: r.target, phone: r.phone, name: r.name, ok: true });
    } catch (e) {
      const error = (e as Error).message;
      console.error(`[agenda] aviso por WhatsApp (${r.target}) falhou`, a.id, error);
      await audit(null, 'agenda.aviso_falha', { orgId: a.orgId, entity: 'appointment', entityId: a.id, meta: { target: r.target, kind, error } }).catch(() => undefined);
      results.push({ target: r.target, phone: r.phone, name: r.name, ok: false, error });
    }
  }
  return results;
}

/** Há alguém para avisar por WhatsApp neste compromisso? */
export function hasRecipients(a: Appointment) {
  return (a.notifyContact && !!a.contactId) || (a.notifyAssignee && !!a.assignedUserId) || (a.notifyExtras && extraContactsOf(a).length > 0);
}

async function notifyCreated(a: Appointment, req?: Request) {
  // A IA já confirma o horário na própria resposta ao cliente; os demais destinatários (equipe) são avisados mesmo assim.
  await notifyRecipients(a, 'criado', { req, skipClient: a.source === 'AI' });
  await notifyTeam(a, req);
}

/** E-mail para o responsável com o convite .ics anexado (abre direto na agenda do celular). */
async function notifyTeam(a: Appointment, req?: Request) {
  const userId = a.assignedUserId ?? a.createdById;
  if (!userId || (!smtpConfigured() && process.env.NODE_ENV !== 'test')) return;
  try {
    const u = await prisma.user.findUnique({ where: { id: userId }, select: { email: true, name: true } });
    if (!u) return;
    const tz = await orgTz(a.orgId);
    const when = humanPt(a.startAt, tz);
    const text = `${KIND_LABEL[a.kind] ?? 'Compromisso'}: ${a.title}\nQuando: ${when} (${a.durationMin} min)\n${a.location ? `Local: ${a.location}\n` : ''}${a.meetLink ? `Google Meet: ${a.meetLink}\n` : ''}\nAbra o anexo convite.ics para adicionar à agenda do celular, ou use: ${publicEventUrl(a.id, req)}`;
    await sendMail({
      to: u.email, subject: `📅 ${a.title} — ${when}`, kind: 'agenda', text,
      html: `<p><strong>${escHtml(a.title)}</strong></p><p>${escHtml(when)} (${a.durationMin} min)</p>${a.location ? `<p>Local: ${escHtml(a.location)}</p>` : ''}${a.meetLink ? `<p>Google Meet: <a href="${escHtml(a.meetLink)}">${escHtml(a.meetLink)}</a></p>` : ''}<p><a href="${publicEventUrl(a.id, req)}">Adicionar à minha agenda</a></p>`,
      attachments: [{ filename: 'convite.ics', content: Buffer.from(icsOf(a, req)), contentType: 'text/calendar; charset=utf-8; method=PUBLISH' }],
    });
  } catch (e) {
    console.error('[agenda] e-mail para a equipe falhou', (e as Error).message);
  }
}

export const escHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

/** Lembretes por WhatsApp para os destinatários marcados (o celular também avisa sozinho pelo alarme do .ics/feed). */
export async function tickAgendaReminders(now = new Date()) {
  const soon = await prisma.appointment.findMany({
    where: {
      status: 'SCHEDULED', reminderSentAt: null, reminderMin: { gt: 0 }, startAt: { gt: now, lte: new Date(now.getTime() + 7 * 24 * 3600e3) },
      OR: [{ notifyContact: true, contactId: { not: null } }, { notifyAssignee: true, assignedUserId: { not: null } }, { notifyExtras: true, extraContacts: { not: '[]' } }],
    },
    orderBy: { startAt: 'asc' }, take: 200,
  });
  let sent = 0;
  for (const a of soon) {
    if (a.startAt.getTime() - a.reminderMin * 60_000 > now.getTime()) continue;
    if (!hasRecipients(a)) continue;
    // Reserva o lembrete (reminderSentAt) antes de enviar: cada destinatário recebe uma vez só, mesmo com ticks simultâneos.
    const claim = await prisma.appointment.updateMany({ where: { id: a.id, reminderSentAt: null }, data: { reminderSentAt: now } });
    if (claim.count !== 1) continue;
    const r = await notifyRecipients(a, 'lembrete');
    if (r.some((x) => x.ok)) sent++;
  }
  return sent;
}
