import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { ah, notFound, HttpError, forbidden } from '../lib/http.js';
import { orgOf, requireRole } from '../auth/session.js';
import { audit } from '../lib/audit.js';
import { randomToken, sha256 } from '../lib/crypto.js';
import { PLANS } from './plans.js';
import rateLimit from 'express-rate-limit';
import type { Request } from 'express';
import type { Role } from '../types.js';
import { deliverMail, inviteMail } from '../lib/mailer.js';
import { channelLabels } from '../whatsapp/channelLabel.js';
import { MODULES, DEFAULT_MODULES, ROLE_MODULES, accessOf, effectiveModules, sanitizeGrant, moduleLabel, type Access } from '../lib/permissions.js';

// Convites: no máximo 30 por hora por usuário (evita uso do app para disparo de e-mails/links em massa).
const inviteLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, limit: 30, standardHeaders: 'draft-7', legacyHeaders: false,
  keyGenerator: (req) => `inv:${req.auth?.userId ?? req.ip}`,
  message: { error: 'Muitos convites em pouco tempo. Tente novamente mais tarde.' },
});

export const teamRouter = Router();

const INVITE_DAYS = 7;
const ROLE_LABEL: Record<string, string> = { OWNER: 'Proprietário', ADMIN: 'Administrador', AGENT: 'Atendente' };
// Reenvio do e-mail do convite: no mínimo 60 s entre envios e no máximo 5 envios por convite.
export const RESEND_COOLDOWN_MS = 60 * 1000;
export const MAX_INVITE_SENDS = 5;

const myAccess = (req: Request): { role: Role; access: Access } => ({ role: req.auth!.role!, access: { modules: req.auth!.modules ?? null, channelIds: req.auth!.channelIds ?? null } });
const parseList = (raw: string | null): string[] | null => { if (raw == null) return null; try { const v = JSON.parse(raw); return Array.isArray(v) ? v : null; } catch { return null; } };

function inviteBase(req: Request) {
  return (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
}

/** Envia o e-mail do convite pelo mesmo provedor dos códigos de cadastro (API do Brevo / SMTP). Nunca registra o link/token. */
async function sendInviteEmail(req: Request, inv: { id: string; email: string; role: string; orgId: string; modules: string | null; channelIds: string | null }, link: string) {
  const [org, inviter, labels] = await Promise.all([
    prisma.organization.findUniqueOrThrow({ where: { id: inv.orgId }, select: { name: true } }),
    prisma.user.findUnique({ where: { id: req.auth!.userId }, select: { name: true } }),
    channelLabels(inv.orgId),
  ]);
  const mods = parseList(inv.modules) ?? ROLE_MODULES[inv.role as Role] ?? [];
  const ch = parseList(inv.channelIds);
  const result = await deliverMail(inviteMail({
    to: inv.email, inviterName: inviter?.name || 'Um administrador', orgName: org.name, roleLabel: ROLE_LABEL[inv.role] ?? inv.role,
    modules: mods.map(moduleLabel), channels: ch ? ch.map((id) => labels.get(id)?.label ?? 'Canal removido') : null, url: link, days: INVITE_DAYS, req,
  }));
  await prisma.invitation.update({ where: { id: inv.id }, data: result.ok ? { lastSentAt: new Date(), sendCount: { increment: 1 } } : { lastSentAt: new Date() } });
  return result;
}

/** Resposta da tela: a mensagem conta o que realmente aconteceu com o e-mail. O link sempre volta como alternativa. */
function inviteResponse(inv: { id: string; email: string; role: string; expiresAt: Date; modules: string | null; channelIds: string | null }, link: string, r: Awaited<ReturnType<typeof deliverMail>>) {
  return {
    id: inv.id, email: inv.email, role: inv.role, expiresAt: inv.expiresAt, modules: parseList(inv.modules), channelIds: parseList(inv.channelIds), link,
    emailSent: r.ok,
    emailStatus: r.ok ? 'sent' : r.reason,
    message: r.ok
      ? `Convite enviado para ${inv.email}.`
      : r.reason === 'not_configured'
        ? 'O envio de e-mail não está configurado: copie o link e envie para a pessoa.'
        : `Não foi possível enviar o e-mail para ${inv.email}: copie o link e envie para a pessoa.`,
  };
}

teamRouter.get('/', ah(async (req, res) => {
  const orgId = orgOf(req);
  const members = await prisma.membership.findMany({ where: { orgId }, include: { user: { select: { id: true, name: true, email: true, phone: true } } }, orderBy: { createdAt: 'asc' } });
  const manager = req.auth!.role !== 'AGENT' && (req.auth!.role === 'OWNER' || !req.auth!.modules || req.auth!.modules.includes('equipe'));
  const invites = !manager ? [] : await prisma.invitation.findMany({ where: { orgId, acceptedAt: null, expiresAt: { gt: new Date() } }, orderBy: { createdAt: 'desc' }, select: { id: true, email: true, role: true, expiresAt: true, createdAt: true, modules: true, channelIds: true, lastSentAt: true, sendCount: true } });
  const me = myAccess(req);
  res.json({
    members: members.map((m) => {
      const a = accessOf(m.role as Role, m);
      return {
        id: m.id, role: m.role, createdAt: m.createdAt, user: { id: m.user.id, name: m.user.name, email: m.user.email, hasPhone: !!m.user.phone?.trim() },
        // Só quem gerencia a equipe vê as permissões dos outros.
        ...(manager || m.userId === req.auth!.userId ? { modules: effectiveModules(m.role as Role, a), channelIds: a.channelIds } : {}),
      };
    }),
    invites: invites.map((i) => ({ ...i, modules: parseList(i.modules), channelIds: parseList(i.channelIds) })),
    permissions: manager ? { catalog: MODULES, defaults: DEFAULT_MODULES, roleModules: ROLE_MODULES, mine: effectiveModules(me.role, me.access), myChannelIds: me.role === 'OWNER' ? null : me.access.channelIds } : null,
  });
}));

const grantSchema = {
  modules: z.array(z.string().max(40)).max(40).optional(),
  channelIds: z.array(z.string().max(40)).max(100).nullable().optional(),
};

async function orgChannelIds(orgId: string) {
  return (await prisma.channel.findMany({ where: { orgId }, select: { id: true } })).map((c) => c.id);
}

teamRouter.post('/invites', requireRole('OWNER', 'ADMIN'), inviteLimiter, ah(async (req, res) => {
  const body = z.object({ email: z.string().trim().toLowerCase().email(), role: z.enum(['ADMIN', 'AGENT']), ...grantSchema }).parse(req.body);
  const orgId = orgOf(req);
  const grant = sanitizeGrant(myAccess(req), { role: body.role, modules: body.modules, channelIds: body.channelIds }, await orgChannelIds(orgId));
  if ('error' in grant) throw new HttpError(403, grant.error);
  const org = await prisma.organization.findUniqueOrThrow({ where: { id: orgId } });
  const limit = PLANS.find((p) => p.id === org.plan)?.limits.members ?? 3;
  const [members, pending] = await Promise.all([
    prisma.membership.count({ where: { orgId } }),
    prisma.invitation.count({ where: { orgId, acceptedAt: null, expiresAt: { gt: new Date() } } }),
  ]);
  if (members + pending >= limit) throw new HttpError(402, `Seu plano permite até ${limit} membros`);
  const existingUser = await prisma.user.findUnique({ where: { email: body.email } });
  if (existingUser && (await prisma.membership.findUnique({ where: { userId_orgId: { userId: existingUser.id, orgId } } }))) {
    throw new HttpError(409, 'Esta pessoa já faz parte da equipe');
  }
  const token = randomToken();
  const inv = await prisma.invitation.create({ data: { orgId, email: body.email, role: body.role, tokenHash: sha256(token), invitedById: req.auth!.userId, expiresAt: new Date(Date.now() + INVITE_DAYS * 24 * 3600e3), modules: grant.modules, channelIds: grant.channelIds } });
  const link = `${inviteBase(req)}/convite/${token}`;
  const sent = await sendInviteEmail(req, inv, link);
  await audit(req, 'team.invite', { entity: 'invitation', entityId: inv.id, meta: { email: body.email, role: body.role, modules: parseList(grant.modules), channelIds: parseList(grant.channelIds), emailSent: sent.ok } });
  res.status(201).json(inviteResponse(inv, link, sent));
}));

// Reenviar convite pendente: gera um link novo (o anterior deixa de valer), renova a validade e envia de novo por e-mail.
teamRouter.post('/invites/:id/resend', requireRole('OWNER', 'ADMIN'), inviteLimiter, ah(async (req, res) => {
  const inv = await prisma.invitation.findFirst({ where: { id: req.params.id, orgId: orgOf(req), acceptedAt: null } });
  if (!inv) throw notFound('Convite');
  if (inv.role === 'ADMIN' && req.auth!.role !== 'OWNER') throw forbidden('Apenas o proprietário reenvia convites de administrador');
  if (inv.sendCount >= MAX_INVITE_SENDS) throw new HttpError(429, `Este convite já foi enviado ${MAX_INVITE_SENDS} vezes. Cancele e crie um novo, ou copie o link.`);
  if (inv.lastSentAt && Date.now() - inv.lastSentAt.getTime() < RESEND_COOLDOWN_MS) {
    const s = Math.ceil((RESEND_COOLDOWN_MS - (Date.now() - inv.lastSentAt.getTime())) / 1000);
    throw new HttpError(429, `Aguarde ${s} s para reenviar este convite.`);
  }
  const token = randomToken();
  const upd = await prisma.invitation.update({ where: { id: inv.id }, data: { tokenHash: sha256(token), expiresAt: new Date(Date.now() + INVITE_DAYS * 24 * 3600e3) } });
  const link = `${inviteBase(req)}/convite/${token}`;
  const sent = await sendInviteEmail(req, upd, link);
  await audit(req, 'team.invite_resend', { entity: 'invitation', entityId: inv.id, meta: { emailSent: sent.ok } });
  res.json(inviteResponse(upd, link, sent));
}));

teamRouter.delete('/invites/:id', requireRole('OWNER', 'ADMIN'), ah(async (req, res) => {
  const inv = await prisma.invitation.findFirst({ where: { id: req.params.id, orgId: orgOf(req) } });
  if (!inv) throw notFound('Convite');
  await prisma.invitation.delete({ where: { id: inv.id } });
  await audit(req, 'team.invite_revoke', { entity: 'invitation', entityId: inv.id });
  res.json({ ok: true });
}));

teamRouter.patch('/members/:id', requireRole('OWNER', 'ADMIN'), ah(async (req, res) => {
  const body = z.object({ role: z.enum(['ADMIN', 'AGENT']).optional(), ...grantSchema }).parse(req.body);
  const orgId = orgOf(req);
  const m = await prisma.membership.findFirst({ where: { id: req.params.id, orgId } });
  if (!m) throw notFound('Membro');
  if (m.role === 'OWNER') throw forbidden('O proprietário sempre tem acesso a tudo: o papel e as permissões dele não podem ser alterados');
  const isOwner = req.auth!.role === 'OWNER';
  if (body.role && body.role !== m.role && !isOwner) throw forbidden('Apenas o proprietário altera o papel');
  if (!isOwner && m.userId === req.auth!.userId) throw forbidden('Você não pode alterar as suas próprias permissões');
  if (!isOwner && m.role === 'ADMIN') throw forbidden('Apenas o proprietário altera as permissões de administradores');
  const role = (body.role ?? m.role) as 'ADMIN' | 'AGENT';
  const data: { role?: string; modules?: string | null; channelIds?: string | null } = {};
  if (body.role) data.role = body.role;
  if (body.modules !== undefined || body.channelIds !== undefined) {
    const current = accessOf(m.role as Role, m);
    const grant = sanitizeGrant(myAccess(req), {
      role,
      modules: body.modules ?? effectiveModules(role, current),
      channelIds: body.channelIds === undefined ? current.channelIds : body.channelIds,
    }, await orgChannelIds(orgId));
    if ('error' in grant) throw new HttpError(403, grant.error);
    data.modules = grant.modules;
    data.channelIds = grant.channelIds;
  }
  const u = await prisma.membership.update({ where: { id: m.id }, data });
  if (data.role) await audit(req, 'team.role_change', { entity: 'membership', entityId: m.id, meta: { from: m.role, to: data.role } });
  if (data.modules !== undefined) await audit(req, 'team.permissions_change', { entity: 'membership', entityId: m.id, meta: { modules: parseList(data.modules ?? null), channelIds: parseList(data.channelIds ?? null) } });
  const a = accessOf(u.role as Role, u);
  res.json({ id: u.id, role: u.role, modules: effectiveModules(u.role as Role, a), channelIds: a.channelIds });
}));

teamRouter.delete('/members/:id', requireRole('OWNER', 'ADMIN'), ah(async (req, res) => {
  const m = await prisma.membership.findFirst({ where: { id: req.params.id, orgId: orgOf(req) } });
  if (!m) throw notFound('Membro');
  if (m.role === 'OWNER') throw forbidden('O proprietário não pode ser removido');
  if (m.role === 'ADMIN' && req.auth!.role !== 'OWNER') throw forbidden('Apenas o proprietário remove administradores');
  await prisma.membership.delete({ where: { id: m.id } });
  await prisma.session.updateMany({ where: { userId: m.userId, orgId: m.orgId }, data: { orgId: null } });
  await audit(req, 'team.remove', { entity: 'membership', entityId: m.id });
  res.json({ ok: true });
}));
