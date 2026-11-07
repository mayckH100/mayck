import { Router, type Request } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import type { Prisma, SdrLead } from '@prisma/client';
import { prisma } from '../db.js';
import { ah, notFound, badRequest, HttpError } from '../lib/http.js';
import { orgOf, requireRole } from '../auth/session.js';
import { audit } from '../lib/audit.js';
import { appUrl } from '../lib/mailer.js';
import { parseJson } from '../lib/json.js';
import { createAppointment, ConflictError } from '../agenda/service.js';
import { parseLocal } from '../agenda/time.js';
import { buildCadenceReport, cadenceReportCsv, parseStepTag, cleanEventDetail, STAGES, STAGE_LABEL, SEGMENTS, VARIABLES, normalizeQuestions, normalizeSteps, defaultCadenceSteps, segmentLabel, type Stage } from './core.js';
import { getSdrPlans, sdrAccess, setSdrPlans } from './access.js';
import {
  assignByRotation, getSdrSettings, questionsOf, ensureCadences, stepsOf, upsertLead, leadView, logEvent, setStage, stopCadence, enroll, runStep, newToken,
} from './service.js';
import { parseCsv } from './csv.js';
import { getV2Config, setV2Config, normalizeDomains, sdrReplyTo, type SdrV2Config } from './v2config.js';
import { contem } from '../lib/busca.js';
import { startOfDayIn } from './time.js';

export const sdrRouter = Router();
const admins = requireRole('OWNER', 'ADMIN');
// Limite por pessoa para as rotas que alteram dados do SDR (além do limite geral da API).
const writeLimiter = rateLimit({
  windowMs: 60_000, limit: 60, standardHeaders: 'draft-7', legacyHeaders: false,
  keyGenerator: (req) => `${req.auth?.userId ?? req.ip}`, message: { error: 'Muitas ações seguidas no SDR. Aguarde um instante.' },
  skip: (req) => req.method === 'GET',
});
sdrRouter.use(writeLimiter);

async function findLead(req: Request, id: string): Promise<SdrLead> {
  const l = await prisma.sdrLead.findFirst({ where: { id, orgId: orgOf(req) } });
  if (!l) throw notFound('Lead');
  return l;
}
async function checkOwner(orgId: string, userId: string | null | undefined) {
  if (userId && !(await prisma.membership.findUnique({ where: { userId_orgId: { userId, orgId } } }))) throw badRequest('Responsável não faz parte da equipe');
}
async function tzOf(orgId: string) {
  return (await prisma.organization.findUnique({ where: { id: orgId }, select: { timezone: true } }))?.timezone ?? 'America/Sao_Paulo';
}

// ---------- Acesso e configuração ----------
sdrRouter.get('/acesso', ah(async (req, res) => {
  const a = await sdrAccess(orgOf(req), !!req.auth?.isSuperAdmin);
  const s = a.liberado ? await getSdrSettings(orgOf(req)) : null;
  res.json({ ...a, enabled: !!s?.enabled, autoMode: s?.autoMode ?? true });
}));

function settingsView(s: Awaited<ReturnType<typeof getSdrSettings>>, req: Request, v2: SdrV2Config) {
  return {
    kanbanSync: v2.kanbanSync, rodizio: v2.rodizio, embedDomains: v2.embedDomains, emailReplies: !!sdrReplyTo('x'.repeat(24)),
    enabled: s.enabled, autoMode: s.autoMode, captureWhatsapp: s.captureWhatsapp, autoBook: s.autoBook, segment: s.segment,
    questions: questionsOf(s), warmScore: s.warmScore, hotScore: s.hotScore, workStart: s.workStart, workEnd: s.workEnd, workDays: s.workDays,
    dailyLimit: s.dailyLimit, silenceHours: s.silenceHours, formEnabled: s.formEnabled, formTitle: s.formTitle, alertHot: s.alertHot,
    formUrl: `${appUrl(req)}/f/${s.formToken}`, segments: SEGMENTS, stages: STAGES.map((id) => ({ id, label: STAGE_LABEL[id] })), variables: VARIABLES,
  };
}

async function teamOf(orgId: string) {
  const ms = await prisma.membership.findMany({ where: { orgId }, include: { user: { select: { id: true, name: true } } }, orderBy: { createdAt: 'asc' } });
  return ms.map((m) => ({ id: m.user.id, name: m.user.name }));
}

sdrRouter.get('/config', ah(async (req, res) => res.json({ ...settingsView(await getSdrSettings(orgOf(req)), req, await getV2Config(orgOf(req))), team: await teamOf(orgOf(req)) })));

const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const configSchema = z.object({
  enabled: z.boolean().optional(), autoMode: z.boolean().optional(), captureWhatsapp: z.boolean().optional(), autoBook: z.boolean().optional(),
  segment: z.enum(SEGMENTS.map((s) => s.id) as [string, ...string[]]).optional(),
  questions: z.array(z.object({ id: z.string().max(40).optional(), pergunta: z.string().min(2).max(200), peso: z.number().int().min(1).max(100) })).min(1).max(8).optional(),
  warmScore: z.number().int().min(1).max(99).optional(), hotScore: z.number().int().min(2).max(100).optional(),
  workStart: HHMM.optional(), workEnd: HHMM.optional(), workDays: z.string().regex(/^[0-6](,[0-6]){0,6}$/).optional(),
  dailyLimit: z.number().int().min(1).max(1000).optional(), silenceHours: z.number().int().min(1).max(23).optional(),
  formEnabled: z.boolean().optional(), formTitle: z.string().min(2).max(80).optional(), alertHot: z.boolean().optional(),
  newFormLink: z.boolean().optional(),
  // v1.19.0 (sem migração; guardado no AuditLog):
  kanbanSync: z.boolean().optional(),
  rodizio: z.object({ enabled: z.boolean(), members: z.array(z.string().max(40)).max(50) }).optional(),
  embedDomains: z.array(z.string().max(200)).max(20).optional(),
});

sdrRouter.put('/config', admins, ah(async (req, res) => {
  const b = configSchema.parse(req.body);
  const orgId = orgOf(req);
  const cur = await getSdrSettings(orgId);
  const warm = b.warmScore ?? cur.warmScore, hot = b.hotScore ?? cur.hotScore;
  if (warm >= hot) throw badRequest('A nota de "quente" precisa ser maior que a de "morno"');
  const { questions, newFormLink, kanbanSync, rodizio, embedDomains, ...rest } = b;
  if (rodizio) {
    const ok = await prisma.membership.findMany({ where: { orgId, userId: { in: rodizio.members } }, select: { userId: true } });
    if (ok.length !== new Set(rodizio.members).size) throw badRequest('Algum membro do rodízio não faz parte da equipe');
    if (rodizio.enabled && !rodizio.members.length) throw badRequest('Escolha pelo menos um membro para o rodízio');
  }
  let v2 = await getV2Config(orgId);
  const v2patch: Partial<SdrV2Config> = {};
  if (kanbanSync !== undefined && kanbanSync !== v2.kanbanSync) v2patch.kanbanSync = kanbanSync;
  if (rodizio && JSON.stringify(rodizio) !== JSON.stringify(v2.rodizio)) v2patch.rodizio = rodizio;
  if (embedDomains && JSON.stringify(normalizeDomains(embedDomains)) !== JSON.stringify(v2.embedDomains)) v2patch.embedDomains = embedDomains;
  if (Object.keys(v2patch).length) v2 = await setV2Config(orgId, v2patch, { userId: req.auth?.userId, ip: req.ip });
  const data: Prisma.SdrSettingsUpdateInput = { ...rest };
  if (questions) data.questionsJson = JSON.stringify(normalizeQuestions(questions));
  if (newFormLink) data.formToken = newToken();
  const s = await prisma.sdrSettings.update({ where: { orgId }, data });
  if (b.enabled && !cur.enabled) await ensureCadences(orgId);
  await audit(req, 'sdr.config', { orgId, entity: 'sdr_settings', entityId: orgId, meta: { enabled: s.enabled, autoMode: s.autoMode, autoBook: s.autoBook, newFormLink: !!newFormLink } });
  res.json({ ...settingsView(s, req, v2), team: await teamOf(orgId) });
}));

// ---------- Cadências ----------
const cadView = (c: { id: string; name: string; segment: string; stepsJson: string; active: boolean; builtIn: boolean }) =>
  ({ id: c.id, name: c.name, segment: c.segment, segmentLabel: segmentLabel(c.segment), steps: stepsOf(c), active: c.active, builtIn: c.builtIn });

sdrRouter.get('/cadencias', ah(async (req, res) => {
  const orgId = orgOf(req);
  await ensureCadences(orgId);
  const list = await prisma.sdrCadence.findMany({ where: { orgId }, orderBy: [{ builtIn: 'asc' }, { segment: 'asc' }, { createdAt: 'asc' }] });
  res.json({ items: list.map(cadView) });
}));

const stepSchema = z.object({ dia: z.number().int().min(0).max(60), canal: z.enum(['WHATSAPP', 'EMAIL']), assunto: z.string().max(150).optional(), texto: z.string().min(2).max(2000) });
const cadSchema = z.object({ name: z.string().min(2).max(80), segment: z.enum(SEGMENTS.map((s) => s.id) as [string, ...string[]]), steps: z.array(stepSchema).min(1).max(12), active: z.boolean().optional() });

sdrRouter.post('/cadencias', admins, ah(async (req, res) => {
  const b = cadSchema.parse(req.body);
  const c = await prisma.sdrCadence.create({ data: { orgId: orgOf(req), name: b.name, segment: b.segment, stepsJson: JSON.stringify(normalizeSteps(b.steps)), active: b.active ?? true } });
  await audit(req, 'sdr.cadencia.create', { orgId: orgOf(req), entity: 'sdr_cadence', entityId: c.id });
  res.status(201).json(cadView(c));
}));

sdrRouter.put('/cadencias/:id', admins, ah(async (req, res) => {
  const b = cadSchema.partial().parse(req.body);
  const cur = await prisma.sdrCadence.findFirst({ where: { id: req.params.id, orgId: orgOf(req) } });
  if (!cur) throw notFound('Cadência');
  const c = await prisma.sdrCadence.update({ where: { id: cur.id }, data: { name: b.name, segment: b.segment, active: b.active, ...(b.steps ? { stepsJson: JSON.stringify(normalizeSteps(b.steps)) } : {}) } });
  await audit(req, 'sdr.cadencia.update', { orgId: orgOf(req), entity: 'sdr_cadence', entityId: c.id });
  res.json(cadView(c));
}));

/** Volta a cadência pronta ao texto original do segmento. */
sdrRouter.post('/cadencias/:id/restaurar', admins, ah(async (req, res) => {
  const cur = await prisma.sdrCadence.findFirst({ where: { id: req.params.id, orgId: orgOf(req), builtIn: true } });
  if (!cur) throw notFound('Cadência pronta');
  const c = await prisma.sdrCadence.update({ where: { id: cur.id }, data: { stepsJson: JSON.stringify(defaultCadenceSteps(cur.segment)), active: true } });
  res.json(cadView(c));
}));

sdrRouter.delete('/cadencias/:id', admins, ah(async (req, res) => {
  const cur = await prisma.sdrCadence.findFirst({ where: { id: req.params.id, orgId: orgOf(req) } });
  if (!cur) throw notFound('Cadência');
  if (cur.builtIn) throw badRequest('As cadências prontas não podem ser apagadas; desative ou edite.');
  if (await prisma.sdrLead.findFirst({ where: { orgId: cur.orgId, cadenceId: cur.id, cadenceStatus: { in: ['ESPERA', 'ATIVA', 'APROVACAO'] } }, select: { id: true } })) throw badRequest('Há leads nesta cadência agora. Desative em vez de apagar.');
  await prisma.sdrCadence.delete({ where: { id: cur.id } });
  res.json({ ok: true });
}));

// ---------- Leads ----------
async function ownersMap(orgId: string) {
  const ms = await prisma.membership.findMany({ where: { orgId }, include: { user: { select: { id: true, name: true } } } });
  return new Map(ms.map((m) => [m.user.id, m.user.name]));
}

sdrRouter.get('/leads', ah(async (req, res) => {
  const orgId = orgOf(req);
  const q = z.object({
    stage: z.enum(STAGES).optional(), temperature: z.enum(['FRIO', 'MORNO', 'QUENTE']).optional(), source: z.enum(['MANUAL', 'IMPORTACAO', 'WHATSAPP', 'FORMULARIO']).optional(),
    owner: z.string().max(40).optional(), q: z.string().max(80).optional(), minScore: z.coerce.number().int().min(0).max(100).optional(),
    order: z.enum(['score', 'recent']).optional(),
  }).parse(req.query);
  const where: Prisma.SdrLeadWhereInput = { orgId };
  if (q.stage) where.stage = q.stage;
  if (q.temperature) where.temperature = q.temperature;
  if (q.source) where.source = q.source;
  if (q.owner) where.ownerUserId = q.owner === 'nenhum' ? null : q.owner;
  if (q.minScore !== undefined) where.score = { gte: q.minScore };
  if (q.q) {
    const t = q.q.trim();
    where.OR = [{ name: contem(t) }, { company: contem(t) }, { email: { contains: t.toLowerCase() } }, { phone: { contains: t.replace(/\D/g, '') || t } }];
  }
  const [items, owners, cads] = await Promise.all([
    prisma.sdrLead.findMany({ where, orderBy: q.order === 'recent' ? { createdAt: 'desc' } : [{ score: 'desc' }, { updatedAt: 'desc' }], take: 500 }),
    ownersMap(orgId),
    prisma.sdrCadence.findMany({ where: { orgId }, select: { id: true, name: true } }),
  ]);
  const cadName = new Map(cads.map((c) => [c.id, c.name]));
  res.json({ items: items.map((l) => leadView(l, { ownerName: l.ownerUserId ? owners.get(l.ownerUserId) ?? null : null, cadenceName: l.cadenceId ? cadName.get(l.cadenceId) ?? null : null })) });
}));

const leadSchema = z.object({
  name: z.string().max(120).optional().nullable(), company: z.string().max(120).optional().nullable(),
  segment: z.enum(SEGMENTS.map((s) => s.id) as [string, ...string[]]).optional().nullable(),
  phone: z.string().max(30).optional().nullable(), email: z.string().max(200).optional().nullable(),
  ownerUserId: z.string().max(40).optional().nullable(), consent: z.boolean().optional(), note: z.string().max(500).optional().nullable(),
});

sdrRouter.post('/leads', ah(async (req, res) => {
  const b = leadSchema.parse(req.body);
  const orgId = orgOf(req);
  await checkOwner(orgId, b.ownerUserId);
  const r = await upsertLead(orgId, b, 'MANUAL');
  await audit(req, 'sdr.lead.create', { orgId, entity: 'sdr_lead', entityId: r.lead.id, meta: { created: r.created } });
  res.status(r.created ? 201 : 200).json({ ...leadView(r.lead), created: r.created });
}));

sdrRouter.get('/leads/:id', ah(async (req, res) => {
  const l = await findLead(req, req.params.id);
  const [events, owners, cad] = await Promise.all([
    prisma.sdrEvent.findMany({ where: { orgId: l.orgId, leadId: l.id }, orderBy: { createdAt: 'desc' }, take: 200 }),
    ownersMap(l.orgId),
    l.cadenceId ? prisma.sdrCadence.findFirst({ where: { id: l.cadenceId, orgId: l.orgId } }) : null,
  ]);
  const s = await getSdrSettings(l.orgId);
  const conv = l.contactId ? await prisma.conversation.findFirst({ where: { orgId: l.orgId, contactId: l.contactId }, orderBy: { lastMessageAt: 'desc' }, select: { id: true } }) : null;
  res.json({
    ...leadView(l, { ownerName: l.ownerUserId ? owners.get(l.ownerUserId) ?? null : null, cadenceName: cad?.name ?? null }),
    questions: questionsOf(s), steps: stepsOf(cad), conversationId: conv?.id ?? null,
    events: events.map((e) => ({ id: e.id, type: e.type, channel: e.channel, detail: cleanEventDetail(e.detail), createdAt: e.createdAt })),
  });
}));

sdrRouter.patch('/leads/:id', ah(async (req, res) => {
  const b = leadSchema.omit({ consent: true, note: true }).extend({ stage: z.enum(STAGES).optional(), consent: z.boolean().optional(), note: z.string().max(500).optional() }).parse(req.body);
  let l = await findLead(req, req.params.id);
  await checkOwner(l.orgId, b.ownerUserId);
  const data: Prisma.SdrLeadUpdateInput = {};
  if (b.name !== undefined) data.name = b.name?.trim() || null;
  if (b.company !== undefined) data.company = b.company?.trim() || null;
  if (b.segment !== undefined) data.segment = b.segment;
  if (b.ownerUserId !== undefined) data.ownerUserId = b.ownerUserId || null;
  // Consentimento: só registra (nunca para quem pediu para sair); retirar = opt-out pela tela.
  if (b.consent === true && !l.consentAt && !l.optOutAt) Object.assign(data, { consentAt: new Date(), consentSource: 'MANUAL' });
  if (b.consent === false && !l.optOutAt) Object.assign(data, { optOutAt: new Date() });
  if (Object.keys(data).length) l = await prisma.sdrLead.update({ where: { id: l.id }, data });
  if (b.consent === true && data.consentAt) await logEvent(l.orgId, l.id, 'NOTA', null, 'Consentimento registrado pela equipe');
  if (b.consent === false && data.optOutAt) { await logEvent(l.orgId, l.id, 'OPTOUT', 'MANUAL', 'Marcado pela equipe'); l = await stopCadence(l, 'SAIU'); }
  if (b.stage && b.stage !== l.stage) l = await setStage(l, b.stage as Stage, { manual: true });
  if (b.note) await logEvent(l.orgId, l.id, 'NOTA', 'MANUAL', b.note);
  await audit(req, 'sdr.lead.update', { orgId: l.orgId, entity: 'sdr_lead', entityId: l.id, meta: { fields: Object.keys(b) } });
  res.json(leadView(l));
}));

/** Aprovação manual: envia agora o passo pendente (respeita consentimento, opt-out e limite diário). */
sdrRouter.post('/leads/:id/aprovar', ah(async (req, res) => {
  const l = await findLead(req, req.params.id);
  if (l.cadenceStatus !== 'APROVACAO') throw badRequest('Este lead não tem passo aguardando aprovação');
  const s = await getSdrSettings(l.orgId);
  const r = await runStep(l, s, new Date(), { approved: true, tz: await tzOf(l.orgId) });
  if (r.waiting === 'limite diário') throw new HttpError(429, 'Limite diário de envios do SDR atingido. Tente amanhã ou aumente o limite.');
  await audit(req, 'sdr.lead.aprovar', { orgId: l.orgId, entity: 'sdr_lead', entityId: l.id, meta: { sent: r.sent } });
  res.json({ sent: r.sent, lead: leadView(r.lead) });
}));

sdrRouter.post('/leads/:id/pular', ah(async (req, res) => {
  const l = await findLead(req, req.params.id);
  if (!['ATIVA', 'APROVACAO'].includes(l.cadenceStatus)) throw badRequest('Nenhum passo para pular');
  const cad = l.cadenceId ? await prisma.sdrCadence.findFirst({ where: { id: l.cadenceId, orgId: l.orgId } }) : null;
  const steps = stepsOf(cad);
  await logEvent(l.orgId, l.id, 'PULO', steps[l.cadenceStep]?.canal ?? null, 'Pulado pela equipe');
  const next = l.cadenceStep + 1;
  const upd = next >= steps.length || !l.cadenceStartedAt
    ? await prisma.sdrLead.update({ where: { id: l.id }, data: { cadenceStep: next, cadenceStatus: 'CONCLUIDA', nextStepAt: null } })
    : await prisma.sdrLead.update({ where: { id: l.id }, data: { cadenceStep: next, cadenceStatus: 'ATIVA', nextStepAt: new Date(l.cadenceStartedAt.getTime() + steps[next].dia * 86400e3) } });
  res.json(leadView(upd));
}));

sdrRouter.post('/leads/:id/parar', ah(async (req, res) => {
  const l = await findLead(req, req.params.id);
  res.json(leadView(await stopCadence(l, 'MANUAL', 'Parada pela equipe')));
}));

/** Coloca (de novo) o lead na cadência do segmento. */
sdrRouter.post('/leads/:id/cadencia', ah(async (req, res) => {
  const l = await findLead(req, req.params.id);
  if (l.optOutAt) throw badRequest('Este lead pediu para sair: não recebe mensagens.');
  const s = await getSdrSettings(l.orgId);
  const upd = await enroll(l, s);
  if (upd.cadenceStatus === l.cadenceStatus && upd.cadenceId === l.cadenceId && upd.nextStepAt === l.nextStepAt) throw badRequest('Nenhuma cadência ativa para o segmento deste lead');
  res.json(leadView(upd));
}));

/** Marca reunião/demonstração na Agenda do MCKBOT (confirmação e lembrete pela própria Agenda). */
sdrRouter.post('/leads/:id/reuniao', ah(async (req, res) => {
  const b = z.object({ inicio: z.string().max(40), duracao: z.number().int().min(5).max(480).optional(), titulo: z.string().max(120).optional() }).parse(req.body);
  const l = await findLead(req, req.params.id);
  const tz = await tzOf(l.orgId);
  const startAt = parseLocal(b.inicio, tz);
  if (!startAt || startAt.getTime() < Date.now()) throw badRequest('Escolha uma data e hora no futuro');
  try {
    const a = await createAppointment({
      kind: 'MEETING', title: b.titulo || `Demonstração com ${l.name || l.company || 'lead'}`, description: 'Marcada pelo SDR', startAt, durationMin: b.duracao,
      contactId: l.contactId, notifyContact: !!l.contactId && !l.optOutAt,
    }, { orgId: l.orgId, userId: req.auth!.userId, req, source: 'MANUAL' });
    if (!l.contactId) {
      // Sem WhatsApp (lead só de e-mail): o hook da Agenda não acha o lead pelo contato.
      let upd = await prisma.sdrLead.update({ where: { id: l.id }, data: { appointmentId: a.id } });
      await logEvent(l.orgId, l.id, 'REUNIAO', null, 'Reunião marcada na Agenda');
      upd = await setStage(upd, 'REUNIAO');
      await stopCadence(upd, 'AGENDOU', 'Reunião marcada');
    }
    res.status(201).json({ appointmentId: a.id, lead: leadView(await prisma.sdrLead.findUniqueOrThrow({ where: { id: l.id } })) });
  } catch (e) {
    if (e instanceof ConflictError) throw new HttpError(409, 'Esse horário já está ocupado na Agenda');
    throw e;
  }
}));

/** Rodízio: distribui agora os leads em aberto que ainda não têm dono (máx. 500 por vez). */
sdrRouter.post('/rodizio/distribuir', admins, ah(async (req, res) => {
  const orgId = orgOf(req);
  if (!(await getV2Config(orgId)).rodizio.enabled) throw badRequest('Ligue o rodízio e escolha os membros primeiro');
  const leads = await prisma.sdrLead.findMany({ where: { orgId, ownerUserId: null, stage: { notIn: ['GANHO', 'PERDIDO'] } }, orderBy: { createdAt: 'asc' }, take: 500 });
  let n = 0;
  for (const l of leads) if ((await assignByRotation(l)).ownerUserId) n++;
  await audit(req, 'sdr.rodizio.distribuir', { orgId, entity: 'sdr_lead', meta: { distribuidos: n } });
  res.json({ distribuidos: n });
}));

// ---------- Importação CSV ----------
sdrRouter.post('/importar', admins, ah(async (req, res) => {
  const b = z.object({ csv: z.string().min(1).max(900_000), consentimento: z.boolean().optional(), segment: z.enum(SEGMENTS.map((s) => s.id) as [string, ...string[]]).optional() }).parse(req.body);
  const orgId = orgOf(req);
  const rows = parseCsv(b.csv);
  if (rows.length > 5000) throw badRequest('Máximo de 5.000 linhas por importação');
  let created = 0, updated = 0, optOut = 0;
  const erros: { linha: number; erro: string }[] = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    try {
      const yes = /^(s|sim|y|yes|1|true|x)$/i.test(r.consentimento ?? '');
      const seg = SEGMENTS.find((s) => s.id === (r.segmento ?? '').toLowerCase() || s.label.toLowerCase() === (r.segmento ?? '').toLowerCase())?.id ?? b.segment ?? null;
      const out = await upsertLead(orgId, { name: r.nome, company: r.empresa, segment: seg, phone: r.telefone, email: r.email, consent: !!b.consentimento || yes }, 'IMPORTACAO');
      if (out.created) created++; else updated++;
      if (out.lead.optOutAt) optOut++;
    } catch (e) {
      if (erros.length < 50) erros.push({ linha: i + 2, erro: (e as Error).message.slice(0, 120) });
    }
  }
  await audit(req, 'sdr.importar', { orgId, entity: 'sdr_lead', meta: { linhas: rows.length, created, updated, optOut, erros: erros.length } });
  res.json({ linhas: rows.length, criados: created, atualizados: updated, comOptOut: optOut, erros });
}));

// ---------- Painel ----------
sdrRouter.get('/painel', ah(async (req, res) => {
  const orgId = orgOf(req);
  const dias = Math.min(365, Math.max(1, Number(req.query.dias) || 30));
  const tz = await tzOf(orgId);
  const since = new Date(startOfDayIn(new Date(), tz).getTime() - (dias - 1) * 86400e3);
  const s = await getSdrSettings(orgId);
  const [byStage, total, ev, upcoming, waiting, hot, sentToday] = await Promise.all([
    prisma.sdrLead.groupBy({ by: ['stage'], where: { orgId }, _count: { _all: true } }),
    prisma.sdrLead.count({ where: { orgId, createdAt: { gte: since } } }),
    prisma.sdrEvent.groupBy({ by: ['type'], where: { orgId, createdAt: { gte: since }, type: { in: ['ENVIO', 'RESPOSTA', 'REUNIAO'] } }, _count: { _all: true } }),
    prisma.sdrLead.findMany({ where: { orgId, cadenceStatus: { in: ['ATIVA', 'ESPERA'] }, nextStepAt: { not: null } }, orderBy: { nextStepAt: 'asc' }, take: 15 }),
    prisma.sdrLead.findMany({ where: { orgId, cadenceStatus: 'APROVACAO' }, orderBy: { updatedAt: 'asc' }, take: 30 }),
    prisma.sdrLead.findMany({ where: { orgId, hotAlertAt: { gte: new Date(Date.now() - 7 * 86400e3) } }, orderBy: { hotAlertAt: 'desc' }, take: 10 }),
    prisma.sdrEvent.count({ where: { orgId, type: 'ENVIO', createdAt: { gte: startOfDayIn(new Date(), tz) } } }),
  ]);
  const distinct = async (type: string) => (await prisma.sdrEvent.groupBy({ by: ['leadId'], where: { orgId, type, createdAt: { gte: since } } })).length;
  const [contatados, responderam, reunioes] = await Promise.all([distinct('ENVIO'), distinct('RESPOSTA'), distinct('REUNIAO')]);
  const qualificados = await prisma.sdrLead.count({ where: { orgId, createdAt: { gte: since }, stage: { in: ['QUALIFICADO', 'REUNIAO', 'GANHO'] } } });
  const ganhos = await prisma.sdrLead.count({ where: { orgId, createdAt: { gte: since }, stage: 'GANHO' } });
  const count = (t: string) => ev.find((e) => e.type === t)?._count._all ?? 0;
  res.json({
    enabled: s.enabled, autoMode: s.autoMode, dias,
    funil: STAGES.map((id) => ({ id, label: STAGE_LABEL[id], total: byStage.find((b) => b.stage === id)?._count._all ?? 0 })),
    metricas: {
      leads: total, contatados, responderam, qualificados, reunioes, ganhos, envios: count('ENVIO'), respostas: count('RESPOSTA'),
      taxaResposta: contatados ? Math.round((responderam / contatados) * 100) : 0,
      conversao: total ? Math.round((ganhos / total) * 100) : 0,
      enviosHoje: sentToday, limiteDiario: s.dailyLimit,
    },
    proximas: upcoming.map((l) => ({ id: l.id, name: l.name, company: l.company, nextStepAt: l.nextStepAt, cadenceStatus: l.cadenceStatus, temperature: l.temperature })),
    aprovar: waiting.map((l) => ({ id: l.id, name: l.name, company: l.company, temperature: l.temperature, score: l.score })),
    quentes: hot.map((l) => ({ id: l.id, name: l.name, company: l.company, score: l.score, aiSummary: l.aiSummary, hotAlertAt: l.hotAlertAt })),
  });
}));

// ---------- Relatórios por cadência e por passo (v1.19.0) ----------
async function cadenceReport(req: Request) {
  const orgId = orgOf(req);
  const dias = Math.min(365, Math.max(1, Number(req.query.dias) || 30));
  const tz = await tzOf(orgId);
  const since = new Date(startOfDayIn(new Date(), tz).getTime() - (dias - 1) * 86400e3);
  // 60 dias antes do período: só para saber qual passo foi o último enviado antes de uma resposta.
  const from = new Date(since.getTime() - 60 * 86400e3);
  const [events, cads] = await Promise.all([
    prisma.sdrEvent.findMany({ where: { orgId, createdAt: { gte: from }, type: { in: ['ENVIO', 'RESPOSTA', 'REUNIAO', 'OPTOUT'] } }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: 100_000, select: { leadId: true, type: true, detail: true, createdAt: true } }),
    prisma.sdrCadence.findMany({ where: { orgId } }),
  ]);
  const untagged = [...new Set(events.filter((e) => e.type === 'ENVIO' && !parseStepTag(e.detail)).map((e) => e.leadId))];
  const leads = untagged.length ? await prisma.sdrLead.findMany({ where: { orgId, id: { in: untagged } }, select: { id: true, cadenceId: true } }) : [];
  const rows = buildCadenceReport(events, since, cads.map((c) => ({ id: c.id, name: c.name, segment: c.segment, steps: stepsOf(c) })), new Map(leads.map((l) => [l.id, l.cadenceId])));
  return { dias, since, rows };
}

sdrRouter.get('/relatorio', ah(async (req, res) => {
  const r = await cadenceReport(req);
  res.json({ dias: r.dias, desde: r.since, cadencias: r.rows.map((c) => ({ ...c, segmentLabel: segmentLabel(c.segment) })) });
}));

sdrRouter.get('/relatorio.csv', ah(async (req, res) => {
  const r = await cadenceReport(req);
  await audit(req, 'sdr.relatorio.exportar', { orgId: orgOf(req), entity: 'sdr_cadence', meta: { dias: r.dias } });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="sdr-cadencias-${r.dias}-dias.csv"`);
  res.setHeader('Cache-Control', 'no-store');
  res.send(cadenceReportCsv(r.rows));
}));

// ---------- Painel Master: SDR por plano (superadmin) ----------
export const sdrMasterRouter = Router();
sdrMasterRouter.get('/', ah(async (_req, res) => res.json(await getSdrPlans())));
sdrMasterRouter.put('/', ah(async (req, res) => {
  const b = z.object({ COMBO: z.boolean().optional(), MCKBOT: z.boolean().optional(), MCKMENSAGEM: z.boolean().optional() }).parse(req.body);
  const r = await setSdrPlans(b);
  await audit(req, 'master.sdr.planos', { orgId: null, entity: 'platform_settings', entityId: 'sdr', meta: r });
  res.json(r);
}));

export { parseJson };
