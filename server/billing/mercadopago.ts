import { httpFetch } from '../lib/fetcher.js';
import { hmacSha256Hex, safeEqual } from '../lib/crypto.js';
import type { Cycle, PlanProduct } from './service.js';
import { isCycle, isPlanProduct } from './service.js';

const API = 'https://api.mercadopago.com';
export const mpToken = () => process.env.MP_ACCESS_TOKEN || '';
export const billingConfigured = () => !!process.env.MP_ACCESS_TOKEN;

export class MpError extends Error {
  /** status: HTTP do Mercado Pago (0 = falha de rede). message: motivo dado pelo MP. */
  constructor(public status: number, message: string) { super(message); }
  /** Erro de credencial/requisição (não adianta repetir). */
  get isClientError() { return this.status >= 400 && this.status < 500 && this.status !== 429; }
}

/** Mensagem amigável para o usuário, incluindo o motivo do Mercado Pago. */
export function mpFriendly(e: MpError, action = 'processar o pagamento') {
  if (e.status === 401 || e.status === 403) return `Mercado Pago recusou a credencial: ${e.message}`;
  if (e.status === 0) return `Não foi possível falar com o Mercado Pago (${e.message})`;
  return `Não foi possível ${action} no Mercado Pago: ${e.message}`;
}

async function mp(path: string, init: RequestInit = {}) {
  const token = mpToken();
  if (!token) throw new MpError(503, 'Mercado Pago não configurado');
  const method = init.method || 'GET';
  let res: Response;
  try {
    res = await httpFetch(API + path, {
      ...init,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(init.headers as Record<string, string> | undefined) },
    });
  } catch (e: any) {
    const msg = String(e?.message || e || 'erro de rede');
    console.error(`[mercadopago] ${method} ${path} falha de rede: ${msg}`);
    throw new MpError(0, msg);
  }
  const text = await res.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  if (!res.ok) {
    const msg = String(body?.message || body?.error || `Mercado Pago respondeu ${res.status}`);
    // Nunca logar o token: só método, caminho, status e mensagem do MP.
    console.error(`[mercadopago] ${method} ${path} status=${res.status} message=${JSON.stringify(msg)}`);
    throw new MpError(res.status, msg);
  }
  return body;
}

/**
 * Valida o token atual (GET /v1/payment_methods). Resultado em cache por 5 minutos, por token.
 */
const CHECK_TTL = 5 * 60 * 1000;
let checkCache: { token: string; at: number; result: { ok: boolean; message: string } } | null = null;
export function resetMpCheckCache() { checkCache = null; }
export async function checkMpCredential(): Promise<{ ok: boolean; message: string }> {
  const token = mpToken();
  if (!token) return { ok: false, message: 'Mercado Pago não configurado (defina MP_ACCESS_TOKEN no servidor)' };
  if (checkCache && checkCache.token === token && Date.now() - checkCache.at < CHECK_TTL) return checkCache.result;
  let result: { ok: boolean; message: string };
  try {
    await mp('/v1/payment_methods');
    result = { ok: true, message: 'Credencial aceita pelo Mercado Pago' };
  } catch (e) {
    result = { ok: false, message: e instanceof MpError ? mpFriendly(e, 'validar a credencial') : 'Falha ao validar a credencial do Mercado Pago' };
  }
  checkCache = { token, at: Date.now(), result };
  return result;
}

/**
 * Referência externa do pagamento: "mckbot|<orgId>|<produto>|<ciclo>" e, com cupom,
 * "|c=<couponId>:<descontoCentavos>". Só o servidor cria preferências (com o token do MP),
 * então o desconto gravado aqui é o calculado no servidor no momento do checkout.
 */
export const buildReference = (orgId: string, product: PlanProduct, cycle: Cycle, coupon?: { id: string; discountCents: number } | null) =>
  `mckbot|${orgId}|${product}|${cycle}` + (coupon ? `|c=${coupon.id}:${Math.round(coupon.discountCents)}` : '');
export function parseReference(ref: unknown): { orgId: string; product: PlanProduct; cycle: Cycle; coupon: { id: string; discountCents: number } | null } | null {
  if (typeof ref !== 'string') return null;
  const parts = ref.split('|');
  if ((parts.length !== 4 && parts.length !== 5) || parts[0] !== 'mckbot' || !parts[1]) return null;
  const [, orgId, product, cycle, extra] = parts;
  if (!isPlanProduct(product) || !isCycle(cycle)) return null;
  let coupon: { id: string; discountCents: number } | null = null;
  if (extra !== undefined) {
    const m = /^c=([A-Za-z0-9_-]{1,40}):(\d{1,9})$/.exec(extra);
    if (!m) return null;
    coupon = { id: m[1], discountCents: Number(m[2]) };
  }
  return { orgId, product, cycle, coupon };
}

export async function createPreference(input: { orgId: string; product: PlanProduct; cycle: Cycle; title: string; amountCents: number; coupon?: { id: string; discountCents: number } | null; baseUrl: string; payerEmail?: string; returnPath?: string }) {
  const body = {
    items: [{ id: `${input.product}-${input.cycle}`, title: input.title, quantity: 1, currency_id: 'BRL', unit_price: Math.round(input.amountCents) / 100 }],
    external_reference: buildReference(input.orgId, input.product, input.cycle, input.coupon),
    notification_url: `${input.baseUrl}/api/billing/mp/webhook`,
    statement_descriptor: 'MCKBOT',
    back_urls: {
      success: `${input.baseUrl}${input.returnPath ?? '/'}?billing=success`,
      pending: `${input.baseUrl}${input.returnPath ?? '/'}?billing=pending`,
      failure: `${input.baseUrl}${input.returnPath ?? '/'}?billing=failure`,
    },
    auto_return: 'approved',
    // Pix e cartão liberados (nenhuma exclusão de meio de pagamento).
    payment_methods: { excluded_payment_types: [], excluded_payment_methods: [], installments: 12 },
    ...(input.payerEmail ? { payer: { email: input.payerEmail } } : {}),
  };
  const pref = await mp('/checkout/preferences', { method: 'POST', body: JSON.stringify(body) });
  return { id: String(pref?.id ?? ''), init_point: String(pref?.init_point ?? ''), sandbox_init_point: pref?.sandbox_init_point as string | undefined };
}

export interface MpPayment { id: string; status: string; external_reference: string | null; transaction_amount: number; currency_id?: string }
export async function getPayment(id: string): Promise<MpPayment> {
  if (!/^\d{1,30}$/.test(id)) throw new MpError(400, 'paymentId inválido');
  const p = await mp(`/v1/payments/${id}`);
  return { id: String(p?.id ?? id), status: String(p?.status ?? ''), external_reference: p?.external_reference ?? null, transaction_amount: Number(p?.transaction_amount ?? 0), currency_id: p?.currency_id };
}

/**
 * Valida o cabeçalho x-signature do Mercado Pago ("ts=...,v1=...").
 * Manifesto: "id:<data.id minúsculo>;request-id:<x-request-id>;ts:<ts>;" (partes ausentes são omitidas).
 */
export function buildManifest(dataId: string | undefined | null, requestId: string | undefined | null, ts: string) {
  let m = '';
  if (dataId) m += `id:${String(dataId).toLowerCase()};`;
  if (requestId) m += `request-id:${requestId};`;
  if (ts) m += `ts:${ts};`;
  return m;
}
export function verifySignature(opts: { secret: string; xSignature?: string | null; xRequestId?: string | null; dataId?: string | null }): boolean {
  if (!opts.xSignature) return false;
  let ts = '';
  let v1 = '';
  for (const part of opts.xSignature.split(',')) {
    const [k, ...rest] = part.split('=');
    const v = rest.join('=').trim();
    if (k?.trim() === 'ts') ts = v;
    else if (k?.trim() === 'v1') v1 = v;
  }
  if (!ts || !v1) return false;
  const expected = hmacSha256Hex(opts.secret, buildManifest(opts.dataId, opts.xRequestId, ts));
  return safeEqual(expected, v1.toLowerCase());
}
