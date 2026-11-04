import type { Conversation } from '@prisma/client';
import { prisma } from '../db.js';
import { decryptOrNull } from '../lib/crypto.js';
import { parseJson } from '../lib/json.js';
import { appUrl, handoffMail, sendMail } from '../lib/mailer.js';
import { sendCloudMessage } from './cloudClient.js';
import { qrManager } from './qr/manager.js';
import { channelInfo } from './channelLabel.js';

/**
 * Aviso de atendimento humano para os números da equipe ("Números de aviso de atendimento" no Perfil).
 *
 * - Sai NO MOMENTO da transferência (qualquer origem: pedido do cliente à IA, bloco do fluxo, qualificação…),
 *   para todos os números configurados; o lembrete "aguardando há N min" continua no tick (handoffAlerts.ts).
 * - Envia por um WhatsApp conectado da organização que não seja o próprio número de destino
 *   (o WhatsApp não entrega notificação de mensagem para si mesmo).
 * - Falhou em todos os números (ou só havia o número do próprio canal)? E-mail (Brevo) para Proprietário/Admin,
 *   nota interna na conversa e status no Perfil. O aviso imediato é repetido até 3 vezes pelo tick.
 */

export const MAX_NOTIFY_PHONES = 5;
export const MAX_NOTIFY_TRIES = 3;

export interface NotifyResult { phone: string; ok: boolean; self?: boolean; via?: string; error?: string }
export interface DeliveryReport { ok: boolean; results: NotifyResult[]; emailed: number; detail: string }
export interface NotifyStatus { at: string; ok: boolean; detail: string; kind: 'handoff' | 'reminder' | 'test' | 'meeting' | 'task' | 'order' | 'ai_failure' }

const digits = (s: string | null | undefined) => String(s ?? '').replace(/\D/g, '');

/** Mesmo telefone? No Brasil ignora o 9 extra (contas antigas do WhatsApp são registradas sem ele). */
export function samePhone(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = digits(a), y = digits(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const br = (d: string) => (d.startsWith('55') && (d.length === 12 || d.length === 13) ? d.slice(2, 4) + d.slice(-8) : null);
  const bx = br(x), by = br(y);
  return !!bx && bx === by;
}

/** Números de aviso da organização: a lista nova; sem ela, o "WhatsApp reserva" antigo (compatível). */
export function orgNotifyPhones(org: { handoffNotifyPhones?: string | null; backupPhone?: string | null }): string[] {
  const list = parseJson<string[] | null>(org.handoffNotifyPhones ?? null, null);
  if (Array.isArray(list)) return list.filter((p) => typeof p === 'string' && p.trim());
  return org.backupPhone ? [org.backupPhone] : [];
}

/** Link da conversa no app (Inbox do MCKBOT). */
export const conversationUrl = (conversationId: string) => `${appUrl()}/inbox/${conversationId}`;

export async function saveNotifyStatus(orgId: string, st: Omit<NotifyStatus, 'at'>, now = new Date()) {
  const v: NotifyStatus = { at: now.toISOString(), ...st, detail: st.detail.slice(0, 500) };
  await prisma.organization.update({ where: { id: orgId }, data: { handoffNotifyStatus: JSON.stringify(v) } }).catch(() => undefined);
}

/** Canais que podem enviar, o da conversa primeiro. */
async function candidateChannels(orgId: string, preferredChannelId?: string | null) {
  const chans = await prisma.channel.findMany({ where: { orgId }, orderBy: { createdAt: 'asc' } });
  return chans.sort((a, b) => (a.id === preferredChannelId ? -1 : b.id === preferredChannelId ? 1 : 0));
}

/** Envia o texto para um número da equipe por um canal que não seja ele mesmo. Nunca lança. */
export async function sendToStaffNumber(orgId: string, preferredChannelId: string | null | undefined, phone: string, text: string): Promise<NotifyResult> {
  const to = digits(phone);
  const chans = await candidateChannels(orgId, preferredChannelId);
  if (!chans.length) return { phone, ok: false, error: 'Nenhum WhatsApp conectado na organização' };
  const others = chans.filter((c) => !samePhone(c.displayPhone, to));
  if (!others.length) {
    return { phone, ok: false, self: true, error: 'Este é o número do próprio WhatsApp conectado: o WhatsApp não envia notificação para ele mesmo. Use outro número (ex.: seu celular pessoal).' };
  }
  const errors: string[] = [];
  for (const ch of others) {
    const label = (await channelInfo(orgId, ch.id).catch(() => null))?.label ?? ch.name;
    try {
      if (ch.provider === 'whatsapp_qr') {
        if (!qrManager.canSend(ch.id)) { errors.push(`${label}: WhatsApp (QR) não conectado`); continue; }
        const num = await qrManager.resolveNumber(ch.id, to);
        if (!num) return { phone, ok: false, error: 'Este número não tem WhatsApp' };
        await qrManager.send(ch.id, num, { type: 'text', text });
      } else {
        const accessToken = decryptOrNull(ch.accessTokenEnc);
        if (ch.status !== 'CONNECTED' || !ch.phoneNumberId || !accessToken) { errors.push(`${label}: canal não conectado`); continue; }
        await sendCloudMessage({ phoneNumberId: ch.phoneNumberId, accessToken }, to, { type: 'text', text });
      }
      return { phone, ok: true, via: label };
    } catch (e) {
      errors.push(`${label}: ${(e as Error).message}`.slice(0, 300));
    }
  }
  return { phone, ok: false, error: errors.join(' | ') || 'Falha ao enviar' };
}

/** Proprietário e Administradores ativos (destino do e-mail de reserva). */
async function ownerAdminEmails(orgId: string) {
  const ms = await prisma.membership.findMany({ where: { orgId, role: { in: ['OWNER', 'ADMIN'] }, user: { disabledAt: null } }, include: { user: { select: { email: true, name: true } } } });
  return ms.map((m) => m.user);
}

/**
 * Entrega um aviso para a equipe: WhatsApp para cada número; se nenhum recebeu, e-mail para Proprietário/Admin.
 * Grava o resultado no status do Perfil. Nunca lança.
 */
export async function deliverStaffAlert(args: {
  orgId: string; channelId?: string | null; text: string; kind: NotifyStatus['kind'];
  email?: { subject: string; title: string; lines: string[]; url?: string };
  phones?: string[];
  /** Manda o e-mail para Proprietário/Admin mesmo quando o WhatsApp foi entregue (ex.: falha da IA). */
  alwaysEmail?: boolean;
}): Promise<DeliveryReport> {
  const org = await prisma.organization.findUnique({ where: { id: args.orgId } });
  if (!org) return { ok: false, results: [], emailed: 0, detail: 'Organização não encontrada' };
  const phones = (args.phones ?? orgNotifyPhones(org)).slice(0, MAX_NOTIFY_PHONES);
  if (!phones.length && args.alwaysEmail && args.email) {
    let emailed = 0;
    for (const u of await ownerAdminEmails(args.orgId)) {
      if (await sendMail(handoffMail({ to: u.email, name: u.name, subject: args.email.subject, title: args.email.title, lines: args.email.lines, url: args.email.url })).catch(() => false)) emailed++;
    }
    return { ok: emailed > 0, results: [], emailed, detail: emailed ? `Sem número de aviso; enviado por e-mail para ${emailed} Proprietário/Admin` : 'Sem número de aviso e nenhum e-mail enviado' };
  }
  if (!phones.length) {
    const r = { ok: false, results: [], emailed: 0, detail: 'Nenhum número de aviso configurado (Perfil › Organização › Números de aviso (WhatsApp))' };
    await saveNotifyStatus(args.orgId, { ok: false, detail: r.detail, kind: args.kind });
    return r;
  }
  const results: NotifyResult[] = [];
  for (const p of phones) results.push(await sendToStaffNumber(args.orgId, args.channelId, p, args.text));
  const okCount = results.filter((r) => r.ok).length;
  let emailed = 0;
  if ((!okCount || args.alwaysEmail) && args.email) {
    for (const u of await ownerAdminEmails(args.orgId)) {
      const sent = await sendMail(handoffMail({ to: u.email, name: u.name, subject: args.email.subject, title: args.email.title, lines: okCount ? args.email.lines : [...args.email.lines, `O aviso por WhatsApp não foi entregue: ${results.map((r) => `${r.phone} — ${r.error}`).join('; ')}`], url: args.email.url })).catch(() => false);
      if (sent) emailed++;
    }
  }
  const failed = results.filter((r) => !r.ok);
  const detail = okCount
    ? `Enviado para ${results.filter((r) => r.ok).map((r) => r.phone).join(', ')}${failed.length ? `; falhou: ${failed.map((r) => `${r.phone} (${r.error})`).join('; ')}` : ''}`
    : `Falhou: ${failed.map((r) => `${r.phone} (${r.error})`).join('; ')}${emailed ? `; enviado por e-mail para ${emailed} Proprietário/Admin` : ''}`;
  const detailFull = okCount && emailed ? `${detail}; e-mail para ${emailed} Proprietário/Admin` : detail;
  await saveNotifyStatus(args.orgId, { ok: okCount > 0, detail: detailFull, kind: args.kind });
  if (!okCount) console.error('[aviso-atendimento] falhou', { orgId: args.orgId, kind: args.kind, detail });
  return { ok: okCount > 0, results, emailed, detail: detailFull };
}

/** Texto do aviso da transferência. */
export function handoffAlertText(o: { who: string; reason: string; channel: string; url: string; reminderMin?: number }): string {
  return [
    o.reminderMin ? `⚠️ Atendimento aguardando há ${o.reminderMin} min` : '🔔 Novo atendimento humano',
    `Contato: ${o.who}`,
    `Motivo: ${o.reason}`,
    o.channel ? `WhatsApp: ${o.channel}` : '',
    `Abrir conversa: ${o.url}`,
  ].filter(Boolean).join('\n');
}

async function describeConv(conv: Pick<Conversation, 'id' | 'orgId' | 'contactId' | 'channelId'>) {
  const contact = await prisma.contact.findFirst({ where: { id: conv.contactId, orgId: conv.orgId } });
  const who = contact ? (contact.name ? `${contact.name} (${contact.phone})` : contact.phone) : 'Contato';
  const ch = await channelInfo(conv.orgId, conv.channelId).catch(() => null);
  return { who, channel: ch?.via ?? '', url: conversationUrl(conv.id) };
}

async function note(conv: Pick<Conversation, 'id' | 'orgId'>, body: string) {
  await prisma.message.create({ data: { orgId: conv.orgId, conversationId: conv.id, direction: 'INTERNAL', sender: 'system', type: 'note', body, status: 'NOTE' } }).catch(() => undefined);
}

/** Último motivo de transferência registrado na conversa (para as novas tentativas do tick). */
async function lastHandoffReason(conversationId: string): Promise<string> {
  const n = await prisma.message.findFirst({ where: { conversationId, direction: 'INTERNAL', body: { startsWith: 'Transferido para atendimento humano:' } }, orderBy: { createdAt: 'desc' } });
  return n?.body?.replace('Transferido para atendimento humano:', '').split('\n')[0].trim() || 'Transferido para atendimento humano';
}

/**
 * Aviso imediato da transferência. Claim atômico (um aviso por espera, vale entre instâncias);
 * se nenhum número recebeu, libera o claim para o tick tentar de novo (até MAX_NOTIFY_TRIES).
 */
export async function notifyHandoffNow(conv: Pick<Conversation, 'id' | 'orgId' | 'contactId' | 'channelId'>, reason?: string, now = new Date()): Promise<DeliveryReport | null> {
  const org = await prisma.organization.findUnique({ where: { id: conv.orgId } });
  if (!org) return null;
  // "Transferência para humano" desligada no Perfil › Organização › Números de aviso.
  if (org.alertHandoff === false) return null;
  if (!orgNotifyPhones(org).length) {
    await saveNotifyStatus(conv.orgId, { ok: false, detail: 'Transferência sem aviso: nenhum número de aviso configurado (Perfil › Organização)', kind: 'handoff' }, now);
    return null;
  }
  const claim = await prisma.conversation.updateMany({ where: { id: conv.id, handoffNotifyAt: null, handoffNotifyTries: { lt: MAX_NOTIFY_TRIES } }, data: { handoffNotifyAt: now, handoffNotifyTries: { increment: 1 } } });
  if (claim.count !== 1) return null;
  const why = reason ?? (await lastHandoffReason(conv.id));
  const d = await describeConv(conv);
  const r = await deliverStaffAlert({
    orgId: conv.orgId, channelId: conv.channelId, kind: 'handoff',
    text: handoffAlertText({ ...d, reason: why }),
    email: { subject: `Novo atendimento humano: ${d.who}`, title: 'Um contato foi transferido para atendimento humano', lines: [`Contato: ${d.who}`, `Motivo: ${why}`, d.channel ? `WhatsApp: ${d.channel}` : ''].filter(Boolean), url: d.url },
  });
  if (r.ok) {
    await note(conv, `Aviso de atendimento enviado por WhatsApp: ${r.results.filter((x) => x.ok).map((x) => x.phone).join(', ')}.`);
  } else {
    const c = await prisma.conversation.findUnique({ where: { id: conv.id }, select: { handoffNotifyTries: true } });
    const willRetry = (c?.handoffNotifyTries ?? MAX_NOTIFY_TRIES) < MAX_NOTIFY_TRIES;
    if (willRetry) await prisma.conversation.updateMany({ where: { id: conv.id, handoffNotifyAt: now }, data: { handoffNotifyAt: null } });
    await note(conv, `⚠️ Aviso de atendimento NÃO entregue por WhatsApp: ${r.detail}.${willRetry ? ' Nova tentativa automática em 2 min.' : ''}`);
  }
  return r;
}

// Avisos em andamento (a transferência não espera o envio; os testes aguardam por aqui).
const pending = new Set<Promise<unknown>>();
export function notifyHandoffInBackground(conv: Pick<Conversation, 'id' | 'orgId' | 'contactId' | 'channelId'>, reason: string) {
  const p = notifyHandoffNow(conv, reason).catch((e) => console.error('[aviso-atendimento] erro inesperado', (e as Error).message));
  pending.add(p);
  p.finally(() => pending.delete(p));
}
export async function flushHandoffNotifies() {
  while (pending.size) await Promise.all([...pending]);
}
