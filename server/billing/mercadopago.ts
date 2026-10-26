import { httpFetch } from '../lib/fetcher.js';
import { hmacSha256Hex, safeEqual } from '../lib/crypto.js';
import type { Cycle, PlanProduct } from './service.js';
import { isCycle, isPlanProduct } from './service.js';

const API = 'https://api.mercadopago.com';
export const mpToken = () => process.env.MP_ACCESS_TOKEN || '';
export const billingConfigured = () => !!process.env.MP_ACCESS_TOKEN;

export class MpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

async function mp(path: string, init: RequestInit = {}) {
  const token = mpToken();
  if (!token) throw new MpError(503, 'Mercado Pago não configurado');
  const res = await httpFetch(API + path, {
    ...init,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(init.headers as Record<string, string> | undefined) },
  });
  const text = await res.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  if (!res.ok) throw new MpError(res.status, body?.message || `Mercado Pago respondeu ${res.status}`);
  return body;
}

export const buildReference = (orgId: string, product: PlanProduct, cycle: Cycle) => `mckbot|${orgId}|${product}|${cycle}`;
export function parseReference(ref: unknown): { orgId: string; product: PlanProduct; cycle: Cycle } | null {
  if (typeof ref !== 'string') return null;
  const parts = ref.split('|');
  if (parts.length !== 4 || parts[0] !== 'mckbot' || !parts[1]) return null;
  const [, orgId, product, cycle] = parts;
  if (!isPlanProduct(product) || !isCycle(cycle)) return null;
  return { orgId, product, cycle };
}

export async function createPreference(input: { orgId: string; product: PlanProduct; cycle: Cycle; title: string; amountCents: number; baseUrl: string; payerEmail?: string; returnPath?: string }) {
  const body = {
    items: [{ id: `${input.product}-${input.cycle}`, title: input.title, quantity: 1, currency_id: 'BRL', unit_price: Math.round(input.amountCents) / 100 }],
    external_reference: buildReference(input.orgId, input.product, input.cycle),
    notification_url: `${input.baseUrl}/api/billing/mp/webhook`,
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
