import express, { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { ah, notFound, HttpError } from '../lib/http.js';
import { orgOf, requireRole } from '../auth/session.js';
import { audit } from '../lib/audit.js';
import { parseJson } from '../lib/json.js';
import { IMPORT_MAX_BYTES, templateCsv, decodeCsv, readSheet, checkRows, type CheckedRow } from '../lib/contacts-import.js';

export const contactsRouter = Router();

export function normalizePhone(raw: string): string | null {
  let d = raw.replace(/\D/g, '');
  if (d.length === 10 || d.length === 11) d = '55' + d; // número brasileiro sem DDI
  return d.length >= 10 && d.length <= 15 ? d : null;
}

function view(c: import('@prisma/client').Contact) {
  return { ...c, tags: parseJson<string[]>(c.tags, []), vars: parseJson<Record<string, unknown>>(c.vars, {}) };
}

contactsRouter.get('/', ah(async (req, res) => {
  const q = z.object({ q: z.string().max(100).optional(), tag: z.string().max(50).optional(), stageId: z.string().optional(), page: z.coerce.number().int().min(1).default(1) }).parse(req.query);
  const orgId = orgOf(req);
  const where: any = { orgId };
  if (q.q) where.OR = [{ name: { contains: q.q } }, { phone: { contains: q.q.replace(/[^\d+]/g, '') || q.q } }, { email: { contains: q.q } }];
  if (q.tag) where.tags = { contains: JSON.stringify(q.tag) };
  if (q.stageId) where.stageId = q.stageId === 'none' ? null : q.stageId;
  const [items, total] = await Promise.all([
    prisma.contact.findMany({ where, orderBy: [{ lastMessageAt: 'desc' }, { createdAt: 'desc' }], take: 50, skip: (q.page - 1) * 50 }),
    prisma.contact.count({ where }),
  ]);
  res.json({ items: items.map(view), total, page: q.page, pageSize: 50 });
}));

const contactSchema = z.object({
  name: z.string().trim().max(100).optional().nullable(),
  phone: z.string().trim().min(8).max(30),
  email: z.string().trim().email().max(200).optional().nullable().or(z.literal('')),
  tags: z.array(z.string().trim().min(1).max(40)).max(30).optional(),
  notes: z.string().max(5000).optional().nullable(),
  stageId: z.string().optional().nullable(),
  optOut: z.boolean().optional(),
});

async function checkStage(orgId: string, stageId?: string | null) {
  if (!stageId) return;
  const st = await prisma.kanbanStage.findFirst({ where: { id: stageId, orgId } });
  if (!st) throw new HttpError(400, 'Etapa do Kanban inválida');
}

contactsRouter.post('/', ah(async (req, res) => {
  const body = contactSchema.parse(req.body);
  const orgId = orgOf(req);
  const waId = normalizePhone(body.phone);
  if (!waId) throw new HttpError(400, 'Telefone inválido. Use DDI + DDD + número, ex.: 5511999998888');
  await checkStage(orgId, body.stageId);
  const exists = await prisma.contact.findUnique({ where: { orgId_waId: { orgId, waId } } });
  if (exists) throw new HttpError(409, 'Já existe um contato com este telefone');
  const c = await prisma.contact.create({
    data: { orgId, waId, phone: '+' + waId, name: body.name || null, email: body.email || null, tags: JSON.stringify(body.tags ?? []), notes: body.notes ?? null, stageId: body.stageId ?? null, optOut: body.optOut ?? false },
  });
  await audit(req, 'contact.create', { entity: 'contact', entityId: c.id });
  res.status(201).json(view(c));
}));

contactsRouter.post('/import', requireRole('OWNER', 'ADMIN'), ah(async (req, res) => {
  const { text } = z.object({ text: z.string().max(200000) }).parse(req.body);
  const orgId = orgOf(req);
  let created = 0, updated = 0;
  const errors: string[] = [];
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (const [i, line] of lines.entries()) {
    if (i === 0 && /telefone|phone/i.test(line)) continue; // cabeçalho
    const [phone, name, email] = line.split(/[;,\t]/).map((s) => s?.trim());
    const waId = normalizePhone(phone ?? '');
    if (!waId) { errors.push(`Linha ${i + 1}: telefone inválido`); continue; }
    const ex = await prisma.contact.findUnique({ where: { orgId_waId: { orgId, waId } } });
    if (ex) {
      await prisma.contact.update({ where: { id: ex.id }, data: { name: ex.name ?? (name || null), email: ex.email ?? (email || null) } });
      updated++;
    } else {
      await prisma.contact.create({ data: { orgId, waId, phone: '+' + waId, name: name || null, email: email || null } });
      created++;
    }
  }
  await audit(req, 'contact.import', { meta: { created, updated, errors: errors.length } });
  res.json({ created, updated, errors: errors.slice(0, 50) });
}));

// ---------- Importação por planilha (CSV) ----------

/** Modelo da planilha: CSV UTF-8 com BOM, separador ';'. Abre direto no Excel/Google Planilhas. */
contactsRouter.get('/import/template', ah(async (_req, res) => {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="modelo-contatos.csv"');
  res.send(templateCsv());
}));

// Arquivo inteiro no corpo (application/octet-stream ou text/csv), até 2 MB.
const csvBody = express.raw({ type: (req) => !String(req.headers['content-type'] ?? '').includes('application/json'), limit: IMPORT_MAX_BYTES });

async function analyzeUpload(req: express.Request, orgId: string): Promise<CheckedRow[]> {
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) throw new HttpError(400, 'Envie o arquivo CSV da planilha.');
  const sheet = readSheet(decodeCsv(req.body));
  if (!sheet.ok) throw new HttpError(400, sheet.error);
  const existingRows = await prisma.contact.findMany({ where: { orgId }, select: { id: true, waId: true, tags: true } });
  const existing = new Map(existingRows.map((c) => [c.waId, c.id]));
  // Etiqueta que já existe na organização (ignorando maiúsculas) é reaproveitada com a mesma grafia; senão é criada.
  const known = new Map<string, string>();
  for (const c of existingRows) for (const t of parseJson<string[]>(c.tags, [])) if (typeof t === 'string' && !known.has(t.toLowerCase())) known.set(t.toLowerCase(), t);
  const canonical = (t: string) => {
    const k = t.toLowerCase();
    if (!known.has(k)) known.set(k, t);
    return known.get(k)!;
  };
  return checkRows(sheet.rows, normalizePhone, existing, canonical);
}

const summarize = (rows: CheckedRow[]) => ({
  total: rows.length,
  ok: rows.filter((r) => r.status === 'ok').length,
  errors: rows.filter((r) => r.status === 'error').length,
  duplicates: rows.filter((r) => r.status === 'duplicate').length,
});

/** Prévia: valida cada linha (ok / erro / duplicado) sem gravar nada. */
contactsRouter.post('/import/preview', requireRole('OWNER', 'ADMIN'), csvBody, ah(async (req, res) => {
  const rows = await analyzeUpload(req, orgOf(req));
  res.json({
    ...summarize(rows),
    rows: rows.map((r) => ({ line: r.line, status: r.status, messages: r.messages, name: r.name, phone: r.phone, email: r.email, empresa: r.empresa, tags: r.tags, notes: r.notes, existing: !!r.existingId })),
  });
}));

/**
 * Confirma a importação: cria as linhas válidas e não duplicadas. Com ?updateExisting=1, também atualiza os
 * contatos que já existem (campos preenchidos na planilha sobrescrevem; etiquetas são somadas).
 */
contactsRouter.post('/import/confirm', requireRole('OWNER', 'ADMIN'), csvBody, ah(async (req, res) => {
  const updateExisting = ['1', 'true', 'sim'].includes(String(req.query.updateExisting ?? '').toLowerCase());
  const orgId = orgOf(req);
  const rows = await analyzeUpload(req, orgId);
  const toCreate = rows.filter((r) => r.status === 'ok');
  const toUpdate = updateExisting ? rows.filter((r) => r.status === 'duplicate' && r.existingId) : [];
  let created = 0, updated = 0;
  try {
    await prisma.$transaction(async (tx) => {
      for (let i = 0; i < toCreate.length; i += 500) {
        const batch = toCreate.slice(i, i + 500);
        const r = await tx.contact.createMany({
          data: batch.map((c) => ({
            orgId, waId: c.waId!, phone: c.phone, name: c.name, email: c.email || null, notes: c.notes || null,
            tags: JSON.stringify(c.tags), vars: JSON.stringify(c.empresa ? { empresa: c.empresa } : {}),
          })),
        });
        created += r.count;
      }
      if (toUpdate.length) {
        const current = await tx.contact.findMany({ where: { orgId, id: { in: toUpdate.map((r) => r.existingId!) } } });
        const byId = new Map(current.map((c) => [c.id, c]));
        for (const r of toUpdate) {
          const c = byId.get(r.existingId!);
          if (!c) continue;
          const tags = parseJson<string[]>(c.tags, []);
          const lower = new Set(tags.map((t) => String(t).toLowerCase()));
          for (const t of r.tags) if (!lower.has(t.toLowerCase())) { tags.push(t); lower.add(t.toLowerCase()); }
          const vars = parseJson<Record<string, unknown>>(c.vars, {});
          if (r.empresa) vars.empresa = r.empresa;
          await tx.contact.update({
            where: { id: c.id },
            data: { name: r.name || c.name, email: r.email || c.email, notes: r.notes || c.notes, tags: JSON.stringify(tags.slice(0, 30)), vars: JSON.stringify(vars) },
          });
          updated++;
        }
      }
    }, { timeout: 120_000, maxWait: 10_000 });
  } catch (e: any) {
    if (e?.code === 'P2002') throw new HttpError(409, 'Alguns contatos foram criados enquanto a importação rodava. Gere a prévia de novo e confirme.');
    throw e;
  }
  const s = summarize(rows);
  const result = { ...s, created, updated, skipped: s.duplicates - updated };
  // Auditoria só com contagens (sem nomes, telefones ou e-mails).
  await audit(req, 'contacts.import', { meta: { ...result, updateExisting } });
  res.json(result);
}));

contactsRouter.get('/:id', ah(async (req, res) => {
  const orgId = orgOf(req);
  const c = await prisma.contact.findFirst({ where: { id: req.params.id, orgId } });
  if (!c) throw notFound('Contato');
  const conversations = await prisma.conversation.findMany({ where: { orgId, contactId: c.id }, orderBy: { createdAt: 'desc' }, take: 20 });
  res.json({ ...view(c), conversations });
}));

contactsRouter.patch('/:id', ah(async (req, res) => {
  const body = contactSchema.partial().parse(req.body);
  const orgId = orgOf(req);
  const c = await prisma.contact.findFirst({ where: { id: req.params.id, orgId } });
  if (!c) throw notFound('Contato');
  await checkStage(orgId, body.stageId);
  let waId: string | undefined;
  if (body.phone) {
    const n = normalizePhone(body.phone);
    if (!n) throw new HttpError(400, 'Telefone inválido');
    waId = n;
  }
  const u = await prisma.contact.update({
    where: { id: c.id },
    data: {
      name: body.name === undefined ? undefined : body.name || null,
      email: body.email === undefined ? undefined : body.email || null,
      notes: body.notes === undefined ? undefined : body.notes,
      tags: body.tags ? JSON.stringify(body.tags) : undefined,
      stageId: body.stageId === undefined ? undefined : body.stageId,
      optOut: body.optOut,
      ...(waId ? { waId, phone: '+' + waId } : {}),
    },
  });
  await audit(req, 'contact.update', { entity: 'contact', entityId: c.id, meta: { fields: Object.keys(body) } });
  res.json(view(u));
}));

/** LGPD — exporta todos os dados do titular (contato, conversas, mensagens, execuções). */
contactsRouter.get('/:id/export', requireRole('OWNER', 'ADMIN'), ah(async (req, res) => {
  const orgId = orgOf(req);
  const c = await prisma.contact.findFirst({ where: { id: req.params.id, orgId } });
  if (!c) throw notFound('Contato');
  const conversations = await prisma.conversation.findMany({ where: { orgId, contactId: c.id } });
  const messages = await prisma.message.findMany({ where: { orgId, conversationId: { in: conversations.map((x) => x.id) } }, orderBy: { createdAt: 'asc' } });
  const runs = await prisma.flowRun.findMany({ where: { orgId, contactId: c.id } });
  await audit(req, 'lgpd.export', { entity: 'contact', entityId: c.id });
  res.setHeader('Content-Disposition', `attachment; filename="contato-${c.id}.json"`);
  res.json({ exportedAt: new Date().toISOString(), contact: view(c), conversations, messages, flowRuns: runs });
}));

/** LGPD — apaga definitivamente o contato e tudo que se refere a ele. */
contactsRouter.delete('/:id', requireRole('OWNER', 'ADMIN'), ah(async (req, res) => {
  const orgId = orgOf(req);
  const c = await prisma.contact.findFirst({ where: { id: req.params.id, orgId } });
  if (!c) throw notFound('Contato');
  const convIds = (await prisma.conversation.findMany({ where: { orgId, contactId: c.id }, select: { id: true } })).map((x) => x.id);
  const runIds = (await prisma.flowRun.findMany({ where: { orgId, contactId: c.id }, select: { id: true } })).map((x) => x.id);
  await prisma.$transaction([
    prisma.flowRunStep.deleteMany({ where: { orgId, runId: { in: runIds } } }),
    prisma.flowRun.deleteMany({ where: { orgId, contactId: c.id } }),
    prisma.aiUsage.updateMany({ where: { orgId, conversationId: { in: convIds } }, data: { conversationId: null } }),
    prisma.message.deleteMany({ where: { orgId, conversationId: { in: convIds } } }),
    prisma.conversation.deleteMany({ where: { orgId, contactId: c.id } }),
    prisma.contact.delete({ where: { id: c.id } }),
  ]);
  await audit(req, 'lgpd.delete', { entity: 'contact', entityId: c.id, meta: { conversations: convIds.length } });
  res.json({ ok: true, deletedConversations: convIds.length });
}));
