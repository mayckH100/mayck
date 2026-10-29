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
import { ensureSuperAdmin } from './superadmin.js';
import { randomToken } from '../lib/crypto.js';
import { sendMailLater, welcomeMail, resetMail, passwordChangedMail, brandOf, appPath, type AppBrand } from '../lib/mailer.js';

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

// Limite por IP (qualquer e-mail): barra teste de senhas em massa e criação de contas em série.
const loginIpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: () => config.LOGIN_RATE_LIMIT * 5,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Muitas tentativas deste endereço. Aguarde alguns minutos e tente novamente.' },
});
const registerIpLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: () => config.LOGIN_RATE_LIMIT,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Muitos cadastros deste endereço. Tente novamente mais tarde.' },
});

export async function meResponse(userId: string, orgId: string | null, csrfToken: string) {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  const memberships = await prisma.membership.findMany({ where: { userId }, include: { org: true }, orderBy: { createdAt: 'asc' } });
  const current = memberships.find((m) => m.orgId === orgId) ?? null;
  const subscriptions = current ? await Promise.all(PRODUCTS.map((p) => getSubscriptionView(current.orgId, p))) : [];
  return {
    user: { id: user.id, email: user.email, name: user.name, phone: user.phone, isSuperAdmin: user.isSuperAdmin, emailVerified: !!user.emailVerifiedAt },
    isSuperAdmin: user.isSuperAdmin,
    subscriptions,
    org: current ? { id: current.org.id, name: current.org.name, plan: current.org.plan, timezone: current.org.timezone } : null,
    role: current?.role ?? null,
    orgs: memberships.map((m) => ({ id: m.org.id, name: m.org.name, role: m.role })),
    csrfToken,
  };
}

authRouter.post('/register', registerIpLimiter, loginLimiter, ah(async (req, res) => {
  const body = z.object({ name: z.string().trim().min(2).max(100), email, password, orgName: z.string().trim().min(2).max(100) }).parse(req.body);
  const exists = await prisma.user.findUnique({ where: { email: body.email } });
  if (exists) throw new HttpError(409, 'Já existe uma conta com este e-mail');
  const user = await prisma.user.create({ data: { email: body.email, name: body.name, passwordHash: await bcrypt.hash(body.password, 12) } });
  await ensureSuperAdmin(user);
  const org = await createOrganization(user.id, body.orgName);
  const csrf = await createSession(res, req, user.id, org.id);
  await audit(req, 'auth.register', { orgId: org.id, userId: user.id, entity: 'user', entityId: user.id });
  // Boas-vindas + link de confirmação do e-mail (não bloqueia o login; falha de SMTP não afeta o cadastro).
  try {
    const app = brandOf(req.body?.app);
    const token = await issueToken(user.id, 'VERIFY_EMAIL', VERIFY_TTL_MS, req.ip);
    sendMailLater(welcomeMail({ to: user.email, name: user.name, app, verifyUrl: appPath(app, `/verificar-email?token=${token}`, req), req }));
  } catch (e) { console.error('[mail] boas-vindas:', (e as Error).message); }
  res.status(201).json(await meResponse(user.id, org.id, csrf));
}));

authRouter.post('/login', loginIpLimiter, loginLimiter, ah(async (req, res) => {
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
  if (await ensureSuperAdmin(user)) await audit(req, 'auth.superadmin_bootstrap', { userId: user.id, meta: { email: user.email } });
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

// ---- Recuperação de senha e verificação de e-mail ----
const RESET_TTL_MS = 60 * 60 * 1000; // 1 hora
const VERIFY_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 dias
type TokenKind = 'RESET_PASSWORD' | 'VERIFY_EMAIL';

/** Gera um token aleatório; só o hash SHA-256 vai para o banco. Tokens anteriores do mesmo tipo deixam de valer. */
async function issueToken(userId: string, kind: TokenKind, ttlMs: number, ip?: string) {
  const token = randomToken(32);
  await prisma.authToken.deleteMany({ where: { userId, kind, usedAt: null } });
  await prisma.authToken.create({ data: { userId, kind, tokenHash: sha256(token), expiresAt: new Date(Date.now() + ttlMs), ip: ip ?? null } });
  return token;
}

/** Consome o token de forma atômica (uso único): só um pedido concorrente consegue marcar usedAt. */
async function consumeToken(token: string, kind: TokenKind) {
  const row = await prisma.authToken.findUnique({ where: { tokenHash: sha256(token) } });
  if (!row || row.kind !== kind || row.usedAt || row.expiresAt < new Date()) return null;
  const upd = await prisma.authToken.updateMany({ where: { id: row.id, usedAt: null }, data: { usedAt: new Date() } });
  return upd.count === 1 ? row : null;
}

const forgotLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: () => config.FORGOT_RATE_LIMIT,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req) => `${req.ip}|${String(req.body?.email ?? '').trim().toLowerCase()}`,
  message: { error: 'Muitos pedidos de redefinição. Aguarde alguns minutos e tente novamente.' },
});
const forgotIpLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: () => config.FORGOT_RATE_LIMIT * 6,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Muitos pedidos de redefinição. Aguarde alguns minutos e tente novamente.' },
});

const FORGOT_MSG = 'Se existir uma conta com este e-mail, enviamos um link para redefinir a senha. Confira a caixa de entrada e o spam.';

authRouter.post('/forgot', forgotIpLimiter, forgotLimiter, ah(async (req, res) => {
  const body = z.object({ email, app: z.enum(['mckbot', 'mensagem']).optional() }).parse(req.body);
  const app: AppBrand = brandOf(body.app);
  // Resposta sempre igual e imediata; o trabalho acontece em segundo plano para não vazar, pelo tempo, se o e-mail existe.
  res.json({ ok: true, message: FORGOT_MSG });
  void (async () => {
    try {
      const user = await prisma.user.findUnique({ where: { email: body.email } });
      if (!user || user.disabledAt) {
        await audit(req, 'auth.forgot_unknown', { meta: { email: body.email } });
        return;
      }
      const token = await issueToken(user.id, 'RESET_PASSWORD', RESET_TTL_MS, req.ip);
      await audit(req, 'auth.forgot', { userId: user.id });
      sendMailLater(resetMail({ to: user.email, name: user.name, app, url: appPath(app, `/redefinir-senha?token=${token}`, req), req }));
    } catch (e) {
      console.error('[auth] forgot:', (e as Error).message);
    }
  })();
}));

authRouter.get('/reset/:token', ah(async (req, res) => {
  const row = await prisma.authToken.findUnique({ where: { tokenHash: sha256(req.params.token) } });
  const valid = !!row && row.kind === 'RESET_PASSWORD' && !row.usedAt && row.expiresAt > new Date();
  res.json({ valid });
}));

authRouter.post('/reset', loginIpLimiter, loginLimiter, ah(async (req, res) => {
  const body = z.object({ token: z.string().min(20).max(200), password, app: z.enum(['mckbot', 'mensagem']).optional() }).parse(req.body);
  const row = await consumeToken(body.token, 'RESET_PASSWORD');
  if (!row) throw new HttpError(400, 'Link inválido ou expirado. Peça um novo em "Esqueci minha senha".');
  const user = await prisma.user.update({ where: { id: row.userId }, data: { passwordHash: await bcrypt.hash(body.password, 12) } });
  // Invalida todas as sessões antigas (inclusive a atual, se houver) e os demais links de redefinição pendentes.
  await prisma.session.deleteMany({ where: { userId: user.id } });
  await prisma.authToken.deleteMany({ where: { userId: user.id, kind: 'RESET_PASSWORD', usedAt: null } });
  // Quem recebeu o link no e-mail provou ser dono dele.
  if (!user.emailVerifiedAt) await prisma.user.update({ where: { id: user.id }, data: { emailVerifiedAt: new Date() } });
  await audit(req, 'auth.password_reset', { userId: user.id, entity: 'user', entityId: user.id });
  sendMailLater(passwordChangedMail({ to: user.email, name: user.name, app: brandOf(body.app), req }));
  res.clearCookie('mck_sid', { path: '/' });
  res.json({ ok: true });
}));

authRouter.post('/verify-email', loginIpLimiter, ah(async (req, res) => {
  const { token } = z.object({ token: z.string().min(20).max(200) }).parse(req.body);
  const row = await consumeToken(token, 'VERIFY_EMAIL');
  if (!row) throw new HttpError(400, 'Link de confirmação inválido ou expirado.');
  const verified = await prisma.user.update({ where: { id: row.userId }, data: { emailVerifiedAt: new Date() } });
  if (await ensureSuperAdmin(verified)) await audit(req, 'auth.superadmin_bootstrap', { userId: verified.id, meta: { email: verified.email } });
  await audit(req, 'auth.email_verified', { userId: row.userId, entity: 'user', entityId: row.userId });
  res.json({ ok: true });
}));

authRouter.post('/resend-verification', requireAuth, ah(async (req, res) => {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: req.auth!.userId } });
  if (user.emailVerifiedAt) return void res.json({ ok: true, alreadyVerified: true });
  const app = brandOf(req.body?.app);
  const token = await issueToken(user.id, 'VERIFY_EMAIL', VERIFY_TTL_MS, req.ip);
  sendMailLater(welcomeMail({ to: user.email, name: user.name, app, verifyUrl: appPath(app, `/verificar-email?token=${token}`, req), req }));
  res.json({ ok: true });
}));
