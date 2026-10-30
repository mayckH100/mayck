import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { ah, notFound, HttpError, forbidden } from '../lib/http.js';
import { orgOf, requireRole } from '../auth/session.js';
import { audit } from '../lib/audit.js';
import { randomToken, sha256 } from '../lib/crypto.js';
import { PLANS } from './plans.js';
import rateLimit from 'express-rate-limit';

// Convites: no máximo 30 por hora por usuário (evita uso do app para disparo de e-mails/links em massa).
const inviteLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, limit: 30, standardHeaders: 'draft-7', legacyHeaders: false,
  keyGenerator: (req) => `inv:${req.auth?.userId ?? req.ip}`,
  message: { error: 'Muitos convites em pouco tempo. Tente novamente mais tarde.' },
});

export const teamRouter = Router();

teamRouter.get('/', ah(async (req, res) => {
  const orgId = orgOf(req);
  const members = await prisma.membership.findMany({ where: { orgId }, include: { user: { select: { id: true, name: true, email: true } } }, orderBy: { createdAt: 'asc' } });
  const invites = req.auth!.role === 'AGENT' ? [] : await prisma.invitation.findMany({ where: { orgId, acceptedAt: null, expiresAt: { gt: new Date() } }, orderBy: { createdAt: 'desc' }, select: { id: true, email: true, role: true, expiresAt: true, createdAt: true } });
  res.json({ members: members.map((m) => ({ id: m.id, role: m.role, createdAt: m.createdAt, user: m.user })), invites });
}));

teamRouter.post('/invites', requireRole('OWNER', 'ADMIN'), inviteLimiter, ah(async (req, res) => {
  const body = z.object({ email: z.string().trim().toLowerCase().email(), role: z.enum(['ADMIN', 'AGENT']) }).parse(req.body);
  const orgId = orgOf(req);
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
  const inv = await prisma.invitation.create({ data: { orgId, email: body.email, role: body.role, tokenHash: sha256(token), invitedById: req.auth!.userId, expiresAt: new Date(Date.now() + 7 * 24 * 3600e3) } });
  await audit(req, 'team.invite', { entity: 'invitation', entityId: inv.id, meta: { email: body.email, role: body.role } });
  // Sem servidor de e-mail configurado: o link é devolvido para o administrador compartilhar.
  const base = (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
  res.status(201).json({ id: inv.id, email: inv.email, role: inv.role, expiresAt: inv.expiresAt, link: `${base}/convite/${token}` });
}));

teamRouter.delete('/invites/:id', requireRole('OWNER', 'ADMIN'), ah(async (req, res) => {
  const inv = await prisma.invitation.findFirst({ where: { id: req.params.id, orgId: orgOf(req) } });
  if (!inv) throw notFound('Convite');
  await prisma.invitation.delete({ where: { id: inv.id } });
  await audit(req, 'team.invite_revoke', { entity: 'invitation', entityId: inv.id });
  res.json({ ok: true });
}));

teamRouter.patch('/members/:id', requireRole('OWNER'), ah(async (req, res) => {
  const { role } = z.object({ role: z.enum(['ADMIN', 'AGENT']) }).parse(req.body);
  const m = await prisma.membership.findFirst({ where: { id: req.params.id, orgId: orgOf(req) } });
  if (!m) throw notFound('Membro');
  if (m.role === 'OWNER') throw forbidden('O papel do proprietário não pode ser alterado');
  const u = await prisma.membership.update({ where: { id: m.id }, data: { role } });
  await audit(req, 'team.role_change', { entity: 'membership', entityId: m.id, meta: { from: m.role, to: role } });
  res.json(u);
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
