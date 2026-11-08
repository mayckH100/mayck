import { prisma } from '../db.js';
import { decryptOrNull, encryptOrNull } from '../lib/crypto.js';
import { applyPlanInput, erpBySubscriptions, parsePlanCatalog, planApps, validatePlanInput, PLAN_CODES, type PlanCatalog, type PlanInput } from './planCatalog.js';
import { applyIntroOfferInput, introEligibility, introOfferActive, parseIntroOffer, validateIntroOfferInput, INTRO_CYCLE, INTRO_PLAN, type IntroOffer, type IntroOfferInput, type PaidEvent } from './introOffer.js';

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
  COMBO: { MENSAL: 10000, ANUAL: 100000 }, // Plano Completo (ERP + MCKBOT + Mensagens): R$ 100/mês
};

/** Nomes padrão (fallback). O nome exibido vem do Master: (await getSettings()).plans[code].name (v1.25.0). */
export const PRODUCT_LABEL: Record<PlanProduct, string> = { MCKBOT: 'MCKBOT', MCKMENSAGEM: 'MCKMENSAGEM', COMBO: 'Plano Completo: MCK ERP + MCKBOT + MCK Mensagens' };

const DAY = 24 * 60 * 60 * 1000;
export const isProduct = (v: unknown): v is Product => typeof v === 'string' && (PRODUCTS as readonly string[]).includes(v);
export const isPlanProduct = (v: unknown): v is PlanProduct => typeof v === 'string' && (PLAN_PRODUCTS as string[]).includes(v);
export const isCycle = (v: unknown): v is Cycle => typeof v === 'string' && (CYCLES as readonly string[]).includes(v);
/** Assinaturas padrão de cada plano (antes da v1.25.0; continua sendo o padrão). */
export const productsOf = (p: PlanProduct): Product[] => (p === 'COMBO' ? [...PRODUCTS] : [p]);
/** Assinaturas que o plano renova conforme os módulos editados no Master (MCKBOT / MCK Mensagens). */
export async function planProducts(p: PlanProduct): Promise<Product[]> {
  const { plans } = await getSettings();
  const apps = planApps(plans[p]);
  return apps.length ? apps : productsOf(p);
}

/** Erro de validação das configurações (a rota do Master responde 400 com a mensagem). */
export class SettingsError extends Error {}

// ---------- Configurações da plataforma ----------
/**
 * Lê (ou cria) a linha 'default'. A migração 0006 já insere essa linha; mesmo assim, no primeiro acesso
 * várias requisições em paralelo podem tentar criá-la ao mesmo tempo — quem perde a corrida recebe P2002
 * (violação de chave única) e simplesmente relê a linha criada pela outra.
 */
async function loadSettingsRow() {
  const found = await prisma.platformSettings.findUnique({ where: { id: 'default' } });
  if (found) return found;
  try {
    return await prisma.platformSettings.create({ data: { id: 'default', pricesJson: JSON.stringify(DEFAULT_PRICES) } });
  } catch (e: any) {
    if (e?.code !== 'P2002') throw e;
    return prisma.platformSettings.findUniqueOrThrow({ where: { id: 'default' } });
  }
}

export async function getSettings() {
  const s = await loadSettingsRow();
  let prices: Prices = DEFAULT_PRICES;
  try {
    const parsed = JSON.parse(s.pricesJson);
    prices = Object.fromEntries(PLAN_PRODUCTS.map((p) => [p, { MENSAL: Number(parsed?.[p]?.MENSAL ?? DEFAULT_PRICES[p].MENSAL), ANUAL: Number(parsed?.[p]?.ANUAL ?? DEFAULT_PRICES[p].ANUAL) }])) as Prices;
  } catch { /* mantém padrão */ }
  const plans: PlanCatalog = parsePlanCatalog((s as { plansJson?: string }).plansJson);
  const introOffer: IntroOffer = parseIntroOffer((s as { introOfferJson?: string }).introOfferJson);
  return { trialDays: s.trialDays, prices, plans, introOffer, webhookSecretConfigured: !!s.mpWebhookSecretEnc, raw: s };
}

export async function getWebhookSecret(): Promise<string | null> {
  const s = await prisma.platformSettings.findUnique({ where: { id: 'default' } });
  return decryptOrNull(s?.mpWebhookSecretEnc ?? null);
}

export async function updateSettings(input: { trialDays?: number; prices?: Partial<Record<PlanProduct, Partial<Record<Cycle, number>>>>; plans?: Partial<Record<PlanProduct, PlanInput>>; introOffer?: IntroOfferInput; mpWebhookSecret?: string | null }) {
  const cur = await getSettings();
  const data: { trialDays?: number; pricesJson?: string; plansJson?: string; introOfferJson?: string; mpWebhookSecretEnc?: string | null } = {};
  if (input.introOffer) {
    const err = validateIntroOfferInput(input.introOffer);
    if (err) throw new SettingsError(err);
    data.introOfferJson = JSON.stringify(applyIntroOfferInput(cur.introOffer, input.introOffer));
  }
  if (input.plans) {
    const next = JSON.parse(JSON.stringify(cur.plans)) as PlanCatalog;
    for (const code of PLAN_CODES) {
      const pi = input.plans[code];
      if (!pi) continue;
      const err = validatePlanInput(code, cur.plans[code], pi);
      if (err) throw new SettingsError(err);
      next[code] = applyPlanInput(cur.plans[code], pi);
    }
    data.plansJson = JSON.stringify(next);
  }
  if (input.trialDays !== undefined) data.trialDays = Math.max(0, Math.floor(input.trialDays));
  if (input.prices) {
    const next: Prices = JSON.parse(JSON.stringify(cur.prices));
    for (const p of PLAN_PRODUCTS) for (const c of CYCLES) {
      const v = input.prices[p]?.[c];
      if (v !== undefined && Number.isInteger(v) && v >= 0) next[p][c] = v; // 0 = ciclo fora de venda (o checkout recusa)
    }
    data.pricesJson = JSON.stringify(next);
  }
  if (input.mpWebhookSecret !== undefined) data.mpWebhookSecretEnc = input.mpWebhookSecret ? encryptOrNull(input.mpWebhookSecret) : null;
  await prisma.platformSettings.update({ where: { id: 'default' }, data });
  return getSettings();
}

export const priceOf = async (product: PlanProduct, cycle: Cycle) => (await getSettings()).prices[product][cycle];

// ---------- Promoção de entrada do Plano Completo (v1.27.0; regra em introOffer.ts) ----------
/**
 * Pagamentos CONFIRMADOS da empresa: Mercado Pago aprovado (kind MP) que não foi estornado e ativação/renovação
 * manual com ciclo feita pelo Master (kind MANUAL com cycle). Ajuste só de data, teste, bloqueio e mês grátis de
 * indicação não são pagamento. `exceptMpPaymentId` tira da conta o pagamento que está sendo conferido (aviso repetido).
 */
export async function confirmedPayments(orgId: string, exceptMpPaymentId?: string): Promise<PaidEvent[]> {
  const evs = await prisma.billingEvent.findMany({
    where: { orgId, OR: [{ kind: 'MP' }, { kind: 'MANUAL', cycle: { not: null } }, { kind: 'MP_ESTORNO' }] },
    select: { kind: true, product: true, cycle: true, mpPaymentId: true, introOffer: true },
  });
  const estornados = new Set(evs.filter((e) => e.kind === 'MP_ESTORNO' && e.mpPaymentId).map((e) => e.mpPaymentId!.replace(/-estorno$/, '')));
  return evs
    .filter((e) => e.kind !== 'MP_ESTORNO')
    .filter((e) => !(e.kind === 'MP' && e.mpPaymentId && (estornados.has(e.mpPaymentId) || e.mpPaymentId === exceptMpPaymentId)))
    .map((e) => ({ product: e.product, cycle: e.cycle, intro: e.introOffer }));
}

/** Situação da empresa na promoção: ainda é "cliente nova"? Quantos meses promocionais já pagou? */
export async function introStatus(orgId: string, exceptMpPaymentId?: string) {
  const { introOffer } = await getSettings();
  return { offer: introOffer, ...introEligibility(await confirmedPayments(orgId, exceptMpPaymentId), introOffer.months) };
}

/**
 * Preço promocional que ESTA empresa paga agora no plano/ciclo, ou null (sem promoção: outro plano, anual,
 * promoção desligada ou mais cara que o preço normal, ou empresa que não é mais cliente nova).
 */
export async function introPriceFor(orgId: string, product: PlanProduct, cycle: Cycle): Promise<{ priceCents: number; month: number; months: number } | null> {
  if (product !== INTRO_PLAN || cycle !== INTRO_CYCLE) return null;
  const { prices } = await getSettings();
  const st = await introStatus(orgId);
  if (!introOfferActive(st.offer, prices[product][cycle]) || !st.eligible) return null;
  return { priceCents: st.offer.priceCents, month: st.used + 1, months: st.offer.months };
}

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

/**
 * Plano Completo (MCK ERP + MCKBOT + MCK Mensagens) ativo ou em teste: os DOIS produtos em TRIAL ou ATIVA.
 * O COMBO renova os dois juntos; o teste começa com os dois em TRIAL. Só MCKBOT ou só MCK Mensagens não basta.
 * Assinatura que ainda não existe só é criada (teste sob demanda, como no resto do app) quando a empresa
 * nunca pagou nada (todas as existentes são de teste): assim quem pagou só um produto não ganha um "teste" do
 * outro só por abrir o ERP.
 */
export async function planoCompletoAtivo(orgId: string, now = new Date()): Promise<boolean> {
  let subs = await prisma.subscription.findMany({ where: { orgId, product: { in: [...PRODUCTS] } } });
  if (subs.length < PRODUCTS.length && subs.every((s) => s.source === 'TRIAL')) {
    subs = await Promise.all(PRODUCTS.map((p) => getSubscription(orgId, p)));
  }
  return PRODUCTS.every((p) => {
    const s = subs.find((x) => x.product === p);
    if (!s) return false;
    const st = effectiveStatus(s, now);
    return st === 'TRIAL' || st === 'ATIVA';
  });
}

/**
 * v1.25.0 — Plano que libera o MCK ERP para esta empresa pelas assinaturas, conforme os planos do Master
 * (módulo ERP marcado; plano oculto só para quem já paga). null = nenhum. Mesma criação de teste sob demanda
 * de planoCompletoAtivo (só para quem nunca pagou nada). A empresa da própria MCK é tratada em erpAccess.ts.
 */
export async function erpPlanoDaEmpresa(orgId: string, now = new Date()): Promise<PlanProduct | null> {
  const { plans } = await getSettings();
  let subs = await prisma.subscription.findMany({ where: { orgId, product: { in: [...PRODUCTS] } } });
  if (subs.length < PRODUCTS.length && subs.every((s) => s.source === 'TRIAL')) {
    subs = await Promise.all(PRODUCTS.map((p) => getSubscription(orgId, p)));
  }
  return erpBySubscriptions(plans, subs, (s, n) => effectiveStatus(s, n), now);
}

/** A empresa já pagou este plano alguma vez (Mercado Pago ou ajuste manual do Master)? Plano oculto continua renovável para ela. */
export async function empresaJaAssinou(orgId: string, plan: PlanProduct): Promise<boolean> {
  const ev = await prisma.billingEvent.findFirst({ where: { orgId, product: plan, kind: { in: ['MP', 'MANUAL'] } }, select: { id: true } });
  return !!ev;
}

/** Planos que esta empresa pode contratar/renovar: os visíveis + os ocultos que ela já assinou. */
export async function planosOferecidos(orgId: string): Promise<PlanProduct[]> {
  const { plans } = await getSettings();
  const out: PlanProduct[] = [];
  for (const p of PLAN_PRODUCTS) if (plans[p].visible || (await empresaJaAssinou(orgId, p))) out.push(p);
  return out;
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
export async function renew(orgId: string, product: PlanProduct, cycle: Cycle, opts: { source?: 'MANUAL' | 'MP'; mpPaymentId?: string; amountCents?: number; actorUserId?: string; introOffer?: boolean } = {}) {
  const source = opts.source ?? (opts.mpPaymentId ? 'MP' : 'MANUAL');
  const products = await planProducts(product); // módulos do plano no Master (padrão: COMBO = os dois)
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
        // createdAt = o mesmo "agora" usado como base: o estorno reconstrói exatamente quanto este pagamento somou.
        data: { orgId, product, kind: source, cycle, amountCents: opts.amountCents ?? null, mpPaymentId: opts.mpPaymentId ?? null, actorUserId: opts.actorUserId ?? null, prevValidUntil: prevMax, newValidUntil: newMax, introOffer: !!opts.introOffer, createdAt: now },
      });
      return { duplicated: false as const, subscriptions: updated };
    });
  } catch (e: any) {
    if (opts.mpPaymentId && e?.code === 'P2002') return { duplicated: true as const, subscriptions: [] };
    throw e;
  }
}

/**
 * Estorno/chargeback/cancelamento de um pagamento que já renovou: desfaz o ciclo pago.
 * Idempotente (evento único "<id>-estorno"). Se o novo vencimento ficar no passado, o plano
 * passa a VENCIDA na hora e o acesso é cortado.
 */
export async function revokePayment(mpPaymentId: string, reason: string) {
  const ev = await prisma.billingEvent.findUnique({ where: { mpPaymentId } });
  if (!ev || ev.kind !== 'MP' || !isPlanProduct(ev.product) || !isCycle(ev.cycle)) return { revoked: false as const, reason: 'sem_renovacao' };
  // Plano com os módulos de hoje (se o Master mudou os módulos depois do pagamento, vale a configuração atual).
  const products = await planProducts(ev.product);
  try {
    return await prisma.$transaction(async (tx) => {
      await tx.billingEvent.create({ data: { orgId: ev.orgId, product: ev.product, kind: 'MP_ESTORNO', cycle: ev.cycle, amountCents: ev.amountCents, mpPaymentId: `${mpPaymentId}-estorno`, prevValidUntil: ev.newValidUntil, newValidUntil: null } });
      const subs = await tx.subscription.findMany({ where: { orgId: ev.orgId, product: { in: products } } });
      // Desfaz exatamente o tempo que ESTE pagamento somou (novo vencimento − base usada na renovação), em vez de
      // "voltar 1 mês" no calendário: 31/out + 1 mês = 01/dez, e 01/dez − 1 mês = 01/nov ≠ 31/out (o plano
      // continuaria ativo após o estorno). Base da renovação = max(vencimento anterior, momento da renovação).
      let paidMs: number | null = null;
      if (ev.newValidUntil) {
        const base = ev.prevValidUntil && ev.prevValidUntil > ev.createdAt ? ev.prevValidUntil : ev.createdAt;
        paidMs = Math.max(0, ev.newValidUntil.getTime() - base.getTime());
      }
      let newMax: Date | null = null;
      for (const s of subs) {
        const d = new Date(s.validUntil.getTime());
        if (paidMs !== null) d.setTime(d.getTime() - paidMs);
        else if (ev.cycle === 'ANUAL') d.setFullYear(d.getFullYear() - 1); else d.setMonth(d.getMonth() - 1);
        await tx.subscription.update({ where: { id: s.id }, data: { validUntil: d } });
        if (!newMax || d > newMax) newMax = d;
      }
      await tx.billingEvent.update({ where: { mpPaymentId: `${mpPaymentId}-estorno` }, data: { newValidUntil: newMax } });
      return { revoked: true as const, orgId: ev.orgId, reason };
    });
  } catch (e: any) {
    if (e?.code === 'P2002') return { revoked: false as const, reason: 'ja_estornado' };
    throw e;
  }
}

export async function setBlocked(orgId: string, product: PlanProduct, blocked: boolean, actorUserId?: string) {
  const products = await planProducts(product);
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
  const products = await planProducts(product);
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
  const products = await planProducts(product);
  let prevMax: Date | null = null;
  for (const p of products) {
    const s = await getSubscription(orgId, p);
    if (!prevMax || s.validUntil > prevMax) prevMax = s.validUntil;
    const status = s.status === 'BLOQUEADA' ? 'BLOQUEADA' : s.status === 'TRIAL' ? 'TRIAL' : 'ATIVA';
    await prisma.subscription.update({ where: { id: s.id }, data: { validUntil, status, source: s.status === 'TRIAL' ? s.source : 'MANUAL' } });
  }
  await prisma.billingEvent.create({ data: { orgId, product, kind: 'MANUAL', actorUserId: actorUserId ?? null, prevValidUntil: prevMax, newValidUntil: validUntil } });
}
