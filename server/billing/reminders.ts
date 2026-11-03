import { prisma } from '../db.js';
import { config } from '../config.js';
import { audit } from '../lib/audit.js';
import { appPath, renewalReminderMail, sendMail, type AppBrand } from '../lib/mailer.js';
import type { Product } from './service.js';

/**
 * Lembrete antes de vencer: o titular (OWNER) recebe UM e-mail RENEWAL_REMINDER_DAYS dias (padrão 5) antes do
 * fim do teste (TRIAL) ou do plano pago (ATIVA), por produto (MCKBOT e MCK Mensagens).
 *  - Nunca envia o mesmo lembrete duas vezes: linha única por (org, produto, aviso, vencimento) gravada ANTES do envio.
 *    Renovar muda o vencimento e libera o lembrete do novo período.
 *  - Horário de Brasília; não envia entre 21h e 8h (fica para a próxima rodada após as 8h).
 *  - O titular pode desligar no Perfil (padrão: ligado).
 *  - WhatsApp: não existe canal da plataforma (só os canais de cada cliente), então só e-mail.
 *  - Auditoria/log sem dados pessoais (só ids, produto e resultado).
 * Não altera cobrança: tolerância após o vencimento continua 0 (corta na hora).
 */
export const TZ = 'America/Sao_Paulo';
const DAY = 24 * 60 * 60 * 1000;
export const QUIET_START_HOUR = 21;
export const QUIET_END_HOUR = 8;
export const MAX_ATTEMPTS = 3;
const RETRY_AFTER_MS = 60 * 60 * 1000;

export const reminderDays = () => config.RENEWAL_REMINDER_DAYS;
export const reminderKind = (days = reminderDays()) => `D${days}`;

const BRAND: Record<Product, AppBrand> = { MCKBOT: 'mckbot', MCKMENSAGEM: 'mensagem' };
const RENEW_PATH: Record<Product, string> = { MCKBOT: '/plano', MCKMENSAGEM: '/assinatura' };
/** Link direto de renovação: /plano (MCKBOT) e /mensagem/assinatura (MCK Mensagens). */
export const renewUrl = (product: Product) => appPath(BRAND[product], RENEW_PATH[product]);

function spParts(d: Date) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d);
  const g = (t: string) => parts.find((p) => p.type === t)!.value;
  return { y: g('year'), m: g('month'), d: g('day'), h: Number(g('hour')), min: g('minute') };
}
export const spHour = (d: Date) => spParts(d).h;
/** Entre 21h e 8h (horário de Brasília) nada é enviado. */
export const isQuietHours = (d: Date) => { const h = spHour(d); return h >= QUIET_START_HOUR || h < QUIET_END_HOUR; };
export function spDateLabel(d: Date) { const p = spParts(d); return `${p.d}/${p.m}/${p.y} às ${p.h.toString().padStart(2, '0')}:${p.min}`; }
/** Diferença em dias de calendário (Brasília) entre agora e o vencimento: "hoje", "amanhã", "em N dias". */
export function whenLabel(validUntil: Date, now: Date) {
  const day = (x: Date) => { const p = spParts(x); return Date.UTC(Number(p.y), Number(p.m) - 1, Number(p.d)); };
  const n = Math.round((day(validUntil) - day(now)) / DAY);
  return n <= 0 ? 'hoje' : n === 1 ? 'amanhã' : `em ${n} dias`;
}
/** Está na janela do lembrete? (falta mais que 0 e no máximo N dias). */
export const inReminderWindow = (validUntil: Date, now: Date, days = reminderDays()) => {
  const left = validUntil.getTime() - now.getTime();
  return left > 0 && left <= days * DAY;
};

/** Grava a marca ANTES de enviar. Devolve a linha reservada ou null (já enviado / em envio / sem novas tentativas). */
async function claim(orgId: string, product: string, kind: string, validUntil: Date, now: Date) {
  try {
    return await prisma.renewalReminder.create({ data: { orgId, product, kind, validUntil, status: 'ENVIANDO', attempts: 1 } });
  } catch (e: any) {
    if (e?.code !== 'P2002') throw e;
  }
  const ex = await prisma.renewalReminder.findUnique({ where: { orgId_product_kind_validUntil: { orgId, product, kind, validUntil } } });
  // Só um envio que FALHOU (ex.: Brevo fora do ar) é tentado de novo, no máximo 3 vezes e com 1 h de intervalo.
  if (!ex || ex.status !== 'FALHOU' || ex.attempts >= MAX_ATTEMPTS || now.getTime() - ex.updatedAt.getTime() < RETRY_AFTER_MS) return null;
  const r = await prisma.renewalReminder.updateMany({ where: { id: ex.id, status: 'FALHOU', attempts: ex.attempts }, data: { status: 'ENVIANDO', attempts: ex.attempts + 1 } });
  return r.count === 1 ? { ...ex, attempts: ex.attempts + 1 } : null;
}

export async function tickRenewalReminders(now = new Date()) {
  const result = { sent: 0, failed: 0, skipped: 0, quiet: false };
  if (isQuietHours(now)) { result.quiet = true; return result; }
  const days = reminderDays();
  const kind = reminderKind(days);
  const subs = await prisma.subscription.findMany({
    where: { status: { in: ['TRIAL', 'ATIVA'] }, product: { in: ['MCKBOT', 'MCKMENSAGEM'] }, validUntil: { gt: now, lte: new Date(now.getTime() + days * DAY) } },
    orderBy: { validUntil: 'asc' }, take: 500,
  });
  for (const sub of subs) {
    if (!inReminderWindow(sub.validUntil, now, days)) continue;
    const owner = await prisma.membership.findFirst({ where: { orgId: sub.orgId, role: 'OWNER' }, orderBy: { createdAt: 'asc' }, include: { user: true, org: true } });
    if (!owner || owner.user.disabledAt || !owner.user.renewalReminders) { result.skipped++; continue; }
    const row = await claim(sub.orgId, sub.product, kind, sub.validUntil, now);
    if (!row) { result.skipped++; continue; }
    const product = sub.product as Product;
    const brand = BRAND[product];
    const ok = await sendMail(renewalReminderMail({
      to: owner.user.email, name: owner.user.name, orgName: owner.org.name, app: brand, trial: sub.status === 'TRIAL',
      whenLabel: whenLabel(sub.validUntil, now), dateLabel: spDateLabel(sub.validUntil), renewUrl: renewUrl(product), profileUrl: appPath('mckbot', '/perfil'),
    }));
    await prisma.renewalReminder.update({ where: { id: row.id }, data: ok ? { status: 'ENVIADO', sentAt: now, lastError: null } : { status: 'FALHOU', lastError: 'envio de e-mail falhou' } });
    await audit(null, ok ? 'billing.renewal_reminder.sent' : 'billing.renewal_reminder.failed', {
      orgId: sub.orgId, userId: null, entity: 'Subscription', entityId: sub.id,
      meta: { product, kind, channel: 'EMAIL', status: sub.status, attempt: row.attempts },
    }).catch(() => undefined);
    if (ok) result.sent++; else { result.failed++; console.error('[lembrete-vencimento] falha no envio', sub.orgId, product, kind); }
  }
  return result;
}
