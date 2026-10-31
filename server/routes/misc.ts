import { Router } from 'express';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { prisma } from '../db.js';
import { ah, HttpError } from '../lib/http.js';
import { orgOf, requireRole, requireAuth } from '../auth/session.js';
import { audit } from '../lib/audit.js';
import rateLimit from 'express-rate-limit';
import { config } from '../config.js';
import { sendResetLink } from '../auth/routes.js';
import { brandOf } from '../lib/mailer.js';
import { normalizeBrPhone } from '../lib/waiting.js';

// Por usuário logado: impede que uma sessão roubada teste senhas atuais em série ou dispare e-mails sem parar.
const passwordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, limit: () => config.LOGIN_RATE_LIMIT,
  standardHeaders: 'draft-7', legacyHeaders: false,
  keyGenerator: (req) => `pw:${req.auth?.userId ?? req.ip}`,
  message: { error: 'Muitas tentativas. Aguarde alguns minutos e tente novamente.' },
});
const resetLinkLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, limit: () => config.FORGOT_RATE_LIMIT,
  standardHeaders: 'draft-7', legacyHeaders: false,
  keyGenerator: (req) => `rl:${req.auth?.userId ?? req.ip}`,
  message: { error: 'Muitos pedidos de link. Aguarde um pouco e confira sua caixa de entrada e o spam.' },
});

export const profileRouter = Router();
profileRouter.use(requireAuth);

profileRouter.patch('/', ah(async (req, res) => {
  const body = z.object({ name: z.string().trim().min(2).max(100), phone: z.string().trim().max(30).optional().nullable() }).parse(req.body);
  const u = await prisma.user.update({ where: { id: req.auth!.userId }, data: { name: body.name, phone: body.phone || null } });
  await audit(req, 'profile.update');
  res.json({ id: u.id, name: u.name, email: u.email, phone: u.phone });
}));

profileRouter.post('/password', passwordLimiter, ah(async (req, res) => {
  const body = z.object({ current: z.string().min(1).max(200), next: z.string().min(8, 'A nova senha precisa ter pelo menos 8 caracteres').max(200) }).parse(req.body);
  const u = await prisma.user.findUniqueOrThrow({ where: { id: req.auth!.userId } });
  if (!(await bcrypt.compare(body.current, u.passwordHash))) throw new HttpError(400, 'Senha atual incorreta');
  await prisma.user.update({ where: { id: u.id }, data: { passwordHash: await bcrypt.hash(body.next, 12) } });
  // Encerra as outras sessões.
  await prisma.session.deleteMany({ where: { userId: u.id, id: { not: req.auth!.sessionId } } });
  await audit(req, 'profile.password_change');
  res.json({ ok: true });
}));

// Logado, mas esqueceu a senha atual: manda o link de redefinição para o e-mail da própria conta.
profileRouter.post('/password-reset-link', resetLinkLimiter, ah(async (req, res) => {
  const body = z.object({ app: z.enum(['mckbot', 'mensagem']).optional() }).parse(req.body ?? {});
  const u = await prisma.user.findUniqueOrThrow({ where: { id: req.auth!.userId } });
  await sendResetLink(req, u, brandOf(body.app));
  await audit(req, 'profile.password_reset_link');
  res.json({ ok: true, message: `Enviamos um link para ${u.email}. Ele vale por 1 hora; confira também o spam.` });
}));

export const orgRouter = Router();
orgRouter.patch('/', requireRole('OWNER', 'ADMIN'), ah(async (req, res) => {
  const body = z.object({
    name: z.string().trim().min(2).max(100).optional(),
    timezone: z.string().refine((tz) => { try { new Intl.DateTimeFormat('pt-BR', { timeZone: tz }); return true; } catch { return false; } }, 'Fuso horário inválido').optional(),
    // Número reserva para o aviso "Aguardando atendente" (vazio/null remove).
    backupPhone: z.union([z.string().max(30), z.null()]).optional().transform((v, ctx) => {
      if (v === undefined) return undefined;
      if (v === null || !v.trim()) return null;
      const n = normalizeBrPhone(v);
      if (!n) { ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Telefone reserva inválido: use o formato +55 DDD número (ex.: +5511999998888)' }); return z.NEVER; }
      return n;
    }),
    handoffAlertMinutes: z.number({ invalid_type_error: 'Minutos do aviso inválidos' }).int('Minutos do aviso devem ser um número inteiro').min(1, 'Minutos do aviso: mínimo 1').max(120, 'Minutos do aviso: máximo 120').optional(),
  }).parse(req.body);
  const o = await prisma.organization.update({ where: { id: orgOf(req) }, data: body });
  await audit(req, 'org.update', { meta: body });
  res.json(o);
}));

export const auditRouter = Router();
auditRouter.get('/', requireRole('OWNER', 'ADMIN'), ah(async (req, res) => {
  const orgId = orgOf(req);
  const logs = await prisma.auditLog.findMany({ where: { orgId }, orderBy: { createdAt: 'desc' }, take: 200 });
  const users = await prisma.user.findMany({ where: { id: { in: logs.map((l) => l.userId).filter(Boolean) as string[] } }, select: { id: true, name: true, email: true } });
  res.json(logs.map((l) => ({ ...l, user: users.find((u) => u.id === l.userId) ?? null })));
}));
