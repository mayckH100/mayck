import express, { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { ah, notFound, HttpError } from '../lib/http.js';
import { orgOf, requireRole } from '../auth/session.js';
import { audit } from '../lib/audit.js';
import { parseJson } from '../lib/json.js';
import { LEAD_STATUS, CONSENT_SOURCES, toE164 } from './constants.js';
import type { Lead, Campaign } from '@prisma/client';
import { isProductActive } from '../billing/service.js';
import { contactIdForPhone, mirrorLeadsToContacts } from './contactSync.js';
import { parseCsv, detectDelimiter, mapHeaderCell, rowFromCells, MAX_PHONES_PER_ROW, type HeaderCol } from '../lib/contacts-import.js';
import { nameKey, siblingsOf, otherNumbersCount } from '../lib/same-client.js';
import { mckIaReady } from '../ai/mckIa.js';
import { qualiView, saveQualiFromRequest, testQuali } from '../sdr/qualificacaoRoutes.js';
import { gruposDaCampanha, contarGrupos, gerarTextoRepescagem } from './repescagem.js';
import { GRUPOS, GRUPO_ROTULO, REPESCAGEM_LIMITES, textoModelo } from './repescagemCore.js';
import { reenviarFalhasDeConexao, contarFalhasDeConexao, resultadoAb, textoDaCampanha } from './dispatcher.js';
import { MAX_VARIACOES, AB_LIMITES, lerVariacoes, normalizarDias, validarAgendamento, versoesDaCampanha } from './variacoes.js';
import { sendOutbound } from '../whatsapp/messaging.js';
import { openConversationFor } from '../whatsapp/multiCanal.js';
import { canalConectado } from '../whatsapp/conexao.js';
import { payloadDaCampanha } from './dispatcher.js';
import {
  MIDIA_TIPOS, maxMbDoTipo, lerMidias, definirMidia, erroLegenda, RECORRENCIAS, ehRecorrencia, proximaDepoisDe, proximaExecucao, diaDoMesBrt, erroFimRecorrencia,
  lerCanais, MAX_CANAIS_RODIZIO, lerPublico, erroFiltroErp, filtroErpVazio, type Publico, type FiltroErp,
} from './campanhaCore.js';
import { midiasView, leadsDoPublico, previaSegmentoErp } from './campanhaExtras.js';
import { salvarArquivo, detectarTipo, getArquivo, lerConteudo } from './automacoes/arquivos.js';
import { riscoLiberado, CONFIRMAR_RISCO, AVISO_RISCO_FIXO } from './campanhaCore.js';
import { allowedChannels } from '../lib/permissions.js';
import { saudeDoNumero } from '../whatsapp/protecao/service.js';
import { channelLabels } from '../whatsapp/channelLabel.js';
import type { Request } from 'express';
import { cnpjRouter } from './cnpjRoutes.js';

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

// v1.53.0: Consulta CNPJ / Prospecção.
mckmensagemRouter.use('/cnpj', cnpjRouter);

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

/** fromMckbot: é o mesmo contato do MCKBOT (vinculado); consentPending: ainda não pode receber campanhas. */
const leadView = (l: Lead) => ({ ...l, tags: parseJson<string[]>(l.tags, []), fromMckbot: !!l.contactId, consentPending: !l.consentAt });
const tagsSchema = z.array(z.string().trim().min(1).max(40)).max(30);
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use o formato HH:MM');

// ---------------- Leads ----------------

/** Filtro de leads (lista, seleção "todos que atendem ao filtro" e ações em massa). campaignId="none" = sem campanha. */
const leadFilterSchema = z.object({
  q: z.string().max(100).optional(), status: z.enum(LEAD_STATUS).optional(), tag: z.string().max(40).optional(),
  campaignId: z.string().max(40).optional(), notCampaignId: z.string().max(40).optional(), optOut: z.enum(['sim', 'nao']).optional(),
  /** sim = com consentimento registrado; nao = consentimento pendente (ex.: contatos vindos do MCKBOT). */
  consent: z.enum(['sim', 'nao']).optional(),
});
type LeadFilter = z.infer<typeof leadFilterSchema>;

function leadWhere(orgId: string, q: LeadFilter) {
  const where: any = { orgId };
  if (q.status) where.status = q.status;
  if (q.campaignId) where.campaignId = q.campaignId === 'none' ? null : q.campaignId;
  if (q.notCampaignId) where.AND = [{ OR: [{ campaignId: null }, { campaignId: { not: q.notCampaignId } }] }];
  if (q.optOut) where.optOutAt = q.optOut === 'sim' ? { not: null } : null;
  if (q.consent) where.consentAt = q.consent === 'sim' ? { not: null } : null;
  if (q.tag) where.tags = { contains: JSON.stringify(q.tag) };
  if (q.q) where.OR = [{ name: { contains: q.q } }, { phone: { contains: q.q.replace(/[^\d+]/g, '') || q.q } }, { empresa: { contains: q.q } }, ...(q.q.replace(/\D/g, '').length >= 8 ? [{ cnpj: { contains: q.q.replace(/\D/g, '') } }] : [])];
  return where;
}

mckmensagemRouter.get('/leads', ah(async (req, res) => {
  const q = leadFilterSchema.extend({ page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(200).default(50) }).parse(req.query);
  const where = leadWhere(orgOf(req), q);
  const [items, total] = await Promise.all([
    prisma.lead.findMany({ where, orderBy: { createdAt: 'desc' }, take: q.pageSize, skip: (q.page - 1) * q.pageSize }),
    prisma.lead.count({ where }),
  ]);
  // "Mesmo cliente / outros números": outros telefones com o mesmo nome (normalizado) na organização.
  const orgId = orgOf(req);
  const names = items.some((l) => nameKey(l.name)) ? await prisma.lead.findMany({ where: { orgId, name: { not: null } }, select: { id: true, name: true, phone: true } }) : [];
  const counts = otherNumbersCount(items, names);
  res.json({ items: items.map((l) => ({ ...leadView(l), otherNumbers: counts.get(l.id) ?? 0 })), total, page: q.page, pageSize: q.pageSize });
}));

export const BULK_MAX = 10_000;
const bulkSchema = z.object({
  ids: z.array(z.string().min(1).max(40)).min(1).max(BULK_MAX).optional(),
  filter: leadFilterSchema.optional(),
  action: z.enum(['setCampaign', 'removeCampaign', 'addTags', 'removeTags', 'setStatus', 'optOut', 'optIn', 'delete', 'registerConsent', 'addToClientes']),
  campaignId: z.string().min(1).optional(),
  tags: tagsSchema.optional(),
  status: z.enum(LEAD_STATUS).optional(),
  /** Campanha em andamento/pausada: também coloca os elegíveis na fila de envio (padrão: sim). */
  addToQueue: z.boolean().default(true),
  /** registerConsent: origem do consentimento e a declaração de quem registra (obrigatória). */
  consentSource: z.enum(CONSENT_SOURCES).optional(),
  consentDeclared: z.boolean().optional(),
}).refine((b) => !!b.ids !== !!b.filter, 'Informe "ids" ou "filter" (um dos dois)')
  .refine((b) => b.action !== 'setCampaign' || !!b.campaignId, 'Escolha a campanha')
  .refine((b) => !['addTags', 'removeTags'].includes(b.action) || !!b.tags?.length, 'Informe ao menos uma etiqueta')
  .refine((b) => b.action !== 'setStatus' || !!b.status, 'Escolha o status')
  .refine((b) => b.action !== 'registerConsent' || b.consentDeclared === true, 'Confirme que estes contatos autorizaram receber mensagens');

/**
 * Contatos → clientes de Automações/Cobranças (para lembretes, marketing e cobranças). Mescla pelo telefone/WhatsApp
 * (ou pelo vínculo com o contato do MCKBOT): cliente existente só ganha os campos vazios. Consentimento e opt-out do
 * lead passam para o cliente. Retorna quantos clientes foram criados ou atualizados.
 */
async function leadsToClientes(orgId: string, ids: string[]): Promise<number> {
  let n = 0;
  for (let i = 0; i < ids.length; i += 500) {
    const leads = await prisma.lead.findMany({ where: { orgId, id: { in: ids.slice(i, i + 500) } } });
    const cIds = leads.map((l) => l.contactId).filter((x): x is string => !!x);
    const contacts = new Map((cIds.length ? await prisma.contact.findMany({ where: { orgId, id: { in: cIds } }, select: { id: true, name: true, email: true, vars: true } }) : []).map((c) => [c.id, c]));
    for (const l of leads) {
      const ct = l.contactId ? contacts.get(l.contactId) : undefined;
      const email = ct?.email ? ct.email.trim().toLowerCase().slice(0, 160) : null;
      const empresaRaw = parseJson<Record<string, unknown>>(ct?.vars, {}).empresa;
      const empresa = typeof empresaRaw === 'string' && empresaRaw.trim() ? empresaRaw.trim().slice(0, 160) : null;
      const or: any[] = [{ telefone: l.phone }, { whatsapp: l.phone }];
      if (l.contactId) or.push({ contactId: l.contactId });
      const dup = await prisma.cliente.findFirst({ where: { orgId, OR: or } });
      if (dup) {
        const data: any = {};
        if (!dup.whatsapp) data.whatsapp = l.phone;
        if (!dup.email && email) data.email = email;
        if (!dup.empresa && empresa) data.empresa = empresa;
        if (!dup.contactId && l.contactId) data.contactId = l.contactId;
        if (!dup.consentimentoAt && l.consentAt) { data.consentimentoAt = l.consentAt; data.consentimentoOrigem = l.consentSource; }
        if (!dup.marketingOptOutAt && l.optOutAt) data.marketingOptOutAt = l.optOutAt;
        if (Object.keys(data).length) { await prisma.cliente.update({ where: { id: dup.id }, data }); n++; }
        continue;
      }
      await prisma.cliente.create({
        data: {
          orgId, nome: (l.name || ct?.name || l.phone).slice(0, 160), whatsapp: l.phone, email, empresa, contactId: l.contactId,
          consentimentoAt: l.consentAt, consentimentoOrigem: l.consentAt ? l.consentSource : null, marketingOptOutAt: l.optOutAt,
        },
      });
      n++;
    }
  }
  return n;
}

/**
 * Ações em massa nos contatos: por lista de ids ou por "todos que atendem ao filtro" (limite de 10.000 por vez).
 * Respeita isolamento por organização, a regra 402 (middleware) e grava auditoria.
 */
mckmensagemRouter.post('/leads/bulk', ah(async (req, res) => {
  const b = bulkSchema.parse(req.body);
  if (b.action === 'delete' && !isLeadAdmin(req)) throw new HttpError(403, 'Apenas proprietário ou administrador pode excluir contatos');
  if (b.action === 'addToClientes' && !isLeadAdmin(req)) throw new HttpError(403, 'Apenas proprietário ou administrador pode cadastrar clientes');
  const orgId = orgOf(req);
  const where = b.ids ? { orgId, id: { in: [...new Set(b.ids)] } } : leadWhere(orgId, b.filter!);
  const matched = await prisma.lead.count({ where });
  if (matched > BULK_MAX) throw new HttpError(400, `A seleção tem ${matched} contatos; o limite por operação é ${BULK_MAX}. Refine os filtros.`);
  const leads = matched ? await prisma.lead.findMany({ where, select: { id: true, tags: true, optOutAt: true, consentAt: true, status: true, campaignId: true, contactId: true } }) : [];
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
      await mirrorLeadsToContacts(orgId, leads.map((l) => l.contactId), { optOut: true }); // vale também no MCKBOT
      break;
    }
    case 'optIn':
      for (const part of chunks(ids)) updated += (await prisma.lead.updateMany({ where: { orgId, id: { in: part }, optOutAt: { not: null } }, data: { optOutAt: null } })).count;
      await mirrorLeadsToContacts(orgId, leads.filter((l) => l.optOutAt).map((l) => l.contactId), { optOut: false });
      break;
    case 'registerConsent': {
      // Só quem ainda está com consentimento pendente (ex.: veio do MCKBOT). Quem já tinha mantém a origem/data.
      const now = new Date();
      for (const part of chunks(ids)) updated += (await prisma.lead.updateMany({ where: { orgId, id: { in: part }, consentAt: null }, data: { consentAt: now, consentSource: b.consentSource ?? 'MANUAL' } })).count;
      break;
    }
    case 'addToClientes':
      updated = await leadsToClientes(orgId, ids);
      break;
    case 'delete':
      for (const part of chunks(ids)) {
        await prisma.campaignRecipient.deleteMany({ where: { leadId: { in: part } } });
        updated += (await prisma.lead.deleteMany({ where: { orgId, id: { in: part } } })).count;
      }
      break;
  }
  await audit(req, 'mckmensagem.lead.bulk', { meta: { action: b.action, por: b.ids ? 'ids' : 'filtro', filtro: b.filter ?? null, matched, updated, queued, campaignId: b.campaignId ?? null, status: b.status ?? null, tags: b.tags ?? null, consentSource: b.action === 'registerConsent' ? (b.consentSource ?? 'MANUAL') : null } });
  if (b.action === 'delete') await audit(req, 'leads.bulk_delete', { entity: 'Lead', meta: { por: b.ids ? 'ids' : 'filtro', requested: b.ids ? new Set(b.ids).size : matched, deleted: updated } });
  res.json({ matched, updated, queued });
}));

/** Exclusão em massa por ids (até 500 por requisição). Ids de outra organização são ignorados. */
export const BULK_DELETE_MAX = 500;
const bulkDeleteSchema = z.object({
  ids: z.array(z.string().trim().min(1).max(40), { error: 'Informe os contatos a excluir' })
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
  consentSource: z.enum(CONSENT_SOURCES, { error: () => ({ message: 'Informe a origem do consentimento (FORMULARIO, IMPORTACAO, ANUNCIO_CTWA ou MANUAL)' }) }),
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
    data: { orgId, phone, name: body.name || null, tags: JSON.stringify(body.tags ?? []), consentSource: body.consentSource, consentAt: body.consentAt ?? new Date(), campaignId: body.campaignId ?? null, contactId: await contactIdForPhone(orgId, phone) },
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
  const orgId = orgOf(req);
  const lead = await prisma.lead.findFirst({ where: { id: req.params.id, orgId } });
  if (!lead) throw notFound('Lead');
  const sameName = nameKey(lead.name) ? await prisma.lead.findMany({ where: { orgId, name: { not: null } }, select: { id: true, name: true, phone: true } }) : [];
  res.json({ ...leadView(lead), sameClient: siblingsOf(lead, sameName) });
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
  // Mesma pessoa no MCKBOT: nome e opt-out valem lá também.
  if (lead.contactId) {
    const mirror: { name?: string | null; optOut?: boolean } = {};
    if (body.name !== undefined && (body.name || null) !== lead.name && body.name) mirror.name = body.name;
    if (body.optOut !== undefined && body.optOut !== !!lead.optOutAt) mirror.optOut = body.optOut;
    await mirrorLeadsToContacts(orgId, [lead.contactId], mirror);
  }
  await audit(req, 'mckmensagem.lead.update', { entity: 'Lead', entityId: lead.id, meta: Object.keys(data) });
  res.json(leadView(updated));
}));

mckmensagemRouter.delete('/leads/:id', canDeleteLeads, ah(async (req, res) => {
  const deleted = await deleteLeadsOfOrg(orgOf(req), [String(req.params.id)]);
  if (!deleted.length) throw notFound('Lead');
  await audit(req, 'leads.delete', { entity: 'Lead', entityId: deleted[0], meta: { count: 1 } });
  res.json({ ok: true });
}));

/** Modelo da importação: uma linha = um cliente, com até 4 telefones (cada um vira um contato). */
export const LEADS_TEMPLATE_CSV = '\uFEFF' + [
  'Nome;Contato 1;Contato 2;Contato 3;Contato 4;Etiquetas',
  'Maria Silva;(11) 99999-0001;(11) 98888-0002;;;cliente|vip',
  'João Souza;(21) 97777-0003;;;;cliente',
  'Comercial Exemplo Ltda;(31) 96666-0004;(31) 95555-0005;(31) 3444-0006;;empresa',
].join('\r\n') + '\r\n';

mckmensagemRouter.get('/leads/import/template', ah(async (_req, res) => {
  res.setHeader('content-type', 'text/csv; charset=utf-8');
  res.setHeader('content-disposition', 'attachment; filename="modelo-contatos-mck-mensagens.csv"');
  res.send(LEADS_TEMPLATE_CSV);
}));

/**
 * Importação CSV. Com cabeçalho: Nome; Contato 1..4 (ou Telefone/WhatsApp/phone do modelo antigo); Etiquetas.
 * Sem cabeçalho (formato antigo): telefone,nome,etiquetas (etiquetas separadas por "|").
 * Cada telefone preenchido vira um contato (duplicidade só pelo telefone); números da mesma linha ou com o mesmo nome
 * são o mesmo cliente (só sinalizado). Exige consentimento declarado.
 */
mckmensagemRouter.post('/leads/import', ah(async (req, res) => {
  const body = z.object({
    text: z.string().min(1).max(2_000_000),
    consentDeclared: z.boolean().optional(), // ignorado: importar já registra o consentimento (LGPD)
    consentSource: z.enum(CONSENT_SOURCES).default('IMPORTACAO'),
    campaignId: z.string().optional().nullable(),
    tags: tagsSchema.optional(),
  }).parse(req.body);
  const orgId = orgOf(req);
  await checkCampaign(orgId, body.campaignId);
  const text = body.text.replace(/^\uFEFF/, '');
  const sep = detectDelimiter(text);
  const table = parseCsv(text, sep).map((r) => r.map((c) => c.trim()));
  while (table.length && table[0].every((c) => !c)) table.shift();
  let header: HeaderCol[] | null = (table[0] ?? []).map(mapHeaderCell);
  if (!header.some((h) => typeof h === 'object' && h)) header = null; // sem cabeçalho reconhecido: formato antigo
  const dataRows = table.slice(header ? 1 : 0).map((cells, i) => ({ cells, line: i + (header ? 2 : 1) })).filter((r) => r.cells.some(Boolean));
  if (dataRows.length > 10000) throw new HttpError(400, 'Máximo de 10.000 linhas por importação');
  let created = 0, updated = 0, sameClient = 0;
  const errors: string[] = [];
  const now = new Date();
  const seen = new Set<string>();
  const strip = (v: string) => v.replace(/^"|"$/g, '').trim();
  for (const { cells, line } of dataRows) {
    let rawName = '', rawTags = '', phonesRaw: string[] = [];
    if (header) {
      const raw = rowFromCells(header, cells);
      rawName = strip(raw.nome); rawTags = raw.tags; phonesRaw = raw.telefones.slice(0, MAX_PHONES_PER_ROW).map((p) => strip(p ?? ''));
    } else {
      phonesRaw = [strip(cells[0] ?? '')]; rawName = strip(cells[1] ?? ''); rawTags = strip(cells[2] ?? '');
    }
    rawName = rawName.replace(/^[=+\-@\t\r]+/, '').slice(0, 100);
    const filled = phonesRaw.map((p, i) => ({ p, n: i + 1 })).filter((x) => x.p);
    if (!filled.length) { errors.push(`Linha ${line}: telefone inválido`); continue; }
    const tags = [...new Set([...(rawTags ? rawTags.split(/[|,]/).map((t) => t.trim().replace(/^[=+\-@]+/, '').slice(0, 40)).filter(Boolean) : []), ...(body.tags ?? [])])].slice(0, 30);
    let okPhones = 0;
    for (const { p, n } of filled) {
      const phone = toE164(p);
      const where = filled.length > 1 ? ` (Contato ${n})` : '';
      if (!phone) { errors.push(`Linha ${line}${where}: telefone inválido`); continue; }
      if (seen.has(phone)) continue; // mesmo número repetido no arquivo: conta uma vez
      seen.add(phone);
      okPhones++;
      const existing = await prisma.lead.findUnique({ where: { orgId_phone: { orgId, phone } } });
      if (existing) {
        const merged = [...new Set([...parseJson<string[]>(existing.tags, []), ...tags])].slice(0, 30);
        // Contato vindo do MCKBOT com consentimento pendente: a declaração desta importação registra o consentimento.
        const consent = (!existing.consentAt && !existing.optOutAt) ? { consentAt: now, consentSource: body.consentSource } : {};
        const link = !existing.contactId ? { contactId: await contactIdForPhone(orgId, phone) } : {};
        await prisma.lead.update({ where: { id: existing.id }, data: { name: existing.name ?? (rawName || null), tags: JSON.stringify(merged), ...consent, ...link, ...(body.campaignId ? { campaignId: body.campaignId } : {}) } });
        updated++;
      } else {
        const contactId = await contactIdForPhone(orgId, phone);
        // Contato do MCKBOT que pediu para sair (opt-out): continua fora, sem consentimento.
        const optedOut = contactId ? !!(await prisma.contact.findFirst({ where: { id: contactId, orgId }, select: { optOut: true } }))?.optOut : false;
        await prisma.lead.create({ data: { orgId, phone, name: rawName || null, tags: JSON.stringify(tags), consentSource: body.consentSource, consentAt: optedOut ? null : now, optOutAt: optedOut ? now : null, campaignId: body.campaignId ?? null, contactId } });
        created++;
      }
    }
    if (okPhones > 1) sameClient++;
  }
  await audit(req, 'mckmensagem.lead.import', { meta: { created, updated, errors: errors.length, sameClient, consentRegistered: true, consentSource: body.consentSource, consentAt: now.toISOString(), consentBy: (req as any).auth?.userId ?? null } });
  res.json({ created, updated, sameClient, errors: errors.slice(0, 100) });
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
  // v1.43.0: repescagem automática de quem não respondeu.
  repescagemAtiva: z.boolean().optional(),
  repescagemDias: z.number().int().min(REPESCAGEM_LIMITES.diasMin).max(REPESCAGEM_LIMITES.diasMax).optional(),
  repescagemMax: z.number().int().min(REPESCAGEM_LIMITES.maxMin).max(REPESCAGEM_LIMITES.maxMax).optional(),
  repescagemModelo: z.string().max(2000).optional(),
  // v1.44.0: número em nível Risco → pausa automática; auto = volta sozinha, manual = espera o Retomar.
  riscoRetomada: z.enum(['auto', 'manual']).optional(),
  // v1.48.0: versões extras da mensagem (teste A/B), vencedora automática e dias da semana.
  variacoes: z.array(z.string().max(4000)).max(MAX_VARIACOES).optional(),
  abAutoVencedora: z.boolean().optional(),
  abMinimo: z.number().int().min(AB_LIMITES.min).max(AB_LIMITES.max).optional(),
  diasSemana: z.union([z.string().max(20), z.array(z.number().int().min(0).max(6)).max(7)]).optional(),
  // v1.49.0: repetição (vazio = não repete) com fim opcional; rodízio entre números (desligado por padrão).
  recorrencia: z.enum(['', ...RECORRENCIAS]).optional(),
  recorrenciaFim: z.string().max(40).nullable().optional(),
  rodizio: z.boolean().optional(),
  canaisRodizio: z.array(z.string().min(1).max(40)).max(MAX_CANAIS_RODIZIO - 1).optional(),
  // v1.51.0: número de envio escolhido (false = automático, como antes) e confirmação "Enviar mesmo assim" (número em Risco).
  envioFixo: z.boolean().optional(),
  confirmarRisco: z.boolean().optional(),
  /** Só na edição: reordena/tira os arquivos já anexados (quando uma versão é removida). Arquivo novo entra por /midia. */
  midias: z.array(z.string().max(40).nullable()).max(MAX_VARIACOES + 1).optional(),
});

const filtroErpSchema = z.object({
  gastoMin: z.number().min(0).max(100_000_000).nullable().optional(), gastoMax: z.number().min(0).max(100_000_000).nullable().optional(),
  comprasMin: z.number().int().min(0).max(100_000).nullable().optional(), comprasMax: z.number().int().min(0).max(100_000).nullable().optional(),
  ultimaCompraMaxDias: z.number().int().min(0).max(3650).nullable().optional(), ultimaCompraMinDias: z.number().int().min(0).max(3650).nullable().optional(),
});

/** Converte os campos da v1.48.0 para o formato do banco. */
function dadosV148(body: { variacoes?: string[]; diasSemana?: string | number[] }) {
  const out: Record<string, unknown> = {};
  if (body.variacoes) out.variacoes = JSON.stringify(body.variacoes.map((t) => t.trim()).filter(Boolean).slice(0, MAX_VARIACOES));
  if (body.diasSemana !== undefined) out.diasSemana = normalizarDias(body.diasSemana);
  return out;
}

/** v1.49.0: campos novos → formato do banco, com as validações (números do rodízio, fim da repetição, legenda). */
async function dadosV149(orgId: string, body: { channelId?: string; recorrencia?: string; recorrenciaFim?: string | null; rodizio?: boolean; canaisRodizio?: string[] }, atual?: Campaign) {
  const out: Record<string, unknown> = {};
  if (body.recorrencia !== undefined) {
    if (atual?.recorrenciaOrigemId && body.recorrencia) throw new HttpError(400, 'Esta campanha é uma repetição. Mude a repetição na campanha original.');
    out.recorrencia = body.recorrencia;
  }
  if (body.recorrenciaFim !== undefined) {
    const fim = body.recorrenciaFim ? new Date(body.recorrenciaFim) : null;
    const erro = erroFimRecorrencia(fim, new Date());
    if (erro && !(fim && atual?.recorrenciaFim && fim.getTime() === atual.recorrenciaFim.getTime())) throw new HttpError(400, erro);
    out.recorrenciaFim = fim;
  }
  if (body.rodizio !== undefined) out.rodizio = body.rodizio;
  if (body.canaisRodizio !== undefined) {
    const principal = body.channelId ?? atual?.channelId;
    const ids = [...new Set(body.canaisRodizio)].filter((id) => id !== principal);
    if (ids.length) {
      const ok = await prisma.channel.count({ where: { orgId, id: { in: ids }, provider: { not: 'site' } } });
      if (ok !== ids.length) throw new HttpError(400, 'Número do rodízio inválido');
    }
    out.canaisRodizio = JSON.stringify(ids);
  }
  return out;
}

/** Com imagem/PDF anexado, todas as versões do texto precisam caber na legenda. */
function checkLegenda(c: { message: string; variacoes: string; midias: string }) {
  if (!lerMidias(c.midias).some(Boolean)) return;
  const erro = erroLegenda([c.message, ...lerVariacoes(c.variacoes)]);
  if (erro) throw new HttpError(400, erro);
}

/** Próxima repetição ao iniciar/editar (só com a campanha rodando ou concluída; pausada/rascunho calcula ao iniciar). */
function proximaRepeticao(c: Pick<Campaign, 'recorrencia' | 'recorrenciaOrigemId' | 'iniciarEm' | 'status'>, now = new Date()): Date | null {
  if (c.recorrenciaOrigemId || !ehRecorrencia(c.recorrencia)) return null;
  if (!['EM_ANDAMENTO', 'AGENDADA', 'CONCLUIDA'].includes(c.status)) return null;
  const base = c.iniciarEm ?? now;
  const dia = c.recorrencia === 'MENSAL' ? diaDoMesBrt(base) : undefined;
  return base.getTime() > now.getTime() ? proximaExecucao(base, c.recorrencia, dia) : proximaDepoisDe(base, c.recorrencia, now, dia);
}

async function checkChannel(orgId: string, channelId?: string) {
  if (!channelId) return;
  if (!(await prisma.channel.findFirst({ where: { id: channelId, orgId, provider: { not: 'site' } } }))) throw new HttpError(400, 'Canal WhatsApp inválido');
}
/** v1.51.0: nível da Saúde do número (só QR; API oficial e erro na avaliação = null, não bloqueia). */
async function nivelDoCanal(orgId: string, channelId: string): Promise<string | null> {
  const ch = await prisma.channel.findFirst({ where: { id: channelId, orgId } });
  if (!ch || ch.provider !== 'whatsapp_qr') return null;
  return (await saudeDoNumero(ch).catch(() => null))?.nivel ?? null;
}

/**
 * v1.51.0: número de envio escolhido pela responsável. Confere que o número é da empresa e que o usuário pode usar esse
 * número (permissão de canais do membro). Número em Risco só é aceito com confirmarRisco (registra quem e quando);
 * sem ela responde 409 com o aviso. Trocar de número ou voltar ao automático apaga a confirmação.
 */
async function dadosNumeroEnvio(req: Request, orgId: string, body: { channelId?: string; envioFixo?: boolean; confirmarRisco?: boolean }, atual?: Campaign) {
  const fixo = body.envioFixo ?? atual?.envioFixo ?? false;
  const canal = body.channelId ?? atual?.channelId;
  const out: Record<string, unknown> = {};
  if (body.envioFixo !== undefined) out.envioFixo = body.envioFixo;
  const limpar = { riscoLiberadoCanalId: null, riscoLiberadoPor: null, riscoLiberadoPorNome: null, riscoLiberadoEm: null };
  if (!fixo || !canal) return atual?.riscoLiberadoEm ? { ...out, ...limpar } : out;
  const allowed = allowedChannels(req);
  if (allowed && !allowed.includes(canal)) throw new HttpError(403, 'Você não tem permissão para usar este número de WhatsApp');
  const jaLiberado = !!atual && riscoLiberado({ envioFixo: true, channelId: canal, riscoLiberadoCanalId: atual.riscoLiberadoCanalId, riscoLiberadoEm: atual.riscoLiberadoEm });
  const trocou = !!atual?.riscoLiberadoEm && atual.riscoLiberadoCanalId !== canal;
  if (body.confirmarRisco) {
    const u = req.auth?.userId ? await prisma.user.findUnique({ where: { id: req.auth.userId }, select: { name: true } }) : null;
    return { ...out, riscoLiberadoCanalId: canal, riscoLiberadoPor: req.auth?.userId ?? null, riscoLiberadoPorNome: u?.name?.slice(0, 120) ?? null, riscoLiberadoEm: new Date() };
  }
  if (jaLiberado) return out;
  // Só confere o Risco quando o número (ou o modo) muda: editar o nome/texto não esbarra no aviso.
  const mexeu = !atual || (body.envioFixo !== undefined && body.envioFixo !== atual.envioFixo) || (body.channelId !== undefined && body.channelId !== atual.channelId);
  if (!mexeu) return out;
  if ((await nivelDoCanal(orgId, canal)) === 'RISCO') throw new HttpError(409, AVISO_RISCO_FIXO, { codigo: CONFIRMAR_RISCO, channelId: canal });
  return trocou ? { ...out, ...limpar } : out;
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
  // v1.46.1: quantos falharam por desconexão (botão "Reenviar os que falharam por desconexão").
  const falhasConexao = recipients.FALHOU ? await contarFalhasDeConexao(c.id) : 0;
  // v1.48.0: versões e resultado do teste A/B (só quando há mais de uma versão).
  const variacoes = lerVariacoes(c.variacoes);
  const ab = variacoes.length && recipients.ENVIADA ? await resultadoAb(c) : null;
  // v1.49.0: arquivos, rodízio, público e repetições.
  const midias = await midiasView(c);
  const midiaFaltando = lerMidias(c.midias).some((id, i) => id && !midias[i]);
  const origem = c.recorrenciaOrigemId ? await prisma.campaign.findFirst({ where: { id: c.recorrenciaOrigemId, orgId: c.orgId }, select: { id: true, name: true } }) : null;
  const repeticoes = !c.recorrenciaOrigemId && c.recorrencia ? await prisma.campaign.count({ where: { orgId: c.orgId, recorrenciaOrigemId: c.id } }) : 0;
  const porNumero = c.rodizio ? await prisma.campaignRecipient.groupBy({ by: ['channelId'], where: { campaignId: c.id, status: 'ENVIADA' }, _count: { _all: true } }) : [];
  return {
    ...c, riscoLiberado: riscoLiberado(c), variacoes, recipients, falhasConexao, ab, midias, midiaFaltando, canaisRodizio: lerCanais(c.canaisRodizio), publico: lerPublico(c.publico), origem, repeticoes,
    enviadasPorNumero: porNumero.map((g) => ({ channelId: g.channelId ?? c.channelId, enviadas: g._count._all })),
  };
}

/**
 * v1.51.0: números para "Escolher número de envio": todos os WhatsApp da empresa (menos o chat do site) que o usuário
 * pode usar, com conexão e nível da Saúde do número (Bom/Atenção/Risco + motivos). Inclui os em Risco e desconectados.
 */
mckmensagemRouter.get('/numeros-envio', ah(async (req, res) => {
  const orgId = orgOf(req);
  const allowed = allowedChannels(req);
  const list = await prisma.channel.findMany({ where: { orgId, provider: { not: 'site' }, ...(allowed ? { id: { in: allowed } } : {}) }, orderBy: { createdAt: 'asc' } });
  const labels = await channelLabels(orgId);
  res.json(await Promise.all(list.map(async (c) => {
    const s = c.provider === 'whatsapp_qr' ? await saudeDoNumero(c).catch(() => null) : null;
    return {
      id: c.id, label: labels.get(c.id)?.label ?? c.name, displayPhone: c.displayPhone, provider: c.provider,
      conectado: canalConectado(c), nivel: s?.nivel ?? null, motivos: s?.motivos ?? [],
    };
  })));
}));

mckmensagemRouter.get('/campaigns', ah(async (req, res) => {
  const items = await prisma.campaign.findMany({ where: { orgId: orgOf(req) }, orderBy: { createdAt: 'desc' } });
  res.json(await Promise.all(items.map(campaignView)));
}));

mckmensagemRouter.post('/campaigns', ah(async (req, res) => {
  const body = campaignBase.parse(req.body);
  const orgId = orgOf(req);
  await checkChannel(orgId, body.channelId);
  checkIntervals(body.minIntervalSec ?? 45, body.maxIntervalSec ?? 120);
  // v1.43.0: campanha nova nasce com a repescagem ligada (padrão 2 dias, até 2 repescagens).
  const { variacoes: _v, diasSemana: _d, recorrencia: _r, recorrenciaFim: _f, rodizio: _z, canaisRodizio: _k, midias: _m, envioFixo: _e, confirmarRisco: _cr, ...resto } = body;
  const numero = await dadosNumeroEnvio(req, orgId, body);
  const c = await prisma.campaign.create({ data: { orgId, repescagemAtiva: true, ...resto, ...dadosV148(body), ...(await dadosV149(orgId, body)), ...numero } });
  await audit(req, 'mckmensagem.campaign.create', { entity: 'Campaign', entityId: c.id });
  if (numero.riscoLiberadoEm) await audit(req, 'mckmensagem.campaign.risco_liberado', { entity: 'Campaign', entityId: c.id, meta: { channelId: c.channelId } });
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
  // Mexeu na repescagem: tira o aviso de pausa (o agendador recoloca se o motivo continuar).
  const repescagemMudou = ['repescagemAtiva', 'repescagemDias', 'repescagemMax'].some((k) => k in body);
  const riscoMudou = 'riscoRetomada' in body && body.riscoRetomada !== c.riscoRetomada;
  const { variacoes: _v, diasSemana: _d, recorrencia: _r, recorrenciaFim: _f, rodizio: _z, canaisRodizio: _k, midias: novasMidias, envioFixo: _e, confirmarRisco: _cr, ...resto } = body;
  const numero = await dadosNumeroEnvio(req, orgId, body, c);
  let midias = c.midias;
  if (novasMidias) {
    const atuais = new Set(lerMidias(c.midias).filter(Boolean));
    if (novasMidias.some((id) => id && !atuais.has(id))) throw new HttpError(400, 'Arquivo inválido para esta campanha');
    midias = JSON.stringify(lerMidias(JSON.stringify(novasMidias)));
  }
  // Mudou as versões: o teste A/B recomeça (a vencedora antiga pode não existir mais).
  const versoesMudaram = body.variacoes !== undefined && JSON.stringify(lerVariacoes(String(dadosV148(body).variacoes))) !== JSON.stringify(lerVariacoes(c.variacoes));
  const v149 = await dadosV149(orgId, body, c);
  const v148 = dadosV148(body);
  checkLegenda({ message: body.message ?? c.message, variacoes: (v148.variacoes as string | undefined) ?? c.variacoes, midias });
  // Repetição mudou: recalcula a próxima (ou desliga).
  const recMudou = ('recorrencia' in v149 && v149.recorrencia !== c.recorrencia) || ('recorrenciaFim' in v149);
  const prox = recMudou ? { recorrenciaProxima: proximaRepeticao({ ...c, recorrencia: (v149.recorrencia as string | undefined) ?? c.recorrencia }) } : {};
  const updated = await prisma.campaign.update({ where: { id: c.id }, data: { ...resto, ...v148, ...v149, ...prox, ...numero, ...(novasMidias ? { midias } : {}), ...(versoesMudaram ? { abVencedora: null, abVencedoraEm: null } : {}), ...(repescagemMudou ? { repescagemPausa: null, repescagemPausaEm: null } : {}), ...(riscoMudou ? { riscoPausa: null, riscoPausaEm: null } : {}) } });
  await audit(req, 'mckmensagem.campaign.update', { entity: 'Campaign', entityId: c.id, meta: Object.keys(body) });
  if (numero.riscoLiberadoEm) await audit(req, 'mckmensagem.campaign.risco_liberado', { entity: 'Campaign', entityId: c.id, meta: { channelId: updated.channelId } });
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
  const body = z.object({ leadIds: z.array(z.string()).max(10000).optional(), tag: z.string().max(40).optional(), agendarPara: z.string().max(40).optional(), erp: filtroErpSchema.optional() }).parse(req.body ?? {});
  if (body.erp) { const erro = erroFiltroErp(body.erp); if (erro) throw new HttpError(400, erro); }
  // v1.48.0: início agendado (data/hora). Sem agendarPara: começa agora, como antes.
  const agendarPara = body.agendarPara ? new Date(body.agendarPara) : null;
  if (agendarPara) { const erro = validarAgendamento(agendarPara, new Date()); if (erro) throw new HttpError(400, erro); }
  const orgId = orgOf(req);
  const c = await getCampaign(orgId, req.params.id);
  if (c.status === 'CONCLUIDA' && !body.leadIds && !body.tag && !body.erp) throw new HttpError(400, 'Campanha já concluída. Informe novos leads para reabrir.');
  await checkChannel(orgId, c.channelId);
  // v1.49.0: público gravado (as repetições usam o público atual com a mesma regra).
  const publico: Publico | null = body.leadIds ? null : body.erp ? { modo: 'erp', erp: body.erp as FiltroErp } : body.tag ? { modo: 'etiqueta', tag: body.tag } : { modo: 'vinculados' };
  let leads: { id: string; consentAt: Date | null }[];
  if (body.leadIds) leads = await prisma.lead.findMany({ where: { orgId, optOutAt: null, status: { not: 'DESCARTADO' }, id: { in: body.leadIds } }, select: { id: true, consentAt: true } });
  else leads = await leadsDoPublico(orgId, c.id, publico!);
  if (body.erp && !leads.length) {
    const p = await previaSegmentoErp(orgId, body.erp as FiltroErp);
    if (!p.disponivel) throw new HttpError(400, p.motivo!);
  }
  let added = 0;
  const semConsentimento = leads.filter((l) => !l.consentAt).length;
  for (const l of leads) {
    if (!l.consentAt) continue;
    const exists = await prisma.campaignRecipient.findUnique({ where: { campaignId_leadId: { campaignId: c.id, leadId: l.id } } });
    if (exists) continue;
    await prisma.campaignRecipient.create({ data: { campaignId: c.id, leadId: l.id } });
    added++;
  }
  const pending = await prisma.campaignRecipient.count({ where: { campaignId: c.id, status: 'PENDENTE' } });
  if (!pending) throw new HttpError(400, semConsentimento
    ? `Nenhum lead elegível: ${semConsentimento} contato(s) ainda estão com consentimento pendente. Registre o consentimento em Contatos para enviar.`
    : 'Nenhum lead elegível (com consentimento e sem opt-out) para esta campanha');
  // v1.44.0: Retomar tira o aviso de pausa por Risco (o agendador pausa de novo se o número continuar em Risco).
  const agendada = !!agendarPara && agendarPara.getTime() > Date.now();
  const repete = !c.recorrenciaOrigemId && ehRecorrencia(c.recorrencia);
  const inicio = agendada ? agendarPara! : repete ? new Date() : null;
  const status = agendada ? 'AGENDADA' : 'EM_ANDAMENTO';
  const updated = await prisma.campaign.update({ where: { id: c.id }, data: {
    status, iniciarEm: inicio, riscoPausa: null, riscoPausaEm: null,
    ...(publico ? { publico: JSON.stringify(publico) } : {}),
    ...(repete ? { recorrenciaProxima: proximaRepeticao({ ...c, status, iniciarEm: inicio }), recorrenciaExecucao: Math.max(1, c.recorrenciaExecucao) } : {}),
  } });
  await audit(req, 'mckmensagem.campaign.start', { entity: 'Campaign', entityId: c.id, meta: { added, pending, agendadaPara: agendada ? agendarPara!.toISOString() : null } });
  res.json({ ...(await campaignView(updated)), added, pending, semConsentimento });
}));

/**
 * v1.46.1: devolve à fila os destinatários que FALHARAM por desconexão/erro passageiro (campanhas antigas).
 * Nunca pega ENVIADA nem quem já recebeu esta campanha (esses viram ENVIADA, sem reenvio).
 */
mckmensagemRouter.post('/campaigns/:id/reenviar-falhas-conexao', ah(async (req, res) => {
  const orgId = orgOf(req);
  const c = await getCampaign(orgId, req.params.id);
  const r = await reenviarFalhasDeConexao(c);
  await audit(req, 'mckmensagem.campaign.reenviar_falhas_conexao', { entity: 'Campaign', entityId: c.id, meta: r });
  const updated = await getCampaign(orgId, c.id);
  res.json({ ...(await campaignView(updated)), ...r });
}));

// ---------------- v1.48.0: duplicar e enviar teste ----------------

/** Cópia da campanha como rascunho (mesmo texto, versões e limites; sem fila, sem resultado do A/B). */
mckmensagemRouter.post('/campaigns/:id/duplicar', ah(async (req, res) => {
  const orgId = orgOf(req);
  const c = await getCampaign(orgId, req.params.id);
  const nome = `Cópia de ${c.name}`.slice(0, 120);
  const copia = await prisma.campaign.create({ data: {
    orgId, name: nome, message: c.message, channelId: c.channelId, status: 'RASCUNHO', dailyLimit: c.dailyLimit, minIntervalSec: c.minIntervalSec, maxIntervalSec: c.maxIntervalSec,
    windowStart: c.windowStart, windowEnd: c.windowEnd, repescagemAtiva: c.repescagemAtiva, repescagemDias: c.repescagemDias, repescagemMax: c.repescagemMax, repescagemModelo: c.repescagemModelo,
    riscoRetomada: c.riscoRetomada, variacoes: c.variacoes, abAutoVencedora: c.abAutoVencedora, abMinimo: c.abMinimo, diasSemana: c.diasSemana,
    midias: c.midias, rodizio: c.rodizio, canaisRodizio: c.canaisRodizio, publico: c.publico, recorrencia: c.recorrenciaOrigemId ? '' : c.recorrencia, recorrenciaFim: c.recorrenciaFim,
    envioFixo: c.envioFixo, // v1.51.0: a confirmação "Enviar mesmo assim" não vai para a cópia (precisa confirmar de novo)
  } });
  await audit(req, 'mckmensagem.campaign.duplicate', { entity: 'Campaign', entityId: copia.id, meta: { de: c.id } });
  res.status(201).json(await campaignView(copia));
}));

/**
 * Envios de teste por empresa: no máximo 10 por hora. v1.49.0: contados no banco (registro de auditoria
 * "mckmensagem.campaign.teste"), então o limite não zera quando o servidor reinicia.
 */
export const TESTE_LIMITE_HORA = 10;
let testesDesde = 0;
/** Só para os testes automáticos: ignora os envios de teste anteriores a agora. */
export function resetTestesCampanha() { testesDesde = Date.now(); }

/**
 * Envia UMA versão da mensagem para um número escolhido (ex.: o celular do dono) para ver como chega.
 * Não entra na fila, não conta como envio da campanha nem no A/B. Só Proprietário/Admin.
 */
mckmensagemRouter.post('/campaigns/:id/teste', requireRole('OWNER', 'ADMIN'), ah(async (req, res) => {
  const body = z.object({ phone: z.string().min(8).max(30), versao: z.number().int().min(0).max(MAX_VARIACOES).optional(), nome: z.string().max(80).optional() }).parse(req.body ?? {});
  const orgId = orgOf(req);
  const c = await getCampaign(orgId, req.params.id);
  const phone = toE164(body.phone);
  if (!phone) throw new HttpError(400, 'Telefone inválido. Use DDD + número, ex.: (11) 91234-5678');
  const desde = new Date(Math.max(Date.now() - 3_600_000, testesDesde));
  const recentes = await prisma.auditLog.count({ where: { orgId, action: 'mckmensagem.campaign.teste', createdAt: { gte: desde } } });
  if (recentes >= TESTE_LIMITE_HORA) throw new HttpError(429, `Limite de ${TESTE_LIMITE_HORA} envios de teste por hora atingido. Tente mais tarde.`);
  const channel = await prisma.channel.findFirst({ where: { id: c.channelId, orgId, provider: { not: 'site' } } });
  if (!channel || !canalConectado(channel)) throw new HttpError(400, 'O WhatsApp desta campanha está desconectado. Conecte em Canais para enviar o teste.');
  const versoes = versoesDaCampanha(c);
  const versao = Math.min(body.versao ?? 0, versoes.length - 1);
  const waId = phone.replace(/\D/g, '');
  let contact = await prisma.contact.findUnique({ where: { orgId_waId: { orgId, waId } } });
  if (contact?.optOut) throw new HttpError(400, 'Este número pediu para não receber mensagens (SAIR). Use outro número para o teste.');
  contact ??= await prisma.contact.create({ data: { orgId, waId, phone, name: body.nome?.trim() || null } });
  const nome = body.nome?.trim() || contact.name || 'Ana Souza';
  const { texto } = textoDaCampanha({ ...c, abVencedora: null }, { id: `teste:${waId}`, name: nome }, versao, new Date());
  // Conta o teste antes de enviar (dois cliques ao mesmo tempo não passam do limite).
  await audit(req, 'mckmensagem.campaign.teste', { entity: 'Campaign', entityId: c.id, meta: { versao, final: waId.slice(-4) } });
  const conv = await openConversationFor(orgId, contact.id, c.channelId);
  // v1.49.0: o teste sai igual ao envio de verdade (com a imagem/PDF da versão, se houver).
  const payload = await payloadDaCampanha(c, versao, texto).catch((e) => { throw new HttpError(400, (e as Error).message); });
  const msg = await sendOutbound({ conversation: conv, contact, payload, sender: 'bot', product: 'MCKMENSAGEM' });
  if (msg.status === 'FAILED') throw new HttpError(400, `O teste não foi enviado: ${msg.error ?? 'falha no envio'}`);
  res.json({ ok: true, versao, texto });
}));

// ---------------- v1.49.0: imagem ou PDF por versão ----------------

/** Corpo binário com limite (o maior dos tipos aceitos) e erro 413 amigável. Nome em x-file-name (URI-encoded). */
const corpoMidia: RequestHandler = (req, res, next) => {
  express.raw({ type: () => true, limit: `${maxMbDoTipo('pdf') + 1}mb` })(req, res, (err?: any) => {
    if (err) return next(err.type === 'entity.too.large' ? new HttpError(413, `Arquivo maior que o limite (imagem até ${maxMbDoTipo('jpg')} MB, PDF até ${maxMbDoTipo('pdf')} MB)`) : new HttpError(400, 'Falha ao ler o arquivo enviado'));
    next();
  });
};
const versaoQuery = z.object({ versao: z.coerce.number().int().min(0).max(MAX_VARIACOES).default(0) });

/** Anexa (ou troca) a imagem/PDF de uma versão. Guardado no mesmo armazenamento de arquivos (Postgres), sem link público. */
mckmensagemRouter.post('/campaigns/:id/midia', corpoMidia, ah(async (req, res) => {
  const { versao } = versaoQuery.parse(req.query);
  const orgId = orgOf(req);
  const c = await getCampaign(orgId, req.params.id);
  if (versao > lerVariacoes(c.variacoes).length) throw new HttpError(400, 'Essa versão não existe. Salve a versão antes de anexar o arquivo.');
  const dados = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  const raw = String(req.header('x-file-name') ?? '');
  let nome = raw; try { nome = decodeURIComponent(raw); } catch { /* nome cru */ }
  const tipo = dados.length ? detectarTipo(dados, nome) : null;
  if (dados.length && (!tipo || !(MIDIA_TIPOS as readonly string[]).includes(tipo))) throw new HttpError(400, 'Tipo de arquivo não aceito. Use imagem JPG, PNG ou WEBP, ou PDF.');
  checkLegenda({ message: c.message, variacoes: c.variacoes, midias: '["x"]' });
  const arq = await salvarArquivo({ orgId, nome: nome.slice(0, 200) || `campanha.${tipo ?? 'jpg'}`, dados, descricao: `Campanha: ${c.name}`.slice(0, 200), criadoPorId: req.auth!.userId }, { tiposArquivo: MIDIA_TIPOS.join(','), tamanhoMaxMb: maxMbDoTipo(tipo ?? 'jpg') });
  const updated = await prisma.campaign.update({ where: { id: c.id }, data: { midias: definirMidia(lerMidias(c.midias), versao, arq.id) } });
  await audit(req, 'mckmensagem.campaign.midia', { entity: 'Campaign', entityId: c.id, meta: { versao, arquivoId: arq.id, mime: arq.mime, tamanho: arq.tamanho } });
  res.status(201).json(await campaignView(updated));
}));

/** Tira o arquivo da versão (o arquivo continua guardado em Automações › Arquivos; nada é apagado). */
mckmensagemRouter.delete('/campaigns/:id/midia', ah(async (req, res) => {
  const { versao } = versaoQuery.parse(req.query);
  const orgId = orgOf(req);
  const c = await getCampaign(orgId, req.params.id);
  const updated = await prisma.campaign.update({ where: { id: c.id }, data: { midias: definirMidia(lerMidias(c.midias), versao, null) } });
  await audit(req, 'mckmensagem.campaign.midia_remover', { entity: 'Campaign', entityId: c.id, meta: { versao } });
  res.json(await campaignView(updated));
}));

/** Prévia do arquivo de uma versão (sessão + organização; sem link público). */
mckmensagemRouter.get('/campaigns/:id/midia/:ref', ah(async (req, res) => {
  const orgId = orgOf(req);
  const c = await getCampaign(orgId, req.params.id);
  // ref = número da versão (0 = A) ou o id de um arquivo desta campanha.
  const lista = lerMidias(c.midias);
  const ref = String(req.params.ref);
  const id = /^\d$/.test(ref) ? lista[Number(ref)] ?? null : lista.includes(ref) ? ref : null;
  if (!id) throw notFound('Arquivo');
  const a = await getArquivo(orgId, id);
  const dados = await lerConteudo(a.id);
  res.setHeader('content-type', a.mime);
  res.setHeader('content-length', String(dados.length));
  res.setHeader('content-disposition', `inline; filename*=UTF-8''${encodeURIComponent(a.nome)}`);
  res.setHeader('cache-control', 'private, no-store');
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('content-security-policy', "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox");
  res.end(dados);
}));

// ---------------- v1.49.0: público pelas compras do ERP ----------------

/** Quantos contatos estão ligados ao ERP e quantos atendem ao filtro (nada é enviado). */
mckmensagemRouter.post('/segmento-erp/previa', ah(async (req, res) => {
  const f = filtroErpSchema.parse(req.body ?? {});
  const erro = erroFiltroErp(f);
  if (erro) throw new HttpError(400, erro);
  res.json({ ...(await previaSegmentoErp(orgOf(req), f)), vazio: filtroErpVazio(f) });
}));

mckmensagemRouter.post('/campaigns/:id/pause', ah(async (req, res) => {
  const c = await getCampaign(orgOf(req), req.params.id);
  if (c.status !== 'EM_ANDAMENTO' && c.status !== 'AGENDADA') throw new HttpError(400, 'Só é possível pausar uma campanha em andamento');
  const updated = await prisma.campaign.update({ where: { id: c.id }, data: { status: 'PAUSADA' } });
  await audit(req, 'mckmensagem.campaign.pause', { entity: 'Campaign', entityId: c.id });
  res.json(await campaignView(updated));
}));

// ---------------- Separação por grupos e repescagem (v1.43.0) ----------------

const gruposQuery = z.object({
  grupo: z.enum([...GRUPOS, 'SEM_RESPOSTA', 'REPESCADOS'] as [string, ...string[]]).optional(),
  q: z.string().max(100).optional(),
  page: z.coerce.number().int().min(1).max(10000).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

function filtrarLinhas<T extends { grupo: string; repescagemStatus: string | null; repescagens: number; nome: string | null; telefone: string }>(linhas: T[], q: { grupo?: string; q?: string }) {
  let out = linhas;
  if (q.grupo === 'SEM_RESPOSTA') out = out.filter((l) => l.repescagemStatus === 'SEM_RESPOSTA');
  else if (q.grupo === 'REPESCADOS') out = out.filter((l) => l.repescagens > 0);
  else if (q.grupo) out = out.filter((l) => l.grupo === q.grupo);
  if (q.q) {
    const t = q.q.toLowerCase(), d = q.q.replace(/\D/g, '');
    out = out.filter((l) => (l.nome ?? '').toLowerCase().includes(t) || (d && l.telefone.includes(d)));
  }
  return out;
}

/** Grupos da campanha: contagem e lista (com filtro por grupo e busca). */
mckmensagemRouter.get('/campaigns/:id/grupos', ah(async (req, res) => {
  const q = gruposQuery.parse(req.query);
  const c = await getCampaign(orgOf(req), req.params.id);
  const linhas = await gruposDaCampanha(c);
  const filtradas = filtrarLinhas(linhas, q);
  const ini = (q.page - 1) * q.pageSize;
  res.json({
    contagem: contarGrupos(linhas), rotulos: GRUPO_ROTULO, total: filtradas.length, page: q.page, pageSize: q.pageSize,
    itens: filtradas.slice(ini, ini + q.pageSize),
    repescagem: { ativa: c.repescagemAtiva, dias: c.repescagemDias, max: c.repescagemMax, pausa: c.repescagemPausa, pausaEm: c.repescagemPausaEm },
  });
}));

const STATUS_MSG: Record<string, string> = { QUEUED: 'na fila', SENT: 'enviada', DELIVERED: 'entregue', READ: 'lida', FAILED: 'falhou' };
const REPESCAGEM_STATUS: Record<string, string> = { RESPONDEU: 'respondeu', SEM_RESPOSTA: 'sem resposta', PARADA: 'parada', ENVIANDO: 'enviando' };

/** CSV dos grupos (todos ou só um grupo). */
mckmensagemRouter.get('/campaigns/:id/grupos/export', ah(async (req, res) => {
  const q = gruposQuery.parse(req.query);
  const c = await getCampaign(orgOf(req), req.params.id);
  const linhas = filtrarLinhas(await gruposDaCampanha(c), q);
  const esc = (v: unknown) => {
    const s = v == null ? '' : v instanceof Date ? v.toISOString() : String(v);
    const t = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
    return /[",\n;]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  const header = ['telefone', 'nome', 'grupo', 'status_mensagem', 'enviada_em', 'respondeu_em', 'status_lead', 'repescagens', 'repescagem', 'motivo', 'proxima_repescagem', 'erro'];
  const rows = linhas.map((l) => [l.telefone, l.nome, l.grupoRotulo, l.statusMensagem ? STATUS_MSG[l.statusMensagem] ?? l.statusMensagem : '', l.enviadaEm, l.respondeuEm, l.leadStatus, l.repescagens,
    l.repescagemStatus ? REPESCAGEM_STATUS[l.repescagemStatus] ?? l.repescagemStatus : '', l.repescagemMotivo, l.proximaRepescagemEm, l.erro].map(esc).join(','));
  await audit(req, 'mckmensagem.campaign.grupos.export', { entity: 'Campaign', entityId: c.id, meta: { grupo: q.grupo ?? 'todos', count: linhas.length } });
  res.setHeader('content-type', 'text/csv; charset=utf-8');
  res.setHeader('content-disposition', `attachment; filename="campanha-grupos${q.grupo ? '-' + q.grupo.toLowerCase() : ''}.csv"`);
  res.send('\uFEFF' + [header.join(','), ...rows].join('\n'));
}));

/** Prévia da repescagem (nada é enviado): texto da IA e um exemplo do texto modelo. */
mckmensagemRouter.post('/campaigns/:id/repescagem/previa', ah(async (req, res) => {
  const body = z.object({ grupo: z.enum(['VISUALIZOU', 'NAO_VISUALIZOU']).default('NAO_VISUALIZOU'), nome: z.string().max(60).optional(), modelo: z.string().max(2000).optional() }).parse(req.body ?? {});
  const orgId = orgOf(req);
  const c = await getCampaign(orgId, req.params.id);
  const nome = body.nome ?? 'Ana Souza';
  const campanha = { ...c, repescagemModelo: body.modelo ?? c.repescagemModelo };
  const ia = await gerarTextoRepescagem({ orgId, campanha, nome, grupo: body.grupo, tentativa: 1, max: c.repescagemMax, anteriores: [c.message] });
  res.json({ ia, modelo: textoModelo(campanha.repescagemModelo, body.grupo, nome) });
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
  const contacted = byStatus.CONTATADO + byStatus.SEM_RESPOSTA + replies;
  const rate = (n: number) => (contacted ? Math.round((n / contacted) * 10000) / 100 : 0);
  res.json({
    totalLeads: Object.values(byStatus).reduce((a, b) => a + b, 0), byStatus, sent, failed, optOuts,
    replies, responseRate: rate(replies), conversionRate: rate(byStatus.CONVERTIDO),
  });
}));

// ---------------- Qualificação (SDR com IA, v1.20.0) ----------------
// Rota antiga mantida por compatibilidade (apps abertos antes do deploy): mesma tela/configuração do SDR
// (server/sdr/qualificacaoRoutes.ts). Fonte de verdade: a etapa de qualificação do SDR.

mckmensagemRouter.get('/ia-leads', ah(async (req, res) => {
  res.json(await qualiView(orgOf(req)));
}));

mckmensagemRouter.put('/ia-leads', ah(async (req, res) => {
  await saveQualiFromRequest(req);
  res.json(await qualiView(orgOf(req)));
}));

/** Simula a resposta de um lead (nada é enviado e nenhum lead é alterado). */
mckmensagemRouter.post('/ia-leads/testar', ah(async (req, res) => {
  res.json(await testQuali(req));
}));
