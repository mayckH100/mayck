import { Router } from 'express';
import { randomInt } from 'node:crypto';
import { prisma } from '../db.js';
import { ah } from '../lib/http.js';
import { orgOf } from '../auth/session.js';
import { audit } from '../lib/audit.js';
import { appUrl, referralRewardMail, sendMail } from '../lib/mailer.js';
import { orgNotifyPhones, ownerAdminEmails, sendToStaffNumber } from '../whatsapp/handoffNotify.js';
import { PRODUCTS, getSubscription, type Product } from './service.js';

/**
 * Programa "Indique e ganhe" (aprovado pelo dono em 05/11/2026).
 *
 * - Cada organização tem um código próprio: link /cadastro?indica=CODIGO.
 * - A empresa indicada é gravada no cadastro (uma indicação por organização, nunca troca).
 * - Quando a indicada tem o PRIMEIRO pagamento aprovado pelo Mercado Pago, quem indicou ganha 30 dias a mais
 *   no plano atual, uma única vez por indicada. Ajuste manual do Master não libera crédito.
 * - Antifraude: nada de autoindicação (mesma organização, mesmo e-mail, celular ou CPF/CNPJ entre os membros das
 *   duas organizações), conferido no cadastro e de novo na hora do crédito. Estorno do pagamento desfaz o crédito.
 */
export const REFERRAL_DAYS = 30;
const DAY = 24 * 60 * 60 * 1000;
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sem I, O, 0 e 1 (evita confusão ao digitar)
export const REFERRAL_CODE_RE = /^[A-Z0-9]{6,12}$/;

export const normalizeReferralCode = (v: unknown) => String(v ?? '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
export const validReferralCode = (v: unknown): string | null => { const c = normalizeReferralCode(v); return REFERRAL_CODE_RE.test(c) ? c : null; };

export function newReferralCode(len = 8) {
  let s = '';
  for (let i = 0; i < len; i++) s += ALPHABET[randomInt(0, ALPHABET.length)];
  return s;
}

export const referralLink = (code: string) => `${appUrl()}/cadastro?indica=${encodeURIComponent(code)}`;

/** Código da organização (cria na primeira vez; corrida/colisão tenta outro). */
export async function getOrCreateReferralCode(orgId: string): Promise<string> {
  const org = await prisma.organization.findUniqueOrThrow({ where: { id: orgId }, select: { referralCode: true } });
  if (org.referralCode) return org.referralCode;
  for (let i = 0; i < 6; i++) {
    const code = newReferralCode();
    try {
      const upd = await prisma.organization.updateMany({ where: { id: orgId, referralCode: null }, data: { referralCode: code } });
      if (upd.count === 1) return code;
      const again = await prisma.organization.findUniqueOrThrow({ where: { id: orgId }, select: { referralCode: true } });
      if (again.referralCode) return again.referralCode;
    } catch (e: any) {
      if (e?.code !== 'P2002') throw e; // colisão de código: tenta outro
    }
  }
  throw new Error('Não foi possível gerar o código de indicação');
}

type Person = { email?: string | null; celular?: string | null; documento?: string | null };
const digits = (v?: string | null) => String(v ?? '').replace(/\D/g, '');
const lower = (v?: string | null) => String(v ?? '').trim().toLowerCase();

/** As duas listas de pessoas têm alguém em comum (mesmo e-mail, celular ou CPF/CNPJ)? Puro. */
export function samePerson(a: Person[], b: Person[]): boolean {
  for (const x of a) for (const y of b) {
    if (x.email && y.email && lower(x.email) === lower(y.email)) return true;
    if (x.celular && y.celular && digits(x.celular) === digits(y.celular)) return true;
    if (x.documento && y.documento && x.documento.toUpperCase() === y.documento.toUpperCase()) return true;
  }
  return false;
}

async function orgPeople(orgId: string): Promise<Person[]> {
  const ms = await prisma.membership.findMany({ where: { orgId }, include: { user: { select: { email: true, celular: true, documento: true } } } });
  return ms.map((m) => m.user);
}

/** É autoindicação? (mesma organização ou alguma pessoa em comum entre as duas). */
export async function isSelfReferral(referrerOrgId: string, referredOrgId: string, extra: Person[] = []): Promise<boolean> {
  if (referrerOrgId === referredOrgId) return true;
  const [a, b] = await Promise.all([orgPeople(referrerOrgId), orgPeople(referredOrgId)]);
  return samePerson(a, [...b, ...extra]);
}

/** Grava a indicação de uma organização recém-criada. Nunca lança (o cadastro não pode falhar por isso). */
export async function registerReferral(referredOrgId: string, code: string | null | undefined, newUser: Person) {
  try {
    const c = validReferralCode(code);
    if (!c) return null;
    const referrer = await prisma.organization.findUnique({ where: { referralCode: c }, select: { id: true } });
    if (!referrer) return null;
    const self = await isSelfReferral(referrer.id, referredOrgId, [newUser]);
    const r = await prisma.referral.create({
      data: { referrerOrgId: referrer.id, referredOrgId, code: c, status: self ? 'RECUSADO' : 'PENDENTE', reason: self ? 'autoindicacao' : null, rewardDays: REFERRAL_DAYS },
    });
    await audit(null, self ? 'referral.recusada' : 'referral.registrada', { orgId: referredOrgId, entity: 'referral', entityId: r.id, meta: { referrerOrgId: referrer.id, ...(self ? { motivo: 'autoindicacao' } : {}) } });
    return r;
  } catch (e: any) {
    if (e?.code !== 'P2002') console.error('[indicacao] falha ao registrar', (e as Error).message);
    return null;
  }
}

const maxDate = (a: Date, b: Date) => (a.getTime() > b.getTime() ? a : b);

/**
 * Credita os 30 dias para quem indicou, quando a indicada tem um pagamento APROVADO (chamado pelo processPayment).
 * Idempotente: só a primeira chamada com a indicação PENDENTE credita. Nunca lança.
 */
export async function creditReferralForPayment(referredOrgId: string, mpPaymentId: string, now = new Date()) {
  try {
    const ref = await prisma.referral.findUnique({ where: { referredOrgId } });
    if (!ref || ref.status !== 'PENDENTE') return null;
    if (await isSelfReferral(ref.referrerOrgId, referredOrgId)) {
      await prisma.referral.updateMany({ where: { id: ref.id, status: 'PENDENTE' }, data: { status: 'RECUSADO', reason: 'autoindicacao' } });
      await audit(null, 'referral.recusada', { orgId: ref.referrerOrgId, entity: 'referral', entityId: ref.id, meta: { motivo: 'autoindicacao' } });
      return null;
    }
    for (const p of PRODUCTS) await getSubscription(ref.referrerOrgId, p);
    const result = await prisma.$transaction(async (tx) => {
      const claim = await tx.referral.updateMany({ where: { id: ref.id, status: 'PENDENTE' }, data: { status: 'CREDITADO', mpPaymentId, creditedAt: now } });
      if (claim.count !== 1) return null;
      const subs = await tx.subscription.findMany({ where: { orgId: ref.referrerOrgId, product: { in: [...PRODUCTS] } } });
      // "Plano atual": os produtos já pagos; quem ainda está só no teste ganha os 30 dias no teste.
      const paid = subs.filter((s) => s.source !== 'TRIAL');
      const target = paid.length ? paid : subs;
      const products = target.map((s) => s.product as Product);
      let prevMax: Date | null = null; let newMax: Date | null = null;
      for (const s of target) {
        const validUntil = new Date(maxDate(s.validUntil, now).getTime() + ref.rewardDays * DAY);
        await tx.subscription.update({ where: { id: s.id }, data: { validUntil } });
        if (!prevMax || s.validUntil > prevMax) prevMax = s.validUntil;
        if (!newMax || validUntil > newMax) newMax = validUntil;
      }
      await tx.referral.update({ where: { id: ref.id }, data: { products: JSON.stringify(products) } });
      await tx.billingEvent.create({ data: { orgId: ref.referrerOrgId, product: products.length > 1 ? 'COMBO' : products[0], kind: 'INDICACAO', prevValidUntil: prevMax, newValidUntil: newMax, createdAt: now } });
      return { products, newValidUntil: newMax };
    });
    if (!result) return null;
    await audit(null, 'referral.creditada', { orgId: ref.referrerOrgId, entity: 'referral', entityId: ref.id, meta: { referredOrgId, dias: ref.rewardDays, produtos: result.products } });
    notifyReferrerInBackground(ref.id);
    return { referralId: ref.id, referrerOrgId: ref.referrerOrgId, ...result };
  } catch (e) {
    console.error('[indicacao] falha ao creditar', (e as Error).message);
    return null;
  }
}

/** Estorno/chargeback do pagamento que liberou o crédito: tira os 30 dias de quem indicou. Nunca lança. */
export async function revokeReferralForPayment(mpPaymentId: string) {
  try {
    const ref = await prisma.referral.findUnique({ where: { mpPaymentId } });
    if (!ref || ref.status !== 'CREDITADO') return false;
    let products: string[] = [];
    try { products = JSON.parse(ref.products ?? '[]'); } catch { products = []; }
    const done = await prisma.$transaction(async (tx) => {
      const claim = await tx.referral.updateMany({ where: { id: ref.id, status: 'CREDITADO' }, data: { status: 'ESTORNADO', reason: 'pagamento_estornado' } });
      if (claim.count !== 1) return false;
      const subs = await tx.subscription.findMany({ where: { orgId: ref.referrerOrgId, product: { in: products } } });
      for (const s of subs) await tx.subscription.update({ where: { id: s.id }, data: { validUntil: new Date(s.validUntil.getTime() - ref.rewardDays * DAY) } });
      if (subs.length) await tx.billingEvent.create({ data: { orgId: ref.referrerOrgId, product: subs.length > 1 ? 'COMBO' : subs[0].product, kind: 'INDICACAO_ESTORNO' } });
      return true;
    });
    if (done) await audit(null, 'referral.estornada', { orgId: ref.referrerOrgId, entity: 'referral', entityId: ref.id, meta: { motivo: 'pagamento_estornado' } });
    return done;
  } catch (e) {
    console.error('[indicacao] falha ao estornar', (e as Error).message);
    return false;
  }
}

const fmtDate = (d: Date, tz = 'America/Sao_Paulo') => d.toLocaleDateString('pt-BR', { timeZone: tz });

/** Texto do WhatsApp de aviso a quem indicou. Puro. */
export function referralRewardText(o: { org: string; days: number; until: string | null; url: string }) {
  return [
    '🎁 Você ganhou 1 mês grátis!',
    `Uma empresa que você indicou (${o.org}) fez o primeiro pagamento.`,
    `Somamos ${o.days} dias ao seu plano${o.until ? `: agora ele vale até ${o.until}` : ''}.`,
    'Continue indicando: cada empresa que assinar vale mais 1 mês.',
    `Seu link: ${o.url}`,
  ].join('\n');
}

/** Avisa quem indicou: WhatsApp nos números de aviso + e-mail (Brevo) para Proprietário/Admin. Nunca lança. */
export async function notifyReferrer(referralId: string) {
  try {
    const ref = await prisma.referral.findUnique({ where: { id: referralId } });
    if (!ref || ref.status !== 'CREDITADO' || ref.notifiedAt) return null;
    const claim = await prisma.referral.updateMany({ where: { id: ref.id, notifiedAt: null }, data: { notifiedAt: new Date() } });
    if (claim.count !== 1) return null;
    const [referrer, referred] = await Promise.all([
      prisma.organization.findUnique({ where: { id: ref.referrerOrgId } }),
      prisma.organization.findUnique({ where: { id: ref.referredOrgId }, select: { name: true } }),
    ]);
    if (!referrer) return null;
    const subs = await prisma.subscription.findMany({ where: { orgId: referrer.id } });
    const until = subs.reduce<Date | null>((m, s) => (!m || s.validUntil > m ? s.validUntil : m), null);
    const url = referralLink(await getOrCreateReferralCode(referrer.id));
    const untilLabel = until ? fmtDate(until, referrer.timezone) : null;
    const text = referralRewardText({ org: referred?.name ?? 'empresa indicada', days: ref.rewardDays, until: untilLabel, url });
    let whatsapp = 0;
    for (const p of orgNotifyPhones(referrer)) if ((await sendToStaffNumber(referrer.id, null, p, text)).ok) whatsapp++;
    let emailed = 0;
    for (const u of await ownerAdminEmails(referrer.id)) {
      if (await sendMail(referralRewardMail({ to: u.email, name: u.name, orgName: referrer.name, referredName: referred?.name ?? 'empresa indicada', days: ref.rewardDays, until: untilLabel, link: url })).catch(() => false)) emailed++;
    }
    return { whatsapp, emailed };
  } catch (e) {
    console.error('[indicacao] falha ao avisar', (e as Error).message);
    return null;
  }
}

const pending = new Set<Promise<unknown>>();
export function notifyReferrerInBackground(referralId: string) {
  const p = notifyReferrer(referralId).catch(() => null);
  pending.add(p);
  p.finally(() => pending.delete(p));
}
/** Testes: espera os avisos em andamento. */
export async function flushReferralNotifies() {
  while (pending.size) await Promise.all([...pending]);
}

/** Resumo da organização para o cartão "Indique e ganhe". */
export async function referralSummary(orgId: string) {
  const code = await getOrCreateReferralCode(orgId);
  const items = await prisma.referral.findMany({ where: { referrerOrgId: orgId }, orderBy: { createdAt: 'desc' }, take: 50 });
  const names = new Map((await prisma.organization.findMany({ where: { id: { in: items.map((i) => i.referredOrgId) } }, select: { id: true, name: true } })).map((o) => [o.id, o.name]));
  const valid = items.filter((i) => i.status !== 'RECUSADO');
  const credited = items.filter((i) => i.status === 'CREDITADO');
  return {
    code, link: referralLink(code), rewardDays: REFERRAL_DAYS,
    indicados: valid.length,
    aguardando: items.filter((i) => i.status === 'PENDENTE').length,
    mesesGanhos: credited.length,
    diasGanhos: credited.reduce((s, i) => s + i.rewardDays, 0),
    items: items.map((i) => ({ empresa: names.get(i.referredOrgId) ?? 'Empresa', status: i.status, createdAt: i.createdAt.toISOString(), creditedAt: i.creditedAt?.toISOString() ?? null })),
  };
}

// ---------- Rotas ----------
/** /api/indicacao (logado, com organização). */
export const referralRouter = Router();
referralRouter.get('/', ah(async (req, res) => { res.json(await referralSummary(orgOf(req))); }));

/** /api/public/indica/:code (sem login): só diz se o código existe (não revela a empresa). */
export const publicReferralRouter = Router();
publicReferralRouter.get('/:code', ah(async (req, res) => {
  const c = validReferralCode(req.params.code);
  const ok = !!c && !!(await prisma.organization.findUnique({ where: { referralCode: c }, select: { id: true } }));
  res.set('Cache-Control', 'no-store').json({ valid: ok, rewardDays: REFERRAL_DAYS });
}));

/** Lista do Painel Master. */
export async function masterReferralList() {
  const items = await prisma.referral.findMany({ orderBy: { createdAt: 'desc' }, take: 500 });
  const ids = [...new Set(items.flatMap((i) => [i.referrerOrgId, i.referredOrgId]))];
  const names = new Map((await prisma.organization.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })).map((o) => [o.id, o.name]));
  const count = (s: string) => items.filter((i) => i.status === s).length;
  return {
    totals: { total: items.length, pendentes: count('PENDENTE'), creditadas: count('CREDITADO'), recusadas: count('RECUSADO'), estornadas: count('ESTORNADO') },
    items: items.map((i) => ({
      id: i.id, code: i.code, status: i.status, reason: i.reason, rewardDays: i.rewardDays,
      referrerOrgId: i.referrerOrgId, referrerName: names.get(i.referrerOrgId) ?? null,
      referredOrgId: i.referredOrgId, referredName: names.get(i.referredOrgId) ?? null,
      createdAt: i.createdAt.toISOString(), creditedAt: i.creditedAt?.toISOString() ?? null, notifiedAt: i.notifiedAt?.toISOString() ?? null,
    })),
  };
}
