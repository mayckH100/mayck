import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { app, registerClient, loginClient, Client, installGraphMock, graph, prisma, uniq } from '../helpers.js';
import { getSettings, updateSettings, type Prices } from '../../server/billing/service.js';
import { livePricesText } from '../../server/ai/siteKnowledge.js';

/**
 * v1.27.0 — Plano Completo R$ 100/mês (R$ 1.000/ano); cliente nova paga R$ 58 nos 2 primeiros meses do mensal.
 */
type Pay = { id: string; status: string; external_reference: string; transaction_amount: number; currency_id?: string };
const mp = { prefs: [] as any[], payments: new Map<string, Pay>() };
let payId = 6610000; // base própria: indicacao usa 8800000, coupons 7700000, billing 900000 (mpPaymentId é único no banco)
const newPay = (p: Omit<Pay, 'id'>) => { const id = String(++payId); mp.payments.set(id, { id, currency_id: 'BRL', ...p }); return id; };
const webhook = (id: string) => request(app).post(`/api/billing/mp/webhook?data.id=${id}&type=payment`).set('content-type', 'application/json').send({ type: 'payment', data: { id } });
const PASS = 'senhaSegura123';

describe('Promoção de cliente nova do Plano Completo', () => {
  let admin: Client;
  let before: { prices: Prices; introOffer: any };

  /** Checkout + pagamento aprovado do valor que o servidor cobrou. Devolve o checkout e o resultado do webhook. */
  async function payCheckout(c: Client, product: string, cycle: string, extra: Record<string, unknown> = {}) {
    const ck = await c.post('/api/billing/checkout', { product, cycle, ...extra });
    expect(ck.status).toBe(200);
    const pref = mp.prefs[mp.prefs.length - 1];
    const id = newPay({ status: 'approved', external_reference: pref.external_reference, transaction_amount: pref.items[0].unit_price });
    const wh = await webhook(id);
    return { ck: ck.body, pref, wh: wh.body, id };
  }

  beforeAll(async () => {
    installGraphMock();
    process.env.MP_ACCESS_TOKEN = 'TEST-token-mp';
    const s = await getSettings();
    before = { prices: s.prices, introOffer: s.introOffer };
    await updateSettings({ mpWebhookSecret: null, prices: { COMBO: { MENSAL: 10000, ANUAL: 100000 }, MCKBOT: { MENSAL: 2200, ANUAL: 22000 }, MCKMENSAGEM: { MENSAL: 1500, ANUAL: 16000 } }, introOffer: { enabled: true, priceCents: 5800, months: 2 }, plans: { COMBO: { visible: true } } });
    graph.other = async (url, init) => {
      if (url === 'https://api.mercadopago.com/checkout/preferences' && init?.method === 'POST') {
        mp.prefs.push(JSON.parse(String(init.body)));
        return new Response(JSON.stringify({ id: 'pref-p' + mp.prefs.length, init_point: 'https://www.mercadopago.com.br/checkout/v1/redirect?pref_id=p' + mp.prefs.length }), { status: 201 });
      }
      const m = url.match(/^https:\/\/api\.mercadopago\.com\/v1\/payments\/(\d+)$/);
      if (m) { const p = mp.payments.get(m[1]); return p ? new Response(JSON.stringify(p), { status: 200 }) : new Response('{"message":"not found"}', { status: 404 }); }
      return null;
    };
    const email = `${uniq('promomaster')}@teste.dev`;
    const first = await registerClient({ email });
    await prisma.user.update({ where: { id: first.me.user.id }, data: { isSuperAdmin: true } });
    admin = (await loginClient(email, PASS)).c;
  });
  afterAll(async () => {
    await updateSettings({ prices: before.prices, introOffer: before.introOffer });
    delete process.env.MP_ACCESS_TOKEN;
    graph.other = null;
  });

  it('vitrine pública, /billing/status e a IA mostram a promoção', async () => {
    const pub = (await request(app).get('/api/public/plans')).body;
    expect(pub.introOffer).toMatchObject({ plan: 'COMBO', cycle: 'MENSAL', priceCents: 5800, months: 2, regularPriceCents: 10000, text: 'R$ 58/mês nos 2 primeiros meses, depois R$ 100/mês' });
    const combo = pub.plans.find((p: any) => p.id === 'COMBO');
    expect(combo.prices).toEqual({ MENSAL: 10000, ANUAL: 100000 });
    expect(combo.introOffer.priceCents).toBe(5800);
    expect(pub.plans.find((p: any) => p.id === 'MCKBOT').introOffer).toBeUndefined();
    const c = await registerClient();
    const st = (await c.get('/api/billing/status')).body;
    expect(st.introOffer).toMatchObject({ priceCents: 5800, eligible: true, monthsUsed: 0, monthsLeft: 2 });
    const txt = (await livePricesText()).replace(/\u00a0/g, ' ');
    expect(txt).toContain('R$ 100,00/mês (PROMOÇÃO PARA CLIENTE NOVA: R$ 58/mês nos 2 primeiros meses, depois R$ 100/mês');
    expect(txt).toContain('R$ 1.000,00/ano');
    expect(txt).toContain('R$ 22,00/mês');
  });

  it('cliente nova paga R$ 58 no 1º e no 2º mês e R$ 100 no 3º', async () => {
    const c = await registerClient();
    const orgId = c.me.org.id;
    const p1 = await payCheckout(c, 'COMBO', 'MENSAL');
    expect(p1.ck).toMatchObject({ amountCents: 5800, originalCents: 10000, introOffer: { priceCents: 5800, month: 1, months: 2, regularPriceCents: 10000 } });
    expect(p1.pref.items[0].unit_price).toBe(58);
    expect(p1.pref.external_reference).toBe(`mckbot|${orgId}|COMBO|MENSAL|i=5800`);
    expect(p1.pref.items[0].title).toContain('mês 1 de 2');
    expect(p1.wh).toMatchObject({ renewed: true });
    const p2 = await payCheckout(c, 'COMBO', 'MENSAL');
    expect(p2.ck).toMatchObject({ amountCents: 5800, introOffer: { month: 2 } });
    expect(p2.wh).toMatchObject({ renewed: true });
    const p3 = await payCheckout(c, 'COMBO', 'MENSAL');
    expect(p3.ck.amountCents).toBe(10000);
    expect(p3.ck.introOffer).toBeUndefined();
    expect(p3.pref.external_reference).toBe(`mckbot|${orgId}|COMBO|MENSAL`);
    expect(p3.wh).toMatchObject({ renewed: true });
    const evs = await prisma.billingEvent.findMany({ where: { orgId, kind: 'MP' }, orderBy: { createdAt: 'asc' } });
    expect(evs.map((e) => [e.amountCents, e.introOffer])).toEqual([[5800, true], [5800, true], [10000, false]]);
    expect((await c.get('/api/billing/status')).body.introOffer).toMatchObject({ eligible: false, monthsLeft: 0 });
  });

  it('quem já pagou outro plano paga R$ 100; anual é R$ 1.000 sem promoção', async () => {
    const c = await registerClient();
    const bot = await payCheckout(c, 'MCKBOT', 'MENSAL');
    expect(bot.ck.amountCents).toBe(2200);
    expect(bot.wh).toMatchObject({ renewed: true });
    const ck = await c.post('/api/billing/checkout', { product: 'COMBO', cycle: 'MENSAL' });
    expect(ck.body.amountCents).toBe(10000);
    expect(ck.body.introOffer).toBeUndefined();
    const nova = await registerClient();
    const anual = await nova.post('/api/billing/checkout', { product: 'COMBO', cycle: 'ANUAL' });
    expect(anual.body.amountCents).toBe(100000);
    expect(anual.body.introOffer).toBeUndefined();
    // Quem começou no anual também deixa de ser cliente nova.
    const a = await payCheckout(nova, 'COMBO', 'ANUAL');
    expect(a.wh.renewed).toBe(true);
    expect((await nova.post('/api/billing/checkout', { product: 'COMBO', cycle: 'MENSAL' })).body.amountCents).toBe(10000);
    // Ativação manual paga pelo Master também conta como "já é cliente".
    const m = await registerClient();
    await prisma.billingEvent.create({ data: { orgId: m.me.org.id, product: 'MCKMENSAGEM', kind: 'MANUAL', cycle: 'MENSAL' } });
    expect((await m.post('/api/billing/checkout', { product: 'COMBO', cycle: 'MENSAL' })).body.amountCents).toBe(10000);
  });

  it('não dá para burlar abrindo vários checkouts: só pagamento confirmado conta, e o 3º promocional é recusado', async () => {
    const c = await registerClient();
    const orgId = c.me.org.id;
    // Abre 3 checkouts enquanto ainda é cliente nova (os 3 saem a R$ 58).
    const refs: string[] = [];
    for (let i = 0; i < 3; i++) {
      const ck = await c.post('/api/billing/checkout', { product: 'COMBO', cycle: 'MENSAL' });
      expect(ck.body.amountCents).toBe(5800);
      refs.push(mp.prefs[mp.prefs.length - 1].external_reference);
    }
    // Checkout aberto/pendente não conta.
    const pend = newPay({ status: 'pending', external_reference: refs[0], transaction_amount: 58 });
    await webhook(pend);
    expect((await c.get('/api/billing/status')).body.introOffer.monthsUsed).toBe(0);
    const ok1 = newPay({ status: 'approved', external_reference: refs[0], transaction_amount: 58 });
    const ok2 = newPay({ status: 'approved', external_reference: refs[1], transaction_amount: 58 });
    const ok3 = newPay({ status: 'approved', external_reference: refs[2], transaction_amount: 58 });
    expect((await webhook(ok1)).body).toMatchObject({ renewed: true });
    expect((await webhook(ok1)).body.duplicated).toBe(true); // aviso repetido não conta de novo nem é recusado
    expect((await webhook(ok2)).body.renewed).toBe(true);
    const r3 = await webhook(ok3);
    expect(r3.body).toMatchObject({ renewed: false, reason: 'promocao_esgotada' });
    expect(await prisma.billingEvent.count({ where: { orgId, kind: 'MP' } })).toBe(2);
    expect(await prisma.auditLog.count({ where: { action: 'billing.mp.valor_divergente', entityId: ok3 } })).toBe(1);
    // Referência forjada com a marca da promoção para quem já pagou outro plano: recusada.
    const outra = await registerClient();
    await payCheckout(outra, 'MCKBOT', 'MENSAL');
    const forj = newPay({ status: 'approved', external_reference: `mckbot|${outra.me.org.id}|COMBO|MENSAL|i=5800`, transaction_amount: 58 });
    expect((await webhook(forj)).body).toMatchObject({ renewed: false, reason: 'promocao_esgotada' });
    // Marca da promoção em outro plano/ciclo não vale.
    const nova = await registerClient();
    const anualForj = newPay({ status: 'approved', external_reference: `mckbot|${nova.me.org.id}|COMBO|ANUAL|i=5800`, transaction_amount: 58 });
    expect((await webhook(anualForj)).body.renewed).toBe(false);
  });

  it('estorno devolve o mês da promoção (pagamento estornado não conta)', async () => {
    const c = await registerClient();
    const p1 = await payCheckout(c, 'COMBO', 'MENSAL');
    expect(p1.wh).toMatchObject({ renewed: true });
    mp.payments.get(p1.id)!.status = 'refunded';
    expect((await webhook(p1.id)).body.revoked).toBe(true);
    expect((await c.get('/api/billing/status')).body.introOffer).toMatchObject({ eligible: true, monthsUsed: 0 });
  });

  it('cupom não acumula: vale o menor preço (promoção ou cupom)', async () => {
    const small = `PROMO${Date.now().toString(36).toUpperCase()}`.slice(0, 20);
    const big = `GRANDE${Date.now().toString(36).toUpperCase()}`.slice(0, 20);
    expect((await admin.post('/api/master/coupons', { code: small, type: 'PERCENT', value: 10, product: 'ALL', cycles: 'ALL', validUntil: null, maxUses: null, active: true })).status).toBe(201);
    const bigRes = await admin.post('/api/master/coupons', { code: big, type: 'PERCENT', value: 50, product: 'ALL', cycles: 'ALL', validUntil: null, maxUses: null, active: true });
    expect(bigRes.status).toBe(201);
    const c = await registerClient();
    const orgId = c.me.org.id;
    // 10% de R$ 100 = R$ 90 > R$ 58: fica a promoção e o cupom não é usado.
    const a = await c.post('/api/billing/checkout', { product: 'COMBO', cycle: 'MENSAL', coupon: small });
    expect(a.body).toMatchObject({ amountCents: 5800, couponNotice: expect.stringMatching(/não acumula/) });
    expect(a.body.coupon).toBeUndefined();
    expect(mp.prefs[mp.prefs.length - 1].external_reference).toBe(`mckbot|${orgId}|COMBO|MENSAL|i=5800`);
    // 50% de R$ 100 = R$ 50 < R$ 58: vale o cupom, e o pagamento ainda conta como mês da promoção.
    const p = await payCheckout(c, 'COMBO', 'MENSAL', { coupon: big });
    expect(p.ck).toMatchObject({ amountCents: 5000, coupon: big, discountCents: 5000 });
    expect(p.pref.external_reference).toBe(`mckbot|${orgId}|COMBO|MENSAL|c=${bigRes.body.id}:5000|i=5800`);
    expect(p.wh.renewed).toBe(true);
    expect((await prisma.billingEvent.findFirst({ where: { orgId, kind: 'MP' } }))!.introOffer).toBe(true);
    expect((await c.get('/api/billing/status')).body.introOffer).toMatchObject({ eligible: true, monthsUsed: 1, monthsLeft: 1 });
    // Fora da promoção (anual), o cupom vale normal.
    expect((await c.post('/api/billing/checkout', { product: 'COMBO', cycle: 'ANUAL', coupon: small })).body.amountCents).toBe(90000);
  });

  it('Master liga/desliga e muda a promoção (validado e auditado)', async () => {
    const off = await admin.put('/api/master/settings', { introOffer: { enabled: false } });
    expect(off.status).toBe(200);
    expect(off.body.introOffer).toEqual({ enabled: false, priceCents: 5800, months: 2 });
    expect((await request(app).get('/api/public/plans')).body.introOffer).toBeNull();
    const c = await registerClient();
    expect((await c.post('/api/billing/checkout', { product: 'COMBO', cycle: 'MENSAL' })).body.amountCents).toBe(10000);
    expect((await admin.put('/api/master/settings', { introOffer: { priceCents: 50 } })).status).toBe(400);
    const on = await admin.put('/api/master/settings', { introOffer: { enabled: true, priceCents: 4900, months: 3 } });
    expect(on.body.introOffer).toEqual({ enabled: true, priceCents: 4900, months: 3 });
    expect((await c.post('/api/billing/checkout', { product: 'COMBO', cycle: 'MENSAL' })).body).toMatchObject({ amountCents: 4900, introOffer: { month: 1, months: 3 } });
    expect(await prisma.auditLog.count({ where: { action: 'master.settings.update' } })).toBeGreaterThanOrEqual(2);
    await admin.put('/api/master/settings', { introOffer: { enabled: true, priceCents: 5800, months: 2 } });
    // Preço normal abaixo do promocional (ex.: R$ 30 antigo salvo no Master): sem promoção.
    await updateSettings({ prices: { COMBO: { MENSAL: 3000 } } });
    expect((await request(app).get('/api/public/plans')).body.introOffer).toBeNull();
    expect((await c.post('/api/billing/checkout', { product: 'COMBO', cycle: 'MENSAL' })).body.amountCents).toBe(3000);
    await updateSettings({ prices: { COMBO: { MENSAL: 10000 } } });
  });
});
