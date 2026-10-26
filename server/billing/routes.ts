import express, { Router, type Request } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { ah, badRequest, HttpError } from '../lib/http.js';
import { orgOf } from '../auth/session.js';
import { audit } from '../lib/audit.js';
import { PRODUCTS, PRODUCT_LABEL, CYCLES, PLAN_PRODUCTS, getSettings, getSubscriptionView, getWebhookSecret, renew, revokePayment } from './service.js';
import { billingConfigured, createPreference, getPayment, MpError, mpFriendly, parseReference, verifySignature } from './mercadopago.js';

const baseUrlOf = (req: Request) => `${req.protocol}://${req.get('host')}`;

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
    if (rv.revoked) await audit(null, 'billing.mp.estornado', { orgId: ref.orgId, entity: 'payment', entityId: String(pay.id), meta: { status: pay.status } });
    return { ok: true, renewed: false, revoked: rv.revoked, reason: `status_${pay.status}`, orgId: ref.orgId };
  }
  if (pay.status !== 'approved') return { ok: true, renewed: false, reason: `status_${pay.status || 'desconhecido'}`, orgId: ref.orgId };
  const org = await prisma.organization.findUnique({ where: { id: ref.orgId } });
  if (!org) return { ok: false, renewed: false, reason: 'organizacao_inexistente' };
  const { prices } = await getSettings();
  const expected = prices[ref.product][ref.cycle];
  const paidCents = Math.round(pay.transaction_amount * 100);
  if (paidCents < expected || (pay.currency_id && pay.currency_id !== 'BRL')) {
    await audit(null, 'billing.mp.valor_divergente', { orgId: ref.orgId, entity: 'payment', entityId: pay.id, meta: { paidCents, expected, product: ref.product, cycle: ref.cycle } });
    return { ok: false, renewed: false, reason: 'valor_divergente', orgId: ref.orgId };
  }
  const r = await renew(ref.orgId, ref.product, ref.cycle, { source: 'MP', mpPaymentId: pay.id, amountCents: paidCents });
  if (!r.duplicated) await audit(null, 'billing.mp.renovado', { orgId: ref.orgId, entity: 'payment', entityId: pay.id, meta: { product: ref.product, cycle: ref.cycle, paidCents } });
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
const checkoutSchema = z.object({ product: z.enum(['MCKBOT', 'MCKMENSAGEM', 'COMBO']), cycle: z.enum(['MENSAL', 'ANUAL']), app: z.enum(['mckbot', 'mensagem']).optional() });
billingRouter.post('/checkout', ah(async (req, res) => {
  const orgId = orgOf(req);
  const { product, cycle, app } = checkoutSchema.parse(req.body);
  if (!billingConfigured()) throw new HttpError(503, 'Pagamento online ainda não configurado');
  const { prices } = await getSettings();
  const amountCents = prices[product][cycle];
  const user = req.auth?.userId ? await prisma.user.findUnique({ where: { id: req.auth.userId } }) : null;
  try {
    const pref = await createPreference({
      orgId, product, cycle, amountCents, baseUrl: baseUrlOf(req), payerEmail: user?.email, returnPath: app === 'mensagem' ? '/mensagem/assinatura' : '/',
      title: `${PRODUCT_LABEL[product]} — plano ${cycle === 'ANUAL' ? 'anual' : 'mensal'}`,
    });
    await audit(req, 'billing.checkout', { entity: 'preference', entityId: pref.id, meta: { product, cycle, amountCents } });
    res.json({ init_point: pref.init_point, preferenceId: pref.id, amountCents });
  } catch (e) {
    if (e instanceof MpError) throw new HttpError(502, mpFriendly(e, 'iniciar o pagamento'));
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
