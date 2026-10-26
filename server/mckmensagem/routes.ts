import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { ah, notFound, HttpError } from '../lib/http.js';
import { orgOf } from '../auth/session.js';
import { audit } from '../lib/audit.js';
import { parseJson } from '../lib/json.js';
import { LEAD_STATUS, CONSENT_SOURCES, toE164 } from './constants.js';
import type { Lead, Campaign } from '@prisma/client';
import { isProductActive } from '../billing/service.js';

export const mckmensagemRouter = Router();

/**
 * Assinatura MCK Mensagens: com o produto inativo (vencido/bloqueado), leitura e exportação continuam
 * liberadas, mas qualquer escrita (criar/editar/excluir/importar/iniciar/pausar) responde 402.
 */
mckmensagemRouter.use(ah(async (req, _res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  if (!(await isProductActive(orgOf(req), 'MCKMENSAGEM'))) throw new HttpError(402, 'Assinatura MCK Mensagens inativa');
  next();
}));

const leadView = (l: Lead) => ({ ...l, tags: parseJson<string[]>(l.tags, []) });
const tagsSchema = z.array(z.string().trim().min(1).max(40)).max(30);
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use o formato HH:MM');

// ---------------- Leads ----------------

mckmensagemRouter.get('/leads', ah(async (req, res) => {
  const q = z.object({
    q: z.string().max(100).optional(), status: z.enum(LEAD_STATUS).optional(), tag: z.string().max(40).optional(),
    campaignId: z.string().optional(), page: z.coerce.number().int().min(1).default(1),
  }).parse(req.query);
  const orgId = orgOf(req);
  const where: any = { orgId };
  if (q.status) where.status = q.status;
  if (q.campaignId) where.campaignId = q.campaignId;
  if (q.tag) where.tags = { contains: JSON.stringify(q.tag) };
  if (q.q) where.OR = [{ name: { contains: q.q } }, { phone: { contains: q.q.replace(/[^\d+]/g, '') || q.q } }];
  const [items, total] = await Promise.all([
    prisma.lead.findMany({ where, orderBy: { createdAt: 'desc' }, take: 50, skip: (q.page - 1) * 50 }),
    prisma.lead.count({ where }),
  ]);
  res.json({ items: items.map(leadView), total, page: q.page, pageSize: 50 });
}));

const leadCreate = z.object({
  phone: z.string().trim().min(8).max(30),
  name: z.string().trim().max(100).optional().nullable(),
  tags: tagsSchema.optional(),
  consentSource: z.enum(CONSENT_SOURCES, { errorMap: () => ({ message: 'Informe a origem do consentimento (FORMULARIO, IMPORTACAO, ANUNCIO_CTWA ou MANUAL)' }) }),
  consentAt: z.coerce.date().optional(),
  campaignId: z.string().optional().nullable(),
});

async function checkCampaign(orgId: string, campaignId?: string | null) {
  if (!campaignId) return;
  if (!(await prisma.campaign.findFirst({ where: { id: campaignId, orgId } }))) throw new HttpError(400, 'Campanha inválida');
}

mckmensagemRouter.post('/leads', ah(async (req, res) => {
  const body = leadCreate.parse(req.body);
  const orgId = orgOf(req);
  const phone = toE164(body.phone);
  if (!phone) throw new HttpError(400, 'Telefone inválido. Use DDI + DDD + número, ex.: +5511999998888');
  await checkCampaign(orgId, body.campaignId);
  if (await prisma.lead.findUnique({ where: { orgId_phone: { orgId, phone } } })) throw new HttpError(409, 'Já existe um lead com este telefone');
  const lead = await prisma.lead.create({
    data: { orgId, phone, name: body.name || null, tags: JSON.stringify(body.tags ?? []), consentSource: body.consentSource, consentAt: body.consentAt ?? new Date(), campaignId: body.campaignId ?? null },
  });
  await audit(req, 'mckmensagem.lead.create', { entity: 'Lead', entityId: lead.id, meta: { consentSource: body.consentSource } });
  res.status(201).json(leadView(lead));
}));

mckmensagemRouter.get('/leads/export', ah(async (req, res) => {
  const orgId = orgOf(req);
  const leads = await prisma.lead.findMany({ where: { orgId }, orderBy: { createdAt: 'asc' } });
  const esc = (v: unknown) => {
    const s = v == null ? '' : v instanceof Date ? v.toISOString() : String(v);
    return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = ['phone', 'name', 'tags', 'status', 'consentSource', 'consentAt', 'optOutAt', 'campaignId', 'createdAt'];
  const rows = leads.map((l) => [l.phone, l.name, parseJson<string[]>(l.tags, []).join('|'), l.status, l.consentSource, l.consentAt, l.optOutAt, l.campaignId, l.createdAt].map(esc).join(','));
  await audit(req, 'mckmensagem.lead.export', { meta: { count: leads.length } });
  res.setHeader('content-type', 'text/csv; charset=utf-8');
  res.setHeader('content-disposition', 'attachment; filename="leads.csv"');
  res.send([header.join(','), ...rows].join('\n'));
}));

mckmensagemRouter.get('/leads/:id', ah(async (req, res) => {
  const lead = await prisma.lead.findFirst({ where: { id: req.params.id, orgId: orgOf(req) } });
  if (!lead) throw notFound('Lead');
  res.json(leadView(lead));
}));

const leadUpdate = z.object({
  name: z.string().trim().max(100).optional().nullable(),
  tags: tagsSchema.optional(),
  status: z.enum(LEAD_STATUS).optional(),
  campaignId: z.string().optional().nullable(),
  optOut: z.boolean().optional(),
});

mckmensagemRouter.patch('/leads/:id', ah(async (req, res) => {
  const body = leadUpdate.parse(req.body);
  const orgId = orgOf(req);
  const lead = await prisma.lead.findFirst({ where: { id: req.params.id, orgId } });
  if (!lead) throw notFound('Lead');
  await checkCampaign(orgId, body.campaignId);
  const data: any = {};
  if (body.name !== undefined) data.name = body.name || null;
  if (body.tags) data.tags = JSON.stringify(body.tags);
  if (body.status) data.status = body.status;
  if (body.campaignId !== undefined) data.campaignId = body.campaignId;
  if (body.optOut !== undefined) data.optOutAt = body.optOut ? (lead.optOutAt ?? new Date()) : null;
  const updated = await prisma.lead.update({ where: { id: lead.id }, data });
  await audit(req, 'mckmensagem.lead.update', { entity: 'Lead', entityId: lead.id, meta: Object.keys(data) });
  res.json(leadView(updated));
}));

mckmensagemRouter.delete('/leads/:id', ah(async (req, res) => {
  const orgId = orgOf(req);
  const lead = await prisma.lead.findFirst({ where: { id: req.params.id, orgId } });
  if (!lead) throw notFound('Lead');
  await prisma.campaignRecipient.deleteMany({ where: { leadId: lead.id } });
  await prisma.lead.delete({ where: { id: lead.id } });
  await audit(req, 'mckmensagem.lead.delete', { entity: 'Lead', entityId: lead.id });
  res.json({ ok: true });
}));

/** Importação CSV: colunas phone,name,tags (tags separadas por "|"). Exige consentimento declarado. */
mckmensagemRouter.post('/leads/import', ah(async (req, res) => {
  const body = z.object({
    text: z.string().min(1).max(2_000_000),
    consentDeclared: z.literal(true, { errorMap: () => ({ message: 'Confirme que todos os leads deram consentimento para receber mensagens' }) }),
    consentSource: z.enum(CONSENT_SOURCES).default('IMPORTACAO'),
    campaignId: z.string().optional().nullable(),
    tags: tagsSchema.optional(),
  }).parse(req.body);
  const orgId = orgOf(req);
  await checkCampaign(orgId, body.campaignId);
  const lines = body.text.split(/\r?\n/);
  const sep = (lines[0] ?? '').includes(';') ? ';' : ',';
  let start = 0;
  if (/phone|telefone|celular|whats/i.test(lines[0] ?? '')) start = 1;
  if (lines.length - start > 10000) throw new HttpError(400, 'Máximo de 10.000 linhas por importação');
  let created = 0, updated = 0;
  const errors: string[] = [];
  const now = new Date();
  for (let i = start; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const [rawPhone, rawName, rawTags] = line.split(sep).map((s) => s.trim().replace(/^"|"$/g, ''));
    const phone = toE164(rawPhone ?? '');
    if (!phone) { errors.push(`Linha ${i + 1}: telefone inválido`); continue; }
    const tags = [...new Set([...(rawTags ? rawTags.split('|').map((t) => t.trim()).filter(Boolean) : []), ...(body.tags ?? [])])].slice(0, 30);
    const existing = await prisma.lead.findUnique({ where: { orgId_phone: { orgId, phone } } });
    if (existing) {
      const merged = [...new Set([...parseJson<string[]>(existing.tags, []), ...tags])].slice(0, 30);
      await prisma.lead.update({ where: { id: existing.id }, data: { name: existing.name ?? (rawName || null), tags: JSON.stringify(merged), ...(body.campaignId ? { campaignId: body.campaignId } : {}) } });
      updated++;
    } else {
      await prisma.lead.create({ data: { orgId, phone, name: rawName || null, tags: JSON.stringify(tags), consentSource: body.consentSource, consentAt: now, campaignId: body.campaignId ?? null } });
      created++;
    }
  }
  await audit(req, 'mckmensagem.lead.import', { meta: { created, updated, errors: errors.length, consentSource: body.consentSource } });
  res.json({ created, updated, errors: errors.slice(0, 100) });
}));

// ---------------- Campanhas ----------------

const campaignBase = z.object({
  name: z.string().trim().min(1).max(120),
  message: z.string().trim().min(1).max(4000),
  channelId: z.string().min(1),
  dailyLimit: z.number().int().min(1).max(1000).optional(),
  minIntervalSec: z.number().int().min(10).max(3600).optional(),
  maxIntervalSec: z.number().int().min(10).max(7200).optional(),
  windowStart: hhmm.optional(),
  windowEnd: hhmm.optional(),
});

async function checkChannel(orgId: string, channelId?: string) {
  if (!channelId) return;
  if (!(await prisma.channel.findFirst({ where: { id: channelId, orgId } }))) throw new HttpError(400, 'Canal WhatsApp inválido');
}
function checkIntervals(min: number, max: number) {
  if (min > max) throw new HttpError(400, 'O intervalo mínimo não pode ser maior que o máximo');
}
async function getCampaign(orgId: string, id: string): Promise<Campaign> {
  const c = await prisma.campaign.findFirst({ where: { id, orgId } });
  if (!c) throw notFound('Campanha');
  return c;
}
async function campaignView(c: Campaign) {
  const groups = await prisma.campaignRecipient.groupBy({ by: ['status'], where: { campaignId: c.id }, _count: { _all: true } });
  const recipients = Object.fromEntries(groups.map((g) => [g.status, g._count._all]));
  return { ...c, recipients };
}

mckmensagemRouter.get('/campaigns', ah(async (req, res) => {
  const items = await prisma.campaign.findMany({ where: { orgId: orgOf(req) }, orderBy: { createdAt: 'desc' } });
  res.json(await Promise.all(items.map(campaignView)));
}));

mckmensagemRouter.post('/campaigns', ah(async (req, res) => {
  const body = campaignBase.parse(req.body);
  const orgId = orgOf(req);
  await checkChannel(orgId, body.channelId);
  checkIntervals(body.minIntervalSec ?? 45, body.maxIntervalSec ?? 120);
  const c = await prisma.campaign.create({ data: { orgId, ...body } });
  await audit(req, 'mckmensagem.campaign.create', { entity: 'Campaign', entityId: c.id });
  res.status(201).json(await campaignView(c));
}));

mckmensagemRouter.get('/campaigns/:id', ah(async (req, res) => {
  res.json(await campaignView(await getCampaign(orgOf(req), req.params.id)));
}));

mckmensagemRouter.patch('/campaigns/:id', ah(async (req, res) => {
  const body = campaignBase.partial().parse(req.body);
  const orgId = orgOf(req);
  const c = await getCampaign(orgId, req.params.id);
  await checkChannel(orgId, body.channelId);
  checkIntervals(body.minIntervalSec ?? c.minIntervalSec, body.maxIntervalSec ?? c.maxIntervalSec);
  const updated = await prisma.campaign.update({ where: { id: c.id }, data: body });
  await audit(req, 'mckmensagem.campaign.update', { entity: 'Campaign', entityId: c.id, meta: Object.keys(body) });
  res.json(await campaignView(updated));
}));

mckmensagemRouter.delete('/campaigns/:id', ah(async (req, res) => {
  const orgId = orgOf(req);
  const c = await getCampaign(orgId, req.params.id);
  await prisma.campaignRecipient.deleteMany({ where: { campaignId: c.id } });
  await prisma.lead.updateMany({ where: { orgId, campaignId: c.id }, data: { campaignId: null } });
  await prisma.campaign.delete({ where: { id: c.id } });
  await audit(req, 'mckmensagem.campaign.delete', { entity: 'Campaign', entityId: c.id });
  res.json({ ok: true });
}));

/**
 * Inicia (ou retoma) a campanha. Destinatários: leadIds informados, ou leads com a etiqueta "tag",
 * ou, por padrão, os leads vinculados à campanha (campaignId). Só entram leads com consentimento e sem opt-out.
 */
mckmensagemRouter.post('/campaigns/:id/start', ah(async (req, res) => {
  const body = z.object({ leadIds: z.array(z.string()).max(10000).optional(), tag: z.string().max(40).optional() }).parse(req.body ?? {});
  const orgId = orgOf(req);
  const c = await getCampaign(orgId, req.params.id);
  if (c.status === 'CONCLUIDA' && !body.leadIds && !body.tag) throw new HttpError(400, 'Campanha já concluída. Informe novos leads para reabrir.');
  await checkChannel(orgId, c.channelId);
  const where: any = { orgId, optOutAt: null, status: { not: 'DESCARTADO' } };
  if (body.leadIds) where.id = { in: body.leadIds };
  else if (body.tag) where.tags = { contains: JSON.stringify(body.tag) };
  else where.campaignId = c.id;
  const leads = await prisma.lead.findMany({ where, select: { id: true, consentAt: true } });
  let added = 0;
  for (const l of leads) {
    if (!l.consentAt) continue;
    const exists = await prisma.campaignRecipient.findUnique({ where: { campaignId_leadId: { campaignId: c.id, leadId: l.id } } });
    if (exists) continue;
    await prisma.campaignRecipient.create({ data: { campaignId: c.id, leadId: l.id } });
    added++;
  }
  const pending = await prisma.campaignRecipient.count({ where: { campaignId: c.id, status: 'PENDENTE' } });
  if (!pending) throw new HttpError(400, 'Nenhum lead elegível (com consentimento e sem opt-out) para esta campanha');
  const updated = await prisma.campaign.update({ where: { id: c.id }, data: { status: 'EM_ANDAMENTO' } });
  await audit(req, 'mckmensagem.campaign.start', { entity: 'Campaign', entityId: c.id, meta: { added, pending } });
  res.json({ ...(await campaignView(updated)), added, pending });
}));

mckmensagemRouter.post('/campaigns/:id/pause', ah(async (req, res) => {
  const c = await getCampaign(orgOf(req), req.params.id);
  if (c.status !== 'EM_ANDAMENTO' && c.status !== 'AGENDADA') throw new HttpError(400, 'Só é possível pausar uma campanha em andamento');
  const updated = await prisma.campaign.update({ where: { id: c.id }, data: { status: 'PAUSADA' } });
  await audit(req, 'mckmensagem.campaign.pause', { entity: 'Campaign', entityId: c.id });
  res.json(await campaignView(updated));
}));

// ---------------- Métricas ----------------

mckmensagemRouter.get('/metrics', ah(async (req, res) => {
  const q = z.object({ campaignId: z.string().optional() }).parse(req.query);
  const orgId = orgOf(req);
  if (q.campaignId) await getCampaign(orgId, q.campaignId);
  const leadWhere: any = { orgId, ...(q.campaignId ? { campaignId: q.campaignId } : {}) };
  const groups = await prisma.lead.groupBy({ by: ['status'], where: leadWhere, _count: { _all: true } });
  const byStatus: Record<string, number> = Object.fromEntries(LEAD_STATUS.map((s) => [s, 0]));
  for (const g of groups) byStatus[g.status] = g._count._all;
  const campaignIds = q.campaignId ? [q.campaignId] : (await prisma.campaign.findMany({ where: { orgId }, select: { id: true } })).map((c) => c.id);
  const sent = campaignIds.length ? await prisma.campaignRecipient.count({ where: { campaignId: { in: campaignIds }, status: 'ENVIADA' } }) : 0;
  const failed = campaignIds.length ? await prisma.campaignRecipient.count({ where: { campaignId: { in: campaignIds }, status: 'FALHOU' } }) : 0;
  const optOuts = await prisma.lead.count({ where: { ...leadWhere, optOutAt: { not: null } } });
  const replies = byStatus.RESPONDEU + byStatus.CONVERTIDO;
  const contacted = byStatus.CONTATADO + replies;
  const rate = (n: number) => (contacted ? Math.round((n / contacted) * 10000) / 100 : 0);
  res.json({
    totalLeads: Object.values(byStatus).reduce((a, b) => a + b, 0), byStatus, sent, failed, optOuts,
    replies, responseRate: rate(replies), conversionRate: rate(byStatus.CONVERTIDO),
  });
}));
