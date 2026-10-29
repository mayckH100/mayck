import { describe, it, expect } from 'vitest';
import { couponAvailability, couponMatches, normalizeCode, quote, quotesFor, rawDiscount, CODE_RE, MIN_FINAL_CENTS } from '../../server/billing/coupons.js';
import { buildReference, parseReference } from '../../server/billing/mercadopago.js';
import type { Prices } from '../../server/billing/service.js';

const prices: Prices = { MCKBOT: { MENSAL: 5000, ANUAL: 50000 }, MCKMENSAGEM: { MENSAL: 6000, ANUAL: 60000 }, COMBO: { MENSAL: 9000, ANUAL: 90000 } };
const base = { active: true, validUntil: null as Date | null, maxUses: null as number | null, product: 'ALL', cycles: 'ALL' };

describe('Cupons: regras e cálculo de preço', () => {
  it('normaliza e valida o código', () => {
    expect(normalizeCode('  influ 10 ')).toBe('INFLU10');
    expect(CODE_RE.test('INFLU10')).toBe(true);
    expect(CODE_RE.test('AB')).toBe(false);
    expect(CODE_RE.test('COM ESPAÇO')).toBe(false);
  });

  it('percentual arredonda em centavos; fixo desconta o valor', () => {
    expect(rawDiscount({ type: 'PERCENT', value: 10 }, 3990)).toBe(399);
    expect(rawDiscount({ type: 'PERCENT', value: 15 }, 3990)).toBe(599); // 598,5 → 599
    expect(quote({ type: 'PERCENT', value: 10 }, 5000)).toEqual({ originalCents: 5000, discountCents: 500, finalCents: 4500 });
    expect(quote({ type: 'FIXED', value: 1500 }, 5000)).toEqual({ originalCents: 5000, discountCents: 1500, finalCents: 3500 });
  });

  it('valor final nunca abaixo do mínimo cobrável', () => {
    expect(quote({ type: 'FIXED', value: 5000 }, 5000)).toBeNull();
    expect(quote({ type: 'FIXED', value: 5000 - MIN_FINAL_CENTS }, 5000)).toEqual({ originalCents: 5000, discountCents: 4900, finalCents: MIN_FINAL_CENTS });
    expect(quote({ type: 'FIXED', value: 4901 }, 5000)).toBeNull();
    expect(quote({ type: 'PERCENT', value: 99 }, 5000)).toBeNull(); // R$ 0,50
  });

  it('produto e ciclo: ALL vale para tudo; produto exato não vale para o combo', () => {
    expect(couponMatches({ product: 'ALL', cycles: 'ALL' }, 'COMBO', 'ANUAL')).toBe(true);
    expect(couponMatches({ product: 'MCKBOT', cycles: 'ALL' }, 'MCKBOT', 'ANUAL')).toBe(true);
    expect(couponMatches({ product: 'MCKBOT', cycles: 'ALL' }, 'COMBO', 'MENSAL')).toBe(false);
    expect(couponMatches({ product: 'ALL', cycles: 'MENSAL' }, 'MCKMENSAGEM', 'ANUAL')).toBe(false);
    const q = quotesFor({ type: 'PERCENT', value: 20, product: 'COMBO', cycles: 'ANUAL' }, prices);
    expect(q).toEqual({ COMBO: { ANUAL: { originalCents: 90000, discountCents: 18000, finalCents: 72000 } } });
    // Fixo maior que o mensal: só aparece onde cabe.
    const f = quotesFor({ type: 'FIXED', value: 5500, product: 'ALL', cycles: 'ALL' }, prices);
    expect(f.MCKBOT?.MENSAL).toBeUndefined();
    expect(f.MCKMENSAGEM?.MENSAL?.finalCents).toBe(500);
    expect(f.MCKBOT?.ANUAL?.finalCents).toBe(44500);
  });

  it('disponibilidade: inativo, expirado, esgotado', () => {
    const now = new Date('2026-11-01T12:00:00Z');
    expect(couponAvailability({ ...base, type: 'PERCENT', value: 10 }, 0, now)).toBeNull();
    expect(couponAvailability({ ...base, type: 'PERCENT', value: 10, active: false }, 0, now)).toBe('inativo');
    expect(couponAvailability({ ...base, type: 'PERCENT', value: 10, validUntil: new Date('2026-10-31T23:59:59-03:00') }, 0, now)).toBe('expirado');
    expect(couponAvailability({ ...base, type: 'PERCENT', value: 10, validUntil: new Date('2026-11-01T23:59:59-03:00') }, 0, now)).toBeNull();
    expect(couponAvailability({ ...base, type: 'PERCENT', value: 10, maxUses: 2 }, 1, now)).toBeNull();
    expect(couponAvailability({ ...base, type: 'PERCENT', value: 10, maxUses: 2 }, 2, now)).toBe('esgotado');
  });

  it('referência do Mercado Pago carrega cupom e desconto; formato antigo continua válido', () => {
    expect(parseReference('mckbot|org1|MCKBOT|MENSAL')).toEqual({ orgId: 'org1', product: 'MCKBOT', cycle: 'MENSAL', coupon: null });
    const ref = buildReference('org1', 'COMBO', 'ANUAL', { id: 'cm123abc', discountCents: 18000 });
    expect(ref).toBe('mckbot|org1|COMBO|ANUAL|c=cm123abc:18000');
    expect(parseReference(ref)).toEqual({ orgId: 'org1', product: 'COMBO', cycle: 'ANUAL', coupon: { id: 'cm123abc', discountCents: 18000 } });
    expect(parseReference('mckbot|org1|COMBO|ANUAL|lixo')).toBeNull();
    expect(parseReference('mckbot|org1|COMBO|ANUAL|c=abc:-5')).toBeNull();
  });
});
