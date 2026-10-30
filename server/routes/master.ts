import { Router, type Request } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { ah, badRequest, HttpError, notFound } from '../lib/http.js';
import { audit } from '../lib/audit.js';
import { maskSecret } from '../lib/crypto.js';
import { checkMpCredential } from '../billing/mercadopago.js';
import {
  PRODUCTS, PLAN_PRODUCTS, CYCLES, type Product, type SubStatus,
  effectiveStatus, getSettings, getSubscription, getWebhookSecret, updateSettings,
  renew, block, unblock, activateManual, setValidUntil,
} from '../billing/service.js';
import { COUPON_CYCLES, COUPON_PRODUCTS, CODE_RE, MIN_FINAL_CENTS, normalizeCode } from '../billing/coupons.js';
import { DEFAULT_SITE, getSiteSettings, updateSiteSettings } from '../lib/site-settings.js';
import { backupDestinations, backupFileName, createBackupFile, runBackup } from '../lib/backup.js';

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
  const mpCheck = await checkMpCredential();
  return { prices: s.prices, trialDays: s.trialDays, mpWebhookSecret: maskSecret(secret), mpWebhookSecretConfigured: !!secret, mpConfigured: !!process.env.MP_ACCESS_TOKEN, mpCheck, products: PLAN_PRODUCTS, cycles: CYCLES };
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

// ---------- Cupons de desconto ----------
type CouponRow = { id: string; code: string; partner: string | null; type: string; value: number; product: string; cycles: string; validUntil: Date | null; maxUses: number | null; active: boolean; createdAt: Date; updatedAt: Date };
async function couponStats(ids: string[]) {
  const rows = await prisma.couponRedemption.groupBy({
    by: ['couponId'], where: { couponId: { in: ids }, status: 'CONFIRMADO' },
    _count: { _all: true }, _sum: { finalCents: true, discountCents: true },
  });
  const anyUse = await prisma.couponRedemption.groupBy({ by: ['couponId'], where: { couponId: { in: ids } }, _count: { _all: true } });
  const used = new Set(anyUse.map((r) => r.couponId));
  return { map: new Map(rows.map((r) => [r.couponId, { uses: r._count._all, revenueCents: r._sum.finalCents ?? 0, discountCents: r._sum.discountCents ?? 0 }])), used };
}
function couponView(c: CouponRow, st?: { uses: number; revenueCents: number; discountCents: number }, everUsed = false) {
  const now = Date.now();
  const uses = st?.uses ?? 0;
  const state = !c.active ? 'INATIVO' : c.validUntil && c.validUntil.getTime() < now ? 'EXPIRADO' : c.maxUses !== null && uses >= c.maxUses ? 'ESGOTADO' : 'ATIVO';
  return {
    id: c.id, code: c.code, partner: c.partner, type: c.type, value: c.value, product: c.product, cycles: c.cycles,
    validUntil: iso(c.validUntil), maxUses: c.maxUses, active: c.active, state, uses,
    revenueCents: st?.revenueCents ?? 0, discountCents: st?.discountCents ?? 0, deletable: !everUsed,
    createdAt: c.createdAt.toISOString(), updatedAt: c.updatedAt.toISOString(),
  };
}

masterRouter.get('/coupons', ah(async (_req, res) => {
  const items = await prisma.coupon.findMany({ orderBy: { createdAt: 'desc' } });
  const { map, used } = await couponStats(items.map((c) => c.id));
  res.json({ items: items.map((c) => couponView(c, map.get(c.id), used.has(c.id))), products: COUPON_PRODUCTS, cycles: COUPON_CYCLES, minFinalCents: MIN_FINAL_CENTS });
}));

const dateOnly = /^\d{4}-\d{2}-\d{2}$/;
const couponSchema = z.object({
  code: z.string().trim().max(40).transform(normalizeCode).refine((v) => CODE_RE.test(v), 'Código: 3 a 30 caracteres, só letras, números, - e _'),
  partner: z.string().trim().max(120).nullable().optional(),
  type: z.enum(['PERCENT', 'FIXED']),
  value: z.number().int().positive().max(100_000_000),
  product: z.enum(COUPON_PRODUCTS),
  cycles: z.enum(COUPON_CYCLES).default('ALL'),
  // Data sem hora: vale até o fim do dia (horário de Brasília).
  validUntil: z.string().datetime({ offset: true }).or(z.string().regex(dateOnly)).nullable().optional(),
  maxUses: z.number().int().positive().max(10_000_000).nullable().optional(),
  active: z.boolean().default(true),
}).superRefine((v, ctx) => {
  if (v.type === 'PERCENT' && (v.value < 1 || v.value > 99)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['value'], message: 'Percentual entre 1 e 99' });
});
const toDate = (v: string | null | undefined) => {
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  const d = dateOnly.test(v) ? new Date(`${v}T23:59:59-03:00`) : new Date(v);
  if (Number.isNaN(d.getTime())) throw badRequest('Data inválida');
  return d;
};
const couponData = (b: z.infer<typeof couponSchema>) => ({
  code: b.code, partner: b.partner?.trim() || null, type: b.type, value: b.value, product: b.product, cycles: b.cycles,
  validUntil: toDate(b.validUntil) ?? null, maxUses: b.maxUses ?? null, active: b.active,
});

masterRouter.post('/coupons', ah(async (req, res) => {
  const b = couponSchema.parse(req.body);
  if (await prisma.coupon.findUnique({ where: { code: b.code } })) throw new HttpError(409, `Já existe um cupom com o código ${b.code}`);
  const c = await prisma.coupon.create({ data: { ...couponData(b), createdBy: req.auth!.userId } });
  await audit(req, 'master.coupon.create', { orgId: null, entity: 'coupon', entityId: c.id, meta: couponData(b) });
  res.status(201).json(couponView(c));
}));

masterRouter.put('/coupons/:id', ah(async (req, res) => {
  const cur = await prisma.coupon.findUnique({ where: { id: req.params.id } });
  if (!cur) throw notFound('Cupom');
  const b = couponSchema.parse(req.body);
  const { map, used } = await couponStats([cur.id]);
  if (b.code !== cur.code) {
    if (used.has(cur.id)) throw new HttpError(409, 'Este cupom já foi usado: o código não pode mudar. Crie um novo cupom.');
    if (await prisma.coupon.findUnique({ where: { code: b.code } })) throw new HttpError(409, `Já existe um cupom com o código ${b.code}`);
  }
  const data = couponData(b);
  const c = await prisma.coupon.update({ where: { id: cur.id }, data });
  const changed = Object.fromEntries(Object.entries(data).filter(([k, v]) => {
    const old = (cur as any)[k];
    return (old instanceof Date ? old.toISOString() : old) !== (v instanceof Date ? v.toISOString() : v);
  }));
  await audit(req, 'master.coupon.update', { orgId: null, entity: 'coupon', entityId: c.id, meta: { code: c.code, changed } });
  res.json(couponView(c, map.get(c.id), used.has(c.id)));
}));

masterRouter.post('/coupons/:id/active', ah(async (req, res) => {
  const { active } = z.object({ active: z.boolean() }).parse(req.body);
  const cur = await prisma.coupon.findUnique({ where: { id: req.params.id } });
  if (!cur) throw notFound('Cupom');
  const c = await prisma.coupon.update({ where: { id: cur.id }, data: { active } });
  await audit(req, active ? 'master.coupon.activate' : 'master.coupon.deactivate', { orgId: null, entity: 'coupon', entityId: c.id, meta: { code: c.code } });
  const { map, used } = await couponStats([c.id]);
  res.json(couponView(c, map.get(c.id), used.has(c.id)));
}));

/** Exclusão só para cupom nunca usado; usado, apenas desativar (mantém histórico e relatórios). */
masterRouter.delete('/coupons/:id', ah(async (req, res) => {
  const cur = await prisma.coupon.findUnique({ where: { id: req.params.id } });
  if (!cur) throw notFound('Cupom');
  if (await prisma.couponRedemption.count({ where: { couponId: cur.id } })) throw new HttpError(409, 'Cupom já usado não pode ser excluído. Desative-o.');
  await prisma.coupon.delete({ where: { id: cur.id } });
  await audit(req, 'master.coupon.delete', { orgId: null, entity: 'coupon', entityId: cur.id, meta: { code: cur.code } });
  res.json({ ok: true });
}));

// ---------- Site oficial (/empresa) ----------
masterRouter.get('/site', ah(async (_req, res) => res.json({ ...(await getSiteSettings()), defaults: DEFAULT_SITE })));

masterRouter.put('/site', ah(async (req, res) => {
  const b = z.object({
    contactEmail: z.string().trim().email('E-mail de contato inválido').max(200).optional(),
    whatsapp: z.string().trim().max(30).transform((v) => v.replace(/\D/g, '')).refine((v) => v === '' || (v.length >= 10 && v.length <= 15), 'WhatsApp: informe DDI + DDD + número, ex.: 5511999999999').optional(),
    facebookUrl: z.string().trim().max(300).refine((v) => v === '' || /^https:\/\/(www\.|m\.)?(facebook|fb)\.com\//i.test(v), 'Use um link https://www.facebook.com/...').optional(),
    tutorialsPublic: z.boolean().optional(),
    promoCoupon: z.string().trim().max(40).transform(normalizeCode).optional(),
    promoText: z.string().trim().max(200).optional(),
  }).parse(req.body);
  if (b.promoCoupon && !(await prisma.coupon.findUnique({ where: { code: b.promoCoupon } }))) throw badRequest(`Cupom ${b.promoCoupon} não existe. Crie o cupom antes de colocá-lo em destaque.`);
  const next = await updateSiteSettings({ ...b, facebookUrl: b.facebookUrl === '' ? DEFAULT_SITE.facebookUrl : b.facebookUrl });
  await audit(req, 'master.site.update', { orgId: null, entity: 'platform_settings', entityId: 'site', meta: b });
  res.json({ ...next, defaults: DEFAULT_SITE });
}));

// ---------------- Segurança: backups do banco ----------------
const backupView = (r: { id: string; trigger: string; status: string; startedAt: Date; finishedAt: Date | null; sizeBytes: number | null; rows: number | null; destination: string | null; location: string | null; error: string | null }) => ({
  ...r, startedAt: r.startedAt.toISOString(), finishedAt: r.finishedAt?.toISOString() ?? null,
});

masterRouter.get('/backups', ah(async (_req, res) => {
  const runs = await prisma.backupRun.findMany({ orderBy: { startedAt: 'desc' }, take: 20 });
  const lastOk = await prisma.backupRun.findFirst({ where: { status: 'OK' }, orderBy: { startedAt: 'desc' } });
  res.json({ destinations: backupDestinations(), runs: runs.map(backupView), lastOk: lastOk ? backupView(lastOk) : null });
}));

masterRouter.post('/backups/run', ah(async (req, res) => {
  let result;
  try { result = await runBackup('MANUAL', req.auth!.userId); } catch (e) { throw new HttpError(409, (e as Error).message); }
  res.json(backupView(result.run));
}));

masterRouter.get('/backups/download', ah(async (req, res) => {
  const { data, rows } = await createBackupFile();
  await audit(req, 'backup.download', { orgId: null, entity: 'backup', meta: { sizeBytes: data.length, rows } });
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${backupFileName()}"`);
  res.setHeader('Cache-Control', 'no-store');
  res.send(data);
}));
