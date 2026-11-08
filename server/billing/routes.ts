import express, { Router, type Request } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { ah, badRequest, HttpError } from '../lib/http.js';
import { orgOf } from '../auth/session.js';
import { audit } from '../lib/audit.js';
import { PRODUCTS, CYCLES, PLAN_PRODUCTS, getSettings, getSubscriptionView, getWebhookSecret, introPriceFor, introStatus, planosOferecidos, renew, revokePayment } from './service.js';
import { INTRO_CYCLE, INTRO_PLAN, publicIntroOffer } from './introOffer.js';
import { planApps, planModules } from './planCatalog.js';
import { CouponError, MIN_FINAL_CENTS, loadValidCoupon, priceWithCoupon, publicCouponView, quotesFor } from './coupons.js';
import { billingConfigured, createPreference, getPayment, MpError, mpFriendly, parseReference, verifySignature } from './mercadopago.js';

import { appUrl } from '../lib/mailer.js';
import { creditReferralForPayment, revokeReferralForPayment } from './referrals.js';
// URL pública fixa (APP_URL/RENDER_EXTERNAL_URL) para o aviso e o retorno do Mercado Pago; o cabeçalho Host só vale fora de produção.
const baseUrlOf = (req: Request) => appUrl(req);

export type ProcessResult = { ok: boolean; renewed: boolean; duplicated?: boolean; revoked?: boolean; reason?: string; orgId?: string };

/**
 * Confirma um pagamento SEMPRE consultando a API do Mercado Pago (nunca confia no corpo do aviso).
 * Renova apenas se: status approved, referência válida, organização existe, valor confere com o preço.
 */
export async function processPayment(paymentId: string, expectedOrgId?: string): Promise<ProcessResult> {
  const pay = await getPayment(paymentId);
  const ref = parseReference(pay.external_reference);
  if (!ref) return { ok: false, renewed: false, reason: 'referencia_invalida' };
  if (expectedOrgId && ref.orgId !== expectedOrgId) return { ok: false, renewed: false, reason: 'outra_organizacao' };
  if (['refunded', 'charged_back', 'cancelled'].includes(pay.status)) {
    const rv = await revokePayment(String(pay.id), pay.status);
    // Cupom: pagamento estornado deixa de contar como uso.
    await prisma.couponRedemption.updateMany({ where: { mpPaymentId: String(pay.id), status: 'CONFIRMADO' }, data: { status: 'ESTORNADO' } });
    // Indique e ganhe: o mês grátis liberado por este pagamento é desfeito.
    await revokeReferralForPayment(String(pay.id));
    if (rv.revoked) await audit(null, 'billing.mp.estornado', { orgId: ref.orgId, entity: 'payment', entityId: String(pay.id), meta: { status: pay.status } });
    return { ok: true, renewed: false, revoked: rv.revoked, reason: `status_${pay.status}`, orgId: ref.orgId };
  }
  if (pay.status !== 'approved') return { ok: true, renewed: false, reason: `status_${pay.status || 'desconhecido'}`, orgId: ref.orgId };
  const org = await prisma.organization.findUnique({ where: { id: ref.orgId } });
  if (!org) return { ok: false, renewed: false, reason: 'organizacao_inexistente' };
  const { prices } = await getSettings();
  const basePrice = prices[ref.product][ref.cycle];
  // Cupom: o desconto veio da referência criada pelo próprio servidor no checkout (só o servidor cria
  // preferências com o token do MP) e nunca deixa o valor abaixo do mínimo cobrável. Se o cupom
  // expirou, esgotou ou foi desativado depois do checkout, o pagamento já feito é honrado.
  const coupon = ref.coupon ? await prisma.coupon.findUnique({ where: { id: ref.coupon.id } }) : null;
  const discount = ref.coupon ? Math.max(0, Math.min(ref.coupon.discountCents, basePrice - MIN_FINAL_CENTS)) : 0;
  let expected = basePrice - discount;
  // Promoção de entrada (v1.27.0): o preço promocional só vale se, AGORA, a empresa ainda for cliente nova
  // (pagamentos confirmados, sem contar este). Abrir vários checkouts na promoção não adianta: o 3º pagamento
  // promocional chega aqui com a empresa já fora da promoção e o valor fica divergente. Promoção desligada no
  // Master depois do checkout: o pagamento já feito é honrado (como no cupom).
  let intro = false;
  if (ref.introCents !== null) {
    if (ref.product === INTRO_PLAN && ref.cycle === INTRO_CYCLE && (await introStatus(ref.orgId, String(pay.id))).eligible) {
      intro = true;
      expected = Math.min(expected, Math.max(MIN_FINAL_CENTS, ref.introCents));
    }
  }
  const paidCents = Math.round(pay.transaction_amount * 100);
  if (paidCents < expected || (pay.currency_id && pay.currency_id !== 'BRL')) {
    await audit(null, 'billing.mp.valor_divergente', { orgId: ref.orgId, entity: 'payment', entityId: pay.id, meta: { paidCents, expected, product: ref.product, cycle: ref.cycle, coupon: coupon?.code, ...(ref.introCents !== null ? { introCents: ref.introCents, introAceita: intro } : {}) } });
    return { ok: false, renewed: false, reason: ref.introCents !== null && !intro ? 'promocao_esgotada' : 'valor_divergente', orgId: ref.orgId };
  }
  const r = await renew(ref.orgId, ref.product, ref.cycle, { source: 'MP', mpPaymentId: pay.id, amountCents: paidCents, introOffer: intro });
  if (coupon) {
    // Uso do cupom só conta com pagamento confirmado; único por pagamento (aviso repetido não conta de novo).
    try {
      await prisma.couponRedemption.create({ data: { couponId: coupon.id, orgId: ref.orgId, product: ref.product, cycle: ref.cycle, mpPaymentId: String(pay.id), originalCents: basePrice, discountCents: discount, finalCents: paidCents } });
    } catch (e: any) { if (e?.code !== 'P2002') throw e; }
  }
  // Indique e ganhe: primeiro pagamento aprovado da indicada libera 30 dias para quem indicou (uma vez; nunca lança).
  await creditReferralForPayment(ref.orgId, String(pay.id));
  if (!r.duplicated) await audit(null, 'billing.mp.renovado', { orgId: ref.orgId, entity: 'payment', entityId: pay.id, meta: { product: ref.product, cycle: ref.cycle, paidCents, ...(coupon ? { coupon: coupon.code, discountCents: discount } : {}), ...(intro ? { introOffer: true } : {}) } });
  return { ok: true, renewed: !r.duplicated, duplicated: r.duplicated, orgId: ref.orgId };
}

// ---------- Rotas autenticadas (/api/billing) ----------
export const billingRouter = Router();

billingRouter.get('/status', ah(async (req, res) => {
  const orgId = orgOf(req);
  const subscriptions = await Promise.all(PRODUCTS.map((p) => getSubscriptionView(orgId, p)));
  const { prices, trialDays, plans, introOffer } = await getSettings();
  // v1.27.0: promoção de entrada do Plano Completo (texto público + situação desta empresa).
  const introPub = publicIntroOffer(introOffer, prices[INTRO_PLAN][INTRO_CYCLE]);
  const introMe = introPub ? await introStatus(orgId) : null;
  // v1.25.0: planos do Master. "offered" = à venda (visível) ou oculto que a empresa já assinou (pode renovar).
  const offered = new Set(await planosOferecidos(orgId));
  res.json({
    subscriptions, prices, trialDays, cycles: CYCLES, configured: billingConfigured(),
    products: PLAN_PRODUCTS.map((id) => ({ id, name: plans[id].name })),
    plans: PLAN_PRODUCTS.filter((id) => offered.has(id)).map((id) => ({
      id, name: plans[id].name, desc: plans[id].desc, features: plans[id].features, modules: planModules(plans[id]), apps: planApps(plans[id]), visible: plans[id].visible,
      ...(id === INTRO_PLAN && introPub ? { introOffer: introPub } : {}),
    })),
    // eligible = esta empresa ainda paga o preço promocional no próximo pagamento mensal do Plano Completo.
    introOffer: introPub && introMe ? { ...introPub, eligible: introMe.eligible, monthsUsed: introMe.used, monthsLeft: introMe.remaining } : null,
  });
}));

// app: de qual frontend veio o pagamento ("mensagem" = MCK Mensagens), para o Mercado Pago devolver ao app certo.
// coupon: código do cupom (opcional). O preço final é recalculado aqui; o valor do cliente nunca é usado.
const checkoutSchema = z.object({ product: z.enum(['MCKBOT', 'MCKMENSAGEM', 'COMBO']), cycle: z.enum(['MENSAL', 'ANUAL']), app: z.enum(['mckbot', 'mensagem']).optional(), coupon: z.string().trim().max(40).optional() });
billingRouter.post('/checkout', ah(async (req, res) => {
  const orgId = orgOf(req);
  const { product, cycle, app, coupon: couponCode } = checkoutSchema.parse(req.body);
  if (!billingConfigured()) throw new HttpError(503, 'Pagamento online ainda não configurado');
  const { prices, plans } = await getSettings();
  // Plano oculto (fora de venda): só quem já assinou pode renovar; ciclo com preço abaixo do mínimo não é vendido.
  if (!(await planosOferecidos(orgId)).includes(product)) throw badRequest('Este plano não está mais à venda.');
  if (prices[product][cycle] < MIN_FINAL_CENTS) throw badRequest('Este ciclo do plano não está à venda.');
  const fullCents = prices[product][cycle];
  // Promoção de entrada (v1.27.0): Plano Completo mensal para cliente nova. Calculada só aqui no servidor.
  const intro = await introPriceFor(orgId, product, cycle);
  let amountCents = intro ? intro.priceCents : fullCents;
  let applied: { id: string; code: string; discountCents: number } | null = null;
  let couponNotice: string | undefined;
  if (couponCode) {
    try {
      const { coupon, quote } = await priceWithCoupon(couponCode, product, cycle, orgId);
      // Cupom não acumula com a promoção: vale o MENOR preço. Empate fica com a promoção (o cupom não é gasto).
      if (!intro || quote.finalCents < intro.priceCents) {
        amountCents = quote.finalCents;
        applied = { id: coupon.id, code: coupon.code, discountCents: quote.discountCents };
      } else {
        couponNotice = 'O cupom não acumula com a promoção de cliente nova. Aplicamos o menor preço: o promocional.';
      }
    } catch (e) {
      if (e instanceof CouponError) throw badRequest(e.message);
      throw e;
    }
  }
  const user = req.auth?.userId ? await prisma.user.findUnique({ where: { id: req.auth.userId } }) : null;
  try {
    const pref = await createPreference({
      orgId, product, cycle, amountCents, coupon: applied ? { id: applied.id, discountCents: applied.discountCents } : null, introCents: intro ? intro.priceCents : null, baseUrl: baseUrlOf(req), payerEmail: user?.email, returnPath: app === 'mensagem' ? '/mensagem/assinatura' : '/',
      title: `${plans[product].name} — plano ${cycle === 'ANUAL' ? 'anual' : 'mensal'}${applied ? ` (cupom ${applied.code})` : intro ? ` (promoção cliente nova: mês ${intro.month} de ${intro.months})` : ''}`,
    });
    await audit(req, 'billing.checkout', { entity: 'preference', entityId: pref.id, meta: { product, cycle, amountCents, ...(applied ? { coupon: applied.code, discountCents: applied.discountCents } : {}), ...(intro ? { introOffer: true, introMonth: intro.month } : {}) } });
    res.json({
      init_point: pref.init_point, preferenceId: pref.id, amountCents,
      ...(applied ? { coupon: applied.code, discountCents: applied.discountCents, originalCents: fullCents } : {}),
      ...(intro ? { introOffer: { priceCents: intro.priceCents, month: intro.month, months: intro.months, regularPriceCents: fullCents }, originalCents: fullCents } : {}),
      ...(couponNotice ? { couponNotice } : {}),
    });
  } catch (e) {
    if (e instanceof MpError) throw new HttpError(502, mpFriendly(e, 'iniciar o pagamento'));
    throw e;
  }
}));

/** Valida um cupom e devolve o preço com desconto de cada plano/ciclo em que ele vale (calculado no servidor). */
billingRouter.post('/coupon', ah(async (req, res) => {
  const { code } = z.object({ code: z.string().trim().min(1).max(40) }).parse(req.body);
  try {
    const c = await loadValidCoupon(code, orgOf(req));
    const { prices } = await getSettings();
    const quotes = quotesFor(c, prices);
    if (Object.keys(quotes).length === 0) throw new CouponError('valor');
    // v1.27.0: cupom não acumula com a promoção de cliente nova; no checkout vale o menor preço.
    const intro = await introPriceFor(orgOf(req), INTRO_PLAN, INTRO_CYCLE);
    res.json({ coupon: publicCouponView(c), quotes, ...(intro ? { introOffer: { plan: INTRO_PLAN, cycle: INTRO_CYCLE, priceCents: intro.priceCents, stacks: false } } : {}) });
  } catch (e) {
    if (e instanceof CouponError) return void res.status(e.problem === 'inexistente' ? 404 : 400).json({ error: e.message, reason: e.problem });
    throw e;
  }
}));

const confirmSchema = z.object({ paymentId: z.union([z.string(), z.number()]).transform(String) });
billingRouter.post('/confirm', ah(async (req, res) => {
  const orgId = orgOf(req);
  const { paymentId } = confirmSchema.parse(req.body);
  if (!/^\d{1,30}$/.test(paymentId)) throw badRequest('paymentId inválido');
  if (!billingConfigured()) throw new HttpError(503, 'Pagamento online ainda não configurado');
  let r: ProcessResult;
  try { r = await processPayment(paymentId, orgId); } catch (e) {
    if (e instanceof MpError) throw e.status === 404 ? new HttpError(404, 'Pagamento não encontrado') : new HttpError(502, mpFriendly(e, 'consultar o pagamento'));
    throw e;
  }
  const subscriptions = await Promise.all(PRODUCTS.map((p) => getSubscriptionView(orgId, p)));
  res.json({ ...r, subscriptions });
}));

// ---------- Webhook público (montado antes da sessão/CSRF) ----------
export const billingWebhookRouter = Router();
billingWebhookRouter.use(express.json({ limit: '100kb' }));
billingWebhookRouter.post('/', ah(async (req, res) => {
  const q = req.query as Record<string, unknown>;
  const body = (req.body ?? {}) as any;
  const type = String(body.type ?? body.topic ?? q.type ?? q.topic ?? '');
  const dataId = String(q['data.id'] ?? body?.data?.id ?? q.id ?? '') || null;

  const secret = (await getWebhookSecret()) || process.env.MP_WEBHOOK_SECRET || null;
  if (secret) {
    const ok = verifySignature({ secret, xSignature: req.get('x-signature'), xRequestId: req.get('x-request-id'), dataId });
    if (!ok) return res.status(401).json({ error: 'Assinatura inválida' });
  }
  if (type && type !== 'payment') return res.status(200).json({ ok: true, ignored: true });
  if (!dataId || !/^\d{1,30}$/.test(dataId) || !billingConfigured()) return res.status(200).json({ ok: true, ignored: true });
  try {
    const r = await processPayment(dataId);
    return res.status(200).json({ ok: true, renewed: r.renewed, duplicated: !!r.duplicated, revoked: !!r.revoked, reason: r.reason });
  } catch (e) {
    if (e instanceof MpError && e.status === 404) return res.status(200).json({ ok: true, ignored: true });
    // Credencial/requisição recusada (400/401/403 etc.): repetir não resolve — responde 200 para não gerar reenvio infinito.
    if (e instanceof MpError && e.isClientError) {
      console.error(`[billing] webhook payment=${dataId} ignorado: Mercado Pago status=${e.status} message=${JSON.stringify(e.message)}`);
      return res.status(200).json({ ok: false, ignored: true, reason: `mp_${e.status}` });
    }
    // Erro temporário (5xx/rede): 500 faz o Mercado Pago tentar de novo.
    console.error('[billing] webhook falha temporária', e instanceof MpError ? `status=${e.status} message=${JSON.stringify(e.message)}` : e);
    return res.status(500).json({ error: 'Falha temporária' });
  }
}));
