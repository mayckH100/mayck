import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { ah, notFound, HttpError, badRequest } from '../lib/http.js';
import { orgOf, requireRole } from '../auth/session.js';
import { audit } from '../lib/audit.js';
import { encrypt, decryptOrNull, maskSecret } from '../lib/crypto.js';
import { assertPublicUrl, safeFetch } from '../lib/ssrf.js';
import type { Integration } from '@prisma/client';

/** Integrações de parceiro: API HTTP externa com credencial cifrada, usada pelo bloco HTTP dos fluxos. */
export const integrationsRouter = Router();

async function checkBaseUrl(u: string) {
  try { await assertPublicUrl(u); } catch (e) { throw badRequest(`URL recusada: ${(e as Error).message}`); }
}

const view = (i: Integration) => ({ id: i.id, name: i.name, slug: i.slug, baseUrl: i.baseUrl, authHeaderName: i.authHeaderName, authPreview: maskSecret(decryptOrNull(i.authValueEnc)), lastTestAt: i.lastTestAt, lastTestStatus: i.lastTestStatus, createdAt: i.createdAt });

integrationsRouter.get('/', ah(async (req, res) => {
  res.json((await prisma.integration.findMany({ where: { orgId: orgOf(req) }, orderBy: { createdAt: 'asc' } })).map(view));
}));

const schema = z.object({
  name: z.string().trim().min(1).max(60),
  baseUrl: z.string().trim().url().max(300),
  authHeaderName: z.string().trim().regex(/^[A-Za-z0-9-]{1,60}$/).optional().or(z.literal('')),
  authValue: z.string().trim().max(1000).optional(),
});
const slugify = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'integracao';

integrationsRouter.post('/', requireRole('OWNER', 'ADMIN'), ah(async (req, res) => {
  const body = schema.parse(req.body);
  const orgId = orgOf(req);
  const slug = slugify(body.name);
  if (await prisma.integration.findUnique({ where: { orgId_slug: { orgId, slug } } })) throw new HttpError(409, 'Já existe uma integração com este nome');
  await checkBaseUrl(body.baseUrl);
  const i = await prisma.integration.create({ data: { orgId, name: body.name, slug, baseUrl: body.baseUrl, authHeaderName: body.authHeaderName || null, authValueEnc: body.authValue ? encrypt(body.authValue) : null } });
  await audit(req, 'integration.create', { entity: 'integration', entityId: i.id });
  res.status(201).json(view(i));
}));

integrationsRouter.patch('/:id', requireRole('OWNER', 'ADMIN'), ah(async (req, res) => {
  const body = schema.partial().parse(req.body);
  const i = await prisma.integration.findFirst({ where: { id: req.params.id, orgId: orgOf(req) } });
  if (!i) throw notFound('Integração');
  if (body.baseUrl) await checkBaseUrl(body.baseUrl);
  const u = await prisma.integration.update({ where: { id: i.id }, data: { name: body.name, baseUrl: body.baseUrl, authHeaderName: body.authHeaderName === '' ? null : body.authHeaderName, authValueEnc: body.authValue ? encrypt(body.authValue) : undefined } });
  await audit(req, 'integration.update', { entity: 'integration', entityId: i.id });
  res.json(view(u));
}));

integrationsRouter.post('/:id/test', requireRole('OWNER', 'ADMIN'), ah(async (req, res) => {
  const i = await prisma.integration.findFirst({ where: { id: req.params.id, orgId: orgOf(req) } });
  if (!i) throw notFound('Integração');
  const headers: Record<string, string> = {};
  const secret = decryptOrNull(i.authValueEnc);
  if (i.authHeaderName && secret) headers[i.authHeaderName] = secret;
  let status = 'erro';
  let detail = '';
  try {
    const r = await safeFetch(i.baseUrl, { headers, signal: AbortSignal.timeout(10000) });
    status = r.ok ? 'ok' : `HTTP ${r.status}`;
    detail = `Resposta HTTP ${r.status}`;
  } catch (e) {
    detail = (e as Error).message;
  }
  const u = await prisma.integration.update({ where: { id: i.id }, data: { lastTestAt: new Date(), lastTestStatus: status } });
  res.json({ ...view(u), detail });
}));

integrationsRouter.delete('/:id', requireRole('OWNER', 'ADMIN'), ah(async (req, res) => {
  const i = await prisma.integration.findFirst({ where: { id: req.params.id, orgId: orgOf(req) } });
  if (!i) throw notFound('Integração');
  await prisma.integration.delete({ where: { id: i.id } });
  await audit(req, 'integration.delete', { entity: 'integration', entityId: i.id });
  res.json({ ok: true });
}));
