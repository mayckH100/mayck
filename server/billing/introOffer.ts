/**
 * v1.27.0 — Promoção de entrada do Plano Completo (decisão do Mayck em 08/11/2026).
 *
 * Regra:
 *  - vale só para o plano COMBO (Plano Completo: MCK ERP + MCKBOT + MCK Mensagens) no ciclo MENSAL;
 *  - empresa "cliente nova" paga o preço promocional (padrão R$ 58,00 = 5800 centavos) nos N primeiros meses
 *    (padrão 2); do pagamento N+1 em diante paga o preço normal do Master (pricesJson.COMBO.MENSAL);
 *  - "cliente nova" = TODOS os pagamentos confirmados da empresa (Mercado Pago aprovado e não estornado, ou
 *    ativação/renovação manual com ciclo feita pelo Master) são meses da própria promoção. Quem já pagou qualquer
 *    outro plano (MCKBOT, MCK Mensagens, COMBO anual) ou um COMBO mensal antes da promoção existir NÃO ganha;
 *  - só pagamento CONFIRMADO conta: abrir vários checkouts não muda nada, porque o webhook confere de novo a
 *    elegibilidade na hora de aprovar (excluindo o próprio pagamento) e recusa o valor promocional se a empresa
 *    já usou os N meses;
 *  - cupom NÃO acumula com a promoção: o checkout cobra o MENOR entre o preço promocional e o preço com cupom.
 *    Se o cupom ganhar, o pagamento ainda conta como um mês da promoção (a empresa continua "cliente nova");
 *  - o anual (R$ 1.000) não tem promoção.
 *
 * Configuração: PlatformSettings.introOfferJson (Painel Master), '{}' = padrão abaixo. Este arquivo é puro (sem banco).
 */

export const INTRO_PLAN = 'COMBO' as const;
export const INTRO_CYCLE = 'MENSAL' as const;
/** Mínimo cobrável pelo Mercado Pago (o mesmo de coupons.MIN_FINAL_CENTS). */
const MIN_CENTS = 100;

export interface IntroOffer {
  enabled: boolean;
  /** Preço promocional em centavos (5800 = R$ 58,00). */
  priceCents: number;
  /** Quantos pagamentos mensais saem pelo preço promocional. */
  months: number;
}

export const DEFAULT_INTRO_OFFER: IntroOffer = { enabled: true, priceCents: 5800, months: 2 };
export const INTRO_LIMITS = { maxMonths: 12, maxPriceCents: 100_000_000 } as const;

/** Lê o JSON salvo, completando com o padrão. Nunca lança. */
export function parseIntroOffer(json: string | null | undefined): IntroOffer {
  let raw: any = {};
  try { raw = json ? JSON.parse(json) : {}; } catch { raw = {}; }
  if (!raw || typeof raw !== 'object') raw = {};
  const d = DEFAULT_INTRO_OFFER;
  const price = Number.isInteger(raw.priceCents) && raw.priceCents >= MIN_CENTS && raw.priceCents <= INTRO_LIMITS.maxPriceCents ? raw.priceCents : d.priceCents;
  const months = Number.isInteger(raw.months) && raw.months >= 1 && raw.months <= INTRO_LIMITS.maxMonths ? raw.months : d.months;
  return { enabled: typeof raw.enabled === 'boolean' ? raw.enabled : d.enabled, priceCents: price, months };
}

export type IntroOfferInput = Partial<IntroOffer>;

/** Erro legível (vai para o Master como 400) ou null. */
export function validateIntroOfferInput(input: IntroOfferInput): string | null {
  if (input.priceCents !== undefined && (!Number.isInteger(input.priceCents) || input.priceCents < MIN_CENTS || input.priceCents > INTRO_LIMITS.maxPriceCents)) {
    return 'O preço promocional precisa ser de pelo menos R$ 1,00.';
  }
  if (input.months !== undefined && (!Number.isInteger(input.months) || input.months < 1 || input.months > INTRO_LIMITS.maxMonths)) {
    return `A promoção pode valer de 1 a ${INTRO_LIMITS.maxMonths} meses.`;
  }
  return null;
}

export const applyIntroOfferInput = (cur: IntroOffer, input: IntroOfferInput): IntroOffer => ({
  enabled: input.enabled ?? cur.enabled,
  priceCents: input.priceCents ?? cur.priceCents,
  months: input.months ?? cur.months,
});

/** A promoção está valendo para venda (ligada e mais barata que o preço normal, que precisa estar à venda)? */
export const introOfferActive = (offer: IntroOffer, fullPriceCents: number) => offer.enabled && fullPriceCents >= MIN_CENTS && offer.priceCents < fullPriceCents;

/** Pagamento confirmado da empresa, como a regra enxerga. intro = contou como mês da promoção. */
export interface PaidEvent { product: string; cycle: string | null; intro: boolean }

/**
 * Puro: a empresa ainda é "cliente nova" para a promoção? Não olha se a promoção está ligada (isso é do checkout).
 * used = meses da promoção já pagos; remaining = quantos ainda faltam.
 */
export function introEligibility(paid: PaidEvent[], months: number): { eligible: boolean; used: number; remaining: number } {
  const allIntro = paid.every((p) => p.intro && p.product === INTRO_PLAN && p.cycle === INTRO_CYCLE);
  const used = paid.length;
  const eligible = allIntro && used < months;
  return { eligible, used: allIntro ? used : months, remaining: eligible ? months - used : 0 };
}

/** Espaço normal (não o \u00a0 do Intl) para o texto bater igual no site, no app e na IA. */
const brl0 = (cents: number) => `R$ ${(cents / 100).toLocaleString('pt-BR', cents % 100 === 0 ? {} : { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** "R$ 58/mês nos 2 primeiros meses, depois R$ 100/mês" (null quando a promoção não está valendo). */
export function introOfferText(offer: IntroOffer, fullPriceCents: number): string | null {
  if (!introOfferActive(offer, fullPriceCents)) return null;
  const meses = offer.months === 1 ? 'no 1º mês' : `nos ${offer.months} primeiros meses`;
  return `${brl0(offer.priceCents)}/mês ${meses}, depois ${brl0(fullPriceCents)}/mês`;
}

/** Visão pública da promoção (vitrine, app, site, IA). null quando não está valendo. */
export function publicIntroOffer(offer: IntroOffer, fullPriceCents: number) {
  const text = introOfferText(offer, fullPriceCents);
  if (!text) return null;
  return { plan: INTRO_PLAN, cycle: INTRO_CYCLE, priceCents: offer.priceCents, months: offer.months, regularPriceCents: fullPriceCents, newCustomersOnly: true, text };
}
