import { prisma } from '../db.js';
import { decryptOrNull, encryptOrNull } from '../lib/crypto.js';

/**
 * Cobrança por produto. Cada organização tem uma assinatura por app
 * (MCKBOT e MCKMENSAGEM); o plano COMBO renova os dois de uma vez.
 */
export const PRODUCTS = ['MCKBOT', 'MCKMENSAGEM'] as const;
export type Product = (typeof PRODUCTS)[number];
export type PlanProduct = Product | 'COMBO';
export const PLAN_PRODUCTS: PlanProduct[] = ['MCKBOT', 'MCKMENSAGEM', 'COMBO'];
export const CYCLES = ['MENSAL', 'ANUAL'] as const;
export type Cycle = (typeof CYCLES)[number];
export type SubStatus = 'TRIAL' | 'ATIVA' | 'VENCIDA' | 'BLOQUEADA';
export type Prices = Record<PlanProduct, Record<Cycle, number>>;

export const DEFAULT_PRICES: Prices = {
  MCKBOT: { MENSAL: 3990, ANUAL: 39900 },
  MCKMENSAGEM: { MENSAL: 4500, ANUAL: 45000 },
  COMBO: { MENSAL: 6990, ANUAL: 69900 },
};

export const PRODUCT_LABEL: Record<PlanProduct, string> = { MCKBOT: 'MCKBOT', MCKMENSAGEM: 'MCKMENSAGEM', COMBO: 'Combo MCKBOT + MCKMENSAGEM' };

const DAY = 24 * 60 * 60 * 1000;
export const isProduct = (v: unknown): v is Product => typeof v === 'string' && (PRODUCTS as readonly string[]).includes(v);
export const isPlanProduct = (v: unknown): v is PlanProduct => typeof v === 'string' && (PLAN_PRODUCTS as string[]).includes(v);
export const isCycle = (v: unknown): v is Cycle => typeof v === 'string' && (CYCLES as readonly string[]).includes(v);
export const productsOf = (p: PlanProduct): Product[] => (p === 'COMBO' ? [...PRODUCTS] : [p]);

// ---------- Configurações da plataforma ----------
export async function getSettings() {
  const s = await prisma.platformSettings.upsert({ where: { id: 'default' }, update: {}, create: { id: 'default' } });
  let prices: Prices = DEFAULT_PRICES;
  try {
    const parsed = JSON.parse(s.pricesJson);
    prices = Object.fromEntries(PLAN_PRODUCTS.map((p) => [p, { MENSAL: Number(parsed?.[p]?.MENSAL ?? DEFAULT_PRICES[p].MENSAL), ANUAL: Number(parsed?.[p]?.ANUAL ?? DEFAULT_PRICES[p].ANUAL) }])) as Prices;
  } catch { /* mantém padrão */ }
  return { trialDays: s.trialDays, prices, webhookSecretConfigured: !!s.mpWebhookSecretEnc, raw: s };
}

export async function getWebhookSecret(): Promise<string | null> {
  const s = await prisma.platformSettings.findUnique({ where: { id: 'default' } });
  return decryptOrNull(s?.mpWebhookSecretEnc ?? null);
}

export async function updateSettings(input: { trialDays?: number; prices?: Partial<Record<PlanProduct, Partial<Record<Cycle, number>>>>; mpWebhookSecret?: string | null }) {
  const cur = await getSettings();
  const data: { trialDays?: number; pricesJson?: string; mpWebhookSecretEnc?: string | null } = {};
  if (input.trialDays !== undefined) data.trialDays = Math.max(0, Math.floor(input.trialDays));
  if (input.prices) {
    const next: Prices = JSON.parse(JSON.stringify(cur.prices));
    for (const p of PLAN_PRODUCTS) for (const c of CYCLES) {
      const v = input.prices[p]?.[c];
      if (v !== undefined && Number.isInteger(v) && v > 0) next[p][c] = v;
    }
    data.pricesJson = JSON.stringify(next);
  }
  if (input.mpWebhookSecret !== undefined) data.mpWebhookSecretEnc = input.mpWebhookSecret ? encryptOrNull(input.mpWebhookSecret) : null;
  await prisma.platformSettings.update({ where: { id: 'default' }, data });
  return getSettings();
}

export const priceOf = async (product: PlanProduct, cycle: Cycle) => (await getSettings()).prices[product][cycle];

// ---------- Assinaturas ----------
export function effectiveStatus(sub: { status: string; validUntil: Date }, now = new Date()): SubStatus {
  if (sub.status === 'BLOQUEADA') return 'BLOQUEADA';
  if (sub.validUntil.getTime() <= now.getTime()) return 'VENCIDA';
  return sub.status === 'TRIAL' ? 'TRIAL' : 'ATIVA';
}

/** Busca a assinatura; se ainda não existe, cria o período de teste (TRIAL) sob demanda. */
export async function getSubscription(orgId: string, product: Product) {
  const found = await prisma.subscription.findUnique({ where: { orgId_product: { orgId, product } } });
  if (found) return found;
  const { trialDays } = await getSettings();
  const validUntil = new Date(Date.now() + trialDays * DAY);
  try {
    const sub = await prisma.subscription.create({ data: { orgId, product, status: 'TRIAL', cycle: 'MENSAL', validUntil, source: 'TRIAL' } });
    await prisma.billingEvent.create({ data: { orgId, product, kind: 'TRIAL', newValidUntil: validUntil } });
    return sub;
  } catch {
    // corrida: outra requisição criou primeiro
    return prisma.subscription.findUniqueOrThrow({ where: { orgId_product: { orgId, product } } });
  }
}

export async function getSubscriptionView(orgId: string, product: Product) {
  const s = await getSubscription(orgId, product);
  const status = effectiveStatus(s);
  return { product, status, active: status === 'TRIAL' || status === 'ATIVA', cycle: s.cycle, validUntil: s.validUntil.toISOString(), source: s.source };
}

export async function isProductActive(orgId: string, product: Product): Promise<boolean> {
  const s = await getSubscription(orgId, product);
  const st = effectiveStatus(s);
  return st === 'TRIAL' || st === 'ATIVA';
}

function addCycle(from: Date, cycle: Cycle): Date {
  const d = new Date(from.getTime());
  if (cycle === 'ANUAL') d.setFullYear(d.getFullYear() + 1);
  else d.setMonth(d.getMonth() + 1);
  return d;
}

/**
 * Renova um produto (ou os dois, no COMBO) a partir de max(agora, validUntil).
 * Se `mpPaymentId` vier, o evento é único por pagamento: um segundo aviso do mesmo
 * pagamento não renova de novo (retorna { duplicated: true }).
 */
export async function renew(orgId: string, product: PlanProduct, cycle: Cycle, opts: { source?: 'MANUAL' | 'MP'; mpPaymentId?: string; amountCents?: number; actorUserId?: string } = {}) {
  const source = opts.source ?? (opts.mpPaymentId ? 'MP' : 'MANUAL');
  const products = productsOf(product);
  for (const p of products) await getSubscription(orgId, p);
  try {
    return await prisma.$transaction(async (tx) => {
      const now = new Date();
      const subs = await tx.subscription.findMany({ where: { orgId, product: { in: products } } });
      const prevMax = subs.reduce<Date | null>((m, s) => (!m || s.validUntil > m ? s.validUntil : m), null);
      const updated: typeof subs = [];
      for (const s of subs) {
        const base = s.validUntil.getTime() > now.getTime() ? s.validUntil : now;
        const validUntil = addCycle(base, cycle);
        // Renovação não desbloqueia: bloqueio é decisão administrativa.
        updated.push(await tx.subscription.update({ where: { id: s.id }, data: { validUntil, cycle, source, status: s.status === 'BLOQUEADA' ? 'BLOQUEADA' : 'ATIVA' } }));
      }
      const newMax = updated.reduce<Date | null>((m, s) => (!m || s.validUntil > m ? s.validUntil : m), null);
      await tx.billingEvent.create({
        data: { orgId, product, kind: source, cycle, amountCents: opts.amountCents ?? null, mpPaymentId: opts.mpPaymentId ?? null, actorUserId: opts.actorUserId ?? null, prevValidUntil: prevMax, newValidUntil: newMax },
      });
      return { duplicated: false as const, subscriptions: updated };
    });
  } catch (e: any) {
    if (opts.mpPaymentId && e?.code === 'P2002') return { duplicated: true as const, subscriptions: [] };
    throw e;
  }
}

export async function setBlocked(orgId: string, product: PlanProduct, blocked: boolean, actorUserId?: string) {
  const products = productsOf(product);
  for (const p of products) {
    const s = await getSubscription(orgId, p);
    const status = blocked ? 'BLOQUEADA' : s.source === 'TRIAL' ? 'TRIAL' : 'ATIVA';
    await prisma.subscription.update({ where: { id: s.id }, data: { status } });
  }
  await prisma.billingEvent.create({ data: { orgId, product, kind: blocked ? 'BLOCK' : 'UNBLOCK', actorUserId: actorUserId ?? null } });
}
export const block = (orgId: string, product: PlanProduct, actorUserId?: string) => setBlocked(orgId, product, true, actorUserId);
export const unblock = (orgId: string, product: PlanProduct, actorUserId?: string) => setBlocked(orgId, product, false, actorUserId);

/** Ativa manualmente (ATIVA por 1 ciclo a partir de agora), inclusive desbloqueando. */
export async function activateManual(orgId: string, product: PlanProduct, cycle: Cycle, actorUserId?: string) {
  const products = productsOf(product);
  const now = new Date();
  const validUntil = addCycle(now, cycle);
  let prevMax: Date | null = null;
  for (const p of products) {
    const s = await getSubscription(orgId, p);
    if (!prevMax || s.validUntil > prevMax) prevMax = s.validUntil;
    await prisma.subscription.update({ where: { id: s.id }, data: { status: 'ATIVA', cycle, source: 'MANUAL', validUntil } });
  }
  await prisma.billingEvent.create({ data: { orgId, product, kind: 'MANUAL', cycle, actorUserId: actorUserId ?? null, prevValidUntil: prevMax, newValidUntil: validUntil } });
}

/** Define manualmente a data de validade. Não altera bloqueio. */
export async function setValidUntil(orgId: string, product: PlanProduct, validUntil: Date, actorUserId?: string) {
  const products = productsOf(product);
  let prevMax: Date | null = null;
  for (const p of products) {
    const s = await getSubscription(orgId, p);
    if (!prevMax || s.validUntil > prevMax) prevMax = s.validUntil;
    const status = s.status === 'BLOQUEADA' ? 'BLOQUEADA' : s.status === 'TRIAL' ? 'TRIAL' : 'ATIVA';
    await prisma.subscription.update({ where: { id: s.id }, data: { validUntil, status, source: s.status === 'TRIAL' ? s.source : 'MANUAL' } });
  }
  await prisma.billingEvent.create({ data: { orgId, product, kind: 'MANUAL', actorUserId: actorUserId ?? null, prevValidUntil: prevMax, newValidUntil: validUntil } });
}
