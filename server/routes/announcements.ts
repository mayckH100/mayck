import express, { Router, type Request, type RequestHandler } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { prisma } from '../db.js';
import { ah, badRequest, HttpError, notFound } from '../lib/http.js';
import { audit } from '../lib/audit.js';
import { effectiveStatus, getSubscription } from '../billing/service.js';
import {
  ANN_APPS, ANN_AUDIENCES, ANN_MAX_BYTES, announcementState, appMatches, audienceMatches, dayKeySP, detectImageMime,
  parseSpDateTime, safeLink, sha256Hex, toSpLocalInput,
} from '../lib/announcements.js';

/**
 * Avisos com imagem (pop-up no centro da tela para os clientes).
 *  - masterAnnouncementsRouter: CRUD no Painel Master (montado em /api/master/announcements, já com requireSuperAdmin);
 *  - announcementsRouter: lado do cliente (/api/announcements): avisos ativos, imagem e "visto/fechado".
 * A imagem fica no banco (bytea): o disco do Render Free some a cada deploy.
 */

// Campos sem a imagem (nunca carregar os bytes em listas).
const META = {
  id: true, title: true, body: true, linkUrl: true, linkLabel: true, app: true, audience: true, startsAt: true, endsAt: true, active: true,
  imageMime: true, imageSize: true, imageSha256: true, createdBy: true, createdAt: true, updatedAt: true,
} as const;
type AnnMeta = { id: string; title: string | null; body: string | null; linkUrl: string | null; linkLabel: string | null; app: string; audience: string; startsAt: Date; endsAt: Date; active: boolean; imageMime: string | null; imageSize: number; imageSha256: string | null; createdAt: Date; updatedAt: Date };

const imageUrl = (a: Pick<AnnMeta, 'id' | 'imageSha256'>) => (a.imageSha256 ? `/api/announcements/${a.id}/image?v=${a.imageSha256.slice(0, 12)}` : null);

// ======================= Master =======================
export const masterAnnouncementsRouter = Router();

const optText = (max: number) => z.string().max(max).optional().nullable().transform((v) => (v ?? '').trim() || null);
const annSchema = z.object({
  title: optText(120),
  body: optText(1000),
  linkUrl: optText(500),
  linkLabel: optText(40),
  app: z.enum(ANN_APPS).default('AMBOS'),
  audience: z.enum(ANN_AUDIENCES).default('TODOS'),
  startsAt: z.string().max(40),
  endsAt: z.string().max(40),
  active: z.boolean().default(true),
}).strict();

function annData(raw: unknown) {
  const b = annSchema.parse(raw);
  const startsAt = parseSpDateTime(b.startsAt);
  const endsAt = parseSpDateTime(b.endsAt);
  if (!startsAt || !endsAt) throw badRequest('Datas inválidas. Use dia e hora (horário de Brasília).');
  if (endsAt.getTime() <= startsAt.getTime()) throw badRequest('O fim precisa ser depois do início.');
  let linkUrl: string | null = null;
  if (b.linkUrl) {
    linkUrl = safeLink(b.linkUrl);
    if (!linkUrl) throw badRequest('Link inválido: use um endereço https:// ou um caminho do app começando com /.');
  }
  return {
    title: b.title, body: b.body, linkUrl, linkLabel: linkUrl ? (b.linkLabel ?? 'Saiba mais') : null,
    app: b.app, audience: b.audience, startsAt, endsAt, active: b.active,
  };
}
const auditMeta = (d: { title: string | null; app: string; audience: string; startsAt: Date; endsAt: Date; active: boolean; linkUrl: string | null }) => ({
  title: d.title, app: d.app, audience: d.audience, startsAt: d.startsAt.toISOString(), endsAt: d.endsAt.toISOString(), active: d.active, link: !!d.linkUrl,
});

async function statsFor(ids: string[]) {
  const out = new Map<string, { views: number; viewers: number; dismissals: number }>();
  if (!ids.length) return out;
  const rows = await prisma.announcementView.findMany({ where: { announcementId: { in: ids } }, select: { announcementId: true, userId: true, dismissedAt: true } });
  const users = new Map<string, Set<string>>();
  for (const r of rows) {
    const s = out.get(r.announcementId) ?? { views: 0, viewers: 0, dismissals: 0 };
    s.views++;
    if (r.dismissedAt) s.dismissals++;
    out.set(r.announcementId, s);
    const u = users.get(r.announcementId) ?? new Set<string>();
    u.add(r.userId);
    users.set(r.announcementId, u);
  }
  for (const [id, u] of users) out.get(id)!.viewers = u.size;
  return out;
}

function masterView(a: AnnMeta, st?: { views: number; viewers: number; dismissals: number }) {
  return {
    id: a.id, title: a.title, body: a.body, linkUrl: a.linkUrl, linkLabel: a.linkLabel, app: a.app, audience: a.audience,
    startsAt: a.startsAt.toISOString(), endsAt: a.endsAt.toISOString(), startsAtLocal: toSpLocalInput(a.startsAt), endsAtLocal: toSpLocalInput(a.endsAt),
    active: a.active, state: announcementState(a), imageUrl: imageUrl(a), imageMime: a.imageMime, imageSize: a.imageSize,
    createdAt: a.createdAt.toISOString(), updatedAt: a.updatedAt.toISOString(),
    stats: st ?? { views: 0, viewers: 0, dismissals: 0 },
  };
}

async function findMeta(id: string) {
  const a = await prisma.announcement.findUnique({ where: { id }, select: META });
  if (!a) throw notFound('Aviso');
  return a;
}

masterAnnouncementsRouter.get('/', ah(async (_req, res) => {
  const items = await prisma.announcement.findMany({ select: META, orderBy: { createdAt: 'desc' }, take: 200 });
  const st = await statsFor(items.map((a) => a.id));
  res.json({ items: items.map((a) => masterView(a, st.get(a.id))), maxBytes: ANN_MAX_BYTES });
}));

masterAnnouncementsRouter.post('/', ah(async (req, res) => {
  const d = annData(req.body);
  const a = await prisma.announcement.create({ data: { ...d, createdBy: req.auth!.userId }, select: META });
  await audit(req, 'master.announcement.create', { orgId: null, entity: 'announcement', entityId: a.id, meta: auditMeta(d) });
  res.status(201).json(masterView(a));
}));

masterAnnouncementsRouter.put('/:id', ah(async (req, res) => {
  await findMeta(req.params.id);
  const d = annData(req.body);
  const a = await prisma.announcement.update({ where: { id: req.params.id }, data: d, select: META });
  await audit(req, 'master.announcement.update', { orgId: null, entity: 'announcement', entityId: a.id, meta: auditMeta(d) });
  res.json(masterView(a, (await statsFor([a.id])).get(a.id)));
}));

masterAnnouncementsRouter.post('/:id/active', ah(async (req, res) => {
  const { active } = z.object({ active: z.boolean() }).strict().parse(req.body);
  await findMeta(req.params.id);
  const a = await prisma.announcement.update({ where: { id: req.params.id }, data: { active }, select: META });
  await audit(req, active ? 'master.announcement.activate' : 'master.announcement.deactivate', { orgId: null, entity: 'announcement', entityId: a.id, meta: { title: a.title } });
  res.json(masterView(a, (await statsFor([a.id])).get(a.id)));
}));

masterAnnouncementsRouter.delete('/:id', ah(async (req, res) => {
  const a = await findMeta(req.params.id);
  await prisma.announcementView.deleteMany({ where: { announcementId: a.id } });
  await prisma.announcement.delete({ where: { id: a.id } });
  await audit(req, 'master.announcement.delete', { orgId: null, entity: 'announcement', entityId: a.id, meta: { title: a.title } });
  res.json({ ok: true });
}));

// Upload da imagem: corpo binário (no máximo 2 MB), tipo conferido pelos bytes. Limite de envios por usuário.
const uploadLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, limit: 30, standardHeaders: 'draft-7', legacyHeaders: false,
  keyGenerator: (req) => `ann:${req.auth?.userId ?? 'anon'}`,
  message: { error: 'Muitos envios de imagem. Aguarde alguns minutos.' },
});
const imageBody: RequestHandler = (req, res, next) => {
  express.raw({ type: () => true, limit: ANN_MAX_BYTES })(req, res, (err?: any) => {
    if (err) return next(err.type === 'entity.too.large' ? new HttpError(413, 'Imagem maior que 2 MB. Reduza o tamanho e tente de novo.') : new HttpError(400, 'Falha ao ler a imagem enviada'));
    next();
  });
};

masterAnnouncementsRouter.post('/:id/image', uploadLimiter, imageBody, ah(async (req, res) => {
  await findMeta(req.params.id);
  const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  if (!buf.length) throw badRequest('Envie a imagem (PNG, JPG ou WEBP).');
  if (buf.length > ANN_MAX_BYTES) throw new HttpError(413, 'Imagem maior que 2 MB. Reduza o tamanho e tente de novo.');
  const mime = detectImageMime(buf);
  if (!mime) throw new HttpError(415, 'Formato não aceito. Use PNG, JPG ou WEBP (SVG não é permitido).');
  const sha = sha256Hex(buf);
  const a = await prisma.announcement.update({
    where: { id: req.params.id },
    data: { imageData: new Uint8Array(buf), imageMime: mime, imageSize: buf.length, imageSha256: sha },
    select: META,
  });
  // Auditoria sem o conteúdo da imagem: só tipo, tamanho e hash.
  await audit(req, 'master.announcement.image', { orgId: null, entity: 'announcement', entityId: a.id, meta: { mime, size: buf.length, sha256: sha } });
  res.json(masterView(a, (await statsFor([a.id])).get(a.id)));
}));

// ======================= Clientes =======================
export const announcementsRouter = Router();

const requireLogin: RequestHandler = (req, _res, next) => (req.auth ? next() : next(new HttpError(401, 'Faça login para continuar')));
announcementsRouter.use(requireLogin);

const APP_PARAM = z.enum(['MCKBOT', 'MCKMENSAGEM']);

/** Avisos que este usuário deve ver agora neste app (sem os já fechados hoje). */
export async function activeAnnouncementsFor(req: Request, app: 'MCKBOT' | 'MCKMENSAGEM', now = new Date()) {
  const orgId = req.auth?.orgId;
  if (!orgId || !req.auth?.role) return [];
  const list = await prisma.announcement.findMany({
    where: { active: true, startsAt: { lte: now }, endsAt: { gt: now }, imageMime: { not: null }, app: { in: [app, 'AMBOS'] } },
    select: META, orderBy: [{ startsAt: 'asc' }, { createdAt: 'asc' }], take: 20,
  });
  if (!list.length) return [];
  let status: string | null = null;
  if (list.some((a) => a.audience !== 'TODOS')) status = effectiveStatus(await getSubscription(orgId, app), now);
  const day = dayKeySP(now);
  const closed = new Set((await prisma.announcementView.findMany({
    where: { userId: req.auth.userId, day, dismissedAt: { not: null }, announcementId: { in: list.map((a) => a.id) } },
    select: { announcementId: true },
  })).map((v) => v.announcementId));
  return list
    .filter((a) => appMatches(a.app, app) && audienceMatches(a.audience, status) && !closed.has(a.id))
    .map((a) => ({ id: a.id, title: a.title, body: a.body, linkUrl: a.linkUrl, linkLabel: a.linkLabel, imageUrl: imageUrl(a), day }));
}

announcementsRouter.get('/active', ah(async (req, res) => {
  const app = APP_PARAM.safeParse(String(req.query.app ?? '').toUpperCase());
  if (!app.success) throw badRequest('Informe app=MCKBOT ou app=MCKMENSAGEM');
  res.setHeader('Cache-Control', 'no-store');
  res.json({ items: await activeAnnouncementsFor(req, app.data) });
}));

/** Registra que o aviso apareceu ("view") ou foi fechado ("dismiss") hoje. Fechado: não volta mais hoje. */
announcementsRouter.post('/:id/seen', ah(async (req, res) => {
  const { action } = z.object({ action: z.enum(['view', 'dismiss']) }).strict().parse(req.body ?? {});
  const a = await prisma.announcement.findUnique({ where: { id: req.params.id }, select: { id: true, active: true } });
  if (!a || !a.active) throw notFound('Aviso');
  const userId = req.auth!.userId;
  const day = dayKeySP();
  const key = { announcementId_userId_day: { announcementId: a.id, userId, day } };
  const dismissedAt = action === 'dismiss' ? new Date() : undefined;
  try {
    await prisma.announcementView.upsert({
      where: key,
      create: { announcementId: a.id, userId, orgId: req.auth!.orgId ?? null, day, ...(dismissedAt ? { dismissedAt } : {}) },
      update: dismissedAt ? { dismissedAt } : {},
    });
  } catch {
    // Corrida entre duas abas: a linha já existe; só marca o fechamento.
    if (dismissedAt) await prisma.announcementView.updateMany({ where: { announcementId: a.id, userId, day }, data: { dismissedAt } });
  }
  res.json({ ok: true, day });
}));

/** Imagem do aviso. Cliente só vê aviso ativo; superadmin vê todos (pré-visualização). */
announcementsRouter.get('/:id/image', ah(async (req, res) => {
  const a = await prisma.announcement.findUnique({ where: { id: req.params.id }, select: { active: true, imageData: true, imageMime: true, imageSha256: true } });
  if (!a || !a.imageData || !a.imageMime || (!a.active && !req.auth!.isSuperAdmin)) throw notFound('Imagem');
  const mime = detectImageMime(Buffer.from(a.imageData));
  if (!mime) throw notFound('Imagem'); // nunca serve algo que não seja PNG/JPEG/WEBP de verdade
  const etag = `"${a.imageSha256 ?? sha256Hex(Buffer.from(a.imageData))}"`;
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, max-age=86400');
  res.setHeader('ETag', etag);
  res.setHeader('Content-Disposition', 'inline');
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  if (req.headers['if-none-match'] === etag) return void res.status(304).end();
  res.type(mime).send(Buffer.from(a.imageData));
}));
