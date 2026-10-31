import { Router, type Request } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { prisma } from '../db.js';
import { ah, forbidden, notFound, HttpError } from '../lib/http.js';
import { orgOf, requireRole } from '../auth/session.js';
import { audit } from '../lib/audit.js';
import { exclusaoLimiter, exigirSenhaExclusao } from '../lib/exclusao-senha.js';
import { encrypt, decrypt, randomToken, sha256 } from '../lib/crypto.js';
import { appUrl } from '../lib/mailer.js';
import { buildIcs, googleAddLink, outlookAddLink, verifyPublicEventToken } from './ics.js';
import {
  createAppointment, updateAppointment, deleteAppointment, viewMany, getSettings, orgTz, freeSlots, findConflicts,
  icsOf, publicEventUrl, escHtml, KIND_LABEL, notifyRecipients, hasRecipients, MAX_EXTRA_CONTACTS,
} from './service.js';
import { googleConfigured, googleRedirectUri, makeState, readState, authUrl, exchangeCode, revokeGoogle, forgetToken } from './google.js';
import { parseLocal, humanPt, toLocalIso } from './time.js';

export const agendaRouter = Router();
const admins = requireRole('OWNER', 'ADMIN');
const isAdmin = (req: Request) => req.auth?.role === 'OWNER' || req.auth?.role === 'ADMIN';

/** Atendente (AGENT) só vê/edita o que é dele (responsável ou criador) ou o que não tem responsável. */
function visibleWhere(req: Request): any {
  const orgId = orgOf(req);
  if (isAdmin(req)) return { orgId };
  const me = req.auth!.userId;
  return { orgId, OR: [{ assignedUserId: me }, { createdById: me }, { assignedUserId: null }] };
}
async function findVisible(req: Request, id: string) {
  const a = await prisma.appointment.findFirst({ where: { ...visibleWhere(req), id } });
  if (!a) throw notFound('Compromisso');
  return a;
}
function canEdit(req: Request, a: { assignedUserId: string | null; createdById: string | null }) {
  if (isAdmin(req)) return true;
  const me = req.auth!.userId;
  return a.assignedUserId === me || a.createdById === me || (!a.assignedUserId && a.createdById === me);
}

const baseSchema = z.object({
  kind: z.enum(['MEETING', 'TASK']).default('MEETING'),
  title: z.string().trim().min(1).max(120),
  description: z.string().max(2000).optional().nullable(),
  location: z.string().max(300).optional().nullable(),
  /** "2026-11-03T14:00" (hora local da empresa) ou ISO com fuso. */
  start: z.string().min(10).max(40),
  durationMin: z.number().int().min(5).max(24 * 60).optional(),
  reminderMin: z.number().int().min(0).max(7 * 24 * 60).optional(),
  contactId: z.string().max(40).optional().nullable(),
  assignedUserId: z.string().max(40).optional().nullable(),
  notifyContact: z.boolean().optional(),
  /** "Gerar link do Google Meet" (só na criação; padrão ligado para reuniões com Google conectado). */
  generateMeet: z.boolean().optional(),
  /** Contatos adicionais (equipe) que recebem o link por WhatsApp — validados/normalizados no serviço. */
  extraContacts: z.array(z.object({ name: z.string().max(80).optional().nullable(), phone: z.string().max(30) })).max(MAX_EXTRA_CONTACTS, `No máximo ${MAX_EXTRA_CONTACTS} contatos adicionais por compromisso`).optional(),
  notifyAssignee: z.boolean().optional(),
  notifyExtras: z.boolean().optional(),
  force: z.boolean().optional(),
  source: z.enum(['MANUAL', 'KANBAN']).optional(),
});

async function startOf(req: Request, s: string) {
  const d = parseLocal(s, await orgTz(orgOf(req)));
  if (!d) throw new HttpError(400, 'Data/hora inválida');
  return d;
}

agendaRouter.get('/', ah(async (req, res) => {
  const q = z.object({
    from: z.string().optional(), to: z.string().optional(),
    status: z.enum(['SCHEDULED', 'DONE', 'CANCELLED', 'all']).default('all'),
    kind: z.enum(['MEETING', 'TASK', 'all']).default('all'), mine: z.enum(['1', '0']).optional(), contactId: z.string().optional(),
  }).parse(req.query);
  const tz = await orgTz(orgOf(req));
  const from = (q.from && parseLocal(q.from.length === 10 ? `${q.from}T00:00` : q.from, tz)) || new Date(Date.now() - 24 * 3600e3);
  const to = (q.to && parseLocal(q.to.length === 10 ? `${q.to}T23:59` : q.to, tz)) || new Date(from.getTime() + 60 * 24 * 3600e3);
  const where: any = { ...visibleWhere(req), startAt: { gte: from, lte: to } };
  if (q.status !== 'all') where.status = q.status;
  if (q.kind !== 'all') where.kind = q.kind;
  if (q.contactId) where.contactId = q.contactId;
  if (q.mine === '1') where.AND = [{ OR: [{ assignedUserId: req.auth!.userId }, { createdById: req.auth!.userId }] }];
  const list = await prisma.appointment.findMany({ where, orderBy: { startAt: 'asc' }, take: 500 });
  res.json({ timezone: tz, items: await viewMany(orgOf(req), list, req) });
}));

agendaRouter.get('/free-slots', ah(async (req, res) => {
  const q = z.object({ duration: z.coerce.number().int().min(5).max(480).optional(), days: z.coerce.number().int().min(1).max(30).default(7) }).parse(req.query);
  const orgId = orgOf(req);
  const tz = await orgTz(orgId);
  const slots = await freeSlots(orgId, { days: q.days, max: 40, durationMin: q.duration });
  res.json({ timezone: tz, slots: slots.map((d) => ({ start: d, local: toLocalIso(d, tz), label: humanPt(d, tz) })) });
}));

agendaRouter.post('/check', ah(async (req, res) => {
  const b = z.object({ start: z.string(), durationMin: z.number().int().min(5).max(1440).default(30), excludeId: z.string().optional(), assignedUserId: z.string().nullable().optional() }).parse(req.body);
  const conflicts = await findConflicts(orgOf(req), await startOf(req, b.start), b.durationMin, { excludeId: b.excludeId, assignedUserId: b.assignedUserId });
  res.json({ ok: conflicts.length === 0, conflicts: conflicts.map((c) => ({ start: c.start, end: c.end, title: c.title ?? 'Ocupado (Google Agenda)', source: c.source })) });
}));

agendaRouter.post('/', ah(async (req, res) => {
  const b = baseSchema.parse(req.body);
  if (!isAdmin(req) && b.assignedUserId && b.assignedUserId !== req.auth!.userId) throw forbidden('Atendentes só podem agendar para si mesmos');
  const a = await createAppointment({ ...b, startAt: await startOf(req, b.start) }, { orgId: orgOf(req), userId: req.auth!.userId, req, source: b.source ?? 'MANUAL', force: b.force });
  res.status(201).json((await viewMany(a.orgId, [a], req))[0]);
}));

agendaRouter.get('/settings', ah(async (req, res) => {
  res.json({ ...(await getSettings(orgOf(req))), timezone: await orgTz(orgOf(req)) });
}));

agendaRouter.put('/settings', admins, ah(async (req, res) => {
  const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
  const b = z.object({
    aiBooking: z.boolean(), workStart: hhmm, workEnd: hhmm, workDays: z.array(z.number().int().min(0).max(6)).min(1).max(7),
    defaultDurationMin: z.number().int().min(5).max(480), minNoticeMin: z.number().int().min(0).max(7 * 24 * 60),
    notifyContact: z.boolean(), reminderMin: z.number().int().min(0).max(7 * 24 * 60),
    notifyAssignee: z.boolean().optional(), notifyExtras: z.boolean().optional(),
  }).parse(req.body);
  if (b.workEnd <= b.workStart) throw new HttpError(400, 'O fim do expediente deve ser depois do início');
  const orgId = orgOf(req);
  const data = { ...b, workDays: [...new Set(b.workDays)].sort().join(',') };
  await prisma.agendaSettings.upsert({ where: { orgId }, create: { orgId, ...data }, update: data });
  await audit(req, 'agenda.settings', { entity: 'agenda', meta: data });
  res.json(await getSettings(orgId));
}));

// ---------- Feed assinável (URL secreta webcal/ICS que atualiza sozinho no celular) ----------

const feedUrls = (token: string, req: Request) => {
  const https = `${appUrl(req)}/api/public/agenda/feed/${token}.ics`;
  return { https, webcal: https.replace(/^https?:/, 'webcal:'), google: `https://calendar.google.com/calendar/r?cid=${encodeURIComponent(https.replace(/^https?:/, 'webcal:'))}` };
};

agendaRouter.get('/feeds', ah(async (req, res) => {
  const orgId = orgOf(req);
  const feeds = await prisma.calendarFeed.findMany({ where: { orgId, revokedAt: null, OR: [{ userId: req.auth!.userId }, ...(isAdmin(req) ? [{ userId: null }] : [])] } });
  res.json(feeds.map((f) => ({ id: f.id, scope: f.userId ? 'me' : 'org', createdAt: f.createdAt, lastUsedAt: f.lastUsedAt, ...feedUrls(decrypt(f.tokenEnc), req) })));
}));

agendaRouter.post('/feeds', ah(async (req, res) => {
  const { scope } = z.object({ scope: z.enum(['me', 'org']) }).parse(req.body);
  if (scope === 'org' && !isAdmin(req)) throw forbidden('Só donos e administradores criam o feed da empresa');
  const orgId = orgOf(req);
  const userId = scope === 'me' ? req.auth!.userId : null;
  // Gerar de novo revoga o link antigo (útil se ele vazou).
  await prisma.calendarFeed.updateMany({ where: { orgId, userId, revokedAt: null }, data: { revokedAt: new Date() } });
  const token = randomToken(24);
  const f = await prisma.calendarFeed.create({ data: { orgId, userId, tokenHash: sha256(token), tokenEnc: encrypt(token) } });
  await audit(req, 'agenda.feed_create', { entity: 'calendar_feed', entityId: f.id, meta: { scope } });
  res.status(201).json({ id: f.id, scope, createdAt: f.createdAt, ...feedUrls(token, req) });
}));

agendaRouter.delete('/feeds/:id', ah(async (req, res) => {
  const orgId = orgOf(req);
  const f = await prisma.calendarFeed.findFirst({ where: { id: req.params.id, orgId, revokedAt: null } });
  if (!f || (f.userId ? f.userId !== req.auth!.userId : !isAdmin(req))) throw notFound('Feed');
  await prisma.calendarFeed.update({ where: { id: f.id }, data: { revokedAt: new Date() } });
  await audit(req, 'agenda.feed_revoke', { entity: 'calendar_feed', entityId: f.id });
  res.json({ ok: true });
}));

// ---------- Google Agenda (OAuth) ----------

agendaRouter.get('/google/status', ah(async (req, res) => {
  const acc = await prisma.googleCalendarAccount.findUnique({ where: { orgId_userId: { orgId: orgOf(req), userId: req.auth!.userId } } });
  res.json({ configured: googleConfigured(), connected: !!acc, email: acc?.email ?? null, redirectUri: googleRedirectUri(req) });
}));

agendaRouter.post('/google/connect', ah(async (req, res) => {
  if (!googleConfigured()) throw new HttpError(503, 'Integração com Google Agenda ainda não configurada no servidor (GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET).');
  const { app } = z.object({ app: z.enum(['mckbot', 'mensagem']).default('mckbot') }).parse(req.body ?? {});
  res.json({ url: authUrl(makeState(req.auth!.userId, orgOf(req), app), req) });
}));

agendaRouter.delete('/google', ah(async (req, res) => {
  const orgId = orgOf(req);
  const acc = await prisma.googleCalendarAccount.findUnique({ where: { orgId_userId: { orgId, userId: req.auth!.userId } } });
  if (!acc) throw notFound('Conta Google');
  await revokeGoogle(acc.refreshTokenEnc);
  forgetToken(acc.id);
  await prisma.googleCalendarAccount.delete({ where: { id: acc.id } });
  await prisma.appointment.updateMany({ where: { orgId, googleAccountId: acc.id }, data: { googleAccountId: null, googleEventId: null } });
  await audit(req, 'agenda.google_disconnect', { entity: 'google', entityId: acc.id });
  res.json({ ok: true });
}));

// ---------- Compromisso específico ----------

agendaRouter.get('/:id', ah(async (req, res) => {
  const a = await findVisible(req, req.params.id);
  res.json((await viewMany(a.orgId, [a], req))[0]);
}));

agendaRouter.get('/:id/ics', ah(async (req, res) => {
  const a = await findVisible(req, req.params.id);
  res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="evento.ics"');
  res.send(icsOf(a, req));
}));

agendaRouter.patch('/:id', ah(async (req, res) => {
  const a = await findVisible(req, req.params.id);
  if (!canEdit(req, a)) throw forbidden('Você só pode alterar compromissos seus');
  const b = baseSchema.partial().extend({ status: z.enum(['SCHEDULED', 'DONE', 'CANCELLED']).optional() }).parse(req.body);
  if (!isAdmin(req) && b.assignedUserId && b.assignedUserId !== req.auth!.userId) throw forbidden('Atendentes só podem agendar para si mesmos');
  const { start, force, source: _s, generateMeet: _g, ...rest } = b;
  const u = await updateAppointment(a.id, { ...rest, ...(start ? { startAt: await startOf(req, start) } : {}) }, { orgId: a.orgId, userId: req.auth!.userId, req, force });
  res.json((await viewMany(u.orgId, [u], req))[0]);
}));

/** Exclusão definitiva: só compromisso CANCELADO, com a senha de login do usuário (limite de tentativas). */
agendaRouter.delete('/:id', admins, exclusaoLimiter, ah(async (req, res) => {
  await deleteAppointment(req.params.id, { orgId: orgOf(req), userId: req.auth!.userId, req }, () => exigirSenhaExclusao(req));
  res.json({ ok: true });
}));

/** Reenvia, por WhatsApp, o aviso com o link "Adicionar à agenda" aos destinatários marcados (cliente / responsável / adicionais). */
agendaRouter.post('/:id/send', ah(async (req, res) => {
  const a = await findVisible(req, req.params.id);
  if (!hasRecipients(a)) throw new HttpError(400, 'Nenhum destinatário marcado para este compromisso');
  if (a.notifyContact && a.contactId) {
    const contact = await prisma.contact.findFirst({ where: { id: a.contactId, orgId: a.orgId }, select: { optOut: true } });
    if (contact?.optOut && !(a.notifyAssignee && a.assignedUserId) && !(a.notifyExtras && a.extraContacts !== '[]')) throw new HttpError(400, 'O contato pediu para não receber mensagens');
  }
  const results = await notifyRecipients(a, a.status === 'CANCELLED' ? 'cancelado' : 'criado', { req, sender: 'agent', authorUserId: req.auth!.userId });
  const ok = results.length > 0 && results.every((r) => r.ok);
  const failed = results.filter((r) => !r.ok);
  await audit(req, 'agenda.send', { entity: 'appointment', entityId: a.id, meta: { results: results.map((r) => ({ target: r.target, ok: r.ok })) } });
  res.json({ ok, sent: results.filter((r) => r.ok).length, total: results.length, results, status: ok ? 'SENT' : 'FAILED', error: failed.map((r) => r.error).filter(Boolean).join('; ') || undefined });
}));

// ================= Rotas públicas (sem login) =================

export const publicAgendaRouter = Router();
publicAgendaRouter.use(rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: 'draft-7', legacyHeaders: false }));

/** Página do evento enviada ao contato (botões Google / iPhone / Outlook) e o .ics. */
publicAgendaRouter.get('/e/:token', ah(async (req, res) => {
  const raw = req.params.token;
  const wantsIcs = raw.endsWith('.ics');
  const id = verifyPublicEventToken(wantsIcs ? raw.slice(0, -4) : raw);
  const a = id ? await prisma.appointment.findUnique({ where: { id } }) : null;
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex');
  if (!a) return void res.status(404).type('text/plain').send('Evento não encontrado');
  if (wantsIcs) {
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', 'inline; filename="evento.ics"');
    return void res.send(icsOf(a, req));
  }
  const tz = await orgTz(a.orgId);
  const org = await prisma.organization.findUnique({ where: { id: a.orgId }, select: { name: true } });
  const when = humanPt(a.startAt, tz);
  const cancelled = a.status === 'CANCELLED';
  const btn = (href: string, label: string, primary = false) => `<a class="b${primary ? ' p' : ''}" href="${escHtml(href)}">${label}</a>`;
  res.type('html').send(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escHtml(a.title)}</title>
<style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#f4f5f7;margin:0;padding:24px;color:#111}.c{max-width:440px;margin:0 auto;background:#fff;border-radius:16px;padding:24px;box-shadow:0 2px 12px #0001}h1{font-size:20px;margin:4px 0 12px}.m{color:#555;margin:6px 0}.k{font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:#e10a2c;font-weight:700}.b{display:block;text-align:center;padding:14px;border-radius:12px;border:1px solid #ddd;margin-top:10px;text-decoration:none;color:#111;font-weight:600}.p{background:#e10a2c;border-color:#e10a2c;color:#fff}.x{background:#fee2e2;color:#991b1b;padding:10px;border-radius:10px;margin:12px 0}.f{font-size:12px;color:#888;margin-top:16px;text-align:center}</style></head>
<body><div class="c"><div class="k">${escHtml(KIND_LABEL[a.kind] ?? 'Compromisso')}${org ? ' · ' + escHtml(org.name) : ''}</div><h1>${escHtml(a.title)}</h1>
<div class="m">🗓 ${escHtml(when.charAt(0).toUpperCase() + when.slice(1))} (${a.durationMin} min)</div>${a.location ? `<div class="m">📍 ${escHtml(a.location)}</div>` : ''}${a.meetLink && !cancelled ? `<div class="m">🎥 <a href="${escHtml(a.meetLink)}">Entrar no Google Meet</a></div>` : ''}
${cancelled ? '<div class="x">Este compromisso foi cancelado.</div>' : `
${btn(googleAddLink(a), 'Adicionar ao Google Agenda (Android)', true)}
${btn(`${publicEventUrl(a.id, req)}.ics`, 'Adicionar à agenda do iPhone / Apple')}
${btn(outlookAddLink(a), 'Adicionar ao Outlook')}`}
<div class="f">No iPhone, toque em "Adicionar à agenda do iPhone" e depois em "Adicionar tudo".</div></div></body></html>`);
}));

/** Feed assinável: o celular consulta sozinho e mostra novos compromissos, remarcações e cancelamentos. */
publicAgendaRouter.get('/feed/:token', ah(async (req, res) => {
  const token = req.params.token.replace(/\.ics$/, '');
  const f = token.length >= 20 ? await prisma.calendarFeed.findUnique({ where: { tokenHash: sha256(token) } }) : null;
  if (!f || f.revokedAt) return void res.status(404).type('text/plain').send('Feed não encontrado');
  const where: any = { orgId: f.orgId, startAt: { gte: new Date(Date.now() - 60 * 24 * 3600e3), lte: new Date(Date.now() + 400 * 24 * 3600e3) } };
  if (f.userId) where.OR = [{ assignedUserId: f.userId }, { assignedUserId: null, createdById: f.userId }];
  const list = await prisma.appointment.findMany({ where, orderBy: { startAt: 'asc' }, take: 2000 });
  const org = await prisma.organization.findUnique({ where: { id: f.orgId }, select: { name: true } });
  if (!f.lastUsedAt || Date.now() - f.lastUsedAt.getTime() > 3600e3) prisma.calendarFeed.update({ where: { id: f.id }, data: { lastUsedAt: new Date() } }).catch(() => undefined);
  res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.send(buildIcs(list.map((a) => ({ ...a, title: a.status === 'DONE' ? `✔ ${a.title}` : a.title, url: publicEventUrl(a.id, req) })), { name: `${org?.name ?? 'MCKBOT'} — Agenda` }));
}));

/** Retorno do OAuth do Google. Precisa da sessão do mesmo usuário que pediu (state assinado). */
export const googleCallbackRouter = Router();
googleCallbackRouter.get('/', ah(async (req, res) => {
  const st = readState(String(req.query.state ?? ''));
  const base = st?.a === 'mensagem' ? '/mensagem/agenda' : '/agenda';
  const back = (status: string, msg?: string) => res.redirect(`${base}?google=${status}${msg ? `&msg=${encodeURIComponent(msg.slice(0, 200))}` : ''}`);
  if (!st) return void back('erro', 'Link de conexão expirado. Tente de novo.');
  if (!req.auth || req.auth.userId !== st.u) return void back('erro', 'Entre no MCKBOT com o mesmo usuário e tente de novo.');
  const m = await prisma.membership.findUnique({ where: { userId_orgId: { userId: st.u, orgId: st.o } } });
  if (!m) return void back('erro', 'Você não faz parte desta empresa.');
  if (req.query.error) return void back('erro', 'Conexão cancelada no Google.');
  try {
    const t = await exchangeCode(String(req.query.code ?? ''), req);
    const acc = await prisma.googleCalendarAccount.upsert({
      where: { orgId_userId: { orgId: st.o, userId: st.u } },
      create: { orgId: st.o, userId: st.u, email: t.email, refreshTokenEnc: encrypt(t.refreshToken) },
      update: { email: t.email, refreshTokenEnc: encrypt(t.refreshToken) },
    });
    forgetToken(acc.id);
    await audit(req, 'agenda.google_connect', { orgId: st.o, entity: 'google', entityId: acc.id, meta: { email: t.email } });
    back('ok');
  } catch (e) {
    await audit(req, 'agenda.google_falha', { orgId: st.o, entity: 'google', meta: { op: 'connect', error: (e as Error).message } });
    back('erro', (e as Error).message);
  }
}));
