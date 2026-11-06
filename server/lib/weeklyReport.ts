/**
 * Relatório semanal por e-mail ao Proprietário: toda segunda a partir das 8h (America/Sao_Paulo),
 * com os números da semana anterior (segunda 00:00 a domingo 23:59, Brasília):
 * conversas atendidas, respostas da IA, transferências para humano e leads qualificados.
 *
 * - Só roda com ENABLE_SCHEDULER ligado e e-mail configurado (Brevo ou SMTP); WEEKLY_REPORT_ENABLED=false desliga para todos.
 * - Sem migração: o envio da semana e a preferência do usuário ficam no registro de auditoria
 *   ('report.weekly.sent' por organização/semana; 'profile.weekly_report' { enabled } por usuário, o mais recente vale).
 * - Empresa sem nenhum movimento na semana não recebe (evita e-mail zerado).
 */
import { prisma } from '../db.js';
import { sendMail, smtpConfigured, weeklyReportMail } from './mailer.js';

const TZ = 'America/Sao_Paulo';
export const WEEKLY_SENT_ACTION = 'report.weekly.sent';
export const WEEKLY_PREF_ACTION = 'profile.weekly_report';

export const weeklyReportEnabled = (env: Record<string, string | undefined> = process.env) => (env.WEEKLY_REPORT_ENABLED ?? 'true').trim().toLowerCase() !== 'false';

/** Data (AAAA-MM-DD), dia da semana (0=domingo) e hora em Brasília. */
function spParts(d: Date) {
  const day = d.toLocaleDateString('en-CA', { timeZone: TZ });
  const hour = Number(d.toLocaleString('en-US', { timeZone: TZ, hour: 'numeric', hour12: false })) % 24;
  const dow = new Date(`${day}T12:00:00Z`).getUTCDay();
  return { day, hour, dow };
}
/** Meia-noite de Brasília do dia AAAA-MM-DD, em UTC (Brasil sem horário de verão: UTC−3; calculado pelo fuso). */
function spMidnight(day: string): Date {
  const base = new Date(`${day}T12:00:00Z`);
  const local = new Date(base.toLocaleString('en-US', { timeZone: TZ }));
  return new Date(new Date(`${day}T00:00:00Z`).getTime() - (local.getTime() - base.getTime()));
}
const addDays = (day: string, n: number) => new Date(new Date(`${day}T12:00:00Z`).getTime() + n * 86_400_000).toISOString().slice(0, 10);

/** Semana anterior à de `now` (segunda a domingo, Brasília): início/fim em UTC e a chave (segunda, AAAA-MM-DD). */
export function previousWeek(now = new Date()) {
  const { day, dow } = spParts(now);
  const thisMonday = addDays(day, -((dow + 6) % 7));
  const key = addDays(thisMonday, -7);
  const sunday = addDays(thisMonday, -1);
  const br = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}`;
  return { key, ini: spMidnight(key), fim: spMidnight(thisMonday), label: `${br(key)} a ${br(sunday)}/${sunday.slice(0, 4)}` };
}

/** Segunda-feira, a partir das 8h e antes das 21h (Brasília)? */
export function isSendWindow(now = new Date(), hour = 8) {
  const p = spParts(now);
  return p.dow === 1 && p.hour >= hour && p.hour < 21;
}

export async function weeklyNumbers(orgId: string, ini: Date, fim: Date) {
  const periodo = { gte: ini, lt: fim };
  const [conv, respostasIa, transferencias, leadsQualificados] = await Promise.all([
    prisma.message.groupBy({ by: ['conversationId'], where: { orgId, direction: 'OUT', status: { not: 'FAILED' }, createdAt: periodo } }),
    prisma.aiUsage.count({ where: { orgId, success: true, createdAt: periodo, AND: [{ conversationId: { not: null } }, { conversationId: { not: '' } }] } }),
    prisma.message.count({ where: { orgId, direction: 'INTERNAL', sender: 'system', type: 'note', body: { startsWith: 'Transferido para atendimento humano' }, createdAt: periodo } }),
    prisma.lead.count({ where: { orgId, qualifiedAt: periodo } }),
  ]);
  return { conversas: conv.length, respostasIa, transferencias, leadsQualificados };
}

/** Preferência do usuário (padrão: recebe). O registro mais recente de 'profile.weekly_report' vale. */
export async function weeklyReportPref(userId: string): Promise<boolean> {
  const last = await prisma.auditLog.findFirst({ where: { userId, action: WEEKLY_PREF_ACTION }, orderBy: { createdAt: 'desc' }, select: { meta: true } });
  if (!last) return true;
  try { return JSON.parse(last.meta).enabled !== false; } catch { return true; }
}

/** Tick do agendador (a cada 15 min): na janela de segunda, manda uma vez por organização/semana. */
export async function tickWeeklyReport(now = new Date()) {
  const result = { sent: 0, skipped: 0, failed: 0 };
  if (!weeklyReportEnabled() || !smtpConfigured() || !isSendWindow(now)) return result;
  const w = previousWeek(now);
  const sent = new Set((await prisma.auditLog.findMany({ where: { action: WEEKLY_SENT_ACTION, entityId: w.key }, select: { orgId: true } })).map((a) => a.orgId));
  const owners = await prisma.membership.findMany({ where: { role: 'OWNER' }, orderBy: { createdAt: 'asc' }, select: { orgId: true, userId: true, org: { select: { name: true } }, user: { select: { name: true, email: true, disabledAt: true } } } });
  const seen = new Set<string>();
  for (const m of owners) {
    if (seen.has(m.orgId)) continue; // um relatório por organização (o primeiro Proprietário)
    seen.add(m.orgId);
    if (sent.has(m.orgId) || m.user.disabledAt) { result.skipped++; continue; }
    try {
      if (!(await weeklyReportPref(m.userId))) { result.skipped++; continue; }
      const n = await weeklyNumbers(m.orgId, w.ini, w.fim);
      if (!n.conversas && !n.respostasIa && !n.transferencias && !n.leadsQualificados) { result.skipped++; continue; }
      // Marca antes de enviar: nunca manda duas vezes a mesma semana (se o envio falhar, fica registrado como falho).
      const mark = await prisma.auditLog.create({ data: { orgId: m.orgId, userId: m.userId, action: WEEKLY_SENT_ACTION, entity: 'weekly_report', entityId: w.key, meta: JSON.stringify({ ...n, ok: null }) } });
      const ok = await sendMail(weeklyReportMail({ to: m.user.email, name: m.user.name, orgName: m.org.name, periodLabel: w.label, ...n }));
      await prisma.auditLog.update({ where: { id: mark.id }, data: { meta: JSON.stringify({ ...n, ok }) } });
      if (ok) result.sent++; else result.failed++;
    } catch (e) {
      result.failed++;
      console.error('[relatorio-semanal]', { orgId: m.orgId, error: (e as Error).message });
    }
  }
  if (result.sent || result.failed) console.info('[relatorio-semanal]', { semana: w.key, ...result });
  return result;
}
