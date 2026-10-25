import { Router } from 'express';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { prisma } from '../db.js';
import { ah, HttpError } from '../lib/http.js';
import { orgOf, requireRole, requireAuth } from '../auth/session.js';
import { audit } from '../lib/audit.js';

export const profileRouter = Router();
profileRouter.use(requireAuth);

profileRouter.patch('/', ah(async (req, res) => {
  const body = z.object({ name: z.string().trim().min(2).max(100), phone: z.string().trim().max(30).optional().nullable() }).parse(req.body);
  const u = await prisma.user.update({ where: { id: req.auth!.userId }, data: { name: body.name, phone: body.phone || null } });
  await audit(req, 'profile.update');
  res.json({ id: u.id, name: u.name, email: u.email, phone: u.phone });
}));

profileRouter.post('/password', ah(async (req, res) => {
  const body = z.object({ current: z.string().min(1), next: z.string().min(8, 'A nova senha precisa ter pelo menos 8 caracteres').max(200) }).parse(req.body);
  const u = await prisma.user.findUniqueOrThrow({ where: { id: req.auth!.userId } });
  if (!(await bcrypt.compare(body.current, u.passwordHash))) throw new HttpError(400, 'Senha atual incorreta');
  await prisma.user.update({ where: { id: u.id }, data: { passwordHash: await bcrypt.hash(body.next, 12) } });
  // Encerra as outras sessões.
  await prisma.session.deleteMany({ where: { userId: u.id, id: { not: req.auth!.sessionId } } });
  await audit(req, 'profile.password_change');
  res.json({ ok: true });
}));

export const orgRouter = Router();
orgRouter.patch('/', requireRole('OWNER', 'ADMIN'), ah(async (req, res) => {
  const body = z.object({ name: z.string().trim().min(2).max(100).optional(), timezone: z.string().refine((tz) => { try { new Intl.DateTimeFormat('pt-BR', { timeZone: tz }); return true; } catch { return false; } }, 'Fuso horário inválido').optional() }).parse(req.body);
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
