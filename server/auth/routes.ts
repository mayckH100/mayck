import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import { prisma } from '../db.js';
import { ah, HttpError, badRequest } from '../lib/http.js';
import { createSession, destroySession, requireAuth } from './session.js';
import { createOrganization } from './orgDefaults.js';
import { audit } from '../lib/audit.js';
import { sha256 } from '../lib/crypto.js';
import { config } from '../config.js';
import { PRODUCTS, getSubscriptionView } from '../billing/service.js';

export const authRouter = Router();

let dummy: string | null = null;
async function dummyHash() {
  if (!dummy) dummy = await bcrypt.hash('mckbot-dummy-password', 12);
  return dummy;
}

const email = z.string().trim().toLowerCase().email('E-mail inválido').max(200);
const password = z.string().min(8, 'A senha precisa ter pelo menos 8 caracteres').max(200);

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: () => config.LOGIN_RATE_LIMIT,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req) => `${req.ip}|${String(req.body?.email ?? '').toLowerCase()}`,
  message: { error: 'Muitas tentativas. Aguarde alguns minutos e tente novamente.' },
});

export async function meResponse(userId: string, orgId: string | null, csrfToken: string) {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  const memberships = await prisma.membership.findMany({ where: { userId }, include: { org: true }, orderBy: { createdAt: 'asc' } });
  const current = memberships.find((m) => m.orgId === orgId) ?? null;
  const subscriptions = current ? await Promise.all(PRODUCTS.map((p) => getSubscriptionView(current.orgId, p))) : [];
  return {
    user: { id: user.id, email: user.email, name: user.name, phone: user.phone, isSuperAdmin: user.isSuperAdmin },
    isSuperAdmin: user.isSuperAdmin,
    subscriptions,
    org: current ? { id: current.org.id, name: current.org.name, plan: current.org.plan, timezone: current.org.timezone } : null,
    role: current?.role ?? null,
    orgs: memberships.map((m) => ({ id: m.org.id, name: m.org.name, role: m.role })),
    csrfToken,
  };
}

authRouter.post('/register', loginLimiter, ah(async (req, res) => {
  const body = z.object({ name: z.string().trim().min(2).max(100), email, password, orgName: z.string().trim().min(2).max(100) }).parse(req.body);
  const exists = await prisma.user.findUnique({ where: { email: body.email } });
  if (exists) throw new HttpError(409, 'Já existe uma conta com este e-mail');
  const user = await prisma.user.create({ data: { email: body.email, name: body.name, passwordHash: await bcrypt.hash(body.password, 12) } });
  const org = await createOrganization(user.id, body.orgName);
  const csrf = await createSession(res, req, user.id, org.id);
  await audit(req, 'auth.register', { orgId: org.id, userId: user.id, entity: 'user', entityId: user.id });
  res.status(201).json(await meResponse(user.id, org.id, csrf));
}));

authRouter.post('/login', loginLimiter, ah(async (req, res) => {
  const body = z.object({ email, password: z.string().min(1).max(200) }).parse(req.body);
  const user = await prisma.user.findUnique({ where: { email: body.email } });
  // Compara mesmo quando o usuário não existe, para não vazar por tempo de resposta quais e-mails têm conta.
  const ok = await bcrypt.compare(body.password, user?.passwordHash ?? (await dummyHash()));
  if (user && ok && user.disabledAt) {
    await audit(req, 'auth.login_disabled', { userId: user.id, meta: { email: body.email } });
    throw new HttpError(401, 'Esta conta está desativada. Fale com o suporte.');
  }
  if (!user || !ok) {
    await audit(req, 'auth.login_failed', { meta: { email: body.email } });
    throw new HttpError(401, 'E-mail ou senha incorretos');
  }
  const first = await prisma.membership.findFirst({ where: { userId: user.id }, orderBy: { createdAt: 'asc' } });
  const csrf = await createSession(res, req, user.id, first?.orgId ?? null);
  await audit(req, 'auth.login', { orgId: first?.orgId, userId: user.id });
  res.json(await meResponse(user.id, first?.orgId ?? null, csrf));
}));

authRouter.post('/logout', ah(async (req, res) => {
  await destroySession(req, res);
  res.json({ ok: true });
}));

authRouter.get('/me', requireAuth, ah(async (req, res) => {
  res.json(await meResponse(req.auth!.userId, req.auth!.orgId, req.auth!.csrfToken));
}));

authRouter.post('/switch-org', requireAuth, ah(async (req, res) => {
  const { orgId } = z.object({ orgId: z.string() }).parse(req.body);
  const m = await prisma.membership.findUnique({ where: { userId_orgId: { userId: req.auth!.userId, orgId } } });
  if (!m) throw new HttpError(404, 'Organização não encontrada');
  await prisma.session.update({ where: { id: req.auth!.sessionId }, data: { orgId } });
  res.json(await meResponse(req.auth!.userId, orgId, req.auth!.csrfToken));
}));

authRouter.post('/orgs', requireAuth, ah(async (req, res) => {
  const { name } = z.object({ name: z.string().trim().min(2).max(100) }).parse(req.body);
  const org = await createOrganization(req.auth!.userId, name);
  await prisma.session.update({ where: { id: req.auth!.sessionId }, data: { orgId: org.id } });
  await audit(req, 'org.create', { orgId: org.id, entity: 'organization', entityId: org.id });
  res.status(201).json(await meResponse(req.auth!.userId, org.id, req.auth!.csrfToken));
}));

// ---- Convites ----
authRouter.get('/invite/:token', ah(async (req, res) => {
  const inv = await prisma.invitation.findUnique({ where: { tokenHash: sha256(req.params.token) } });
  if (!inv || inv.acceptedAt || inv.expiresAt < new Date()) throw new HttpError(404, 'Convite inválido ou expirado');
  const org = await prisma.organization.findUnique({ where: { id: inv.orgId } });
  const hasAccount = !!(await prisma.user.findUnique({ where: { email: inv.email } }));
  res.json({ email: inv.email, role: inv.role, orgName: org?.name, hasAccount });
}));

authRouter.post('/accept-invite', loginLimiter, ah(async (req, res) => {
  const body = z.object({ token: z.string().min(10), name: z.string().trim().min(2).max(100).optional(), password: password.optional() }).parse(req.body);
  const inv = await prisma.invitation.findUnique({ where: { tokenHash: sha256(body.token) } });
  if (!inv || inv.acceptedAt || inv.expiresAt < new Date()) throw new HttpError(404, 'Convite inválido ou expirado');
  let user = await prisma.user.findUnique({ where: { email: inv.email } });
  if (user) {
    // Conta existente: precisa estar logado como ela.
    if (req.auth?.userId !== user.id) throw new HttpError(401, 'Entre com a conta ' + inv.email + ' para aceitar o convite');
  } else {
    if (!body.name || !body.password) throw badRequest('Informe nome e senha para criar sua conta');
    user = await prisma.user.create({ data: { email: inv.email, name: body.name, passwordHash: await bcrypt.hash(body.password, 12) } });
  }
  await prisma.$transaction([
    prisma.membership.upsert({ where: { userId_orgId: { userId: user.id, orgId: inv.orgId } }, create: { userId: user.id, orgId: inv.orgId, role: inv.role }, update: {} }),
    prisma.invitation.update({ where: { id: inv.id }, data: { acceptedAt: new Date() } }),
  ]);
  let csrf = req.auth?.csrfToken;
  if (req.auth) await prisma.session.update({ where: { id: req.auth.sessionId }, data: { orgId: inv.orgId } });
  else csrf = await createSession(res, req, user.id, inv.orgId);
  await audit(req, 'team.invite_accepted', { orgId: inv.orgId, userId: user.id, entity: 'invitation', entityId: inv.id });
  res.json(await meResponse(user.id, inv.orgId, csrf!));
}));
