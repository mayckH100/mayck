import type { Channel } from '@prisma/client';
import { DEFAULT_PRICES } from '../billing/service.js';
import { prisma } from '../db.js';
import { sendMail, waDownMail, waDownDigestMail, type AppBrand } from '../lib/mailer.js';
import { channelLabels } from './channelLabel.js';
import { superAdminEmails } from '../auth/superadmin.js';

/**
 * Alerta de WhatsApp desconectado (MCKBOT e MCK Mensagens), QR code (Baileys) e API oficial.
 *
 * Um monitor (a cada minuto) lê o status dos canais no banco:
 *  - Só canais "armados" alertam: o monitor já os viu CONNECTED (waUpSeenAt). Canal novo que nunca conectou
 *    e desconexão feita de propósito pelo dono (botão Desconectar/Excluir/trocar credenciais) não alertam.
 *  - A queda só conta depois de DOWN_GRACE_MS (5 min) seguidos fora do ar: reconexões rápidas são ignoradas.
 *  - Reinício/deploy: nos primeiros BOOT_GRACE_MS o monitor não marca nada, e um episódio iniciado antes
 *    deste processo subir recomeça a contagem (só conta o tempo que este processo viu fora do ar).
 *  - Um alerta por episódio (claim atômico no banco, vale entre instâncias) e um único lembrete após 24 h.
 *  - Ao voltar depois de um alerta: waBackAt (nota "voltou a conectar" só no app, sem e-mail).
 * Logs sem dados pessoais: só ids de canal e contagens.
 */

export const DOWN_GRACE_MS = 5 * 60_000;
export const REMINDER_MS = 24 * 3600_000;
export const BOOT_GRACE_MS = 3 * 60_000;
export const DIGEST_MIN_DOWN_MS = 3600_000;
export const DIGEST_HOUR_SP = 8;
const UP_REFRESH_MS = 10 * 60_000;

const processBootAt = Date.now();

type ChannelState = Pick<Channel, 'status' | 'waUpSeenAt' | 'waDownSince' | 'waDownAlertAt' | 'waDownReminderAt' | 'waBackAt'>;
export type DownAction = 'alert' | 'reminder' | 'back' | null;
export interface DownDecision { patch: Partial<ChannelState>; action: DownAction }

export const isUp = (status: string) => status === 'CONNECTED';

/** Regra pura (testável): o que fazer com um canal neste instante. */
export function decideDown(ch: ChannelState, now: Date, bootAt: Date): DownDecision {
  const t = now.getTime();
  if (isUp(ch.status)) {
    const patch: Partial<ChannelState> = {};
    if (!ch.waUpSeenAt || t - ch.waUpSeenAt.getTime() >= UP_REFRESH_MS) patch.waUpSeenAt = now;
    let action: DownAction = null;
    if (ch.waDownSince || ch.waDownAlertAt) {
      patch.waDownSince = null; patch.waDownAlertAt = null; patch.waDownReminderAt = null;
      if (ch.waDownAlertAt) { patch.waBackAt = now; action = 'back'; }
    }
    return { patch, action };
  }
  // Fora do ar. Nunca visto conectado (ou desarmado de propósito): nada a fazer.
  if (!ch.waUpSeenAt) return { patch: {}, action: null };
  // Início do episódio, ou episódio herdado de antes deste processo subir (reinício/deploy) ainda sem alerta.
  if (!ch.waDownSince || (!ch.waDownAlertAt && ch.waDownSince.getTime() < bootAt.getTime())) {
    return { patch: { waDownSince: now }, action: null };
  }
  if (!ch.waDownAlertAt) {
    return t - ch.waDownSince.getTime() >= DOWN_GRACE_MS ? { patch: { waDownAlertAt: now, waBackAt: null }, action: 'alert' } : { patch: {}, action: null };
  }
  if (!ch.waDownReminderAt && t - ch.waDownAlertAt.getTime() >= REMINDER_MS) return { patch: { waDownReminderAt: now }, action: 'reminder' };
  return { patch: {}, action: null };
}

/** Campos que desarmam o alerta (desconexão/troca feita de propósito pelo dono). */
export const DISARM_DOWN_ALERT = { waUpSeenAt: null, waDownSince: null, waDownAlertAt: null, waDownReminderAt: null, waBackAt: null } as const;

/** Produto usado no e-mail: MCK Mensagens só quando a organização não tem o MCKBOT. */
async function brandForOrg(orgId: string): Promise<AppBrand> {
  const subs = await prisma.subscription.findMany({ where: { orgId }, select: { product: true } });
  const has = (p: string) => subs.some((s) => s.product === p);
  return !has('MCKBOT') && has('MCKMENSAGEM') ? 'mensagem' : 'mckbot';
}

/** Destinatários: Proprietário e Administradores ativos que não desligaram o e-mail no Perfil. */
export async function downAlertRecipients(orgId: string) {
  const ms = await prisma.membership.findMany({
    where: { orgId, role: { in: ['OWNER', 'ADMIN'] }, user: { disabledAt: null, waDownEmail: true } },
    include: { user: { select: { email: true, name: true } } },
  });
  return ms.map((m) => m.user);
}

async function notify(ch: Channel, kind: 'alert' | 'reminder', since: Date) {
  const [labels, org, brand, to] = await Promise.all([
    channelLabels(ch.orgId),
    prisma.organization.findUnique({ where: { id: ch.orgId }, select: { name: true } }),
    brandForOrg(ch.orgId),
    downAlertRecipients(ch.orgId),
  ]);
  const label = labels.get(ch.id)?.label ?? ch.name;
  let sent = 0;
  for (const u of to) {
    if (await sendMail(waDownMail({ to: u.email, name: u.name, app: brand, channel: label, orgName: org?.name ?? '', since, reminder: kind === 'reminder' }))) sent++;
  }
  return sent;
}

/** Um ciclo do monitor. Devolve quantos alertas/lembretes foram disparados (para testes e log). */
export async function tickDownAlerts(now = new Date(), opts: { bootAt?: Date } = {}) {
  const bootAt = opts.bootAt ?? new Date(processBootAt);
  if (now.getTime() - bootAt.getTime() < BOOT_GRACE_MS) return { alerts: 0, reminders: 0, back: 0 };
  const channels = await prisma.channel.findMany({
    where: { OR: [{ status: 'CONNECTED' }, { waUpSeenAt: { not: null } }] },
    orderBy: { id: 'asc' }, take: 2000,
  });
  const out = { alerts: 0, reminders: 0, back: 0 };
  for (const ch of channels) {
    const d = decideDown(ch, now, bootAt);
    if (!Object.keys(d.patch).length) continue;
    // Claim atômico: só grava se o estado ainda é o que lemos (outra instância pode ter agido).
    const claim = await prisma.channel.updateMany({
      where: { id: ch.id, status: ch.status, waDownSince: ch.waDownSince, waDownAlertAt: ch.waDownAlertAt, waDownReminderAt: ch.waDownReminderAt },
      data: d.patch,
    });
    if (claim.count !== 1 || !d.action) continue;
    if (d.action === 'back') { out.back++; continue; }
    try {
      const n = await notify(ch, d.action, ch.waDownSince ?? now);
      if (d.action === 'alert') out.alerts++; else out.reminders++;
      console.info(`[whatsapp-alerta] ${d.action === 'alert' ? 'alerta' : 'lembrete'} do canal ${ch.id}: ${n} e-mail(s)`);
    } catch (e) {
      console.error(`[whatsapp-alerta] falha ao avisar o canal ${ch.id}:`, (e as Error).message);
    }
  }
  return out;
}

const dayKeySP = (d: Date) => d.toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
const hourSP = (d: Date) => Number(d.toLocaleString('en-US', { timeZone: 'America/Sao_Paulo', hour: 'numeric', hour12: false })) % 24;

/** Canais fora do ar há mais de 1 h (episódios do monitor), de todas as organizações. */
export async function channelsDownOverHour(now = new Date()) {
  const rows = await prisma.channel.findMany({
    where: { status: { not: 'CONNECTED' }, waDownSince: { lte: new Date(now.getTime() - DIGEST_MIN_DOWN_MS) } },
    orderBy: { waDownSince: 'asc' }, take: 500,
  });
  const orgIds = [...new Set(rows.map((r) => r.orgId))];
  const orgs = await prisma.organization.findMany({ where: { id: { in: orgIds } }, select: { id: true, name: true } });
  const out: { orgName: string; channel: string; since: Date }[] = [];
  for (const orgId of orgIds) {
    const labels = await channelLabels(orgId);
    for (const r of rows.filter((x) => x.orgId === orgId)) {
      out.push({ orgName: orgs.find((o) => o.id === orgId)?.name ?? '—', channel: labels.get(r.id)?.label ?? r.name, since: r.waDownSince! });
    }
  }
  return out;
}

/** Resumo diário para SUPERADMIN_EMAILS (a partir das 8h de Brasília, uma vez por dia; nada é enviado se não houver canal fora do ar). */
export async function maybeDownDigest(now = new Date()) {
  if (hourSP(now) < DIGEST_HOUR_SP) return false;
  const to = superAdminEmails();
  if (!to.length) return false;
  const today = dayKeySP(now);
  const row = await prisma.platformSettings.findUnique({ where: { id: 'default' } })
    ?? await prisma.platformSettings.create({ data: { id: 'default', pricesJson: JSON.stringify(DEFAULT_PRICES) } }).catch(() => prisma.platformSettings.findUniqueOrThrow({ where: { id: 'default' } }));
  if (row.waDigestDay === today) return false;
  const claim = await prisma.platformSettings.updateMany({ where: { id: 'default', waDigestDay: row.waDigestDay }, data: { waDigestDay: today } });
  if (claim.count !== 1) return false;
  const list = await channelsDownOverHour(now);
  if (!list.length) return false;
  for (const email of to) await sendMail(waDownDigestMail({ to: email, items: list, now }));
  console.info(`[whatsapp-alerta] resumo diário: ${list.length} canal(is) fora do ar, ${to.length} destinatário(s)`);
  return true;
}
