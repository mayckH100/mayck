import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { app, registerClient, loginClient, Client, installGraphMock, graph, prisma, uniq } from '../helpers.js';
import { getSettings, updateSettings } from '../../server/billing/service.js';
import { livePricesText } from '../../server/ai/siteKnowledge.js';

/**
 * v1.52.0 — Reajuste (MCKBOT R$ 47, MCK Mensagens R$ 29, Completo R$ 97) com preço antigo garantido para quem já
 * pagava, e promoção do 1º mês (Black Friday MCK: R$ 22 / R$ 15 / R$ 58 no 1º mês, até a data, só no mensal).
 */
type Pay = { id: string; status: string; external_reference: string; transaction_amount: number; currency_id?: string };
const mp = { prefs: [] as any[], payments: new Map<string, Pay>() };
let payId = 5520000; // base própria (mpPaymentId é único no banco)
const newPay = (p: Omit<Pay, 'id'>) => { const id = String(++payId); mp.payments.set(id, { id, currency_id: 'BRL', ...p }); return id; };
const webhook = (id: string) => request(app).post(`/api/billing/mp/webhook?data.id=${id}&type=payment`).set('content-type', 'application/json').send({ type: 'payment', data: { id } });
const PASS = 'senhaSegura123';
const FUTURO = () => new Date(Date.now() + 5 * 86400_000).toISOString();
const PASSADO = () => new Date(Date.now() - 60_000).toISOString();
const NOVOS = { MCKBOT: { MENSAL: 4700, ANUAL: 47000 }, MCKMENSAGEM: { MENSAL: 2900, ANUAL: 30900 }, COMBO: { MENSAL: 9700, ANUAL: 97000 } };
const ANTIGOS = { MCKBOT: { MENSAL: 2200, ANUAL: 22000 }, MCKMENSAGEM: { MENSAL: 1500, ANUAL: 16000 }, COMBO: { MENSAL: 10000, ANUAL: 100000 } };

describe('v1.52.0 — reajuste com preço antigo garantido + Black Friday', () => {
  let admin: Client;
  let before: any;

  async function payCheckout(c: Client, product: string, cycle: string, extra: Record<string, unknown> = {}) {
    const ck = await c.post('/api/billing/checkout', { product, cycle, ...extra });
    expect(ck.status).toBe(200);
    const pref = mp.prefs[mp.prefs.length - 1];
    const id = newPay({ status: 'approved', external_reference: pref.external_reference, transaction_amount: pref.items[0].unit_price });
    const wh = await webhook(id);
    return { ck: ck.body, pref, wh: wh.body, id };
  }
  const bf = (ate: string, enabled = true) => updateSettings({ promo: { enabled, codigo: 'BLACKFRIDAY', nome: 'Black Friday MCK', ate, faixa: 'Black Friday MCK: 1º mês com preço especial até 30/11', precos: { MCKBOT: 2200, MCKMENSAGEM: 1500, COMBO: 5800 } } });

  beforeAll(async () => {
    installGraphMock();
    process.env.MP_ACCESS_TOKEN = 'TEST-token-mp';
    const s = await getSettings();
    before = { prices: s.prices, introOffer: s.introOffer, promo: s.promo };
    await updateSettings({ mpWebhookSecret: null, prices: NOVOS, introOffer: { enabled: false, priceCents: 5800, months: 2 }, plans: { COMBO: { visible: true }, MCKBOT: { visible: true }, MCKMENSAGEM: { visible: true } } });
    // Preço antigo guardado como na migração 0076 (legacyAte = agora).
    await prisma.platformSettings.update({ where: { id: 'default' }, data: { legacyPricesJson: JSON.stringify(ANTIGOS), legacyIntroJson: JSON.stringify({ enabled: true, priceCents: 5800, months: 2 }), legacyAte: new Date() } as any });
    await bf(FUTURO());
    graph.other = async (url, init) => {
      if (url === 'https://api.mercadopago.com/checkout/preferences' && init?.method === 'POST') {
        mp.prefs.push(JSON.parse(String(init.body)));
        return new Response(JSON.stringify({ id: 'pref-bf' + mp.prefs.length, init_point: 'https://www.mercadopago.com.br/checkout/v1/redirect?pref_id=bf' + mp.prefs.length }), { status: 201 });
      }
      const m = url.match(/^https:\/\/api\.mercadopago\.com\/v1\/payments\/(\d+)$/);
      if (m) { const p = mp.payments.get(m[1]); return p ? new Response(JSON.stringify(p), { status: 200 }) : new Response('{"message":"not found"}', { status: 404 }); }
      return null;
    };
    const email = `${uniq('bfmaster')}@teste.dev`;
    const first = await registerClient({ email });
    await prisma.user.update({ where: { id: first.me.user.id }, data: { isSuperAdmin: true } });
    admin = (await loginClient(email, PASS)).c;
  });
  afterAll(async () => {
    await prisma.platformSettings.update({ where: { id: 'default' }, data: { legacyPricesJson: null, legacyIntroJson: null, legacyAte: null } as any });
    await updateSettings({ prices: before.prices, introOffer: before.introOffer, promo: { ...before.promo, enabled: false } });
    delete process.env.MP_ACCESS_TOKEN;
    graph.other = null;
  });

  it('vitrine pública: preços novos, faixa e de/por de cada plano; IA sabe da promoção', async () => {
    const pub = (await request(app).get('/api/public/plans')).body;
    expect(pub.promo).toMatchObject({ codigo: 'BLACKFRIDAY', nome: 'Black Friday MCK', faixa: 'Black Friday MCK: 1º mês com preço especial até 30/11' });
    expect(pub.promo.planos).toEqual([{ id: 'MCKBOT', de: 4700, por: 2200 }, { id: 'MCKMENSAGEM', de: 2900, por: 1500 }, { id: 'COMBO', de: 9700, por: 5800 }]);
    const bot = pub.plans.find((p: any) => p.id === 'MCKBOT');
    expect(bot.prices).toEqual({ MENSAL: 4700, ANUAL: 47000 });
    expect(bot.introOffer).toMatchObject({ priceCents: 2200, regularPriceCents: 4700, months: 1, label: 'Black Friday MCK', code: 'BLACKFRIDAY' });
    expect(pub.introOffer).toBeNull(); // promoção de entrada antiga desligada para novas empresas
    const txt = (await livePricesText()).replace(/\u00a0/g, ' ');
    expect(txt).toContain('R$ 47,00/mês (PROMOÇÃO BLACK FRIDAY MCK: R$ 22,00 no 1º mês, depois R$ 47,00/mês');
    expect(txt).toContain('R$ 970,00/ano');
  });

  it('empresa nova: 1º mês com a promoção (automática), 2º mês preço novo; anual sem promoção', async () => {
    const c = await registerClient();
    const orgId = c.me.org.id;
    const st = (await c.get('/api/billing/status')).body;
    expect(st.prices.MCKBOT).toEqual({ MENSAL: 4700, ANUAL: 47000 });
    expect(st.plans.find((p: any) => p.id === 'MCKMENSAGEM').introOffer).toMatchObject({ priceCents: 1500, eligible: true });
    const p1 = await payCheckout(c, 'MCKBOT', 'MENSAL');
    expect(p1.ck).toMatchObject({ amountCents: 2200, originalCents: 4700, promo: { code: 'BLACKFRIDAY', priceCents: 2200 } });
    expect(p1.pref.external_reference).toBe(`mckbot|${orgId}|MCKBOT|MENSAL|p=2200`);
    expect(p1.pref.items[0].title).toContain('BLACKFRIDAY');
    expect(p1.wh).toMatchObject({ renewed: true });
    const st2 = (await c.get('/api/billing/status')).body;
    expect(st2.plans.find((p: any) => p.id === 'MCKBOT').introOffer).toBeUndefined();
    const p2 = await payCheckout(c, 'MCKBOT', 'MENSAL');
    expect(p2.ck.amountCents).toBe(4700);
    expect(p2.ck.promo).toBeUndefined();
    const c2 = await registerClient();
    const a = await c2.post('/api/billing/checkout', { product: 'COMBO', cycle: 'ANUAL' });
    expect(a.body.amountCents).toBe(97000);
  });

  it('uso só conta com pagamento confirmado: dois checkouts promocionais, o 2º pagamento é recusado', async () => {
    const c = await registerClient();
    await c.post('/api/billing/checkout', { product: 'COMBO', cycle: 'MENSAL' });
    const pref1 = mp.prefs[mp.prefs.length - 1];
    await c.post('/api/billing/checkout', { product: 'COMBO', cycle: 'MENSAL' });
    const pref2 = mp.prefs[mp.prefs.length - 1];
    expect(pref1.items[0].unit_price).toBe(58);
    expect(pref2.items[0].unit_price).toBe(58);
    const w1 = (await webhook(newPay({ status: 'approved', external_reference: pref1.external_reference, transaction_amount: 58 }))).body;
    expect(w1).toMatchObject({ renewed: true });
    const w2 = (await webhook(newPay({ status: 'approved', external_reference: pref2.external_reference, transaction_amount: 58 }))).body;
    expect(w2).toMatchObject({ renewed: false, reason: 'promocao_esgotada' });
  });

  it('promoção com preço igual ao antigo não passa duas vezes pela folga do reajuste', async () => {
    const c = await registerClient();
    await c.post('/api/billing/checkout', { product: 'MCKBOT', cycle: 'MENSAL' });
    const pref1 = mp.prefs[mp.prefs.length - 1];
    await c.post('/api/billing/checkout', { product: 'MCKBOT', cycle: 'MENSAL' });
    const pref2 = mp.prefs[mp.prefs.length - 1];
    expect((await webhook(newPay({ status: 'approved', external_reference: pref1.external_reference, transaction_amount: 22 }))).body).toMatchObject({ renewed: true });
    expect((await webhook(newPay({ status: 'approved', external_reference: pref2.external_reference, transaction_amount: 22 }))).body).toMatchObject({ renewed: false, reason: 'promocao_esgotada' });
  });

  it('checkout aberto antes do reajuste (sem marca) e pago logo depois: aceita o preço antigo', async () => {
    const c = await registerClient();
    const id = newPay({ status: 'approved', external_reference: `mckbot|${c.me.org.id}|MCKMENSAGEM|ANUAL`, transaction_amount: 160 });
    expect((await webhook(id)).body).toMatchObject({ renewed: true });
  });

  it('quem já pagava antes do reajuste mantém o preço antigo (e a promoção de entrada antiga) e não pega a Black Friday', async () => {
    const c = await registerClient();
    const orgId = c.me.org.id;
    const antes = new Date(Date.now() - 86400_000);
    await prisma.platformSettings.update({ where: { id: 'default' }, data: { legacyAte: new Date() } as any });
    await prisma.billingEvent.create({ data: { orgId, product: 'COMBO', kind: 'MP', cycle: 'MENSAL', amountCents: 5800, mpPaymentId: 'legado-' + orgId, introOffer: true, createdAt: antes } });
    const st = (await c.get('/api/billing/status')).body;
    expect(st.precoAntigoGarantido).toBe(true);
    expect(st.prices.MCKBOT).toEqual({ MENSAL: 2200, ANUAL: 22000 });
    const combo = await payCheckout(c, 'COMBO', 'MENSAL');
    expect(combo.ck).toMatchObject({ amountCents: 5800, introOffer: { month: 2 } }); // 2º mês da promoção antiga
    expect(combo.wh).toMatchObject({ renewed: true });
    const combo3 = await payCheckout(c, 'COMBO', 'MENSAL');
    expect(combo3.ck.amountCents).toBe(10000); // depois, R$ 100 (preço antigo dele)
    const bot = await c.post('/api/billing/checkout', { product: 'MCKBOT', cycle: 'MENSAL' });
    expect(bot.body.amountCents).toBe(2200);
    expect(bot.body.promo).toBeUndefined();
  });

  it('depois do prazo a promoção some sozinha (vitrine, status e checkout)', async () => {
    await bf(PASSADO());
    const pub = (await request(app).get('/api/public/plans')).body;
    expect(pub.promo).toBeNull();
    expect(pub.plans.find((p: any) => p.id === 'MCKBOT').introOffer).toBeUndefined();
    const c = await registerClient();
    const ck = await c.post('/api/billing/checkout', { product: 'MCKMENSAGEM', cycle: 'MENSAL' });
    expect(ck.body.amountCents).toBe(2900);
    expect((await livePricesText())).toContain('Não há promoção valendo agora');
    await bf(FUTURO());
  });

  it('Master: lê e salva a promoção; ligar sem data é recusado', async () => {
    const g = await admin.get('/api/master/settings');
    expect(g.body.promo).toMatchObject({ enabled: true, codigo: 'BLACKFRIDAY' });
    expect(g.body.promoValendo).toBe(true);
    expect(g.body.legacy.prices.MCKBOT.MENSAL).toBe(2200);
    const bad = await admin.put('/api/master/settings', { promo: { enabled: true, ate: null } });
    expect(bad.status).toBe(400);
    const off = await admin.put('/api/master/settings', { promo: { enabled: false } });
    expect(off.status).toBe(200);
    expect((await request(app).get('/api/public/plans')).body.promo).toBeNull();
    await bf(FUTURO());
  });
});
