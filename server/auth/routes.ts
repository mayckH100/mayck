import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import { prisma } from '../db.js';
import { ah, HttpError, badRequest } from '../lib/http.js';
import { createSession, destroySession, requireAuth, superAdminMfaRequired } from './session.js';
import { securityRouter, registerFailure, clearFailures, lockRemainingMin, lockedError, trackDevice, checkSecondFactor } from './security.js';
import type { Request, Response } from 'express';
import { createOrganization } from './orgDefaults.js';
import { accessOf, effectiveModules } from '../lib/permissions.js';
import type { Role } from '../types.js';
import { audit } from '../lib/audit.js';
import { sha256 } from '../lib/crypto.js';
import { config } from '../config.js';
import { PRODUCTS, getSubscriptionView } from '../billing/service.js';
import { ensureSuperAdmin } from './superadmin.js';
import { randomToken } from '../lib/crypto.js';
import { sendMailLater, welcomeMail, resetMail, passwordChangedMail, signupCodeMail, accountExistsMail, brandOf, appPath, type AppBrand } from '../lib/mailer.js';
import { needsCadastro } from './session.js';
import { parseDocumento, normalizeCelular, maskDocumento, maskCelular, onlyDigits, isValidCpf, isValidCnpj } from '../lib/documento.js';
import { checkSignupEmail } from '../lib/emailCheck.js';
import { randomInt, timingSafeEqual } from 'node:crypto';

export const authRouter = Router();
authRouter.use(securityRouter); // 2FA e sessões ativas

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
  keyGenerator: (req) => `${req.ip}|${String(req.body?.identifier ?? req.body?.email ?? '').trim().toLowerCase()}`,
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
    user: {
      id: user.id, email: user.email, name: user.name, phone: user.phone, isSuperAdmin: user.isSuperAdmin, emailVerified: !!user.emailVerifiedAt, mfaEnabled: !!user.totpEnabledAt, mfaRequired: user.isSuperAdmin && superAdminMfaRequired(),
      // CPF/CNPJ e celular só mascarados (dado pessoal).
      documento: maskDocumento(user.documento), celular: maskCelular(user.celular),
      renewalReminders: user.renewalReminders,
      waDownEmail: user.waDownEmail,
    },
    // Titular sem CPF/CNPJ ou celular: o app mostra a tela única de completar cadastro antes de qualquer outra.
    cadastroPendente: needsCadastro(user, (current?.role ?? null) as never) ? { documento: !user.documento, celular: !user.celular } : null,
    isSuperAdmin: user.isSuperAdmin,
    subscriptions,
    org: current ? { id: current.org.id, name: current.org.name, plan: current.org.plan, timezone: current.org.timezone, backupPhone: current.org.backupPhone, handoffAlertMinutes: current.org.handoffAlertMinutes } : null,
    role: current?.role ?? null,
    // Módulos e canais que o membro pode usar (o menu esconde o resto; o servidor bloqueia de verdade).
    access: current ? (() => { const a = accessOf(current.role as Role, current); return { modules: effectiveModules(current.role as Role, a), channelIds: a.channelIds }; })() : null,
    orgs: memberships.map((m) => ({ id: m.org.id, name: m.org.name, role: m.role })),
    csrfToken,
  };
}

// ---- Cadastro com confirmação do e-mail por código ----
// Nada utilizável é criado antes do código: os dados ficam em PendingSignup e a conta (usuário + organização)
// só nasce em /register/confirm. Um cadastro pendente não consegue entrar nem usar os apps.
const SIGNUP_CODE_TTL_MS = 15 * 60 * 1000;
const SIGNUP_MAX_ATTEMPTS = 5;
const SIGNUP_RESEND_COOLDOWN_MS = 60 * 1000;
const SIGNUP_MAX_SENDS = 5;
const SIGNUP_PENDING_TTL_MS = 24 * 60 * 60 * 1000;
const SIGNUP_SENT_MSG = 'Enviamos um código de 6 dígitos para o seu e-mail. Digite-o para concluir o cadastro (confira também o spam).';
const DUP_MSG = 'Já existe uma conta com este e-mail, CPF/CNPJ ou celular. Entre ou recupere a senha.';

const signupEmailLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: () => config.SIGNUP_RATE_LIMIT,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req) => `signup|${String(req.body?.email ?? '').trim().toLowerCase()}`,
  message: { error: 'Muitos pedidos de cadastro para este e-mail. Aguarde um pouco e tente novamente.' },
});

const codeHash = (pendingId: string, code: string) => sha256(`signup:${pendingId}:${code}`);
const newCode = () => String(randomInt(0, 1_000_000)).padStart(6, '0');
function sameHash(a: string, b: string) {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function sendSignupMail(req: Request, p: { email: string; name: string; app: string; existingUser: boolean }, code: string) {
  const app = brandOf(p.app);
  if (p.existingUser) sendMailLater(accountExistsMail({ to: p.email, name: p.name, app, req }));
  else sendMailLater(signupCodeMail({ to: p.email, name: p.name, app, code, minutes: SIGNUP_CODE_TTL_MS / 60000, req }));
}

const signupBody = z.object({
  name: z.string().trim().min(2, 'Informe seu nome').max(100),
  email,
  password,
  orgName: z.string().trim().min(2, 'Informe o nome da empresa').max(100),
  documento: z.string().max(30).optional(),
  celular: z.string().max(30).optional(),
  app: z.enum(['mckbot', 'mensagem']).optional(),
});

authRouter.post('/register', registerIpLimiter, loginLimiter, signupEmailLimiter, ah(async (req, res) => {
  const body = signupBody.parse(req.body);
  const doc = parseDocumento(body.documento);
  if (!doc) throw badRequest(body.documento ? 'CPF/CNPJ inválido. Confira os números digitados.' : 'Informe o CPF (ou o CNPJ, se for empresa) do titular da conta.');
  const celular = normalizeCelular(body.celular);
  if (!celular) throw badRequest(body.celular ? 'Celular inválido. Informe DDD + número, ex.: (11) 91234-5678.' : 'Informe o seu celular com DDD.');
  const check = await checkSignupEmail(body.email);
  if (!check.ok) throw badRequest(check.error);

  // Mesmo trabalho (hash + consultas) com ou sem conta existente: tempo de resposta uniforme.
  const passwordHash = await bcrypt.hash(body.password, 12);
  const existing = await prisma.user.findUnique({ where: { email: body.email }, select: { id: true, name: true } });
  await prisma.pendingSignup.deleteMany({ where: { OR: [{ email: body.email }, { createdAt: { lt: new Date(Date.now() - SIGNUP_PENDING_TTL_MS) } }] } });
  const signupToken = randomToken(32);
  const code = newCode();
  const pending = await prisma.pendingSignup.create({
    data: {
      tokenHash: sha256(signupToken), email: body.email, name: body.name, passwordHash, orgName: body.orgName,
      documento: doc.digits, celular, app: brandOf(body.app), codeHash: 'x', existingUser: !!existing,
      expiresAt: new Date(Date.now() + SIGNUP_CODE_TTL_MS), ip: req.ip ?? null,
    },
  });
  // Conta existente: o hash guardado nunca bate com nenhum código (o dono recebe o aviso "você já tem conta").
  await prisma.pendingSignup.update({ where: { id: pending.id }, data: { codeHash: existing ? sha256(randomToken(32)) : codeHash(pending.id, code) } });
  sendSignupMail(req, { email: body.email, name: existing?.name ?? body.name, app: pending.app, existingUser: !!existing }, code);
  await audit(req, existing ? 'auth.signup_existing_email' : 'auth.signup_code_sent', { orgId: null, userId: existing?.id ?? null, meta: { email: body.email, documento: 'informado' } });
  res.status(202).json({
    pending: true, signupToken, email: body.email, message: SIGNUP_SENT_MSG,
    expiresInSec: SIGNUP_CODE_TTL_MS / 1000, resendInSec: SIGNUP_RESEND_COOLDOWN_MS / 1000,
  });
}));

const findPending = async (signupToken: string) => prisma.pendingSignup.findUnique({ where: { tokenHash: sha256(signupToken) } });
const PENDING_GONE = 'Este cadastro expirou ou não foi encontrado. Preencha o cadastro de novo.';

authRouter.post('/register/confirm', loginIpLimiter, ah(async (req, res) => {
  const body = z.object({ signupToken: z.string().min(20).max(200), code: z.string().trim().max(20) }).parse(req.body);
  const p = await findPending(body.signupToken);
  if (!p || p.createdAt.getTime() < Date.now() - SIGNUP_PENDING_TTL_MS) throw new HttpError(400, PENDING_GONE);
  if (p.attempts >= SIGNUP_MAX_ATTEMPTS) throw new HttpError(429, 'Muitas tentativas com código errado. Peça um novo código.', { code: 'CODE_LOCKED' });
  if (p.expiresAt < new Date()) throw new HttpError(400, 'O código expirou. Peça um novo código.', { code: 'CODE_EXPIRED' });
  const code = onlyDigits(body.code);
  const ok = code.length === 6 && !p.existingUser && sameHash(codeHash(p.id, code), p.codeHash);
  if (!ok) {
    // Incremento atômico: pedidos simultâneos não ganham tentativas extras.
    const upd = await prisma.pendingSignup.updateMany({ where: { id: p.id, attempts: { lt: SIGNUP_MAX_ATTEMPTS } }, data: { attempts: { increment: 1 } } });
    const left = SIGNUP_MAX_ATTEMPTS - p.attempts - 1;
    await audit(req, 'auth.signup_code_failed', { orgId: null, meta: { email: p.email } });
    if (upd.count === 0 || left <= 0) throw new HttpError(429, 'Muitas tentativas com código errado. Peça um novo código.', { code: 'CODE_LOCKED' });
    throw new HttpError(400, `Código incorreto. Você ainda tem ${left} tentativa${left === 1 ? '' : 's'}.`, { code: 'CODE_INVALID', attemptsLeft: left });
  }
  // Uso único: só um pedido concorrente consome o cadastro pendente.
  const del = await prisma.pendingSignup.deleteMany({ where: { id: p.id } });
  if (del.count !== 1) throw new HttpError(400, PENDING_GONE);
  // Checagem de duplicidade feita aqui (depois de provar que o e-mail é seu): limita a sondagem de CPF/celular.
  const dup = await prisma.user.findFirst({ where: { OR: [{ email: p.email }, { documento: p.documento }, { celular: p.celular }] }, select: { id: true } });
  if (dup) {
    await audit(req, 'auth.signup_duplicate', { orgId: null, meta: { email: p.email } });
    throw new HttpError(409, DUP_MSG, { code: 'DUPLICATE' });
  }
  let user;
  try {
    user = await prisma.user.create({ data: { email: p.email, name: p.name, passwordHash: p.passwordHash, documento: p.documento, celular: p.celular, emailVerifiedAt: new Date() } });
  } catch (e) {
    if ((e as { code?: string }).code === 'P2002') throw new HttpError(409, DUP_MSG, { code: 'DUPLICATE' });
    throw e;
  }
  if (await ensureSuperAdmin(user)) await audit(req, 'auth.superadmin_bootstrap', { userId: user.id, meta: { email: user.email } });
  const org = await createOrganization(user.id, p.orgName);
  const csrf = await createSession(res, req, user.id, org.id);
  const app = brandOf(p.app);
  await trackDevice(req, res, user, org.id, app, false);
  await audit(req, 'auth.register', { orgId: org.id, userId: user.id, entity: 'user', entityId: user.id, meta: { emailVerified: true, documento: 'informado', celular: 'informado' } });
  sendMailLater(welcomeMail({ to: user.email, name: user.name, app, req }));
  res.status(201).json(await meResponse(user.id, org.id, csrf));
}));

authRouter.post('/register/resend', loginIpLimiter, ah(async (req, res) => {
  const body = z.object({ signupToken: z.string().min(20).max(200) }).parse(req.body);
  const p = await findPending(body.signupToken);
  if (!p || p.createdAt.getTime() < Date.now() - SIGNUP_PENDING_TTL_MS) throw new HttpError(400, PENDING_GONE);
  const wait = Math.ceil((p.lastSentAt.getTime() + SIGNUP_RESEND_COOLDOWN_MS - Date.now()) / 1000);
  if (wait > 0) throw new HttpError(429, `Aguarde ${wait} segundo${wait === 1 ? '' : 's'} para pedir outro código.`, { code: 'RESEND_COOLDOWN', retryInSec: wait });
  if (p.sends >= SIGNUP_MAX_SENDS) throw new HttpError(429, 'Limite de reenvios atingido. Preencha o cadastro de novo mais tarde.', { code: 'RESEND_LIMIT' });
  const code = newCode();
  // Condição em lastSentAt: dois reenvios simultâneos não disparam dois e-mails.
  const upd = await prisma.pendingSignup.updateMany({
    where: { id: p.id, lastSentAt: p.lastSentAt },
    data: {
      codeHash: p.existingUser ? sha256(randomToken(32)) : codeHash(p.id, code), attempts: 0, sends: { increment: 1 },
      lastSentAt: new Date(), expiresAt: new Date(Date.now() + SIGNUP_CODE_TTL_MS),
    },
  });
  if (upd.count === 1) {
    const existing = p.existingUser ? await prisma.user.findUnique({ where: { email: p.email }, select: { name: true } }) : null;
    sendSignupMail(req, { email: p.email, name: existing?.name ?? p.name, app: p.app, existingUser: p.existingUser }, code);
  }
  res.json({ ok: true, message: SIGNUP_SENT_MSG, expiresInSec: SIGNUP_CODE_TTL_MS / 1000, resendInSec: SIGNUP_RESEND_COOLDOWN_MS / 1000 });
}));

// Tela de completar cadastro: limita tentativas de CPF/celular por conta (evita sondar quais documentos existem).
const completeCadastroLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: () => config.LOGIN_RATE_LIMIT,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req) => `cadastro|${req.auth?.userId ?? req.ip}`,
  message: { error: 'Muitas tentativas. Aguarde alguns minutos e tente novamente.' },
});

/** Tela única para contas antigas: o titular informa CPF/CNPJ e/ou celular que faltam (não altera o que já existe). */
authRouter.post('/complete-cadastro', requireAuth, completeCadastroLimiter, ah(async (req, res) => {
  const body = z.object({ documento: z.string().max(30).optional(), celular: z.string().max(30).optional() }).parse(req.body);
  const user = await prisma.user.findUniqueOrThrow({ where: { id: req.auth!.userId } });
  const data: { documento?: string; celular?: string } = {};
  if (!user.documento) {
    const doc = parseDocumento(body.documento);
    if (!doc) throw badRequest(body.documento ? 'CPF/CNPJ inválido. Confira os números digitados.' : 'Informe o CPF (ou o CNPJ, se for empresa) do titular da conta.');
    data.documento = doc.digits;
  }
  if (!user.celular) {
    const cel = normalizeCelular(body.celular);
    if (!cel) throw badRequest(body.celular ? 'Celular inválido. Informe DDD + número, ex.: (11) 91234-5678.' : 'Informe o seu celular com DDD.');
    data.celular = cel;
  }
  if (!data.documento && !data.celular) return void res.json(await meResponse(user.id, req.auth!.orgId, req.auth!.csrfToken));
  const taken = await prisma.user.findFirst({ where: { id: { not: user.id }, OR: [...(data.documento ? [{ documento: data.documento }] : []), ...(data.celular ? [{ celular: data.celular }] : [])] }, select: { documento: true } });
  if (taken) {
    const what = data.documento && taken.documento === data.documento ? 'Este CPF/CNPJ' : 'Este celular';
    throw new HttpError(409, `${what} já está vinculado a outra conta. Se achar que é um engano, fale com o suporte.`);
  }
  try {
    await prisma.user.update({ where: { id: user.id }, data });
  } catch (e) {
    if ((e as { code?: string }).code === 'P2002') throw new HttpError(409, 'Este CPF/CNPJ ou celular já está vinculado a outra conta. Se achar que é um engano, fale com o suporte.');
    throw e;
  }
  await audit(req, 'auth.cadastro_completado', { userId: user.id, entity: 'user', entityId: user.id, meta: { ...(data.documento ? { documento: 'informado' } : {}), ...(data.celular ? { celular: 'informado' } : {}) } });
  res.json(await meResponse(user.id, req.auth!.orgId, req.auth!.csrfToken));
}));

/** Só o formato (nunca a existência): e-mail válido, ou apenas números e sinais de máscara. */
function checkIdentifierFormat(identifier: string) {
  if (identifier.includes('@')) { email.parse(identifier); return; }
  if (isValidCnpj(identifier) && !/[^0-9A-Za-z.\-/\s]/.test(identifier)) return; // CNPJ alfanumérico
  if (/[^\d+()\-./\s]/.test(identifier) || onlyDigits(identifier).length < 8) throw badRequest('Informe um e-mail, CPF/CNPJ ou celular válido.');
}

/**
 * Login por e-mail, CPF, CNPJ ou celular. 11 dígitos podem ser CPF ou celular: tenta CPF válido primeiro, depois celular.
 * Devolve null quando não encontra (a rota responde com o mesmo erro genérico de senha errada).
 */
export async function findUserByIdentifier(raw: string) {
  const id = raw.trim();
  if (!id) return null;
  if (id.includes('@')) return prisma.user.findUnique({ where: { email: id.toLowerCase() } });
  if (/[A-Za-z]/.test(id)) {
    // CNPJ alfanumérico (letras só podem ser CNPJ; guardado em maiúsculas).
    const doc = parseDocumento(id);
    return doc?.tipo === 'CNPJ' ? prisma.user.findUnique({ where: { documento: doc.digits } }) : null;
  }
  if (/[^\d+()\-./\s]/.test(id)) return null;
  const d = onlyDigits(id);
  if (!id.startsWith('+')) {
    if (d.length === 11 && isValidCpf(d)) {
      const u = await prisma.user.findUnique({ where: { documento: d } });
      if (u) return u;
    } else if (d.length === 14 && isValidCnpj(d)) {
      return prisma.user.findUnique({ where: { documento: d } });
    }
  }
  const cel = normalizeCelular(id);
  return cel ? prisma.user.findUnique({ where: { celular: cel } }) : null;
}

const MFA_TTL_MS = 5 * 60 * 1000;
export const LOGIN_FAIL_MSG = 'Credenciais inválidas. Confira o e-mail, CPF/CNPJ ou celular e a senha.';
const firstOrgId = async (userId: string) => (await prisma.membership.findFirst({ where: { userId }, orderBy: { createdAt: 'asc' } }))?.orgId ?? null;

/** Etapa final do login (senha e, se ativa, 2FA já conferidas): zera falhas, cria sessão, confere aparelho e audita. */
async function completeLogin(req: Request, res: Response, user: { id: string; email: string; name: string; isSuperAdmin: boolean; emailVerifiedAt: Date | null }, meta: Record<string, unknown>) {
  await clearFailures(user.id);
  if (await ensureSuperAdmin(user)) await audit(req, 'auth.superadmin_bootstrap', { userId: user.id, meta: { email: user.email } });
  const orgId = await firstOrgId(user.id);
  const csrf = await createSession(res, req, user.id, orgId);
  const newDevice = await trackDevice(req, res, user, orgId, brandOf(req.body?.app));
  await audit(req, 'auth.login', { orgId, userId: user.id, meta: { ...meta, newDevice } });
  return meResponse(user.id, orgId, csrf);
}

authRouter.post('/login', loginIpLimiter, loginLimiter, ah(async (req, res) => {
  // "identifier" aceita e-mail, CPF, CNPJ ou celular; "email" continua aceito (clientes antigos).
  const parsed = z.object({ identifier: z.string().trim().min(1).max(200).optional(), email: z.string().trim().max(200).optional(), password: z.string().min(1).max(200) }).parse(req.body);
  const identifier = parsed.identifier ?? parsed.email ?? '';
  if (!identifier) throw badRequest('Informe seu e-mail, CPF/CNPJ ou celular.');
  checkIdentifierFormat(identifier);
  // Na auditoria vai só o e-mail; CPF/CNPJ/celular digitados nunca são registrados.
  const body = { password: parsed.password, email: identifier.includes('@') ? identifier.toLowerCase() : '(cpf/cnpj/celular)' };
  const user = await findUserByIdentifier(identifier);
  // Compara mesmo quando o usuário não existe, para não vazar por tempo de resposta quais e-mails têm conta.
  const ok = await bcrypt.compare(body.password, user?.passwordHash ?? (await dummyHash()));
  const app = brandOf(req.body?.app);
  if (user) {
    // Bloqueio temporário por conta (vale mesmo com a senha certa, até o prazo acabar).
    const locked = lockRemainingMin(user);
    if (locked > 0) {
      await audit(req, 'auth.login_locked', { orgId: await firstOrgId(user.id), userId: user.id, meta: { email: user.email, minutes: locked } });
      throw lockedError(locked);
    }
  }
  if (user && ok && user.disabledAt) {
    await audit(req, 'auth.login_disabled', { userId: user.id, meta: { email: user.email } });
    throw new HttpError(401, 'Esta conta está desativada. Fale com o suporte.');
  }
  if (!user || !ok) {
    const orgId = user ? await firstOrgId(user.id) : null;
    await audit(req, 'auth.login_failed', { orgId, userId: user?.id ?? null, meta: { email: user?.email ?? body.email } });
    if (user) {
      const minutes = await registerFailure(req, user, orgId, app, 'password');
      if (minutes > 0) throw lockedError(minutes);
    }
    throw new HttpError(401, LOGIN_FAIL_MSG);
  }
  if (user.totpEnabledAt) {
    // Senha certa + 2FA ativa: devolve um token curto (5 min) para a etapa do código. Nenhuma sessão é criada ainda.
    const token = randomToken(32);
    await prisma.authToken.deleteMany({ where: { userId: user.id, kind: 'MFA_LOGIN' } });
    await prisma.authToken.create({ data: { userId: user.id, kind: 'MFA_LOGIN', tokenHash: sha256(token), expiresAt: new Date(Date.now() + MFA_TTL_MS), ip: req.ip ?? null } });
    return void res.json({ mfaRequired: true, mfaToken: token });
  }
  res.json(await completeLogin(req, res, user, { mfa: false }));
}));

authRouter.post('/login/mfa', loginIpLimiter, ah(async (req, res) => {
  const body = z.object({ mfaToken: z.string().min(20).max(200), code: z.string().min(6).max(20) }).parse(req.body);
  const row = await prisma.authToken.findUnique({ where: { tokenHash: sha256(body.mfaToken) } });
  if (!row || row.kind !== 'MFA_LOGIN' || row.usedAt || row.expiresAt < new Date()) throw new HttpError(401, 'A etapa de verificação expirou. Entre de novo com e-mail e senha.');
  const user = await prisma.user.findUniqueOrThrow({ where: { id: row.userId } });
  const orgId = await firstOrgId(user.id);
  const locked = lockRemainingMin(user);
  if (locked > 0) {
    await prisma.authToken.deleteMany({ where: { id: row.id } });
    throw lockedError(locked);
  }
  if (user.disabledAt) throw new HttpError(401, 'Esta conta está desativada. Fale com o suporte.');
  const method = await checkSecondFactor(user, body.code);
  if (!method) {
    await audit(req, 'auth.mfa_failed', { orgId, userId: user.id, meta: { context: 'login' } });
    const minutes = await registerFailure(req, user, orgId, brandOf(req.body?.app), 'mfa');
    if (minutes > 0) {
      await prisma.authToken.deleteMany({ where: { id: row.id } });
      throw lockedError(minutes);
    }
    throw new HttpError(401, 'Código inválido. Digite o código atual do app autenticador ou um código de recuperação.');
  }
  const used = await prisma.authToken.updateMany({ where: { id: row.id, usedAt: null }, data: { usedAt: new Date() } });
  if (used.count !== 1) throw new HttpError(401, 'A etapa de verificação expirou. Entre de novo com e-mail e senha.');
  if (method === 'recovery') await audit(req, 'auth.mfa_recovery_used', { orgId, userId: user.id });
  res.json(await completeLogin(req, res, user, { mfa: method }));
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
authRouter.get('/invite/:token', loginIpLimiter, ah(async (req, res) => {
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
    prisma.membership.upsert({ where: { userId_orgId: { userId: user.id, orgId: inv.orgId } }, create: { userId: user.id, orgId: inv.orgId, role: inv.role, modules: inv.modules, channelIds: inv.channelIds }, update: {} }),
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
type TokenKind = 'RESET_PASSWORD' | 'VERIFY_EMAIL'; // + MFA_LOGIN (etapa do código no login)

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

/** Gera e envia por e-mail um link de redefinição de senha (1 h). Usado pelo "Esqueci minha senha" e pelo Perfil logado. */
export async function sendResetLink(req: Request, user: { id: string; email: string; name: string }, app: AppBrand) {
  const token = await issueToken(user.id, 'RESET_PASSWORD', RESET_TTL_MS, req.ip);
  sendMailLater(resetMail({ to: user.email, name: user.name, app, url: appPath(app, `/redefinir-senha?token=${token}`, req), req }));
}

const FORGOT_MSG = 'Se existir uma conta com estes dados, enviamos um link para redefinir a senha para o e-mail cadastrado. Confira a caixa de entrada e o spam.';

authRouter.post('/forgot', forgotIpLimiter, forgotLimiter, ah(async (req, res) => {
  // Aceita e-mail, CPF, CNPJ ou celular; o link vai sempre para o e-mail cadastrado da conta.
  const parsed = z.object({ identifier: z.string().trim().min(1).max(200).optional(), email: z.string().trim().max(200).optional(), app: z.enum(['mckbot', 'mensagem']).optional() }).parse(req.body);
  const identifier = parsed.identifier ?? parsed.email ?? '';
  if (!identifier) throw badRequest('Informe seu e-mail, CPF/CNPJ ou celular.');
  checkIdentifierFormat(identifier);
  const body = { ...parsed, email: identifier.includes('@') ? identifier.toLowerCase() : null };
  const app: AppBrand = brandOf(body.app);
  // Resposta sempre igual e imediata; o trabalho acontece em segundo plano para não vazar, pelo tempo, se o e-mail existe.
  res.json({ ok: true, message: FORGOT_MSG });
  void (async () => {
    try {
      const user = await findUserByIdentifier(identifier);
      // Por CPF/CNPJ/celular, só envia para e-mail já confirmado (o link nunca vai para um endereço não verificado).
      if (!user || user.disabledAt || (!body.email && !user.emailVerifiedAt)) {
        await audit(req, 'auth.forgot_unknown', { meta: { email: body.email ?? 'identificador' } });
        return;
      }
      await sendResetLink(req, user, app);
      await audit(req, 'auth.forgot', { userId: user.id });
    } catch (e) {
      console.error('[auth] forgot:', (e as Error).message);
    }
  })();
}));

authRouter.get('/reset/:token', loginIpLimiter, ah(async (req, res) => {
  const row = await prisma.authToken.findUnique({ where: { tokenHash: sha256(req.params.token) } });
  const valid = !!row && row.kind === 'RESET_PASSWORD' && !row.usedAt && row.expiresAt > new Date();
  res.json({ valid });
}));

authRouter.post('/reset', loginIpLimiter, loginLimiter, ah(async (req, res) => {
  const body = z.object({ token: z.string().min(20).max(200), password, app: z.enum(['mckbot', 'mensagem']).optional() }).parse(req.body);
  const row = await consumeToken(body.token, 'RESET_PASSWORD');
  if (!row) throw new HttpError(400, 'Link inválido ou expirado. Peça um novo em "Esqueci minha senha".');
  // Nova senha também desbloqueia a conta (quem recebeu o link no e-mail provou ser o dono).
  const user = await prisma.user.update({ where: { id: row.userId }, data: { passwordHash: await bcrypt.hash(body.password, 12), failedLogins: 0, lockedUntil: null } });
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

authRouter.post('/resend-verification', requireAuth, forgotLimiter, ah(async (req, res) => {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: req.auth!.userId } });
  if (user.emailVerifiedAt) return void res.json({ ok: true, alreadyVerified: true });
  const app = brandOf(req.body?.app);
  const token = await issueToken(user.id, 'VERIFY_EMAIL', VERIFY_TTL_MS, req.ip);
  sendMailLater(welcomeMail({ to: user.email, name: user.name, app, verifyUrl: appPath(app, `/verificar-email?token=${token}`, req), req }));
  res.json({ ok: true });
}));
