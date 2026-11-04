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
import { deliverStaffAlert, MAX_NOTIFY_PHONES, orgNotifyPhones, samePhone, conversationUrl } from '../whatsapp/handoffNotify.js';
import { channelLabels } from '../whatsapp/channelLabel.js';
import { parseJson } from '../lib/json.js';

/** Lista de números de aviso: valida cada um (+55 DDD número), tira repetidos; máx. MAX_NOTIFY_PHONES. */
const notifyPhonesSchema = z.array(z.string().max(30)).max(MAX_NOTIFY_PHONES, `No máximo ${MAX_NOTIFY_PHONES} números de aviso`).transform((list, ctx) => {
  const out: string[] = [];
  for (const raw of list) {
    if (!raw.trim()) continue;
    const n = normalizeBrPhone(raw);
    if (!n) { ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Número de aviso inválido: ${raw.slice(0, 30)} (use +55 DDD número, ex.: +5511999998888)` }); return z.NEVER; }
    if (!out.some((x) => samePhone(x, n))) out.push(n);
  }
  return out;
});

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

// Lembrete de vencimento por e-mail (titular): ligado por padrão; aqui o usuário liga/desliga.
profileRouter.put('/reminders', ah(async (req, res) => {
  const { enabled } = z.object({ enabled: z.boolean() }).parse(req.body);
  await prisma.user.update({ where: { id: req.auth!.userId }, data: { renewalReminders: enabled } });
  await audit(req, 'profile.renewal_reminders', { meta: { enabled } });
  res.json({ renewalReminders: enabled });
}));

/** Alerta de WhatsApp desconectado por e-mail (Proprietário/Administrador). Padrão: ligado. */
profileRouter.put('/alertas', ah(async (req, res) => {
  const body = z.object({ waDownEmail: z.boolean() }).parse(req.body);
  const u = await prisma.user.update({ where: { id: req.auth!.userId }, data: { waDownEmail: body.waDownEmail } });
  await audit(req, 'profile.wa_down_email', { meta: { ligado: u.waDownEmail } });
  res.json({ waDownEmail: u.waDownEmail });
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
    handoffNotifyPhones: notifyPhonesSchema.optional(),
    // O que os números de aviso recebem (todos ligados por padrão).
    alertHandoff: z.boolean().optional(),
    alertMeeting: z.boolean().optional(),
    alertTask: z.boolean().optional(),
    alertOrder: z.boolean().optional(),
  }).parse(req.body);
  const { handoffNotifyPhones, ...rest } = body;
  const data: Record<string, unknown> = { ...rest };
  // Lista nova manda; backupPhone (antigo) fica igual ao 1º número para compatibilidade.
  if (handoffNotifyPhones !== undefined) {
    data.handoffNotifyPhones = JSON.stringify(handoffNotifyPhones);
    data.backupPhone = handoffNotifyPhones[0] ?? null;
  } else if (rest.backupPhone !== undefined) {
    data.handoffNotifyPhones = rest.backupPhone ? JSON.stringify([rest.backupPhone]) : JSON.stringify([]);
  }
  const o = await prisma.organization.update({ where: { id: orgOf(req) }, data });
  await audit(req, 'org.update', { meta: body });
  res.json(o);
}));

/** Números de aviso de atendimento: lista, último resultado e números dos WhatsApps conectados (para avisar "é o próprio número"). */
orgRouter.get('/handoff-notify', requireRole('OWNER', 'ADMIN'), ah(async (req, res) => {
  const orgId = orgOf(req);
  const org = await prisma.organization.findUniqueOrThrow({ where: { id: orgId } });
  const chans = await prisma.channel.findMany({ where: { orgId }, orderBy: { createdAt: 'asc' }, select: { id: true, displayPhone: true, status: true } });
  const labels = await channelLabels(orgId);
  const me = await prisma.user.findUnique({ where: { id: req.auth!.userId }, select: { phone: true } });
  res.json({
    phones: orgNotifyPhones(org),
    handoffAlertMinutes: org.handoffAlertMinutes,
    alerts: { handoff: org.alertHandoff !== false, meeting: org.alertMeeting !== false, task: org.alertTask !== false, order: org.alertOrder !== false },
    status: parseJson(org.handoffNotifyStatus, null),
    channels: chans.map((c) => ({ id: c.id, label: labels.get(c.id)?.label ?? 'WhatsApp', phone: c.displayPhone, connected: c.status === 'CONNECTED' })),
    suggestion: me?.phone ? normalizeBrPhone(me.phone) : null,
  });
}));

const testLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, limit: 10, standardHeaders: 'draft-7', legacyHeaders: false,
  keyGenerator: (req) => `hn:${req.auth?.orgId ?? req.ip}`,
  message: { error: 'Muitos testes seguidos. Aguarde alguns minutos.' },
});

/** "Enviar teste": manda uma mensagem de teste para os números (os da tela, ainda não salvos, ou os salvos). */
orgRouter.post('/handoff-notify/test', requireRole('OWNER', 'ADMIN'), testLimiter, ah(async (req, res) => {
  const orgId = orgOf(req);
  const body = z.object({ phones: notifyPhonesSchema.optional() }).parse(req.body ?? {});
  const org = await prisma.organization.findUniqueOrThrow({ where: { id: orgId } });
  const phones = body.phones ?? orgNotifyPhones(org);
  if (!phones.length) throw new HttpError(400, 'Informe pelo menos um número de aviso (+55 DDD número).');
  const text = ['✅ Teste do aviso de atendimento', `Organização: ${org.name}`, 'Você vai receber aqui os avisos ligados no Perfil (transferência para humano, reunião marcada, tarefa criada e pedido feito), com o contato e o link para abrir no app.', `App: ${conversationUrl('').replace(/\/inbox\/$/, '/inbox')}`].join('\n');
  const r = await deliverStaffAlert({
    orgId, kind: 'test', phones, text,
    email: { subject: 'Teste do aviso de atendimento (WhatsApp não entregue)', title: 'Teste do aviso de atendimento', lines: ['Este é o e-mail de reserva: o teste por WhatsApp não foi entregue.'] },
  });
  await audit(req, 'org.handoff_notify_test', { meta: { phones: phones.length, ok: r.ok } });
  res.json(r);
}));

export const auditRouter = Router();
auditRouter.get('/', requireRole('OWNER', 'ADMIN'), ah(async (req, res) => {
  const orgId = orgOf(req);
  const logs = await prisma.auditLog.findMany({ where: { orgId }, orderBy: { createdAt: 'desc' }, take: 200 });
  const users = await prisma.user.findMany({ where: { id: { in: logs.map((l) => l.userId).filter(Boolean) as string[] } }, select: { id: true, name: true, email: true } });
  res.json(logs.map((l) => ({ ...l, user: users.find((u) => u.id === l.userId) ?? null })));
}));
