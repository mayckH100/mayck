import { Router, type Request, type Response } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import QRCode from 'qrcode';
import rateLimit from 'express-rate-limit';
import { prisma } from '../db.js';
import { ah, HttpError, badRequest } from '../lib/http.js';
import { audit } from '../lib/audit.js';
import { decrypt, encrypt, randomToken, sha256, safeEqual } from '../lib/crypto.js';
import { generateTotpSecret, verifyTotp, otpauthUrl, generateRecoveryCodes, normalizeRecoveryCode } from '../lib/totp.js';
import { sendMailLater, newDeviceMail, accountLockedMail, mfaChangedMail, type AppBrand } from '../lib/mailer.js';
import { config, isProd } from '../config.js';
import { COOKIE, requireAuth, superAdminMfaRequired } from './session.js';
export { superAdminMfaRequired };

// ---------------- Configuração ----------------
/** Tentativas erradas seguidas (senha ou código) até bloquear a conta. */
export const lockThreshold = () => Math.max(3, Number(process.env.ACCOUNT_LOCK_THRESHOLD || 5));
/** Duração do 1º bloqueio; cada nova falha depois disso dobra o tempo (máx. 24 h). */
export const lockMinutes = () => Math.max(1, Number(process.env.ACCOUNT_LOCK_MINUTES || 15));

type UserLite = { id: string; email: string; name: string; failedLogins: number; lockedUntil: Date | null };

// ---------------- Bloqueio temporário ----------------
export function lockRemainingMin(u: { lockedUntil: Date | null }): number {
  if (!u.lockedUntil) return 0;
  const ms = u.lockedUntil.getTime() - Date.now();
  return ms > 0 ? Math.ceil(ms / 60000) : 0;
}

export function lockedError(min: number) {
  return new HttpError(423, `Conta bloqueada temporariamente por muitas tentativas erradas. Tente de novo em ${min} minuto(s) ou use "Esqueci minha senha".`, { code: 'ACCOUNT_LOCKED', minutes: min });
}

/** Registra uma tentativa errada; bloqueia ao atingir o limite. Devolve os minutos de bloqueio aplicados (0 = não bloqueou). */
export async function registerFailure(req: Request, user: UserLite, orgId: string | null, app: AppBrand, kind: 'password' | 'mfa'): Promise<number> {
  const upd = await prisma.user.update({ where: { id: user.id }, data: { failedLogins: { increment: 1 } }, select: { failedLogins: true } });
  const n = upd.failedLogins;
  const t = lockThreshold();
  if (n < t) return 0;
  const minutes = Math.min(24 * 60, lockMinutes() * 2 ** (n - t));
  await prisma.user.update({ where: { id: user.id }, data: { lockedUntil: new Date(Date.now() + minutes * 60000) } });
  await audit(req, 'auth.account_locked', { orgId, userId: user.id, entity: 'user', entityId: user.id, meta: { failures: n, minutes, via: kind } });
  // E-mail só no 1º bloqueio da sequência (evita inundar a caixa durante um ataque).
  if (n === t) sendMailLater(accountLockedMail({ to: user.email, name: user.name, app, minutes, ip: req.ip, req }));
  return minutes;
}

export async function clearFailures(userId: string) {
  await prisma.user.updateMany({ where: { id: userId, OR: [{ failedLogins: { gt: 0 } }, { lockedUntil: { not: null } }] }, data: { failedLogins: 0, lockedUntil: null } });
}

// ---------------- Aparelhos conhecidos ----------------
export const DEVICE_COOKIE = 'mck_did';
const DEVICE_TTL_MS = 400 * 24 * 3600 * 1000;

export function describeDevice(ua?: string | null): string {
  const s = String(ua ?? '');
  if (!s) return 'Desconhecido';
  const browser = /Edg\//.test(s) ? 'Edge' : /OPR\/|Opera/.test(s) ? 'Opera' : /SamsungBrowser/.test(s) ? 'Samsung Internet' : /Chrome\//.test(s) ? 'Chrome' : /Firefox\//.test(s) ? 'Firefox' : /Safari\//.test(s) ? 'Safari' : 'Navegador';
  const os = /Android/.test(s) ? 'Android' : /iPhone|iPad|iPod/.test(s) ? 'iPhone/iPad' : /Windows/.test(s) ? 'Windows' : /Mac OS X|Macintosh/.test(s) ? 'Mac' : /Linux/.test(s) ? 'Linux' : 'sistema desconhecido';
  return `${browser} no ${os}`;
}

/**
 * Marca o navegador com um cookie de aparelho e confere se ele já foi usado por este usuário.
 * Aparelho novo (quando o usuário já tem algum conhecido) → e-mail de alerta + auditoria.
 * O primeiro aparelho registrado (cadastro ou primeiro login após a atualização) não gera alerta.
 */
export async function trackDevice(req: Request, res: Response, user: { id: string; email: string; name: string }, orgId: string | null, app: AppBrand, alert = true) {
  let raw = req.cookies?.[DEVICE_COOKIE] as string | undefined;
  if (!raw || raw.length < 20 || raw.length > 100) raw = randomToken(24);
  res.cookie(DEVICE_COOKIE, raw, { httpOnly: true, sameSite: 'lax', secure: config.COOKIE_SECURE ? config.COOKIE_SECURE === 'true' : isProd, maxAge: DEVICE_TTL_MS, path: '/' });
  const deviceHash = sha256(raw);
  const ua = String(req.headers['user-agent'] ?? '').slice(0, 200);
  const known = await prisma.knownDevice.findUnique({ where: { userId_deviceHash: { userId: user.id, deviceHash } } });
  if (known) {
    await prisma.knownDevice.update({ where: { id: known.id }, data: { lastSeenAt: new Date(), ip: req.ip ?? null, userAgent: ua } });
    return false;
  }
  const hasOthers = (await prisma.knownDevice.count({ where: { userId: user.id } })) > 0;
  await prisma.knownDevice.create({ data: { userId: user.id, deviceHash, userAgent: ua, ip: req.ip ?? null } });
  if (!hasOthers || !alert) return false;
  const device = describeDevice(ua);
  await audit(req, 'auth.login_new_device', { orgId, userId: user.id, meta: { device, ip: req.ip } });
  sendMailLater(newDeviceMail({ to: user.email, name: user.name, app, ip: req.ip, device, req }));
  return true;
}

// ---------------- 2FA: verificação de código ----------------
type MfaUser = { id: string; totpSecretEnc: string | null; totpLastStep: number | null; recoveryCodes: string };

/** Confere código TOTP (6 dígitos) ou código de recuperação (uso único). Atualiza o estado no banco quando aceito. */
export async function checkSecondFactor(user: MfaUser, code: string): Promise<'totp' | 'recovery' | null> {
  if (!user.totpSecretEnc) return null;
  const c = String(code ?? '').trim();
  if (/^\d{3}\s?\d{3}$/.test(c)) {
    const step = verifyTotp(decrypt(user.totpSecretEnc), c, user.totpLastStep);
    if (step === null) return null;
    // Atualização condicional: dois pedidos simultâneos com o mesmo código → só um passa.
    const r = await prisma.user.updateMany({ where: { id: user.id, OR: [{ totpLastStep: null }, { totpLastStep: { lt: step } }] }, data: { totpLastStep: step } });
    return r.count === 1 ? 'totp' : null;
  }
  const norm = normalizeRecoveryCode(c);
  if (norm.length !== 10) return null;
  const h = sha256(norm);
  let list: string[] = [];
  try { list = JSON.parse(user.recoveryCodes || '[]'); } catch { list = []; }
  const idx = list.findIndex((x) => safeEqual(x, h));
  if (idx < 0) return null;
  const rest = list.filter((_, i) => i !== idx);
  const r = await prisma.user.updateMany({ where: { id: user.id, recoveryCodes: user.recoveryCodes }, data: { recoveryCodes: JSON.stringify(rest) } });
  return r.count === 1 ? 'recovery' : null;
}

const hashCodes = (codes: string[]) => JSON.stringify(codes.map((c) => sha256(normalizeRecoveryCode(c))));
const codesLeft = (json: string) => { try { return (JSON.parse(json || '[]') as string[]).length; } catch { return 0; } };

// ---------------- Rotas: 2FA e sessões ativas (montadas em /api/auth) ----------------
export const securityRouter = Router();

const mfaLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: () => config.LOGIN_RATE_LIMIT * 2,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Muitas tentativas. Aguarde alguns minutos e tente novamente.' },
});

async function requirePassword(userId: string, password: string) {
  const u = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  if (!(await bcrypt.compare(password, u.passwordHash))) throw new HttpError(400, 'Senha atual incorreta');
  return u;
}

securityRouter.get('/2fa', requireAuth, ah(async (req, res) => {
  const u = await prisma.user.findUniqueOrThrow({ where: { id: req.auth!.userId } });
  res.json({ enabled: !!u.totpEnabledAt, enabledAt: u.totpEnabledAt?.toISOString() ?? null, required: u.isSuperAdmin && superAdminMfaRequired(), recoveryCodesLeft: u.totpEnabledAt ? codesLeft(u.recoveryCodes) : 0 });
}));

securityRouter.post('/2fa/setup', requireAuth, mfaLimiter, ah(async (req, res) => {
  const { password } = z.object({ password: z.string().min(1).max(200) }).parse(req.body);
  const u = await requirePassword(req.auth!.userId, password);
  if (u.totpEnabledAt) throw badRequest('A verificação em duas etapas já está ativa. Desative antes de configurar outro aparelho.');
  const secret = generateTotpSecret();
  await prisma.user.update({ where: { id: u.id }, data: { totpPendingEnc: encrypt(secret) } });
  const url = otpauthUrl(secret, u.email);
  const qr = await QRCode.toDataURL(url, { margin: 1, width: 240 });
  res.json({ secret, otpauthUrl: url, qr });
}));

securityRouter.post('/2fa/enable', requireAuth, mfaLimiter, ah(async (req, res) => {
  const { code } = z.object({ code: z.string().min(6).max(20) }).parse(req.body);
  const u = await prisma.user.findUniqueOrThrow({ where: { id: req.auth!.userId } });
  if (u.totpEnabledAt) throw badRequest('A verificação em duas etapas já está ativa.');
  if (!u.totpPendingEnc) throw badRequest('Comece pela leitura do QR code.');
  const secret = decrypt(u.totpPendingEnc);
  const step = verifyTotp(secret, code, null);
  if (step === null) throw badRequest('Código incorreto. Confira se o horário do celular está automático e digite o código atual do app.');
  const codes = generateRecoveryCodes();
  await prisma.user.update({ where: { id: u.id }, data: { totpSecretEnc: u.totpPendingEnc, totpPendingEnc: null, totpEnabledAt: new Date(), totpLastStep: step, recoveryCodes: hashCodes(codes) } });
  await audit(req, 'auth.mfa_enabled', { entity: 'user', entityId: u.id });
  sendMailLater(mfaChangedMail({ to: u.email, name: u.name, enabled: true, req }));
  res.json({ ok: true, recoveryCodes: codes });
}));

securityRouter.post('/2fa/disable', requireAuth, mfaLimiter, ah(async (req, res) => {
  const body = z.object({ password: z.string().min(1).max(200), code: z.string().min(6).max(20) }).parse(req.body);
  const u = await requirePassword(req.auth!.userId, body.password);
  if (!u.totpEnabledAt) throw badRequest('A verificação em duas etapas não está ativa.');
  if (u.isSuperAdmin && superAdminMfaRequired()) throw badRequest('Para o administrador da plataforma (Painel Master) a verificação em duas etapas é obrigatória e não pode ser desligada.');
  if (!(await checkSecondFactor(u, body.code))) {
    await audit(req, 'auth.mfa_failed', { entity: 'user', entityId: u.id, meta: { context: 'disable' } });
    throw badRequest('Código inválido.');
  }
  await prisma.user.update({ where: { id: u.id }, data: { totpSecretEnc: null, totpPendingEnc: null, totpEnabledAt: null, totpLastStep: null, recoveryCodes: '[]' } });
  await audit(req, 'auth.mfa_disabled', { entity: 'user', entityId: u.id });
  sendMailLater(mfaChangedMail({ to: u.email, name: u.name, enabled: false, req }));
  res.json({ ok: true });
}));

securityRouter.post('/2fa/recovery-codes', requireAuth, mfaLimiter, ah(async (req, res) => {
  const { code } = z.object({ code: z.string().min(6).max(20) }).parse(req.body);
  const u = await prisma.user.findUniqueOrThrow({ where: { id: req.auth!.userId } });
  if (!u.totpEnabledAt) throw badRequest('A verificação em duas etapas não está ativa.');
  if (!(await checkSecondFactor(u, code))) {
    await audit(req, 'auth.mfa_failed', { entity: 'user', entityId: u.id, meta: { context: 'recovery_codes' } });
    throw badRequest('Código inválido.');
  }
  const codes = generateRecoveryCodes();
  await prisma.user.update({ where: { id: u.id }, data: { recoveryCodes: hashCodes(codes) } });
  await audit(req, 'auth.mfa_recovery_regenerated', { entity: 'user', entityId: u.id });
  res.json({ ok: true, recoveryCodes: codes });
}));

// ---- Sessões ativas ----
securityRouter.get('/sessions', requireAuth, ah(async (req, res) => {
  const rows = await prisma.session.findMany({ where: { userId: req.auth!.userId, expiresAt: { gt: new Date() } }, orderBy: { createdAt: 'desc' } });
  res.json(rows.map((s) => ({
    id: s.id.slice(0, 24), current: s.id === req.auth!.sessionId, ip: s.ip, device: describeDevice(s.userAgent), userAgent: s.userAgent,
    createdAt: s.createdAt.toISOString(), lastSeenAt: (s.lastSeenAt ?? s.createdAt).toISOString(), expiresAt: s.expiresAt.toISOString(),
  })));
}));

securityRouter.delete('/sessions/:id', requireAuth, ah(async (req, res) => {
  const pid = String(req.params.id);
  if (!/^[a-f0-9]{24}$/.test(pid)) throw badRequest('Sessão inválida');
  const s = await prisma.session.findFirst({ where: { userId: req.auth!.userId, id: { startsWith: pid } } });
  if (!s) throw new HttpError(404, 'Sessão não encontrada');
  await prisma.session.delete({ where: { id: s.id } });
  const current = s.id === req.auth!.sessionId;
  if (current) res.clearCookie(COOKIE, { path: '/' });
  await audit(req, 'auth.session_revoked', { entity: 'session', entityId: pid, meta: { ip: s.ip, device: describeDevice(s.userAgent), current } });
  res.json({ ok: true, current });
}));

securityRouter.post('/sessions/revoke-all', requireAuth, ah(async (req, res) => {
  const { includeCurrent } = z.object({ includeCurrent: z.boolean().optional() }).parse(req.body ?? {});
  const where = includeCurrent ? { userId: req.auth!.userId } : { userId: req.auth!.userId, id: { not: req.auth!.sessionId } };
  const r = await prisma.session.deleteMany({ where });
  if (includeCurrent) res.clearCookie(COOKIE, { path: '/' });
  await audit(req, 'auth.sessions_revoked', { meta: { count: r.count, includeCurrent: !!includeCurrent } });
  res.json({ ok: true, count: r.count });
}));
