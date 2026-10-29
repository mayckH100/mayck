import express, { Router, type Request } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { ah, badRequest, HttpError } from '../lib/http.js';
import { orgOf } from '../auth/session.js';
import { audit } from '../lib/audit.js';
import { PRODUCTS, PRODUCT_LABEL, CYCLES, PLAN_PRODUCTS, getSettings, getSubscriptionView, getWebhookSecret, renew, revokePayment } from './service.js';
import { CouponError, MIN_FINAL_CENTS, loadValidCoupon, priceWithCoupon, publicCouponView, quotesFor } from './coupons.js';
import { billingConfigured, createPreference, getPayment, MpError, mpFriendly, parseReference, verifySignature } from './mercadopago.js';

import { appUrl } from '../lib/mailer.js';
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
    if (rv.revoked) await audit(null, 'billing.mp.estornado', { orgId: ref.orgId, entity: 'payment', entityId: String(pay.id), meta: { status: pay.status } });
    return { ok: true, renewed: false, revoked: rv.revoked, reason: `status_${pay.status}`, orgId: ref.orgId };
  }
  if (pay.status !== 'approved') return { ok: true, renewed: false, reason: `status_${pay.status || 'desconhecido'}`, orgId: ref.orgId };
  const org = await prisma.organization.findUnique({ where: { id: ref.orgId } });
  if (!org) return { ok: false, renewed: false, reason: 'organizacao_inexistente' };
  const { prices } = await getSettings();
  const basePrice = prices[ref.product][ref.cycle];
  let expected = basePrice;
  // Cupom: o desconto veio da referência criada pelo próprio servidor no checkout (só o servidor cria
  // preferências com o token do MP) e nunca deixa o valor abaixo do mínimo cobrável. Se o cupom
  // expirou, esgotou ou foi desativado depois do checkout, o pagamento já feito é honrado.
  const coupon = ref.coupon ? await prisma.coupon.findUnique({ where: { id: ref.coupon.id } }) : null;
  const discount = ref.coupon ? Math.max(0, Math.min(ref.coupon.discountCents, basePrice - MIN_FINAL_CENTS)) : 0;
  expected -= discount;
  const paidCents = Math.round(pay.transaction_amount * 100);
  if (paidCents < expected || (pay.currency_id && pay.currency_id !== 'BRL')) {
    await audit(null, 'billing.mp.valor_divergente', { orgId: ref.orgId, entity: 'payment', entityId: pay.id, meta: { paidCents, expected, product: ref.product, cycle: ref.cycle, coupon: coupon?.code } });
    return { ok: false, renewed: false, reason: 'valor_divergente', orgId: ref.orgId };
  }
  const r = await renew(ref.orgId, ref.product, ref.cycle, { source: 'MP', mpPaymentId: pay.id, amountCents: paidCents });
  if (coupon) {
    // Uso do cupom só conta com pagamento confirmado; único por pagamento (aviso repetido não conta de novo).
    try {
      await prisma.couponRedemption.create({ data: { couponId: coupon.id, orgId: ref.orgId, product: ref.product, cycle: ref.cycle, mpPaymentId: String(pay.id), originalCents: basePrice, discountCents: discount, finalCents: paidCents } });
    } catch (e: any) { if (e?.code !== 'P2002') throw e; }
  }
  if (!r.duplicated) await audit(null, 'billing.mp.renovado', { orgId: ref.orgId, entity: 'payment', entityId: pay.id, meta: { product: ref.product, cycle: ref.cycle, paidCents, ...(coupon ? { coupon: coupon.code, discountCents: discount } : {}) } });
  return { ok: true, renewed: !r.duplicated, duplicated: r.duplicated, orgId: ref.orgId };
}

// ---------- Rotas autenticadas (/api/billing) ----------
export const billingRouter = Router();

billingRouter.get('/status', ah(async (req, res) => {
  const orgId = orgOf(req);
  const subscriptions = await Promise.all(PRODUCTS.map((p) => getSubscriptionView(orgId, p)));
  const { prices, trialDays } = await getSettings();
  res.json({ subscriptions, prices, trialDays, products: PLAN_PRODUCTS.map((id) => ({ id, name: PRODUCT_LABEL[id] })), cycles: CYCLES, configured: billingConfigured() });
}));

// app: de qual frontend veio o pagamento ("mensagem" = MCK Mensagens), para o Mercado Pago devolver ao app certo.
// coupon: código do cupom (opcional). O preço final é recalculado aqui; o valor do cliente nunca é usado.
const checkoutSchema = z.object({ product: z.enum(['MCKBOT', 'MCKMENSAGEM', 'COMBO']), cycle: z.enum(['MENSAL', 'ANUAL']), app: z.enum(['mckbot', 'mensagem']).optional(), coupon: z.string().trim().max(40).optional() });
billingRouter.post('/checkout', ah(async (req, res) => {
  const orgId = orgOf(req);
  const { product, cycle, app, coupon: couponCode } = checkoutSchema.parse(req.body);
  if (!billingConfigured()) throw new HttpError(503, 'Pagamento online ainda não configurado');
  const { prices } = await getSettings();
  let amountCents = prices[product][cycle];
  let applied: { id: string; code: string; discountCents: number } | null = null;
  if (couponCode) {
    try {
      const { coupon, quote } = await priceWithCoupon(couponCode, product, cycle);
      amountCents = quote.finalCents;
      applied = { id: coupon.id, code: coupon.code, discountCents: quote.discountCents };
    } catch (e) {
      if (e instanceof CouponError) throw badRequest(e.message);
      throw e;
    }
  }
  const user = req.auth?.userId ? await prisma.user.findUnique({ where: { id: req.auth.userId } }) : null;
  try {
    const pref = await createPreference({
      orgId, product, cycle, amountCents, coupon: applied ? { id: applied.id, discountCents: applied.discountCents } : null, baseUrl: baseUrlOf(req), payerEmail: user?.email, returnPath: app === 'mensagem' ? '/mensagem/assinatura' : '/',
      title: `${PRODUCT_LABEL[product]} — plano ${cycle === 'ANUAL' ? 'anual' : 'mensal'}${applied ? ` (cupom ${applied.code})` : ''}`,
    });
    await audit(req, 'billing.checkout', { entity: 'preference', entityId: pref.id, meta: { product, cycle, amountCents, ...(applied ? { coupon: applied.code, discountCents: applied.discountCents } : {}) } });
    res.json({ init_point: pref.init_point, preferenceId: pref.id, amountCents, ...(applied ? { coupon: applied.code, discountCents: applied.discountCents, originalCents: prices[product][cycle] } : {}) });
  } catch (e) {
    if (e instanceof MpError) throw new HttpError(502, mpFriendly(e, 'iniciar o pagamento'));
    throw e;
  }
}));

/** Valida um cupom e devolve o preço com desconto de cada plano/ciclo em que ele vale (calculado no servidor). */
billingRouter.post('/coupon', ah(async (req, res) => {
  const { code } = z.object({ code: z.string().trim().min(1).max(40) }).parse(req.body);
  try {
    const c = await loadValidCoupon(code);
    const { prices } = await getSettings();
    const quotes = quotesFor(c, prices);
    if (Object.keys(quotes).length === 0) throw new CouponError('valor');
    res.json({ coupon: publicCouponView(c), quotes });
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
