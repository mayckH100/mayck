import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { app, registerClient, loginClient, Client, installGraphMock, graph, prisma, uniq } from '../helpers.js';
import { getSettings, updateSettings } from '../../server/billing/service.js';
import { updateSiteSettings, DEFAULT_SITE } from '../../server/lib/site-settings.js';

type Pay = { id: string; status: string; external_reference: string; transaction_amount: number; currency_id?: string };
const mp = { prefs: [] as any[], payments: new Map<string, Pay>() };
let payId = 7700000;
const newPay = (p: Omit<Pay, 'id'>) => { const id = String(++payId); mp.payments.set(id, { id, currency_id: 'BRL', ...p }); return id; };
const webhook = (id: string) => request(app).post(`/api/billing/mp/webhook?data.id=${id}&type=payment`).set('content-type', 'application/json').send({ type: 'payment', data: { id } });
const PASS = 'senhaSegura123';

describe('Cupons de desconto e site oficial', () => {
  let admin: Client;
  let owner: Client;
  let orgId: string;
  let prices: Awaited<ReturnType<typeof getSettings>>['prices'];
  const CODE = uniq('INFLU').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 20);

  beforeAll(async () => {
    installGraphMock();
    process.env.MP_ACCESS_TOKEN = 'TEST-token-mp';
    await updateSettings({ mpWebhookSecret: null });
    graph.other = async (url, init) => {
      if (url === 'https://api.mercadopago.com/checkout/preferences' && init?.method === 'POST') {
        mp.prefs.push(JSON.parse(String(init.body)));
        return new Response(JSON.stringify({ id: 'pref-c' + mp.prefs.length, init_point: 'https://www.mercadopago.com.br/checkout/v1/redirect?pref_id=c' + mp.prefs.length }), { status: 201 });
      }
      const m = url.match(/^https:\/\/api\.mercadopago\.com\/v1\/payments\/(\d+)$/);
      if (m) { const p = mp.payments.get(m[1]); return p ? new Response(JSON.stringify(p), { status: 200 }) : new Response('{"message":"not found"}', { status: 404 }); }
      return null;
    };
    const email = `${uniq('cupmaster')}@teste.dev`;
    const first = await registerClient({ email });
    await prisma.user.update({ where: { id: first.me.user.id }, data: { isSuperAdmin: true } });
    admin = (await loginClient(email, PASS)).c;
    owner = await registerClient();
    orgId = owner.me.org.id;
    prices = (await getSettings()).prices;
  });
  afterAll(async () => {
    delete process.env.MP_ACCESS_TOKEN;
    graph.other = null;
    await updateSiteSettings({ ...DEFAULT_SITE });
  });

  let couponId: string;

  it('Master: só superadmin gerencia cupons; cria com código em maiúsculas e audita', async () => {
    expect((await owner.get('/api/master/coupons')).status).toBe(403);
    expect((await owner.post('/api/master/coupons', { code: 'X1X', type: 'PERCENT', value: 10, product: 'ALL' })).status).toBe(403);
    const r = await admin.post('/api/master/coupons', { code: CODE.toLowerCase(), partner: 'Influenciadora Teste', type: 'PERCENT', value: 10, product: 'ALL', cycles: 'ALL', validUntil: null, maxUses: 2, active: true });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ code: CODE, partner: 'Influenciadora Teste', type: 'PERCENT', value: 10, uses: 0, state: 'ATIVO', deletable: true });
    couponId = r.body.id;
    expect((await admin.post('/api/master/coupons', { code: CODE, type: 'PERCENT', value: 5, product: 'ALL' })).status).toBe(409);
    expect((await admin.post('/api/master/coupons', { code: 'PCT100', type: 'PERCENT', value: 100, product: 'ALL' })).status).toBe(400);
    expect((await admin.post('/api/master/coupons', { code: 'a b', type: 'FIXED', value: 100, product: 'ALL' })).status).toBe(400);
    const log = await prisma.auditLog.findFirst({ where: { action: 'master.coupon.create', entityId: couponId } });
    expect(log).toBeTruthy();
    const list = await admin.get('/api/master/coupons');
    expect(list.body.items.some((c: any) => c.code === CODE)).toBe(true);
  });

  it('cliente valida o cupom: preço original, desconto e final calculados no servidor', async () => {
    const r = await owner.post('/api/billing/coupon', { code: ` ${CODE.toLowerCase()} ` });
    expect(r.status).toBe(200);
    expect(r.body.coupon).toMatchObject({ code: CODE, type: 'PERCENT', value: 10 });
    expect(r.body.coupon.partner).toBeUndefined();
    const q = r.body.quotes.MCKBOT.MENSAL;
    const d = Math.round(prices.MCKBOT.MENSAL * 0.1);
    expect(q).toEqual({ originalCents: prices.MCKBOT.MENSAL, discountCents: d, finalCents: prices.MCKBOT.MENSAL - d });
    expect(r.body.quotes.COMBO.ANUAL.finalCents).toBe(prices.COMBO.ANUAL - Math.round(prices.COMBO.ANUAL * 0.1));
    const bad = await owner.post('/api/billing/coupon', { code: 'NAOEXISTE123' });
    expect(bad.status).toBe(404);
    expect(bad.body.error).toMatch(/não encontrado/);
  });

  it('checkout com cupom manda o valor com desconto ao Mercado Pago (ignora preço do cliente)', async () => {
    const r = await owner.post('/api/billing/checkout', { product: 'MCKBOT', cycle: 'MENSAL', coupon: CODE, amountCents: 1, price: 1 });
    expect(r.status).toBe(200);
    const d = Math.round(prices.MCKBOT.MENSAL * 0.1);
    expect(r.body).toMatchObject({ amountCents: prices.MCKBOT.MENSAL - d, coupon: CODE, discountCents: d, originalCents: prices.MCKBOT.MENSAL });
    const pref = mp.prefs[mp.prefs.length - 1];
    expect(pref.items[0].unit_price).toBe((prices.MCKBOT.MENSAL - d) / 100);
    expect(pref.external_reference).toBe(`mckbot|${orgId}|MCKBOT|MENSAL|c=${couponId}:${d}`);
    expect(pref.items[0].title).toContain(CODE);
    expect((await owner.post('/api/billing/checkout', { product: 'MCKBOT', cycle: 'MENSAL', coupon: 'NAOEXISTE123' })).status).toBe(400);
    // Sem cupom continua igual.
    const plain = await owner.post('/api/billing/checkout', { product: 'MCKBOT', cycle: 'MENSAL' });
    expect(plain.body.amountCents).toBe(prices.MCKBOT.MENSAL);
  });

  it('uso só conta com pagamento confirmado; aviso repetido não conta duas vezes; limite e estorno', async () => {
    const d = Math.round(prices.MCKBOT.MENSAL * 0.1);
    const ref = `mckbot|${orgId}|MCKBOT|MENSAL|c=${couponId}:${d}`;
    const final = (prices.MCKBOT.MENSAL - d) / 100;
    // Pendente: não conta.
    const pend = newPay({ status: 'pending', external_reference: ref, transaction_amount: final });
    await webhook(pend);
    expect(await prisma.couponRedemption.count({ where: { couponId } })).toBe(0);
    // Valor abaixo do preço com desconto: não renova nem conta.
    const low = newPay({ status: 'approved', external_reference: ref, transaction_amount: final - 1 });
    expect((await webhook(low)).body.reason).toBe('valor_divergente');
    // Aprovado: renova e conta 1 uso.
    const ok1 = newPay({ status: 'approved', external_reference: ref, transaction_amount: final });
    expect((await webhook(ok1)).body.renewed).toBe(true);
    await webhook(ok1);
    const red = await prisma.couponRedemption.findMany({ where: { couponId } });
    expect(red).toHaveLength(1);
    expect(red[0]).toMatchObject({ orgId, product: 'MCKBOT', cycle: 'MENSAL', originalCents: prices.MCKBOT.MENSAL, discountCents: d, finalCents: prices.MCKBOT.MENSAL - d, status: 'CONFIRMADO' });
    // Segundo uso → atinge o limite (2).
    const ok2 = newPay({ status: 'approved', external_reference: ref, transaction_amount: final });
    expect((await webhook(ok2)).body.renewed).toBe(true);
    const lim = await owner.post('/api/billing/coupon', { code: CODE });
    expect(lim.status).toBe(400);
    expect(lim.body.reason).toBe('esgotado');
    expect((await owner.post('/api/billing/checkout', { product: 'MCKBOT', cycle: 'MENSAL', coupon: CODE })).status).toBe(400);
    // Master vê usos, receita e descontos; cupom usado não pode ser excluído.
    let row = (await admin.get('/api/master/coupons')).body.items.find((c: any) => c.id === couponId);
    expect(row).toMatchObject({ uses: 2, revenueCents: 2 * (prices.MCKBOT.MENSAL - d), discountCents: 2 * d, state: 'ESGOTADO', deletable: false });
    expect((await admin.del(`/api/master/coupons/${couponId}`)).status).toBe(409);
    // Estorno: deixa de contar e o cupom volta a ter uso disponível.
    mp.payments.get(ok2)!.status = 'refunded';
    await webhook(ok2);
    row = (await admin.get('/api/master/coupons')).body.items.find((c: any) => c.id === couponId);
    expect(row).toMatchObject({ uses: 1, state: 'ATIVO' });
    expect((await owner.post('/api/billing/coupon', { code: CODE })).status).toBe(200);
  });

  it('Master: editar, desativar/ativar (auditado); código de cupom usado não muda', async () => {
    const body = { code: CODE, partner: 'Empresa Parceira', type: 'FIXED', value: 1000, product: 'COMBO', cycles: 'ANUAL', validUntil: '2099-12-31', maxUses: null, active: true };
    const e = await admin.put(`/api/master/coupons/${couponId}`, body);
    expect(e.status).toBe(200);
    expect(e.body).toMatchObject({ partner: 'Empresa Parceira', type: 'FIXED', value: 1000, product: 'COMBO', cycles: 'ANUAL', maxUses: null });
    expect(e.body.validUntil).toBe(new Date('2099-12-31T23:59:59-03:00').toISOString());
    expect((await admin.put(`/api/master/coupons/${couponId}`, { ...body, code: 'OUTROCODIGO' })).status).toBe(409);
    expect(await prisma.auditLog.count({ where: { action: 'master.coupon.update', entityId: couponId } })).toBe(1);
    // Agora só vale para o combo anual.
    const v = await owner.post('/api/billing/coupon', { code: CODE });
    expect(Object.keys(v.body.quotes)).toEqual(['COMBO']);
    expect(v.body.quotes.COMBO).toEqual({ ANUAL: { originalCents: prices.COMBO.ANUAL, discountCents: 1000, finalCents: prices.COMBO.ANUAL - 1000 } });
    const wrong = await owner.post('/api/billing/checkout', { product: 'MCKBOT', cycle: 'MENSAL', coupon: CODE });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error).toMatch(/não vale para o plano/);
    // Desativar.
    expect((await admin.post(`/api/master/coupons/${couponId}/active`, { active: false })).body.state).toBe('INATIVO');
    expect((await owner.post('/api/billing/coupon', { code: CODE })).body.reason).toBe('inativo');
    expect((await admin.post(`/api/master/coupons/${couponId}/active`, { active: true })).body.state).toBe('ATIVO');
    expect(await prisma.auditLog.count({ where: { action: { in: ['master.coupon.activate', 'master.coupon.deactivate'] }, entityId: couponId } })).toBe(2);
  });

  it('cupom expirado é recusado; cupom nunca usado pode ser excluído', async () => {
    const code = 'VENCIDO' + Date.now().toString(36).toUpperCase();
    const c = await admin.post('/api/master/coupons', { code, type: 'PERCENT', value: 5, product: 'ALL', validUntil: '2020-01-01' });
    expect(c.status).toBe(201);
    expect(c.body.state).toBe('EXPIRADO');
    expect((await owner.post('/api/billing/coupon', { code })).body.reason).toBe('expirado');
    expect((await admin.del(`/api/master/coupons/${c.body.id}`)).status).toBe(200);
    expect(await prisma.coupon.findUnique({ where: { code } })).toBeNull();
  });

  it('pagamento com cupom já desativado depois do checkout é honrado', async () => {
    await admin.post(`/api/master/coupons/${couponId}/active`, { active: false });
    const ref = `mckbot|${orgId}|COMBO|ANUAL|c=${couponId}:1000`;
    const id = newPay({ status: 'approved', external_reference: ref, transaction_amount: (prices.COMBO.ANUAL - 1000) / 100 });
    expect((await webhook(id)).body.renewed).toBe(true);
    expect(await prisma.couponRedemption.count({ where: { mpPaymentId: id } })).toBe(1);
    await admin.post(`/api/master/coupons/${couponId}/active`, { active: true });
  });

  it('site oficial: Master edita; API pública com padrões, promoção só com cupom válido', async () => {
    const pub0 = await request(app).get('/api/public/site');
    expect(pub0.status).toBe(200);
    expect(pub0.body).toMatchObject({ contactEmail: 'mckdevbr@gmail.com', facebookUrl: 'https://www.facebook.com/profile.php?id=61596189174050', tutorialsPublic: false, whatsapp: null, promo: null });
    expect((await owner.put('/api/master/site', { contactEmail: 'x@y.com' })).status).toBe(403);
    expect((await admin.put('/api/master/site', { promoCoupon: 'NAOEXISTE123' })).status).toBe(400);
    expect((await admin.put('/api/master/site', { facebookUrl: 'https://evil.example.com/' })).status).toBe(400);
    const r = await admin.put('/api/master/site', { contactEmail: 'contato@mck.dev', whatsapp: '+55 (11) 99999-0000', promoCoupon: CODE.toLowerCase(), promoText: 'Desconto de parceiro' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ contactEmail: 'contato@mck.dev', whatsapp: '5511999990000', promoCoupon: CODE });
    expect(await prisma.auditLog.count({ where: { action: 'master.site.update' } })).toBeGreaterThan(0);
    const pub = await request(app).get('/api/public/site');
    expect(pub.body).toMatchObject({ contactEmail: 'contato@mck.dev', whatsapp: '5511999990000', whatsappUrl: 'https://wa.me/5511999990000', promo: { code: CODE, text: 'Desconto de parceiro' } });
    // Cupom desativado: a faixa some.
    await admin.post(`/api/master/coupons/${couponId}/active`, { active: false });
    expect((await request(app).get('/api/public/site')).body.promo).toBeNull();
    await admin.post(`/api/master/coupons/${couponId}/active`, { active: true });
  });

  it('tutoriais completos no site: fechados por padrão, abertos quando o Master liga', async () => {
    await admin.put('/api/master/site', { tutorialsPublic: false });
    expect((await request(app).get('/api/public/site/tutorials/mckbot/video')).status).toBe(403);
    expect((await request(app).get('/api/public/site/tutorials/xpto/video')).status).toBe(404);
    await admin.put('/api/master/site', { tutorialsPublic: true });
    const site = await request(app).get('/api/public/site');
    expect(site.body.tutorialsPublic).toBe(true);
    expect(site.body.tutorials.map((t: any) => t.app).sort()).toEqual(['mck-mensagens', 'mckbot']);
    const v = await request(app).get('/api/public/site/tutorials/mckbot/video').set('Range', 'bytes=0-99');
    expect(v.status).toBe(206);
    expect(v.headers['content-type']).toBe('video/mp4');
    expect((await request(app).get('/api/public/site/tutorials/mck-mensagens/captions.vtt')).status).toBe(200);
    await admin.put('/api/master/site', { tutorialsPublic: false });
  });
});
