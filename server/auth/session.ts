import type { Request, Response, NextFunction } from 'express';
import { prisma } from '../db.js';
import { randomToken, sha256 } from '../lib/crypto.js';
import { HttpError, forbidden } from '../lib/http.js';
import { config, isProd } from '../config.js';
import type { Role } from '../types.js';

export const COOKIE = 'mck_sid';
/** 2FA obrigatória para superadmin (Painel Master). Desligável só por variável de ambiente (emergência/testes). */
export const superAdminMfaRequired = () => process.env.SUPERADMIN_MFA_REQUIRED !== 'false';
const SEEN_EVERY_MS = 5 * 60 * 1000;
const TTL_MS = 7 * 24 * 3600 * 1000;

export async function createSession(res: Response, req: Request, userId: string, orgId: string | null) {
  const token = randomToken();
  const csrfToken = randomToken(24);
  await prisma.session.create({
    data: {
      id: sha256(token), userId, orgId, csrfToken,
      ip: req.ip, userAgent: String(req.headers['user-agent'] ?? '').slice(0, 200),
      expiresAt: new Date(Date.now() + TTL_MS),
    },
  });
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.COOKIE_SECURE ? config.COOKIE_SECURE === 'true' : isProd,
    maxAge: TTL_MS,
    path: '/',
  });
  return csrfToken;
}

export async function destroySession(req: Request, res: Response) {
  const token = req.cookies?.[COOKIE];
  if (token) await prisma.session.deleteMany({ where: { id: sha256(token) } });
  res.clearCookie(COOKIE, { path: '/' });
}

export async function loadSession(req: Request, _res: Response, next: NextFunction) {
  try {
    const token = req.cookies?.[COOKIE];
    if (!token) return next();
    const session = await prisma.session.findUnique({ where: { id: sha256(token) } });
    if (!session || session.expiresAt < new Date()) return next();
    const user = await prisma.user.findUnique({ where: { id: session.userId }, select: { isSuperAdmin: true, disabledAt: true, totpEnabledAt: true } });
    if (!user || user.disabledAt) return next(); // usuário desativado: sessão não vale (401 nas rotas protegidas)
    let role: Role | null = null;
    let orgId = session.orgId;
    if (orgId) {
      const m = await prisma.membership.findUnique({ where: { userId_orgId: { userId: session.userId, orgId } } });
      if (m) role = m.role as Role;
      else orgId = null; // removido da organização
    }
    req.auth = { userId: session.userId, sessionId: session.id, csrfToken: session.csrfToken, orgId, role, isSuperAdmin: user.isSuperAdmin, mfaEnabled: !!user.totpEnabledAt };
    // "Visto por último" para a tela Sessões ativas (no máximo uma escrita a cada 5 min por sessão).
    if (!session.lastSeenAt || Date.now() - session.lastSeenAt.getTime() > SEEN_EVERY_MS) {
      prisma.session.updateMany({ where: { id: session.id }, data: { lastSeenAt: new Date(), ip: req.ip } }).catch(() => undefined);
    }
    next();
  } catch (e) {
    next(e);
  }
}

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Proteção CSRF:
 *  - toda requisição mutável exige o cabeçalho X-Requested-With: mckbot (força preflight CORS, que não habilitamos);
 *  - se houver sessão, exige também X-CSRF-Token igual ao token da sessão (double submit ligado à sessão).
 */
export function csrfProtection(req: Request, _res: Response, next: NextFunction) {
  if (SAFE.has(req.method)) return next();
  if (req.headers['x-requested-with'] !== 'mckbot') return next(new HttpError(403, 'Falha na verificação CSRF'));
  if (req.auth && req.headers['x-csrf-token'] !== req.auth.csrfToken) {
    return next(new HttpError(403, 'Token CSRF inválido'));
  }
  next();
}

export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  if (!req.auth) return next(new HttpError(401, 'Faça login para continuar'));
  next();
}

export function requireOrg(req: Request, _res: Response, next: NextFunction) {
  if (!req.auth) return next(new HttpError(401, 'Faça login para continuar'));
  if (!req.auth.orgId || !req.auth.role) return next(forbidden('Selecione uma organização'));
  next();
}

export const requireRole = (...roles: Role[]) => (req: Request, _res: Response, next: NextFunction) => {
  if (!req.auth?.role || !roles.includes(req.auth.role)) return next(forbidden());
  next();
};

/** Somente superadmin da plataforma (painel Master). OWNER de organização não basta. */
export function requireSuperAdmin(req: Request, _res: Response, next: NextFunction) {
  if (!req.auth) return next(new HttpError(401, 'Faça login para continuar'));
  if (!req.auth.isSuperAdmin) return next(forbidden('Acesso restrito ao administrador da plataforma'));
  if (superAdminMfaRequired() && !req.auth.mfaEnabled) {
    return next(new HttpError(403, 'Ative a verificação em duas etapas (app autenticador) para usar o Painel Master.', { code: 'MFA_REQUIRED' }));
  }
  next();
}

/** orgId do usuário autenticado — toda consulta de dados de negócio deve filtrar por ele. */
export function orgOf(req: Request): string {
  const id = req.auth?.orgId;
  if (!id) throw forbidden('Selecione uma organização');
  return id;
}
