import { createHmac } from 'node:crypto';
import { getMasterKey, safeEqual } from '../lib/crypto.js';

export interface IcsEvent {
  id: string;
  title: string;
  description?: string | null;
  location?: string | null;
  startAt: Date;
  durationMin: number;
  reminderMin: number;
  status: string; // SCHEDULED | DONE | CANCELLED
  sequence: number;
  updatedAt: Date;
  url?: string;
}

const pad = (n: number) => String(n).padStart(2, '0');
/** 20261103T170000Z */
export const icsDate = (d: Date) => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');

/** Dobra linhas em 75 octetos (RFC 5545), sem quebrar caracteres UTF-8. */
function fold(line: string): string {
  const out: string[] = [];
  let cur = '';
  let bytes = 0;
  for (const ch of line) {
    const b = Buffer.byteLength(ch);
    if (bytes + b > (out.length ? 74 : 75)) { out.push(cur); cur = ''; bytes = 0; }
    cur += ch; bytes += b;
  }
  out.push(cur);
  return out.join('\r\n ');
}

export const eventUid = (id: string) => `${id}@mckbot`;

export function buildIcs(events: IcsEvent[], opts: { name?: string; method?: 'PUBLISH' | 'REQUEST' | 'CANCEL' } = {}): string {
  const L: string[] = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//MCK Desenvolvimento//MCKBOT Agenda//PT-BR', 'CALSCALE:GREGORIAN', `METHOD:${opts.method ?? 'PUBLISH'}`];
  if (opts.name) L.push(`X-WR-CALNAME:${esc(opts.name)}`, 'X-PUBLISHED-TTL:PT15M', 'REFRESH-INTERVAL;VALUE=DURATION:PT15M');
  for (const e of events) {
    const end = new Date(e.startAt.getTime() + Math.max(1, e.durationMin) * 60_000);
    L.push('BEGIN:VEVENT', `UID:${eventUid(e.id)}`, `DTSTAMP:${icsDate(e.updatedAt)}`, `LAST-MODIFIED:${icsDate(e.updatedAt)}`,
      `SEQUENCE:${e.sequence}`, `DTSTART:${icsDate(e.startAt)}`, `DTEND:${icsDate(end)}`, `SUMMARY:${esc(e.title)}`,
      `STATUS:${e.status === 'CANCELLED' ? 'CANCELLED' : 'CONFIRMED'}`);
    if (e.description) L.push(`DESCRIPTION:${esc(e.description)}`);
    if (e.location) L.push(`LOCATION:${esc(e.location)}`);
    if (e.url) L.push(`URL:${e.url}`);
    if (e.reminderMin > 0 && e.status !== 'CANCELLED') {
      L.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${esc(e.title)}`, `TRIGGER:-PT${e.reminderMin}M`, 'END:VALARM');
    }
    L.push('END:VEVENT');
  }
  L.push('END:VCALENDAR');
  return L.map(fold).join('\r\n') + '\r\n';
}

/** Link "Adicionar ao Google Agenda" (abre o app/site do Google com o evento preenchido; não precisa de integração). */
export function googleAddLink(e: Pick<IcsEvent, 'title' | 'description' | 'location' | 'startAt' | 'durationMin'>): string {
  const end = new Date(e.startAt.getTime() + Math.max(1, e.durationMin) * 60_000);
  const q = new URLSearchParams({ action: 'TEMPLATE', text: e.title, dates: `${icsDate(e.startAt)}/${icsDate(end)}` });
  if (e.description) q.set('details', e.description);
  if (e.location) q.set('location', e.location);
  return `https://calendar.google.com/calendar/render?${q.toString()}`;
}

/** Link "Adicionar ao Outlook" (web). */
export function outlookAddLink(e: Pick<IcsEvent, 'title' | 'description' | 'location' | 'startAt' | 'durationMin'>): string {
  const end = new Date(e.startAt.getTime() + Math.max(1, e.durationMin) * 60_000);
  const q = new URLSearchParams({ path: '/calendar/action/compose', rru: 'addevent', subject: e.title, startdt: e.startAt.toISOString(), enddt: end.toISOString() });
  if (e.description) q.set('body', e.description);
  if (e.location) q.set('location', e.location);
  return `https://outlook.live.com/calendar/0/deeplink/compose?${q.toString()}`;
}

// Token público de um evento (link enviado ao contato, sem login): id + HMAC. Não precisa de coluna no banco.
const sign = (id: string) => createHmac('sha256', getMasterKey()).update(`agenda-evento:${id}`).digest('base64url').slice(0, 22);
export const publicEventToken = (id: string) => `${id}.${sign(id)}`;
export function verifyPublicEventToken(token: string): string | null {
  const [id, sig] = String(token ?? '').split('.');
  if (!id || !sig || !/^[a-z0-9]{10,40}$/i.test(id)) return null;
  return safeEqual(sig, sign(id)) ? id : null;
}
