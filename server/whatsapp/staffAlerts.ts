import { prisma } from '../db.js';
import { appUrl } from '../lib/mailer.js';
import { safeTz, zonedParts } from '../agenda/time.js';
import { deliverStaffAlert, orgNotifyPhones, samePhone, conversationUrl, type DeliveryReport } from './handoffNotify.js';
import { channelInfo } from './channelLabel.js';

/**
 * Avisos de eventos para os "Números de aviso (WhatsApp)" do Perfil › Organização (os mesmos da transferência
 * para humano): reunião marcada, tarefa criada e pedido feito. Cada tipo pode ser desligado no Perfil
 * (Organization.alertHandoff/alertMeeting/alertTask/alertOrder, todos ligados por padrão).
 *
 * - Sai em segundo plano (não atrasa a resposta ao cliente) e nunca lança.
 * - Um aviso por evento (chave tipo:id; a criação chama uma vez só).
 * - Não avisa o que o próprio Proprietário criou manualmente no app (ele já sabe); IA, fluxo, cliente e
 *   demais membros da equipe sempre avisam.
 * - Números que já receberam o aviso da Agenda/Pedidos (dono e equipe da Agenda) não recebem de novo.
 * - Envia por um WhatsApp conectado da organização diferente do número de destino (deliverStaffAlert);
 *   se nenhum número recebeu, e-mail para Proprietário/Admin.
 */

export type StaffEvent = 'handoff' | 'meeting' | 'task' | 'order' | 'ai_failure';

type OrgFlags = { alertHandoff?: boolean | null; alertMeeting?: boolean | null; alertTask?: boolean | null; alertOrder?: boolean | null; alertAiFailure?: boolean | null };

/** O tipo de aviso está ligado? (coluna ausente/nula = ligado). */
export function alertEnabled(org: OrgFlags, ev: StaffEvent): boolean {
  const v = { handoff: org.alertHandoff, meeting: org.alertMeeting, task: org.alertTask, order: org.alertOrder, ai_failure: org.alertAiFailure }[ev];
  return v !== false;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** "05/11/2026 às 14:00 (horário de Brasília)" no fuso da organização. */
export function formatWhen(d: Date, tz?: string | null): string {
  const z = safeTz(tz ?? undefined);
  const p = zonedParts(d, z);
  const zone = z === 'America/Sao_Paulo' ? 'horário de Brasília' : `fuso ${z}`;
  return `${pad(p.day)}/${pad(p.month)}/${p.year} às ${pad(p.hour)}:${pad(p.minute)} (${zone})`;
}

export const brl = (cents: number) => (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }).replace(/\u00a0/g, ' ');

/** Texto do aviso de reunião/tarefa. */
export function appointmentAlertText(o: { kind: 'MEETING' | 'TASK' | string; title: string; who: string | null; when: string; by?: string | null; via?: string | null; url: string }): string {
  const task = o.kind === 'TASK';
  return [
    task ? '📝 Nova tarefa' : '📅 Nova reunião marcada',
    `${task ? 'Tarefa' : 'Assunto'}: ${o.title}`,
    o.who ? `Contato: ${o.who}` : '',
    `${task ? 'Para' : 'Quando'}: ${o.when}`,
    o.by ? `${task ? 'Criada' : 'Marcada'} por: ${o.by}` : '',
    o.via ? `WhatsApp: ${o.via}` : '',
    `Abrir: ${o.url}`,
  ].filter(Boolean).join('\n');
}

/** Texto do aviso de pedido (WhatsApp/IA ou MCK ERP). */
export function orderAlertText(o: { title: string; who: string | null; items: string; total?: string | null; extra?: string | null; by?: string | null; via?: string | null; url: string }): string {
  return [
    o.title,
    o.who ? `Contato: ${o.who}` : '',
    o.items ? `Itens: ${o.items.length > 400 ? `${o.items.slice(0, 397)}...` : o.items}` : '',
    o.total ? `Total: ${o.total}` : '',
    o.extra ?? '',
    o.by ? `Registrado por: ${o.by}` : '',
    o.via ? `WhatsApp: ${o.via}` : '',
    `Abrir: ${o.url}`,
  ].filter(Boolean).join('\n');
}

/** O usuário é Proprietário desta organização? (para não avisar o dono do que ele mesmo criou no app). */
export async function isOwner(orgId: string, userId: string | null | undefined): Promise<boolean> {
  if (!userId) return false;
  const m = await prisma.membership.findFirst({ where: { orgId, userId, role: 'OWNER' }, select: { id: true } }).catch(() => null);
  return !!m;
}

export async function contactLabel(orgId: string, contactId: string | null | undefined): Promise<string | null> {
  if (!contactId) return null;
  const c = await prisma.contact.findFirst({ where: { id: contactId, orgId }, select: { name: true, phone: true } }).catch(() => null);
  if (!c) return null;
  return c.name ? `${c.name} (${c.phone})` : c.phone;
}

export async function userName(userId: string | null | undefined): Promise<string | null> {
  if (!userId) return null;
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { name: true } }).catch(() => null);
  return u?.name ?? null;
}

export const appLink = (path: string) => `${appUrl()}${path}`;
export const linkFor = (conversationId: string | null | undefined, fallbackPath: string) => (conversationId ? conversationUrl(conversationId) : appLink(fallbackPath));

const LABEL: Record<StaffEvent, string> = { handoff: 'Transferência', meeting: 'Nova reunião', task: 'Nova tarefa', order: 'Novo pedido', ai_failure: 'Falha da IA' };

// Um aviso por evento (mesmo processo); limpa quando cresce demais.
const sentKeys = new Set<string>();

export interface StaffEventArgs {
  orgId: string;
  event: StaffEvent;
  /** Identificador único do evento (ex.: id do compromisso/pedido). */
  key: string;
  /** Monta o texto (só é chamado se houver número para avisar). */
  text: () => Promise<string> | string;
  channelId?: string | null;
  /** Usuário que criou (se for o Proprietário, manual no app, não avisa). */
  createdByUserId?: string | null;
  manual?: boolean;
  /** Números que já receberam o aviso por outro caminho (Agenda/Pedidos). */
  skipPhones?: string[];
  emailUrl?: string;
}

/** Avisa os números de aviso sobre um evento. Retorna null quando nada foi enviado (desligado, sem número, duplicado, dono). Nunca lança. */
export async function notifyStaffEvent(a: StaffEventArgs): Promise<DeliveryReport | null> {
  try {
    const k = `${a.event}:${a.key}`;
    if (sentKeys.has(k)) return null;
    if (sentKeys.size > 5000) sentKeys.clear();
    sentKeys.add(k);
    const org = await prisma.organization.findUnique({ where: { id: a.orgId } });
    if (!org || !alertEnabled(org, a.event)) return null;
    const all = orgNotifyPhones(org);
    if (!all.length) return null;
    if (a.manual !== false && a.createdByUserId && (await isOwner(a.orgId, a.createdByUserId))) return null;
    const skip = a.skipPhones ?? [];
    const phones = all.filter((p) => !skip.some((s) => samePhone(s, p)));
    if (!phones.length) return null;
    const text = await a.text();
    const [head, ...rest] = text.split('\n');
    return await deliverStaffAlert({
      orgId: a.orgId, channelId: a.channelId ?? null, kind: a.event, phones, text,
      email: { subject: `${LABEL[a.event]}: ${head.replace(/^\S+\s/, '')}`, title: head, lines: rest.filter((l) => !l.startsWith('Abrir:')), url: a.emailUrl },
    });
  } catch (e) {
    console.error('[aviso-whatsapp] erro inesperado', a.event, (e as Error).message);
    return null;
  }
}

const pending = new Set<Promise<unknown>>();
/** Dispara o aviso sem esperar (não atrasa a resposta ao cliente/equipe). */
export function notifyStaffEventInBackground(a: StaffEventArgs) {
  const p = notifyStaffEvent(a).catch(() => null);
  pending.add(p);
  p.finally(() => pending.delete(p));
}
/** Testes: espera os avisos em andamento. */
export async function flushStaffAlerts() {
  while (pending.size) await Promise.all([...pending]);
}

// ---------- Falha da IA (pedido do dono, 2026-11-04) ----------

/** Intervalo mínimo (ms) entre alertas da mesma conversa. AI_FAILURE_ALERT_MIN; padrão 30 min. */
export function aiFailureAlertWindowMs(): number {
  const v = Number(process.env.AI_FAILURE_ALERT_MIN);
  return (Number.isFinite(v) && v > 0 ? v : 30) * 60_000;
}
/** Intervalo mínimo (ms) entre alertas da mesma organização (agrupa quedas que pegam várias conversas). AI_FAILURE_ORG_ALERT_MIN; padrão 5 min. */
export function aiFailureOrgWindowMs(): number {
  const v = Number(process.env.AI_FAILURE_ORG_ALERT_MIN);
  return (Number.isFinite(v) && v >= 0 ? v : 5) * 60_000;
}

const aiConvLast = new Map<string, number>();
const aiOrgLast = new Map<string, { at: number; suppressed: number }>();
/** Testes: zera o controle de repetição. */
export function resetAiFailureAlerts() { aiConvLast.clear(); aiOrgLast.clear(); }

/** Texto do alerta de falha da IA (WhatsApp; a 1ª linha vira o título do e-mail). Puro. */
export function aiFailureAlertText(o: { org: string; who: string; when: string; reason: string; error?: string | null; via?: string | null; repeated?: boolean; others?: number; url: string }): string {
  const err = o.error && !o.reason.includes(o.error) ? ` (${o.error.slice(0, 200)})` : '';
  return [
    '⚠️ A IA não conseguiu responder um cliente',
    `Empresa: ${o.org}`,
    `Contato: ${o.who}`,
    `Quando: ${o.when}`,
    `Motivo: ${o.reason}${err}`,
    o.via ? `WhatsApp: ${o.via}` : '',
    o.repeated ? 'Falhou de novo nesta conversa: o cliente recebeu o aviso de instabilidade com a opção de falar com um atendente.' : 'O cliente recebeu o texto de falha; a IA segue tentando nas próximas mensagens.',
    o.others ? `Mais ${o.others} falha(s) da IA em outras conversas desde o último alerta.` : '',
    'Responda pelo app se for urgente.',
    `Abrir conversa: ${o.url}`,
  ].filter(Boolean).join('\n');
}

export interface AiFailureArgs { orgId: string; conversationId: string; reason: string; error?: string | null; repeated?: boolean; now?: Date }

/**
 * Alerta o Proprietário quando a IA não consegue responder um cliente: WhatsApp nos números de aviso
 * (deliverStaffAlert) E e-mail (Brevo) para Proprietário/Admin. No máximo 1 por conversa a cada 30 min e
 * 1 por organização a cada 5 min (as falhas seguradas entram como contagem no próximo). Desligável no Perfil
 * (Organization.alertAiFailure). Retorna null quando nada foi enviado. Nunca lança.
 */
export async function notifyAiFailure(a: AiFailureArgs): Promise<DeliveryReport | null> {
  try {
    const now = (a.now ?? new Date()).getTime();
    const lastConv = aiConvLast.get(a.conversationId);
    if (lastConv !== undefined && now - lastConv < aiFailureAlertWindowMs()) return null;
    const org = await prisma.organization.findUnique({ where: { id: a.orgId } });
    if (!org || !alertEnabled(org, 'ai_failure')) return null;
    const ol = aiOrgLast.get(a.orgId);
    if (ol && now - ol.at < aiFailureOrgWindowMs()) { ol.suppressed++; aiConvLast.set(a.conversationId, now); return null; }
    aiConvLast.set(a.conversationId, now);
    if (aiConvLast.size > 5000) aiConvLast.clear();
    const others = ol?.suppressed ?? 0;
    aiOrgLast.set(a.orgId, { at: now, suppressed: 0 });
    const conv = await prisma.conversation.findFirst({ where: { id: a.conversationId, orgId: a.orgId }, select: { contactId: true, channelId: true } });
    const who = (await contactLabel(a.orgId, conv?.contactId)) ?? 'Contato';
    const via = conv?.channelId ? (await channelInfo(a.orgId, conv.channelId).catch(() => null))?.via ?? null : null;
    const url = conversationUrl(a.conversationId);
    const text = aiFailureAlertText({ org: org.name, who, when: formatWhen(new Date(now), org.timezone), reason: a.reason, error: a.error, via, repeated: a.repeated, others, url });
    const [head, ...rest] = text.split('\n');
    return await deliverStaffAlert({
      orgId: a.orgId, channelId: conv?.channelId ?? null, kind: 'ai_failure', text, alwaysEmail: true,
      email: { subject: `Falha da IA: ${who} (${org.name})`, title: head, lines: rest.filter((l) => !l.startsWith('Abrir conversa:')), url },
    });
  } catch (e) {
    console.error('[aviso-ia-falha] erro inesperado', (e as Error).message);
    return null;
  }
}

/** Dispara o alerta de falha da IA sem esperar (não atrasa a resposta ao cliente). */
export function notifyAiFailureInBackground(a: AiFailureArgs) {
  const p = notifyAiFailure(a).catch(() => null);
  pending.add(p);
  p.finally(() => pending.delete(p));
}
