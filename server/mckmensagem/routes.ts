import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { ah, notFound, HttpError } from '../lib/http.js';
import { orgOf, requireRole } from '../auth/session.js';
import { audit } from '../lib/audit.js';
import { parseJson } from '../lib/json.js';
import { LEAD_STATUS, CONSENT_SOURCES, toE164 } from './constants.js';
import type { Lead, Campaign } from '@prisma/client';
import { isProductActive } from '../billing/service.js';
import { getLeadAiSettings, classifyLeadMessage, buildQualifyPrompt, DEFAULT_PROMPT_TEMPLATE, PROMPT_VARIABLES, lockedPromptTail } from './qualificacao.js';

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

/** Excluir contatos é restrito a OWNER/ADMIN (AGENT recebe 403). */
const canDeleteLeads = requireRole('OWNER', 'ADMIN');
const isLeadAdmin = (req: { auth?: { role?: string | null } }) => req.auth?.role === 'OWNER' || req.auth?.role === 'ADMIN';

/** Exclui leads da org e o histórico de envio (CampaignRecipient, sem FK declarada) numa transação. */
async function deleteLeadsOfOrg(orgId: string, ids: string[]) {
  return prisma.$transaction(async (tx) => {
    const found = (await tx.lead.findMany({ where: { orgId, id: { in: ids } }, select: { id: true } })).map((l) => l.id);
    if (!found.length) return [] as string[];
    await tx.campaignRecipient.deleteMany({ where: { leadId: { in: found } } });
    await tx.lead.deleteMany({ where: { orgId, id: { in: found } } });
    return found;
  });
}

const leadView = (l: Lead) => ({ ...l, tags: parseJson<string[]>(l.tags, []) });
const tagsSchema = z.array(z.string().trim().min(1).max(40)).max(30);
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use o formato HH:MM');

// ---------------- Leads ----------------

/** Filtro de leads (lista, seleção "todos que atendem ao filtro" e ações em massa). campaignId="none" = sem campanha. */
const leadFilterSchema = z.object({
  q: z.string().max(100).optional(), status: z.enum(LEAD_STATUS).optional(), tag: z.string().max(40).optional(),
  campaignId: z.string().max(40).optional(), notCampaignId: z.string().max(40).optional(), optOut: z.enum(['sim', 'nao']).optional(),
});
type LeadFilter = z.infer<typeof leadFilterSchema>;

function leadWhere(orgId: string, q: LeadFilter) {
  const where: any = { orgId };
  if (q.status) where.status = q.status;
  if (q.campaignId) where.campaignId = q.campaignId === 'none' ? null : q.campaignId;
  if (q.notCampaignId) where.AND = [{ OR: [{ campaignId: null }, { campaignId: { not: q.notCampaignId } }] }];
  if (q.optOut) where.optOutAt = q.optOut === 'sim' ? { not: null } : null;
  if (q.tag) where.tags = { contains: JSON.stringify(q.tag) };
  if (q.q) where.OR = [{ name: { contains: q.q } }, { phone: { contains: q.q.replace(/[^\d+]/g, '') || q.q } }];
  return where;
}

mckmensagemRouter.get('/leads', ah(async (req, res) => {
  const q = leadFilterSchema.extend({ page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(200).default(50) }).parse(req.query);
  const where = leadWhere(orgOf(req), q);
  const [items, total] = await Promise.all([
    prisma.lead.findMany({ where, orderBy: { createdAt: 'desc' }, take: q.pageSize, skip: (q.page - 1) * q.pageSize }),
    prisma.lead.count({ where }),
  ]);
  res.json({ items: items.map(leadView), total, page: q.page, pageSize: q.pageSize });
}));

export const BULK_MAX = 10_000;
const bulkSchema = z.object({
  ids: z.array(z.string().min(1).max(40)).min(1).max(BULK_MAX).optional(),
  filter: leadFilterSchema.optional(),
  action: z.enum(['setCampaign', 'removeCampaign', 'addTags', 'removeTags', 'setStatus', 'optOut', 'optIn', 'delete']),
  campaignId: z.string().min(1).optional(),
  tags: tagsSchema.optional(),
  status: z.enum(LEAD_STATUS).optional(),
  /** Campanha em andamento/pausada: também coloca os elegíveis na fila de envio (padrão: sim). */
  addToQueue: z.boolean().default(true),
}).refine((b) => !!b.ids !== !!b.filter, 'Informe "ids" ou "filter" (um dos dois)')
  .refine((b) => b.action !== 'setCampaign' || !!b.campaignId, 'Escolha a campanha')
  .refine((b) => !['addTags', 'removeTags'].includes(b.action) || !!b.tags?.length, 'Informe ao menos uma etiqueta')
  .refine((b) => b.action !== 'setStatus' || !!b.status, 'Escolha o status');

/**
 * Ações em massa nos contatos: por lista de ids ou por "todos que atendem ao filtro" (limite de 10.000 por vez).
 * Respeita isolamento por organização, a regra 402 (middleware) e grava auditoria.
 */
mckmensagemRouter.post('/leads/bulk', ah(async (req, res) => {
  const b = bulkSchema.parse(req.body);
  if (b.action === 'delete' && !isLeadAdmin(req)) throw new HttpError(403, 'Apenas proprietário ou administrador pode excluir contatos');
  const orgId = orgOf(req);
  const where = b.ids ? { orgId, id: { in: [...new Set(b.ids)] } } : leadWhere(orgId, b.filter!);
  const matched = await prisma.lead.count({ where });
  if (matched > BULK_MAX) throw new HttpError(400, `A seleção tem ${matched} contatos; o limite por operação é ${BULK_MAX}. Refine os filtros.`);
  const leads = matched ? await prisma.lead.findMany({ where, select: { id: true, tags: true, optOutAt: true, consentAt: true, status: true, campaignId: true } }) : [];
  const ids = leads.map((l) => l.id);
  let updated = 0, queued = 0;
  const chunks = <T,>(arr: T[], n = 500) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));
  let campaign: Campaign | null = null;
  if (b.action === 'setCampaign') campaign = await getCampaign(orgId, b.campaignId!);
  if (b.action === 'removeCampaign' && b.campaignId) campaign = await getCampaign(orgId, b.campaignId);

  switch (b.action) {
    case 'setCampaign': {
      for (const part of chunks(ids)) updated += (await prisma.lead.updateMany({ where: { orgId, id: { in: part } }, data: { campaignId: campaign!.id } })).count;
      if (b.addToQueue && (campaign!.status === 'EM_ANDAMENTO' || campaign!.status === 'PAUSADA')) {
        const elegiveis = leads.filter((l) => !l.optOutAt && l.consentAt && l.status !== 'DESCARTADO').map((l) => l.id);
        for (const part of chunks(elegiveis)) {
          const ja = new Set((await prisma.campaignRecipient.findMany({ where: { campaignId: campaign!.id, leadId: { in: part } }, select: { leadId: true } })).map((r) => r.leadId));
          const novos = part.filter((id) => !ja.has(id)).map((leadId) => ({ campaignId: campaign!.id, leadId }));
          if (novos.length) queued += (await prisma.campaignRecipient.createMany({ data: novos })).count;
        }
      }
      break;
    }
    case 'removeCampaign': {
      // Sem campaignId: tira de qualquer campanha. Com campaignId: só de quem está nela. Envios já feitos ficam no histórico.
      const alvo = campaign ? leads.filter((l) => l.campaignId === campaign!.id).map((l) => l.id) : ids;
      for (const part of chunks(alvo)) {
        updated += (await prisma.lead.updateMany({ where: { orgId, id: { in: part } }, data: { campaignId: null } })).count;
        const camps = campaign ? [campaign.id] : [...new Set(leads.filter((l) => l.campaignId).map((l) => l.campaignId!))];
        if (camps.length) await prisma.campaignRecipient.deleteMany({ where: { campaignId: { in: camps }, leadId: { in: part }, status: 'PENDENTE' } });
      }
      break;
    }
    case 'addTags': case 'removeTags': {
      for (const l of leads) {
        const atual = parseJson<string[]>(l.tags, []);
        const novo = b.action === 'addTags' ? [...new Set([...atual, ...b.tags!])].slice(0, 30) : atual.filter((t) => !b.tags!.includes(t));
        if (novo.length === atual.length && novo.every((t, i) => t === atual[i])) continue;
        await prisma.lead.update({ where: { id: l.id }, data: { tags: JSON.stringify(novo) } });
        updated++;
      }
      break;
    }
    case 'setStatus':
      for (const part of chunks(ids)) updated += (await prisma.lead.updateMany({ where: { orgId, id: { in: part } }, data: { status: b.status! } })).count;
      break;
    case 'optOut': {
      const now = new Date();
      for (const part of chunks(ids)) updated += (await prisma.lead.updateMany({ where: { orgId, id: { in: part }, optOutAt: null }, data: { optOutAt: now } })).count;
      break;
    }
    case 'optIn':
      for (const part of chunks(ids)) updated += (await prisma.lead.updateMany({ where: { orgId, id: { in: part }, optOutAt: { not: null } }, data: { optOutAt: null } })).count;
      break;
    case 'delete':
      for (const part of chunks(ids)) {
        await prisma.campaignRecipient.deleteMany({ where: { leadId: { in: part } } });
        updated += (await prisma.lead.deleteMany({ where: { orgId, id: { in: part } } })).count;
      }
      break;
  }
  await audit(req, 'mckmensagem.lead.bulk', { meta: { action: b.action, por: b.ids ? 'ids' : 'filtro', filtro: b.filter ?? null, matched, updated, queued, campaignId: b.campaignId ?? null, status: b.status ?? null, tags: b.tags ?? null } });
  if (b.action === 'delete') await audit(req, 'leads.bulk_delete', { entity: 'Lead', meta: { por: b.ids ? 'ids' : 'filtro', requested: b.ids ? new Set(b.ids).size : matched, deleted: updated } });
  res.json({ matched, updated, queued });
}));

/** Exclusão em massa por ids (até 500 por requisição). Ids de outra organização são ignorados. */
export const BULK_DELETE_MAX = 500;
const bulkDeleteSchema = z.object({
  ids: z.array(z.string().trim().min(1).max(40), { required_error: 'Informe os contatos a excluir' })
    .min(1, 'Selecione ao menos um contato').max(BULK_DELETE_MAX, `Exclua no máximo ${BULK_DELETE_MAX} contatos por vez`),
}).strict();

mckmensagemRouter.post('/leads/bulk-delete', canDeleteLeads, ah(async (req, res) => {
  const { ids } = bulkDeleteSchema.parse(req.body);
  const unique = [...new Set(ids)];
  const deleted = await deleteLeadsOfOrg(orgOf(req), unique);
  await audit(req, 'leads.bulk_delete', { entity: 'Lead', meta: { requested: unique.length, deleted: deleted.length, ids: deleted } });
  res.json({ requested: unique.length, deleted: deleted.length });
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
    const t = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s; // evita fórmula ao abrir no Excel/Planilhas
    return /[",\n;]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
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

mckmensagemRouter.delete('/leads/:id', canDeleteLeads, ah(async (req, res) => {
  const deleted = await deleteLeadsOfOrg(orgOf(req), [String(req.params.id)]);
  if (!deleted.length) throw notFound('Lead');
  await audit(req, 'leads.delete', { entity: 'Lead', entityId: deleted[0], meta: { count: 1 } });
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
  const replies = byStatus.RESPONDEU + byStatus.QUALIFICADO + byStatus.AGUARDANDO + byStatus.CONVERTIDO;
  const contacted = byStatus.CONTATADO + replies;
  const rate = (n: number) => (contacted ? Math.round((n / contacted) * 10000) / 100 : 0);
  res.json({
    totalLeads: Object.values(byStatus).reduce((a, b) => a + b, 0), byStatus, sent, failed, optOuts,
    replies, responseRate: rate(replies), conversionRate: rate(byStatus.CONVERTIDO),
  });
}));

// ---------------- IA de qualificação de leads ----------------

const leadAiSchema = z.object({
  enabled: z.boolean().optional(),
  instructions: z.string().max(4000).optional(),
  offer: z.string().max(1000).optional(),
  positiveAction: z.enum(['HANDOFF', 'FLOW', 'BOT']).optional(),
  positiveFlowId: z.string().max(40).nullable().optional(),
  retryDays: z.number().int().min(1).max(60).optional(),
  maxAttempts: z.number().int().min(1).max(10).optional(),
  retryMessage: z.string().trim().min(1).max(1000).optional(),
  promptTemplate: z.string().max(8000).nullable().optional(),
  positiveMessage: z.string().max(1000).optional(),
  negativeAction: z.enum(['RETRY', 'FLOW', 'HANDOFF', 'DISCARD']).optional(),
  negativeFlowId: z.string().max(40).nullable().optional(),
  doubtAction: z.enum(['AI', 'FLOW', 'HANDOFF']).optional(),
  doubtFlowId: z.string().max(40).nullable().optional(),
  tagPositive: z.string().trim().max(40).optional(),
  tagWaiting: z.string().trim().max(40).optional(),
  tagDiscarded: z.string().trim().max(40).optional(),
});

async function leadAiView(orgId: string) {
  const [settings, flows, ai, aguardando, qualificados] = await Promise.all([
    getLeadAiSettings(orgId),
    prisma.flow.findMany({ where: { orgId, status: 'ACTIVE' }, select: { id: true, name: true }, orderBy: { name: 'asc' } }),
    prisma.aiSettings.findUnique({ where: { orgId } }),
    prisma.lead.count({ where: { orgId, status: 'AGUARDANDO' } }),
    prisma.lead.count({ where: { orgId, status: 'QUALIFICADO' } }),
  ]);
  return {
    settings, flows, aiReady: !!(ai?.apiKeyEnc || ai?.provider === 'fake'), aiProvider: ai?.provider ?? null, aiModel: ai?.model ?? null,
    counts: { aguardando, qualificados },
    defaultPromptTemplate: DEFAULT_PROMPT_TEMPLATE, promptVariables: PROMPT_VARIABLES, lockedPrompt: lockedPromptTail('(trechos da base de conhecimento)').trim(),
    prompt: buildQualifyPrompt(settings as any, { tone: ai?.tone ?? '', companyInstructions: ai?.instructions ?? '', knowledge: '(trechos da base de conhecimento encontrados para a mensagem do lead)', leadName: '{nome}', attempts: 0, maxAttempts: settings.maxAttempts }),
  };
}

mckmensagemRouter.get('/ia-leads', ah(async (req, res) => {
  res.json(await leadAiView(orgOf(req)));
}));

mckmensagemRouter.put('/ia-leads', ah(async (req, res) => {
  const orgId = orgOf(req);
  const data = leadAiSchema.parse(req.body);
  if (data.promptTemplate !== undefined) {
    const t = data.promptTemplate?.trim() ?? '';
    data.promptTemplate = !t || t === DEFAULT_PROMPT_TEMPLATE.trim() ? null : t;
  }
  const cur = await getLeadAiSettings(orgId);
  const checkFlow = async (action: string | undefined, flowId: string | null | undefined, fallback: string | null, label: string) => {
    if (action !== 'FLOW') return;
    const id = flowId === undefined ? fallback : flowId;
    if (!id || !(await prisma.flow.findFirst({ where: { id, orgId } }))) throw new HttpError(400, `Escolha o fluxo para ${label}`);
  };
  await checkFlow(data.positiveAction, data.positiveFlowId, cur.positiveFlowId, 'o lead interessado');
  await checkFlow(data.negativeAction, data.negativeFlowId, cur.negativeFlowId, 'o lead sem interesse');
  await checkFlow(data.doubtAction, data.doubtFlowId, cur.doubtFlowId, 'o lead com dúvida');
  await prisma.leadAiSettings.upsert({ where: { orgId }, create: { orgId, ...data }, update: data });
  await audit(req, 'mckmensagem.ia_leads.update', { entity: 'LeadAiSettings', entityId: orgId });
  res.json(await leadAiView(orgId));
}));

/** Simula a resposta de um lead (nada é enviado e nenhum lead é alterado). */
mckmensagemRouter.post('/ia-leads/testar', ah(async (req, res) => {
  const q = z.object({ texto: z.string().trim().min(1).max(1000), nome: z.string().max(80).optional() }).parse(req.body);
  try {
    const r = await classifyLeadMessage(orgOf(req), { name: q.nome ?? 'Cliente', qualifyAttempts: 0 }, q.texto);
    res.json(r);
  } catch (e) {
    throw new HttpError(400, (e as Error).message);
  }
}));
