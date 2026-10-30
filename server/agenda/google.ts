import { createHmac, randomBytes } from 'node:crypto';
import type { Request } from 'express';
import { httpFetch } from '../lib/fetcher.js';
import { decrypt, getMasterKey, safeEqual } from '../lib/crypto.js';
import { appUrl } from '../lib/mailer.js';

/**
 * Integração direta com o Google Agenda (Google Calendar API — gratuita).
 * Variáveis: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET e (opcional) GOOGLE_REDIRECT_URI.
 * Sem elas, o resto da Agenda (.ics, links e feed webcal) funciona normalmente.
 */
export const GOOGLE_SCOPES = [
  'openid', 'email',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.freebusy',
];
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API = 'https://www.googleapis.com/calendar/v3';

export const googleConfigured = () => !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
export const googleRedirectUri = (req?: Request) => process.env.GOOGLE_REDIRECT_URI || `${appUrl(req)}/api/agenda/google/callback`;

// ---- state assinado (CSRF do OAuth): liga o retorno ao usuário/empresa que pediu ----
const mac = (s: string) => createHmac('sha256', getMasterKey()).update(`google-oauth:${s}`).digest('base64url');
export function makeState(userId: string, orgId: string, app: string) {
  const body = Buffer.from(JSON.stringify({ u: userId, o: orgId, a: app, e: Date.now() + 10 * 60_000, n: randomBytes(8).toString('hex') })).toString('base64url');
  return `${body}.${mac(body)}`;
}
export function readState(state: string): { u: string; o: string; a: string } | null {
  const [body, sig] = String(state ?? '').split('.');
  if (!body || !sig || !safeEqual(sig, mac(body))) return null;
  try {
    const v = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return v.e > Date.now() ? v : null;
  } catch { return null; }
}

export function authUrl(state: string, req?: Request) {
  const q = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID ?? '', redirect_uri: googleRedirectUri(req), response_type: 'code',
    scope: GOOGLE_SCOPES.join(' '), access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', state,
  });
  return `${AUTH_URL}?${q.toString()}`;
}

async function tokenCall(params: Record<string, string>) {
  const res = await httpFetch(TOKEN_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: process.env.GOOGLE_CLIENT_ID ?? '', client_secret: process.env.GOOGLE_CLIENT_SECRET ?? '', ...params }).toString(),
    signal: AbortSignal.timeout(15000),
  });
  const json = (await res.json().catch(() => ({}))) as any;
  if (!res.ok) throw new Error(json.error_description || json.error || `Google retornou HTTP ${res.status}`);
  return json;
}

/** Troca o código do OAuth por tokens; devolve o refresh token e o e-mail da conta. */
export async function exchangeCode(code: string, req?: Request): Promise<{ refreshToken: string; accessToken: string; expiresIn: number; email: string | null }> {
  const j = await tokenCall({ code, grant_type: 'authorization_code', redirect_uri: googleRedirectUri(req) });
  if (!j.refresh_token) throw new Error('O Google não devolveu acesso permanente. Remova o acesso do MCKBOT em myaccount.google.com/permissions e conecte de novo.');
  let email: string | null = null;
  try {
    // id_token veio direto do Google por HTTPS: basta ler o e-mail.
    if (j.id_token) email = JSON.parse(Buffer.from(String(j.id_token).split('.')[1], 'base64url').toString('utf8')).email ?? null;
  } catch { /* sem e-mail */ }
  return { refreshToken: j.refresh_token, accessToken: j.access_token, expiresIn: Number(j.expires_in ?? 3600), email };
}

const cache = new Map<string, { token: string; until: number }>();
export interface GoogleAccountRow { id: string; refreshTokenEnc: string; calendarId: string }

export async function accessToken(acc: GoogleAccountRow): Promise<string> {
  const c = cache.get(acc.id);
  if (c && c.until > Date.now() + 60_000) return c.token;
  const j = await tokenCall({ refresh_token: decrypt(acc.refreshTokenEnc), grant_type: 'refresh_token' });
  cache.set(acc.id, { token: j.access_token, until: Date.now() + Number(j.expires_in ?? 3600) * 1000 });
  return j.access_token;
}
export const forgetToken = (accId: string) => cache.delete(accId);

async function api(acc: GoogleAccountRow, method: string, path: string, body?: unknown) {
  const token = await accessToken(acc);
  const res = await httpFetch(`${API}${path}`, {
    method, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000),
  });
  if (res.status === 204) return {};
  const json = (await res.json().catch(() => ({}))) as any;
  if (!res.ok) {
    const err = new Error(json?.error?.message ?? `Google Agenda retornou HTTP ${res.status}`) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  return json;
}

export interface GEvent { title: string; description?: string | null; location?: string | null; startAt: Date; durationMin: number; reminderMin: number; status: string }

function toGoogle(e: GEvent, tz: string) {
  const end = new Date(e.startAt.getTime() + Math.max(1, e.durationMin) * 60_000);
  return {
    summary: e.title, description: e.description ?? undefined, location: e.location ?? undefined,
    start: { dateTime: e.startAt.toISOString(), timeZone: tz }, end: { dateTime: end.toISOString(), timeZone: tz },
    status: e.status === 'CANCELLED' ? 'cancelled' : 'confirmed',
    reminders: e.reminderMin > 0 ? { useDefault: false, overrides: [{ method: 'popup', minutes: e.reminderMin }] } : { useDefault: false, overrides: [] },
  };
}

const cal = (acc: GoogleAccountRow) => encodeURIComponent(acc.calendarId || 'primary');

/** Cria ou atualiza o evento no Google Agenda; devolve o id do evento. */
export async function upsertGoogleEvent(acc: GoogleAccountRow, eventId: string | null, e: GEvent, tz: string): Promise<string> {
  if (eventId) {
    try {
      const r = await api(acc, 'PATCH', `/calendars/${cal(acc)}/events/${encodeURIComponent(eventId)}`, toGoogle(e, tz));
      return r.id ?? eventId;
    } catch (err) {
      if ((err as any).status !== 404 && (err as any).status !== 410) throw err;
    }
  }
  const r = await api(acc, 'POST', `/calendars/${cal(acc)}/events`, toGoogle(e, tz));
  return r.id;
}

export async function deleteGoogleEvent(acc: GoogleAccountRow, eventId: string) {
  try { await api(acc, 'DELETE', `/calendars/${cal(acc)}/events/${encodeURIComponent(eventId)}`); }
  catch (err) { if ((err as any).status !== 404 && (err as any).status !== 410) throw err; }
}

/** Horários ocupados no Google Agenda (freeBusy). */
export async function googleBusy(acc: GoogleAccountRow, from: Date, to: Date): Promise<{ start: Date; end: Date }[]> {
  const r = await api(acc, 'POST', '/freeBusy', { timeMin: from.toISOString(), timeMax: to.toISOString(), items: [{ id: acc.calendarId || 'primary' }] });
  const cals = r.calendars ?? {};
  const busy = (Object.values(cals)[0] as any)?.busy ?? [];
  return busy.map((b: any) => ({ start: new Date(b.start), end: new Date(b.end) }));
}

export async function revokeGoogle(refreshTokenEnc: string) {
  try {
    await httpFetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(decrypt(refreshTokenEnc))}`, { method: 'POST', signal: AbortSignal.timeout(10000) });
  } catch { /* melhor esforço */ }
}
