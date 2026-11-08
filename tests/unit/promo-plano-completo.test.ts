import { describe, it, expect } from 'vitest';
import { DEFAULT_INTRO_OFFER, introEligibility, introOfferActive, introOfferText, parseIntroOffer, publicIntroOffer, validateIntroOfferInput } from '../../server/billing/introOffer.js';
import { buildReference, parseReference } from '../../server/billing/mercadopago.js';

const intro = (n: number) => Array.from({ length: n }, () => ({ product: 'COMBO', cycle: 'MENSAL', intro: true }));

describe('Promoção de entrada do Plano Completo (v1.27.0)', () => {
  it('padrão: ligada, R$ 58,00 por 2 meses; JSON inválido volta ao padrão', () => {
    expect(DEFAULT_INTRO_OFFER).toEqual({ enabled: true, priceCents: 5800, months: 2 });
    expect(parseIntroOffer('{}')).toEqual(DEFAULT_INTRO_OFFER);
    expect(parseIntroOffer('lixo')).toEqual(DEFAULT_INTRO_OFFER);
    expect(parseIntroOffer('{"priceCents":50,"months":0}')).toEqual(DEFAULT_INTRO_OFFER);
    expect(parseIntroOffer('{"enabled":false,"priceCents":4900,"months":3}')).toEqual({ enabled: false, priceCents: 4900, months: 3 });
    expect(validateIntroOfferInput({ priceCents: 99 })).toMatch(/R\$ 1,00/);
    expect(validateIntroOfferInput({ months: 13 })).toMatch(/1 a 12/);
    expect(validateIntroOfferInput({ priceCents: 5800, months: 2 })).toBeNull();
  });

  it('cliente nova: 1º e 2º pagamento promocionais, 3º não', () => {
    expect(introEligibility([], 2)).toEqual({ eligible: true, used: 0, remaining: 2 });
    expect(introEligibility(intro(1), 2)).toEqual({ eligible: true, used: 1, remaining: 1 });
    expect(introEligibility(intro(2), 2)).toEqual({ eligible: false, used: 2, remaining: 0 });
  });

  it('quem já pagou qualquer outro plano (ou o anual, ou um COMBO antes da promoção) não é cliente nova', () => {
    expect(introEligibility([{ product: 'MCKBOT', cycle: 'MENSAL', intro: false }], 2).eligible).toBe(false);
    expect(introEligibility([{ product: 'MCKMENSAGEM', cycle: 'ANUAL', intro: false }], 2).eligible).toBe(false);
    expect(introEligibility([{ product: 'COMBO', cycle: 'ANUAL', intro: false }], 2).eligible).toBe(false);
    expect(introEligibility([{ product: 'COMBO', cycle: 'MENSAL', intro: false }], 2).eligible).toBe(false);
  });

  it('texto e vitrine: "R$ 58/mês nos 2 primeiros meses, depois R$ 100/mês"; sem promoção quando não é mais barata', () => {
    expect(introOfferText(DEFAULT_INTRO_OFFER, 10000)).toBe('R$ 58/mês nos 2 primeiros meses, depois R$ 100/mês');
    expect(introOfferText({ ...DEFAULT_INTRO_OFFER, months: 1, priceCents: 5890 }, 10000)).toBe('R$ 58,90/mês no 1º mês, depois R$ 100/mês');
    expect(introOfferActive(DEFAULT_INTRO_OFFER, 3000)).toBe(false); // preço normal antigo (R$ 30) abaixo do promocional
    expect(introOfferText({ ...DEFAULT_INTRO_OFFER, enabled: false }, 10000)).toBeNull();
    expect(publicIntroOffer(DEFAULT_INTRO_OFFER, 10000)).toMatchObject({ plan: 'COMBO', cycle: 'MENSAL', priceCents: 5800, months: 2, regularPriceCents: 10000, newCustomersOnly: true });
  });

  it('referência do Mercado Pago com a marca da promoção (com e sem cupom)', () => {
    expect(buildReference('o1', 'COMBO', 'MENSAL', null, 5800)).toBe('mckbot|o1|COMBO|MENSAL|i=5800');
    expect(parseReference('mckbot|o1|COMBO|MENSAL|i=5800')).toEqual({ orgId: 'o1', product: 'COMBO', cycle: 'MENSAL', coupon: null, introCents: 5800 });
    const ref = buildReference('o1', 'COMBO', 'MENSAL', { id: 'cp1', discountCents: 5000 }, 5800);
    expect(ref).toBe('mckbot|o1|COMBO|MENSAL|c=cp1:5000|i=5800');
    expect(parseReference(ref)).toEqual({ orgId: 'o1', product: 'COMBO', cycle: 'MENSAL', coupon: { id: 'cp1', discountCents: 5000 }, introCents: 5800 });
    expect(parseReference('mckbot|o1|COMBO|MENSAL|i=5800|c=cp1:5000')).toBeNull(); // ordem fixa
    expect(parseReference('mckbot|o1|COMBO|MENSAL|i=5800|i=5800')).toBeNull();
    expect(parseReference('mckbot|o1|COMBO|MENSAL|i=-1')).toBeNull();
  });
});
