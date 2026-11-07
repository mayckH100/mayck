import { randomBytes } from 'node:crypto';
import type { Contact, SdrLead, SdrSettings, SdrCadence, Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import { parseJson } from '../lib/json.js';
import {
  DEFAULT_QUESTIONS, SEGMENTS, advanceStage, defaultCadenceSteps, normalizeQuestions, normalizeSteps, normalizeEmail, normalizePhone,
  channelAllowed, stepDueAt, renderTemplate, inBusinessHours, FINAL_STAGES, DAY_MS, segmentLabel,
  kanbanNameToStage, stepTag, type Stage, type Step, type Question, type Answers, type Source,
} from './core.js';
import { syncSdrStageToKanban } from './kanbanSync.js';
import { getV2Config } from './v2config.js';
import { syncContactsToLeads, leadPhoneOfWaId } from '../mckmensagem/contactSync.js';
import { sendOutbound } from '../whatsapp/messaging.js';
import { openConversationFor } from '../whatsapp/multiCanal.js';
import { deliverMail, appUrl } from '../lib/mailer.js';
import { escHtml } from '../agenda/service.js';
import { deliverStaffAlert } from '../whatsapp/handoffNotify.js';
import { sdrLiberadoCached } from './access.js';
import { badRequest } from '../lib/http.js';

/**
 * SDR com IA — serviço (banco). Regras do dono (07/11/2026):
 * - modo automático por padrão: lead novo entra sozinho na cadência do segmento, a IA qualifica/pontua, move o funil,
 *   marca reunião e avisa a empresa quando o lead fica quente; quem preferir liga a aprovação manual de cada envio;
 * - nunca transfere para humano (lead quente só gera AVISO);
 * - WhatsApp de primeiro contato só para quem chamou ou deu consentimento; lead frio importado só por e-mail;
 * - opt-out (SAIR/PARAR ou descadastro do e-mail) para tudo e nunca é sobrescrito; horário comercial e limite diário.
 * Logs: só ids, nunca nome/telefone/e-mail.
 */

export const newToken = () => randomBytes(18).toString('base64url');

// ---------- Configuração ----------
export async function getSdrSettings(orgId: string): Promise<SdrSettings> {
  let s = await prisma.sdrSettings.findUnique({ where: { orgId } });
  if (!s) {
    try {
      s = await prisma.sdrSettings.create({ data: { orgId, formToken: newToken(), questionsJson: JSON.stringify(DEFAULT_QUESTIONS) } });
    } catch {
      s = await prisma.sdrSettings.findUniqueOrThrow({ where: { orgId } });
    }
  }
  if (!s.formToken) s = await prisma.sdrSettings.update({ where: { orgId }, data: { formToken: newToken() } });
  return s;
}

export function questionsOf(s: Pick<SdrSettings, 'questionsJson'>): Question[] {
  const q = normalizeQuestions(parseJson<unknown[]>(s.questionsJson, []));
  return q.length ? q : DEFAULT_QUESTIONS;
}

/** Cadências prontas (uma por segmento) criadas na primeira vez: o cliente não precisa configurar nada. */
export async function ensureCadences(orgId: string): Promise<void> {
  const n = await prisma.sdrCadence.count({ where: { orgId, builtIn: true } });
  if (n) return;
  await prisma.sdrCadence.createMany({
    data: SEGMENTS.map((seg) => ({ orgId, name: `Padrão · ${seg.label}`, segment: seg.id, stepsJson: JSON.stringify(defaultCadenceSteps(seg.id)), builtIn: true })),
  });
}

export async function cadenceFor(orgId: string, segment: string | null | undefined): Promise<SdrCadence | null> {
  await ensureCadences(orgId);
  const seg = segment || 'geral';
  return (await prisma.sdrCadence.findFirst({ where: { orgId, segment: seg, active: true }, orderBy: [{ builtIn: 'asc' }, { updatedAt: 'desc' }] }))
    ?? (await prisma.sdrCadence.findFirst({ where: { orgId, segment: 'geral', active: true }, orderBy: [{ builtIn: 'asc' }, { updatedAt: 'desc' }] }));
}

export const stepsOf = (c: Pick<SdrCadence, 'stepsJson'> | null) => (c ? normalizeSteps(parseJson<unknown[]>(c.stepsJson, [])) : []);

// ---------- Histórico ----------
export async function logEvent(orgId: string, leadId: string, type: string, channel?: string | null, detail?: string | null) {
  await prisma.sdrEvent.create({ data: { orgId, leadId, type, channel: channel ?? null, detail: detail ? detail.slice(0, 500) : null } }).catch((e) => console.error('[sdr] falha ao gravar evento', { orgId, leadId, type, error: (e as Error).message }));
}

export async function setStage(lead: SdrLead, next: Stage, opts: { manual?: boolean; fromKanban?: boolean } = {}): Promise<SdrLead> {
  const stage = opts.manual ? next : advanceStage(lead.stage, next);
  if (stage === lead.stage) return lead;
  const data: Prisma.SdrLeadUpdateInput = { stage };
  // Ganho/perdido encerra a cadência.
  if (FINAL_STAGES.includes(stage) && ['ESPERA', 'ATIVA', 'APROVACAO'].includes(lead.cadenceStatus)) Object.assign(data, { cadenceStatus: 'PARADA', stopReason: stage === 'GANHO' ? 'GANHO' : 'PERDIDO', nextStepAt: null });
  const upd = await prisma.sdrLead.update({ where: { id: lead.id }, data });
  await logEvent(lead.orgId, lead.id, 'ETAPA', opts.fromKanban ? 'KANBAN' : null, `${lead.stage} → ${stage}${opts.fromKanban ? ' (Kanban do MCKBOT)' : opts.manual ? ' (manual)' : ''}`);
  // v1.19.0: leva a etapa para o Kanban do MCKBOT (contato ligado). Mudança vinda do próprio Kanban não volta.
  if (!opts.fromKanban && upd.contactId) {
    const moved = await syncSdrStageToKanban(upd, stage, { manual: opts.manual });
    if (moved) await logEvent(lead.orgId, lead.id, 'KANBAN', null, moved);
  }
  return upd;
}

/**
 * Kanban → SDR (v1.19.0): o contato mudou de etapa no Kanban do MCKBOT (arrastado pela equipe, editado no contato ou
 * por um fluxo). Os leads do SDR ligados a ele acompanham quando o nome da etapa corresponde (Qualificado, Reunião…,
 * Ganho, Perdido…). `manual` = ação da equipe (pode voltar etapa); automação só anda para a frente. Nunca lança.
 */
export async function onKanbanStageChanged(orgId: string, contactId: string, stageId: string | null, opts: { manual?: boolean } = {}) {
  try {
    if (!stageId) return;
    const leads = await prisma.sdrLead.findMany({ where: { orgId, contactId } });
    if (!leads.length) return;
    if (!(await getV2Config(orgId)).kanbanSync) return;
    const st = await prisma.kanbanStage.findFirst({ where: { id: stageId, orgId }, select: { name: true } });
    const target = st ? kanbanNameToStage(st.name) : null;
    if (!target) return;
    for (const l of leads) await setStage(l, target, { manual: !!opts.manual, fromKanban: true });
  } catch (e) {
    console.error('[sdr] falha ao trazer a etapa do Kanban', { orgId, error: (e as Error).message });
  }
}

// ---------- Entrada de leads ----------
export interface LeadInput { name?: string | null; company?: string | null; segment?: string | null; phone?: string | null; email?: string | null; ownerUserId?: string | null; consent?: boolean; note?: string | null }

/** Opt-out que já existe para esse telefone/e-mail em qualquer lugar da empresa (nunca sobrescrito). */
async function existingOptOut(orgId: string, phone: string | null, email: string | null): Promise<boolean> {
  if (phone) {
    const waId = phone.slice(1);
    if (await prisma.contact.findFirst({ where: { orgId, waId, optOut: true }, select: { id: true } })) return true;
    if (await prisma.lead.findFirst({ where: { orgId, phone, optOutAt: { not: null } }, select: { id: true } })) return true;
  }
  if (email && (await prisma.sdrLead.findFirst({ where: { orgId, email, optOutAt: { not: null } }, select: { id: true } }))) return true;
  return false;
}

/**
 * Cria ou atualiza o lead (deduplica por telefone e e-mail dentro da empresa). Lead existente: preenche só campos vazios,
 * nunca tira opt-out, consentimento só é acrescentado. Lead novo entra na cadência quando o SDR está ligado.
 */
export async function upsertLead(orgId: string, input: LeadInput, source: Source, opts: { contactId?: string | null; now?: Date } = {}): Promise<{ lead: SdrLead; created: boolean }> {
  const now = opts.now ?? new Date();
  const phone = normalizePhone(input.phone);
  const email = normalizeEmail(input.email);
  if (!phone && !email) throw badRequest('Informe telefone ou e-mail válido');
  const or: Prisma.SdrLeadWhereInput[] = [];
  if (phone) or.push({ phone });
  if (email) or.push({ email });
  if (opts.contactId) or.push({ contactId: opts.contactId });
  const existing = await prisma.sdrLead.findFirst({ where: { orgId, OR: or }, orderBy: { createdAt: 'asc' } });
  const consentSource = source === 'IMPORTACAO' ? 'IMPORTACAO' : source === 'FORMULARIO' ? 'FORMULARIO' : 'MANUAL';
  if (existing) {
    const data: Prisma.SdrLeadUpdateInput = {};
    if (!existing.name && input.name) data.name = input.name.trim().slice(0, 120);
    if (!existing.company && input.company) data.company = input.company.trim().slice(0, 120);
    if (!existing.segment && input.segment) data.segment = input.segment;
    if (!existing.phone && phone && !(await prisma.sdrLead.findFirst({ where: { orgId, phone }, select: { id: true } }))) data.phone = phone;
    if (!existing.email && email && !(await prisma.sdrLead.findFirst({ where: { orgId, email }, select: { id: true } }))) data.email = email;
    if (!existing.consentAt && input.consent && !existing.optOutAt) Object.assign(data, { consentAt: now, consentSource });
    if (!existing.contactId && opts.contactId) data.contactId = opts.contactId;
    const lead = Object.keys(data).length ? await prisma.sdrLead.update({ where: { id: existing.id }, data }) : existing;
    if (input.note) await logEvent(orgId, lead.id, 'NOTA', source, input.note);
    return { lead, created: false };
  }
  const optOut = await existingOptOut(orgId, phone, email);
  let lead: SdrLead;
  try {
    lead = await prisma.sdrLead.create({
      data: {
        orgId, name: input.name?.trim().slice(0, 120) || null, company: input.company?.trim().slice(0, 120) || null, segment: input.segment || null,
        phone, email, source, ownerUserId: input.ownerUserId || null, unsubToken: newToken(), contactId: opts.contactId ?? null,
        consentAt: input.consent && !optOut ? now : null, consentSource: input.consent && !optOut ? consentSource : source === 'WHATSAPP' ? 'WHATSAPP' : null,
        optOutAt: optOut ? now : null,
      },
    });
  } catch (e: any) {
    if (e?.code === 'P2002') return upsertLead(orgId, input, source, opts); // corrida: outro processo criou
    throw e;
  }
  await logEvent(orgId, lead.id, 'CRIADO', source, optOut ? 'já tinha pedido para sair: não recebe mensagens' : null);
  if (!lead.ownerUserId) lead = await assignByRotation(lead).catch(() => lead);
  if (input.note) await logEvent(orgId, lead.id, 'NOTA', source, input.note);
  lead = await linkContact(lead).catch(() => lead);
  const s = await getSdrSettings(orgId);
  if (s.enabled && !optOut) lead = await enroll(lead, s, now);
  return { lead, created: true };
}

// ---------- Rodízio de leads (v1.19.0) ----------
/**
 * Próximo dono do rodízio: o membro escolhido que vem depois de quem recebeu o último lead pelo rodízio (na ordem
 * da lista). Membros que saíram da equipe são ignorados. Sem membros válidos: null.
 */
export async function nextRotationOwner(orgId: string, members: string[]): Promise<string | null> {
  if (!members.length) return null;
  const valid = new Set((await prisma.membership.findMany({ where: { orgId, userId: { in: members } }, select: { userId: true } })).map((m) => m.userId));
  const list = members.filter((m) => valid.has(m));
  if (!list.length) return null;
  const last = await prisma.sdrEvent.findFirst({ where: { orgId, type: 'DONO', channel: 'RODIZIO' }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { detail: true } });
  const lastId = last?.detail?.match(/\[u:([^\]]+)\]/)?.[1];
  const i = lastId ? list.indexOf(lastId) : -1;
  return list[(i + 1) % list.length];
}

/** Lead novo sem dono: recebe o próximo do rodízio, quando ligado em SDR › Configuração. */
export async function assignByRotation(lead: SdrLead): Promise<SdrLead> {
  if (lead.ownerUserId) return lead;
  const cfg = (await getV2Config(lead.orgId)).rodizio;
  if (!cfg.enabled) return lead;
  const owner = await nextRotationOwner(lead.orgId, cfg.members);
  if (!owner) return lead;
  const upd = await prisma.sdrLead.update({ where: { id: lead.id }, data: { ownerUserId: owner } });
  const u = await prisma.user.findUnique({ where: { id: owner }, select: { name: true } });
  await logEvent(lead.orgId, lead.id, 'DONO', 'RODIZIO', `[u:${owner}] Rodízio: ${u?.name ?? 'membro da equipe'}`);
  return upd;
}

/** Telefone com consentimento/WhatsApp: liga ao contato do MCKBOT e ao lead do MCK Mensagens (mesma pessoa). */
async function linkContact(lead: SdrLead): Promise<SdrLead> {
  if (!lead.phone) return lead;
  let contact: Contact | null = lead.contactId ? await prisma.contact.findFirst({ where: { id: lead.contactId, orgId: lead.orgId } }) : null;
  const waId = lead.phone.slice(1);
  if (!contact) contact = await prisma.contact.findUnique({ where: { orgId_waId: { orgId: lead.orgId, waId } } });
  if (!contact && (lead.consentAt || lead.source === 'WHATSAPP')) {
    contact = await prisma.contact.create({ data: { orgId: lead.orgId, waId, phone: lead.phone, name: lead.name, email: lead.email } }).catch(() => prisma.contact.findUnique({ where: { orgId_waId: { orgId: lead.orgId, waId } } }));
  }
  if (!contact) return lead;
  if (contact.optOut && !lead.optOutAt) lead = await prisma.sdrLead.update({ where: { id: lead.id }, data: { optOutAt: new Date() } });
  await syncContactsToLeads(lead.orgId, [contact], lead.consentAt ? { consent: { source: lead.consentSource ?? 'MANUAL', at: lead.consentAt } } : {}).catch(() => undefined);
  const mm = leadPhoneOfWaId(contact.waId) ? await prisma.lead.findFirst({ where: { orgId: lead.orgId, contactId: contact.id }, select: { id: true } }) : null;
  return prisma.sdrLead.update({ where: { id: lead.id }, data: { contactId: contact.id, leadId: mm?.id ?? lead.leadId } });
}

/**
 * Põe o lead na cadência do segmento. Quem chamou no WhatsApp espera ficar em silêncio (silenceHours) antes do
 * primeiro acompanhamento; os demais começam agora (passo do dia 0).
 */
export async function enroll(lead: SdrLead, s: SdrSettings, now = new Date()): Promise<SdrLead> {
  if (lead.optOutAt || FINAL_STAGES.includes(lead.stage as Stage)) return lead;
  const cad = await cadenceFor(lead.orgId, lead.segment || s.segment);
  if (!cad || !stepsOf(cad).length) return lead;
  const data: Prisma.SdrLeadUpdateInput = lead.source === 'WHATSAPP'
    ? { cadenceId: cad.id, cadenceStatus: 'ESPERA', cadenceStep: 0, cadenceStartedAt: null, nextStepAt: new Date((lead.lastReplyAt ?? now).getTime() + s.silenceHours * 3600e3), stopReason: null }
    : { cadenceId: cad.id, cadenceStatus: 'ATIVA', cadenceStep: 0, cadenceStartedAt: now, nextStepAt: stepDueAt(now, stepsOf(cad), 0), stopReason: null };
  const upd = await prisma.sdrLead.update({ where: { id: lead.id }, data });
  await logEvent(lead.orgId, lead.id, 'CADENCIA', null, `Entrou na cadência "${cad.name}"${lead.source === 'WHATSAPP' ? ' (acompanhamento se parar de responder)' : ''}`);
  return upd;
}

export async function stopCadence(lead: SdrLead, reason: string, detail?: string): Promise<SdrLead> {
  if (!['ESPERA', 'ATIVA', 'APROVACAO'].includes(lead.cadenceStatus)) return lead;
  const upd = await prisma.sdrLead.update({ where: { id: lead.id }, data: { cadenceStatus: 'PARADA', stopReason: reason, nextStepAt: null } });
  await logEvent(lead.orgId, lead.id, 'PARADA', null, detail ?? reason);
  return upd;
}

/** Lead pediu para sair (SAIR/PARAR no WhatsApp ou descadastro do e-mail): para tudo, para sempre. */
export async function optOutLead(lead: SdrLead, via: string, now = new Date()): Promise<SdrLead> {
  let upd = lead.optOutAt ? lead : await prisma.sdrLead.update({ where: { id: lead.id }, data: { optOutAt: now } });
  if (!lead.optOutAt) await logEvent(lead.orgId, lead.id, 'OPTOUT', via, null);
  upd = await stopCadence(upd, 'SAIU', 'Pediu para sair');
  return upd;
}

/** Hook do opt-out do WhatsApp (mckmensagem/hooks): mesmo contato/telefone. Nunca lança. */
export async function onSdrOptOut(orgId: string, contact: { id: string; waId: string }, at = new Date()) {
  try {
    const phone = leadPhoneOfWaId(contact.waId);
    const or: Prisma.SdrLeadWhereInput[] = [{ contactId: contact.id }];
    if (phone) or.push({ phone });
    const leads = await prisma.sdrLead.findMany({ where: { orgId, OR: or } });
    for (const l of leads) await optOutLead(l, 'WHATSAPP', at);
  } catch (e) {
    console.error('[sdr] falha ao registrar opt-out', { orgId, error: (e as Error).message });
  }
}

/** Resposta do lead: para a cadência (respondeu) e anda o funil. Lead em espera do WhatsApp só reinicia o relógio. */
export async function registerReply(lead: SdrLead, channel: 'WHATSAPP' | 'EMAIL', s: SdrSettings, now = new Date()): Promise<SdrLead> {
  let upd = await prisma.sdrLead.update({ where: { id: lead.id }, data: { lastReplyAt: now } });
  const recent = lead.lastReplyAt && now.getTime() - lead.lastReplyAt.getTime() < 30 * 60_000;
  if (!recent) await logEvent(lead.orgId, lead.id, 'RESPOSTA', channel, null);
  upd = await setStage(upd, 'RESPONDEU');
  if (upd.cadenceStatus === 'ESPERA') {
    upd = await prisma.sdrLead.update({ where: { id: lead.id }, data: { nextStepAt: new Date(now.getTime() + s.silenceHours * 3600e3) } });
  } else if (upd.cadenceStatus === 'ATIVA' || upd.cadenceStatus === 'APROVACAO') {
    upd = await stopCadence(upd, 'RESPONDEU', 'Lead respondeu');
  }
  return upd;
}

/** Hook da Agenda: reunião marcada para o contato → etapa "Reunião marcada" e cadência parada. Nunca lança. */
export async function onSdrMeeting(orgId: string, contactId: string, appointmentId: string) {
  try {
    const leads = await prisma.sdrLead.findMany({ where: { orgId, contactId } });
    for (let l of leads) {
      l = await prisma.sdrLead.update({ where: { id: l.id }, data: { appointmentId } });
      await logEvent(orgId, l.id, 'REUNIAO', null, 'Reunião marcada na Agenda');
      l = await setStage(l, 'REUNIAO');
      await stopCadence(l, 'AGENDOU', 'Reunião marcada');
    }
  } catch (e) {
    console.error('[sdr] falha ao registrar reunião', { orgId, error: (e as Error).message });
  }
}

// ---------- Aviso de lead quente (nunca transfere a conversa) ----------
export function hotAlertText(o: { name: string | null; company: string | null; score: number; summary: string | null; url: string }) {
  return [
    `🔥 Lead quente (${o.score}/100): ${o.name || 'sem nome'}${o.company ? ` · ${o.company}` : ''}`,
    o.summary ? `Resumo: ${o.summary}` : null,
    'A IA continua a conversa normalmente; nada foi transferido.',
    `Abrir: ${o.url}`,
  ].filter(Boolean).join('\n');
}

export async function alertHot(lead: SdrLead, s: SdrSettings): Promise<void> {
  if (lead.hotAlertAt || !s.alertHot) return;
  const claimed = await prisma.sdrLead.updateMany({ where: { id: lead.id, hotAlertAt: null }, data: { hotAlertAt: new Date() } });
  if (claimed.count !== 1) return;
  await logEvent(lead.orgId, lead.id, 'QUENTE', null, `Pontuação ${lead.score}`);
  const url = `${appUrl()}/sdr?lead=${lead.id}`;
  const text = hotAlertText({ name: lead.name, company: lead.company, score: lead.score, summary: lead.aiSummary, url });
  const r = await deliverStaffAlert({
    orgId: lead.orgId, kind: 'sdr_hot', text,
    email: { subject: `Lead quente: ${lead.name || 'novo lead'}`, title: `🔥 Lead quente (${lead.score}/100)`, lines: text.split('\n').slice(1, -1), url },
  }).catch((e) => ({ ok: false, detail: (e as Error).message }));
  if (!r.ok) console.warn('[sdr] aviso de lead quente não entregue por WhatsApp/e-mail (fica no painel)', { orgId: lead.orgId, leadId: lead.id });
}

// ---------- Envio de um passo ----------
async function orgName(orgId: string) {
  return (await prisma.organization.findUnique({ where: { id: orgId }, select: { name: true } }))?.name ?? '';
}

export function emailHtml(body: string, unsubUrl: string, org: string) {
  const paras = escHtml(body).split(/\n{2,}/).map((p) => `<p style="margin:0 0 14px">${p.replace(/\n/g, '<br>')}</p>`).join('');
  return `<div style="font-family:Arial,sans-serif;font-size:15px;color:#1f2937;max-width:560px">${paras}<hr style="border:none;border-top:1px solid #e5e7eb;margin:22px 0 10px"><p style="font-size:12px;color:#6b7280;margin:0">Você recebeu este e-mail de ${escHtml(org)}. Não quer receber mais? <a href="${escHtml(unsubUrl)}">Descadastrar</a>.</p></div>`;
}

export type SendResult = { ok: true } | { ok: false; reason: string; retry?: boolean };

/** Escolhe a conversa do contato (a mais recente com WhatsApp) ou abre uma no primeiro WhatsApp conectado. */
async function conversationFor(orgId: string, contact: Contact) {
  const recent = await prisma.conversation.findFirst({ where: { orgId, contactId: contact.id, status: { not: 'CLOSED' }, channelId: { not: null } }, orderBy: { lastMessageAt: 'desc' } });
  if (recent) return recent;
  const ch = await prisma.channel.findFirst({ where: { orgId, status: 'CONNECTED' }, orderBy: { createdAt: 'asc' } });
  return ch ? openConversationFor(orgId, contact.id, ch.id) : null;
}

export async function sendStep(lead: SdrLead, step: Step): Promise<SendResult> {
  const allowed = channelAllowed(lead, step.canal);
  if (!allowed.ok) return { ok: false, reason: allowed.reason! };
  const minha = await orgName(lead.orgId);
  const vars = { nome: lead.name, empresa: lead.company, segmento: lead.segment, minhaEmpresa: minha };
  if (step.canal === 'WHATSAPP') {
    const l = lead.contactId ? lead : await linkContact(lead);
    const contact = l.contactId ? await prisma.contact.findFirst({ where: { id: l.contactId, orgId: lead.orgId } }) : null;
    if (!contact) return { ok: false, reason: 'sem contato de WhatsApp' };
    if (contact.optOut) { await optOutLead(lead, 'WHATSAPP'); return { ok: false, reason: 'pediu para sair' }; }
    const conv = await conversationFor(lead.orgId, contact);
    if (!conv) return { ok: false, reason: 'nenhum WhatsApp conectado', retry: true };
    if (conv.mode === 'HUMAN') return { ok: false, reason: 'atendente cuidando da conversa' };
    const msg = await sendOutbound({ conversation: conv, contact, payload: { type: 'text', text: renderTemplate(step.texto, vars) }, sender: 'bot' });
    if (msg.status === 'FAILED') return { ok: false, reason: (msg.error || 'falha no envio').slice(0, 160), retry: !/janela de 24|opt-out|Assinatura/.test(msg.error ?? '') };
    return { ok: true };
  }
  const unsubUrl = `${appUrl()}/descadastro/${lead.unsubToken}`;
  const text = renderTemplate(step.texto, vars);
  const r = await deliverMail({
    to: lead.email!, kind: 'sdr', subject: renderTemplate(step.assunto || 'Contato da {minha_empresa}', vars),
    text: `${text}\n\n—\nNão quer receber mais e-mails de ${minha}? Descadastre-se: ${unsubUrl}`,
    html: emailHtml(text, unsubUrl, minha),
  });
  if (!r.ok) return { ok: false, reason: r.reason === 'not_configured' ? 'e-mail não configurado no servidor' : 'falha no envio do e-mail', retry: r.reason === 'failed' };
  return { ok: true };
}

export async function sentToday(orgId: string, now = new Date(), tz = 'America/Sao_Paulo'): Promise<number> {
  const { startOfDayIn } = await import('./time.js');
  return prisma.sdrEvent.count({ where: { orgId, type: 'ENVIO', createdAt: { gte: startOfDayIn(now, tz) } } });
}

/** Avança para o próximo passo (ou conclui). */
async function advance(lead: SdrLead, steps: Step[], from: number): Promise<SdrLead> {
  const next = from + 1;
  if (next >= steps.length || !lead.cadenceStartedAt) {
    const upd = await prisma.sdrLead.update({ where: { id: lead.id }, data: { cadenceStep: next, cadenceStatus: 'CONCLUIDA', nextStepAt: null } });
    await logEvent(lead.orgId, lead.id, 'CADENCIA', null, 'Cadência concluída');
    return upd;
  }
  return prisma.sdrLead.update({ where: { id: lead.id }, data: { cadenceStep: next, cadenceStatus: 'ATIVA', nextStepAt: stepDueAt(lead.cadenceStartedAt, steps, next) } });
}

/**
 * Executa o passo atual (agendador ou aprovação manual). `approved` = a empresa aprovou na tela (ignora o modo manual,
 * mas continua respeitando consentimento, opt-out e limite diário).
 */
export async function runStep(lead: SdrLead, s: SdrSettings, now = new Date(), opts: { approved?: boolean; tz?: string } = {}): Promise<{ lead: SdrLead; sent: boolean; waiting?: string }> {
  const cad = lead.cadenceId ? await prisma.sdrCadence.findFirst({ where: { id: lead.cadenceId, orgId: lead.orgId } }) : null;
  const steps = stepsOf(cad);
  let cur = lead;
  // Passos de canal não permitido para este lead são pulados (ex.: WhatsApp de lead frio importado).
  while (cur.cadenceStep < steps.length) {
    const step = steps[cur.cadenceStep];
    const allowed = channelAllowed(cur, step.canal);
    if (allowed.ok) break;
    await logEvent(cur.orgId, cur.id, 'PULO', step.canal, `Passo do dia ${step.dia}: ${allowed.reason}`);
    cur = await advance(cur, steps, cur.cadenceStep);
    if (cur.cadenceStatus !== 'ATIVA') return { lead: cur, sent: false };
    if (!opts.approved && cur.nextStepAt && cur.nextStepAt > now) return { lead: cur, sent: false };
  }
  if (cur.cadenceStep >= steps.length) return { lead: await advance(cur, steps, steps.length), sent: false };
  const step = steps[cur.cadenceStep];
  if (!opts.approved && !s.autoMode) {
    if (cur.cadenceStatus !== 'APROVACAO') {
      cur = await prisma.sdrLead.update({ where: { id: cur.id }, data: { cadenceStatus: 'APROVACAO' } });
      await logEvent(cur.orgId, cur.id, 'APROVACAO', step.canal, `Passo do dia ${step.dia} aguardando aprovação`);
    }
    return { lead: cur, sent: false, waiting: 'aprovação' };
  }
  if (!opts.approved && !inBusinessHours(s, now, opts.tz)) return { lead: cur, sent: false, waiting: 'horário comercial' };
  if ((await sentToday(cur.orgId, now, opts.tz)) >= s.dailyLimit) return { lead: cur, sent: false, waiting: 'limite diário' };
  const r = await sendStep(cur, step);
  if (!r.ok) {
    const dueAt = cur.nextStepAt ?? now;
    if (r.retry && now.getTime() - dueAt.getTime() < DAY_MS) {
      await logEvent(cur.orgId, cur.id, 'FALHA', step.canal, `${r.reason} (nova tentativa em 2 h)`);
      return { lead: await prisma.sdrLead.update({ where: { id: cur.id }, data: { cadenceStatus: 'ATIVA', nextStepAt: new Date(now.getTime() + 2 * 3600e3) } }), sent: false };
    }
    await logEvent(cur.orgId, cur.id, 'PULO', step.canal, `Passo do dia ${step.dia}: ${r.reason}`);
    const fresh = await prisma.sdrLead.findUniqueOrThrow({ where: { id: cur.id } });
    if (fresh.optOutAt || fresh.cadenceStatus === 'PARADA') return { lead: fresh, sent: false };
    return { lead: await advance(fresh, steps, fresh.cadenceStep), sent: false };
  }
  await logEvent(cur.orgId, cur.id, 'ENVIO', step.canal, `${stepTag(cur.cadenceId, cur.cadenceStep)}Passo do dia ${step.dia}${opts.approved ? ' (aprovado)' : ''}`);
  cur = await prisma.sdrLead.update({ where: { id: cur.id }, data: { lastContactAt: now } });
  cur = await setStage(cur, 'CONTATADO');
  return { lead: await advance(cur, steps, cur.cadenceStep), sent: true };
}

// ---------- Agendador ----------
/** Roda os passos vencidos (todas as empresas). Um lote por chamada; nunca lança. */
export async function tickSdr(now = new Date()): Promise<number> {
  let sent = 0;
  const due = await prisma.sdrLead.findMany({ where: { cadenceStatus: { in: ['ESPERA', 'ATIVA'] }, nextStepAt: { lte: now }, optOutAt: null }, orderBy: { nextStepAt: 'asc' }, take: 100 });
  const settings = new Map<string, SdrSettings | null>();
  const tzs = new Map<string, string>();
  for (let lead of due) {
    try {
      if (!settings.has(lead.orgId)) {
        const ok = await sdrLiberadoCached(lead.orgId);
        const s = ok ? await getSdrSettings(lead.orgId) : null;
        settings.set(lead.orgId, s && s.enabled ? s : null);
        tzs.set(lead.orgId, (await prisma.organization.findUnique({ where: { id: lead.orgId }, select: { timezone: true } }))?.timezone ?? 'America/Sao_Paulo');
      }
      const s = settings.get(lead.orgId);
      if (!s) continue;
      if (lead.cadenceStatus === 'ESPERA') {
        // Quem chamou no WhatsApp ficou em silêncio: começa o acompanhamento (se ainda não marcou reunião).
        if (['REUNIAO', 'GANHO', 'PERDIDO'].includes(lead.stage)) { await stopCadence(lead, lead.stage === 'REUNIAO' ? 'AGENDOU' : lead.stage); continue; }
        const claimed = await prisma.sdrLead.updateMany({ where: { id: lead.id, cadenceStatus: 'ESPERA', nextStepAt: lead.nextStepAt }, data: { cadenceStatus: 'ATIVA', cadenceStartedAt: now, cadenceStep: 0, nextStepAt: now } });
        if (claimed.count !== 1) continue;
        lead = await prisma.sdrLead.findUniqueOrThrow({ where: { id: lead.id } });
        await logEvent(lead.orgId, lead.id, 'CADENCIA', null, 'Lead parou de responder: acompanhamento começou');
      }
      const r = await runStep(lead, s, now, { tz: tzs.get(lead.orgId) });
      if (r.sent) sent++;
    } catch (e) {
      console.error('[sdr] falha no passo da cadência', { orgId: lead.orgId, leadId: lead.id, error: (e as Error).message });
    }
  }
  return sent;
}

// ---------- Visões ----------
export function leadView(l: SdrLead, extra: { ownerName?: string | null; cadenceName?: string | null } = {}) {
  return {
    id: l.id, name: l.name, company: l.company, segment: l.segment, segmentLabel: segmentLabel(l.segment), phone: l.phone, email: l.email,
    source: l.source, stage: l.stage, score: l.score, temperature: l.temperature, ownerUserId: l.ownerUserId, ownerName: extra.ownerName ?? null,
    consent: !!l.consentAt, consentAt: l.consentAt, optOut: !!l.optOutAt, answers: parseJson<Answers>(l.answersJson, {}), aiSummary: l.aiSummary,
    cadenceId: l.cadenceId, cadenceName: extra.cadenceName ?? null, cadenceStep: l.cadenceStep, cadenceStatus: l.cadenceStatus, nextStepAt: l.nextStepAt, stopReason: l.stopReason,
    lastContactAt: l.lastContactAt, lastReplyAt: l.lastReplyAt, hotAlertAt: l.hotAlertAt, appointmentId: l.appointmentId, contactId: l.contactId, createdAt: l.createdAt,
  };
}

export { renderTemplate };
