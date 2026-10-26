import { Router, type Request } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { ah, badRequest, HttpError, notFound } from '../lib/http.js';
import { audit } from '../lib/audit.js';
import { maskSecret } from '../lib/crypto.js';
import {
  PRODUCTS, PLAN_PRODUCTS, CYCLES, type Product, type SubStatus,
  effectiveStatus, getSettings, getSubscription, getWebhookSecret, updateSettings,
  renew, block, unblock, activateManual, setValidUntil,
} from '../billing/service.js';

/**
 * Painel Master (superadmin da plataforma). Montado em /api/master com requireSuperAdmin.
 */
export const masterRouter = Router();

const TZ = 'America/Sao_Paulo';
const monthKey = (d: Date) => {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit' }).formatToParts(d);
  return `${parts.find((p) => p.type === 'year')!.value}-${parts.find((p) => p.type === 'month')!.value}`;
};
const lastMonths = (n: number, now = new Date()) => {
  const [y, m] = monthKey(now).split('-').map(Number);
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(y, m - 1 - i, 15));
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  return out;
};

const PAGE_SIZE = 20;
const pageOf = (req: Request) => Math.max(1, Math.floor(Number(req.query.page) || 1));
const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

function subView(s: { product: string; status: string; cycle: string; validUntil: Date; source: string }) {
  const status = effectiveStatus(s);
  return { product: s.product, status, active: status === 'ATIVA' || status === 'TRIAL', cycle: s.cycle, validUntil: s.validUntil.toISOString(), source: s.source };
}

function paymentView(e: { id: string; orgId: string; product: string; kind: string; cycle: string | null; amountCents: number | null; mpPaymentId: string | null; actorUserId: string | null; prevValidUntil: Date | null; newValidUntil: Date | null; createdAt: Date }, orgNames?: Map<string, string>) {
  return {
    id: e.id, orgId: e.orgId, orgName: orgNames?.get(e.orgId) ?? null, product: e.product, kind: e.kind, cycle: e.cycle,
    amountCents: e.amountCents, mpPaymentId: e.mpPaymentId, actorUserId: e.actorUserId,
    prevValidUntil: iso(e.prevValidUntil), newValidUntil: iso(e.newValidUntil), createdAt: e.createdAt.toISOString(),
  };
}

async function orgNameMap(ids: string[]) {
  const orgs = await prisma.organization.findMany({ where: { id: { in: [...new Set(ids)] } }, select: { id: true, name: true } });
  return new Map(orgs.map((o) => [o.id, o.name]));
}

/** Garante que toda organização tenha as assinaturas (cria TRIAL sob demanda, como no app). */
async function ensureSubs(orgIds: string[]) {
  const existing = await prisma.subscription.findMany({ where: { orgId: { in: orgIds } }, select: { orgId: true, product: true } });
  const have = new Set(existing.map((s) => `${s.orgId}|${s.product}`));
  for (const o of orgIds) for (const p of PRODUCTS) if (!have.has(`${o}|${p}`)) await getSubscription(o, p);
}

// ---------- Dashboard ----------
masterRouter.get('/dashboard', ah(async (_req, res) => {
  const totalClients = await prisma.organization.count();
  await ensureSubs((await prisma.organization.findMany({ select: { id: true } })).map((o) => o.id));
  const subs = await prisma.subscription.findMany();
  const empty = () => ({ ATIVA: 0, TRIAL: 0, VENCIDA: 0, BLOQUEADA: 0 } as Record<SubStatus, number>);
  const byProduct = Object.fromEntries(PRODUCTS.map((p) => [p, empty()])) as Record<Product, Record<SubStatus, number>>;
  const totals = empty();
  const { prices } = await getSettings();
  let mrrCents = 0;
  for (const s of subs) {
    const st = effectiveStatus(s);
    if (byProduct[s.product as Product]) byProduct[s.product as Product][st]++;
    totals[st]++;
    if (st === 'ATIVA' && (PRODUCTS as readonly string[]).includes(s.product)) {
      const p = prices[s.product as Product];
      mrrCents += s.cycle === 'ANUAL' ? p.ANUAL / 12 : p.MENSAL;
    }
  }
  const paid = await prisma.billingEvent.findMany({ where: { kind: 'MP', amountCents: { not: null } }, orderBy: { createdAt: 'desc' } });
  const months = lastMonths(12);
  const byMonth = new Map(months.map((m) => [m, 0]));
  let revenueTotalCents = 0;
  for (const e of paid) {
    revenueTotalCents += e.amountCents!;
    const k = monthKey(e.createdAt);
    if (byMonth.has(k)) byMonth.set(k, byMonth.get(k)! + e.amountCents!);
  }
  const last10 = paid.slice(0, 10);
  const names = await orgNameMap(last10.map((e) => e.orgId));
  res.json({
    totalClients,
    byProduct,
    totals, // soma das assinaturas (por produto) em cada status
    revenueMonthCents: byMonth.get(months[months.length - 1]) ?? 0,
    revenueTotalCents,
    mrrCents: Math.round(mrrCents),
    revenueByMonth: months.map((month) => ({ month, amountCents: byMonth.get(month)! })),
    lastPayments: last10.map((e) => paymentView(e, names)),
  });
}));

// ---------- Clientes ----------
async function ownerOf(orgId: string) {
  const m = await prisma.membership.findFirst({ where: { orgId, role: 'OWNER' }, orderBy: { createdAt: 'asc' }, include: { user: true } });
  return m ? { id: m.user.id, name: m.user.name, email: m.user.email, disabled: !!m.user.disabledAt } : null;
}

async function clientSummary(org: { id: string; name: string; createdAt: Date; plan: string }) {
  const [owner, subs, channels, messages, users, lastPay] = await Promise.all([
    ownerOf(org.id),
    prisma.subscription.findMany({ where: { orgId: org.id }, orderBy: { product: 'asc' } }),
    prisma.channel.count({ where: { orgId: org.id } }),
    prisma.message.count({ where: { orgId: org.id } }),
    prisma.membership.count({ where: { orgId: org.id } }),
    prisma.billingEvent.findFirst({ where: { orgId: org.id, kind: 'MP' }, orderBy: { createdAt: 'desc' } }),
  ]);
  return {
    id: org.id, name: org.name, createdAt: org.createdAt.toISOString(), owner,
    subscriptions: subs.map(subView), channels, messages, users,
    lastPayment: lastPay ? paymentView(lastPay) : null,
  };
}

const STATUS = ['ATIVA', 'TRIAL', 'VENCIDA', 'BLOQUEADA'] as const;
masterRouter.get('/clients', ah(async (req, res) => {
  const q = String(req.query.q ?? '').trim();
  const status = STATUS.includes(req.query.status as any) ? (req.query.status as SubStatus) : null;
  const product = (PRODUCTS as readonly string[]).includes(String(req.query.product)) ? (req.query.product as Product) : null;
  const page = pageOf(req);
  const where = q
    ? { OR: [{ name: { contains: q } }, { id: q }, { memberships: { some: { user: { OR: [{ email: { contains: q.toLowerCase() } }, { name: { contains: q } }] } } } }] }
    : {};
  let orgs = await prisma.organization.findMany({ where, orderBy: { createdAt: 'desc' }, select: { id: true, name: true, createdAt: true, plan: true } });
  await ensureSubs(orgs.map((o) => o.id));
  if (status || product) {
    const subs = await prisma.subscription.findMany({ where: { orgId: { in: orgs.map((o) => o.id) }, ...(product ? { product } : {}) } });
    const ok = new Set(subs.filter((s) => !status || effectiveStatus(s) === status).map((s) => s.orgId));
    orgs = orgs.filter((o) => ok.has(o.id));
  }
  const total = orgs.length;
  const slice = orgs.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  res.json({ items: await Promise.all(slice.map(clientSummary)), total, page, pageSize: PAGE_SIZE });
}));

masterRouter.get('/clients/:orgId', ah(async (req, res) => {
  const org = await prisma.organization.findUnique({ where: { id: req.params.orgId } });
  if (!org) throw notFound('Cliente');
  await ensureSubs([org.id]);
  const [summary, members, events, auditLog] = await Promise.all([
    clientSummary(org),
    prisma.membership.findMany({ where: { orgId: org.id }, include: { user: true }, orderBy: { createdAt: 'asc' } }),
    prisma.billingEvent.findMany({ where: { orgId: org.id }, orderBy: { createdAt: 'desc' }, take: 200 }),
    prisma.auditLog.findMany({ where: { orgId: org.id }, orderBy: { createdAt: 'desc' }, take: 50 }),
  ]);
  res.json({
    ...summary,
    timezone: org.timezone,
    members: members.map((m) => ({ userId: m.user.id, name: m.user.name, email: m.user.email, role: m.role, isSuperAdmin: m.user.isSuperAdmin, disabled: !!m.user.disabledAt, joinedAt: m.createdAt.toISOString() })),
    billingEvents: events.map((e) => paymentView(e)),
    audit: auditLog.map(auditView),
  });
}));

const actionSchema = z.object({
  action: z.enum(['renew', 'set-date', 'block', 'unblock', 'activate', 'deactivate']),
  product: z.enum(['MCKBOT', 'MCKMENSAGEM', 'COMBO']),
  cycle: z.enum(['MENSAL', 'ANUAL']).optional(),
  validUntil: z.string().datetime({ offset: true }).or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).optional(),
  reason: z.string().trim().max(500).optional(),
});
masterRouter.post('/clients/:orgId/actions', ah(async (req, res) => {
  const org = await prisma.organization.findUnique({ where: { id: req.params.orgId } });
  if (!org) throw notFound('Cliente');
  const body = actionSchema.parse(req.body);
  const actor = req.auth!.userId;
  const cycle = body.cycle ?? 'MENSAL';
  switch (body.action) {
    case 'renew': await renew(org.id, body.product, cycle, { source: 'MANUAL', actorUserId: actor }); break;
    case 'activate': await activateManual(org.id, body.product, cycle, actor); break;
    case 'set-date': {
      if (!body.validUntil) throw badRequest('Informe validUntil');
      // Data sem hora: vale até o fim do dia (horário de Brasília).
      const d = /^\d{4}-\d{2}-\d{2}$/.test(body.validUntil) ? new Date(`${body.validUntil}T23:59:59-03:00`) : new Date(body.validUntil);
      if (Number.isNaN(d.getTime())) throw badRequest('Data inválida');
      await setValidUntil(org.id, body.product, d, actor);
      break;
    }
    case 'block': case 'deactivate': await block(org.id, body.product, actor); break;
    case 'unblock': await unblock(org.id, body.product, actor); break;
  }
  await audit(req, `master.client.${body.action}`, { orgId: org.id, entity: 'subscription', entityId: org.id, meta: { product: body.product, cycle: body.cycle, validUntil: body.validUntil, reason: body.reason } });
  const subs = await prisma.subscription.findMany({ where: { orgId: org.id }, orderBy: { product: 'asc' } });
  res.json({ ok: true, subscriptions: subs.map(subView) });
}));

// ---------- Usuários ----------
masterRouter.post('/users/:userId', ah(async (req, res) => {
  const body = z.object({ disabled: z.boolean().optional(), isSuperAdmin: z.boolean().optional() }).parse(req.body);
  const user = await prisma.user.findUnique({ where: { id: req.params.userId } });
  if (!user) throw notFound('Usuário');
  const self = user.id === req.auth!.userId;
  if (self && body.isSuperAdmin === false) throw new HttpError(400, 'Você não pode remover o seu próprio acesso de superadmin');
  if (self && body.disabled === true) throw new HttpError(400, 'Você não pode desativar a sua própria conta');
  const data: { disabledAt?: Date | null; isSuperAdmin?: boolean } = {};
  if (body.disabled !== undefined) data.disabledAt = body.disabled ? (user.disabledAt ?? new Date()) : null;
  if (body.isSuperAdmin !== undefined) data.isSuperAdmin = body.isSuperAdmin;
  const updated = await prisma.user.update({ where: { id: user.id }, data });
  if (body.disabled === true) await prisma.session.deleteMany({ where: { userId: user.id } });
  await audit(req, 'master.user.update', { orgId: null, entity: 'user', entityId: user.id, meta: body });
  res.json({ id: updated.id, email: updated.email, name: updated.name, isSuperAdmin: updated.isSuperAdmin, disabled: !!updated.disabledAt, disabledAt: iso(updated.disabledAt) });
}));

// ---------- Pagamentos e atividade ----------
masterRouter.get('/payments', ah(async (req, res) => {
  const page = pageOf(req);
  const [total, items] = await Promise.all([
    prisma.billingEvent.count(),
    prisma.billingEvent.findMany({ orderBy: { createdAt: 'desc' }, skip: (page - 1) * PAGE_SIZE, take: PAGE_SIZE }),
  ]);
  const names = await orgNameMap(items.map((e) => e.orgId));
  res.json({ items: items.map((e) => paymentView(e, names)), total, page, pageSize: PAGE_SIZE });
}));

function auditView(a: { id: string; orgId: string | null; userId: string | null; action: string; entity: string | null; entityId: string | null; meta: string; ip: string | null; createdAt: Date }) {
  let meta: unknown = {};
  try { meta = JSON.parse(a.meta); } catch { /* texto inválido */ }
  return { id: a.id, orgId: a.orgId, userId: a.userId, action: a.action, entity: a.entity, entityId: a.entityId, meta, ip: a.ip, createdAt: a.createdAt.toISOString() };
}

masterRouter.get('/activity', ah(async (req, res) => {
  const page = pageOf(req);
  const [total, items] = await Promise.all([
    prisma.auditLog.count(),
    prisma.auditLog.findMany({ orderBy: { createdAt: 'desc' }, skip: (page - 1) * PAGE_SIZE, take: PAGE_SIZE }),
  ]);
  const users = await prisma.user.findMany({ where: { id: { in: items.map((i) => i.userId).filter((x): x is string => !!x) } }, select: { id: true, email: true, name: true } });
  const um = new Map(users.map((u) => [u.id, u]));
  const names = await orgNameMap(items.map((i) => i.orgId).filter((x): x is string => !!x));
  res.json({
    items: items.map((a) => ({ ...auditView(a), userEmail: a.userId ? um.get(a.userId)?.email ?? null : null, userName: a.userId ? um.get(a.userId)?.name ?? null : null, orgName: a.orgId ? names.get(a.orgId) ?? null : null })),
    total, page, pageSize: PAGE_SIZE,
  });
}));

// ---------- Configurações ----------
async function settingsView() {
  const s = await getSettings();
  const secret = await getWebhookSecret();
  return { prices: s.prices, trialDays: s.trialDays, mpWebhookSecret: maskSecret(secret), mpWebhookSecretConfigured: !!secret, mpConfigured: !!process.env.MP_ACCESS_TOKEN, products: PLAN_PRODUCTS, cycles: CYCLES };
}

masterRouter.get('/settings', ah(async (_req, res) => res.json(await settingsView())));

const cents = z.number().int().positive().max(100_000_000);
const priceRow = z.object({ MENSAL: cents.optional(), ANUAL: cents.optional() });
masterRouter.put('/settings', ah(async (req, res) => {
  const body = z.object({
    trialDays: z.number().int().min(0).max(365).optional(),
    prices: z.object({ MCKBOT: priceRow.optional(), MCKMENSAGEM: priceRow.optional(), COMBO: priceRow.optional() }).optional(),
    mpWebhookSecret: z.string().trim().max(500).nullable().optional(),
  }).parse(req.body);
  await updateSettings({ ...body, mpWebhookSecret: body.mpWebhookSecret === undefined ? undefined : body.mpWebhookSecret || null });
  await audit(req, 'master.settings.update', { orgId: null, entity: 'platform_settings', entityId: 'default', meta: { trialDays: body.trialDays, prices: body.prices, mpWebhookSecretChanged: body.mpWebhookSecret !== undefined } });
  res.json(await settingsView());
}));
