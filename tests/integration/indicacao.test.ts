import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { app, registerClient, loginClient, Client, installGraphMock, graph, prisma, uniq, createTestChannel } from '../helpers.js';
import { getSettings, updateSettings } from '../../server/billing/service.js';
import { outbox } from '../../server/lib/mailer.js';
import { flushReferralNotifies, registerReferral, getOrCreateReferralCode } from '../../server/billing/referrals.js';

/** Programa "Indique e ganhe" (aprovado pelo dono em 05/11/2026). */
type Pay = { id: string; status: string; external_reference: string; transaction_amount: number; currency_id?: string };
const mp = { payments: new Map<string, Pay>() };
let payId = 8800000;
const newPay = (p: Omit<Pay, 'id'>) => { const id = String(++payId); mp.payments.set(id, { id, currency_id: 'BRL', ...p }); return id; };
const webhook = (id: string) => request(app).post(`/api/billing/mp/webhook?data.id=${id}&type=payment`).set('content-type', 'application/json').send({ type: 'payment', data: { id } });
const DAY = 24 * 60 * 60 * 1000;
const AVISO = '5511955557001';

async function subsOf(orgId: string) {
  const s = await prisma.subscription.findMany({ where: { orgId } });
  return Object.fromEntries(s.map((x) => [x.product, x.validUntil.getTime()]));
}

describe('Indique e ganhe', () => {
  let admin: Client;
  let a: Client & { signup: any }; // quem indica
  let b: Client & { signup: any }; // indicada
  let code: string;
  let prices: Awaited<ReturnType<typeof getSettings>>['prices'];

  beforeAll(async () => {
    installGraphMock();
    process.env.MP_ACCESS_TOKEN = 'TEST-token-mp';
    await updateSettings({ mpWebhookSecret: null });
    const prev = graph.other;
    graph.other = async (url, init) => {
      const m = url.match(/^https:\/\/api\.mercadopago\.com\/v1\/payments\/(\d+)$/);
      if (m) { const p = mp.payments.get(m[1]); return p ? new Response(JSON.stringify(p), { status: 200 }) : new Response('{"message":"not found"}', { status: 404 }); }
      return prev ? prev(url, init) : null;
    };
    const email = `${uniq('indmaster')}@teste.dev`;
    const first = await registerClient({ email });
    await prisma.user.update({ where: { id: first.me.user.id }, data: { isSuperAdmin: true } });
    admin = (await loginClient(email, 'senhaSegura123')).c;
    a = await registerClient();
    prices = (await getSettings()).prices;
  });
  afterAll(() => { delete process.env.MP_ACCESS_TOKEN; graph.other = null; });

  it('cada organização tem link próprio /cadastro?indica=CODIGO (estável) e contagem zerada', async () => {
    const r = await a.get('/api/indicacao');
    expect(r.status).toBe(200);
    expect(r.body.code).toMatch(/^[A-Z2-9]{8}$/);
    expect(r.body.link).toMatch(new RegExp(`/cadastro\\?indica=${r.body.code}$`));
    expect(r.body).toMatchObject({ indicados: 0, mesesGanhos: 0, aguardando: 0, rewardDays: 30 });
    code = r.body.code;
    expect((await a.get('/api/indicacao')).body.code).toBe(code);
    expect((await request(app).get('/api/indicacao')).status).toBe(401);
  });

  it('código público: só diz se existe', async () => {
    expect((await request(app).get(`/api/public/indica/${code.toLowerCase()}`)).body).toEqual({ valid: true, rewardDays: 30 });
    expect((await request(app).get('/api/public/indica/NAOEXISTE9')).body.valid).toBe(false);
    expect((await request(app).get('/api/public/indica/<x>')).body.valid).toBe(false);
  });

  it('cadastro pelo link grava a indicação como pendente; código inválido é ignorado', async () => {
    b = await registerClient({ indica: code });
    const ref = await prisma.referral.findUnique({ where: { referredOrgId: b.me.org.id } });
    expect(ref).toMatchObject({ referrerOrgId: a.me.org.id, status: 'PENDENTE', code });
    const x = await registerClient({ indica: 'ZZZZZZZZ' });
    expect(await prisma.referral.count({ where: { referredOrgId: x.me.org.id } })).toBe(0);
    const s = (await a.get('/api/indicacao')).body;
    expect(s).toMatchObject({ indicados: 1, aguardando: 1, mesesGanhos: 0 });
    expect(s.items[0].empresa).toBe(b.signup.orgName);
  });

  it('autoindicação (mesma organização) é recusada; uma indicação só por organização', async () => {
    const self = await registerReferral(a.me.org.id, code, { email: a.signup.email });
    expect(self).toMatchObject({ status: 'RECUSADO', reason: 'autoindicacao' });
    expect(await registerReferral(b.me.org.id, code, {})).toBeNull(); // b já tem indicação
  });

  it('pagamento pendente não credita; aprovado credita 30 dias uma única vez e avisa por WhatsApp e e-mail', async () => {
    await prisma.organization.update({ where: { id: a.me.org.id }, data: { handoffNotifyPhones: JSON.stringify([`+${AVISO}`]) } });
    await createTestChannel(a.me.org.id);
    await a.get('/api/billing/status'); // garante as assinaturas (teste) de quem indica
    const before = await subsOf(a.me.org.id);
    const refB = `mckbot|${b.me.org.id}|MCKBOT|MENSAL`;
    const pend = newPay({ status: 'pending', external_reference: refB, transaction_amount: prices.MCKBOT.MENSAL / 100 });
    await webhook(pend);
    expect((await prisma.referral.findUnique({ where: { referredOrgId: b.me.org.id } }))!.status).toBe('PENDENTE');
    const outboxBefore = outbox.length;
    const ok = newPay({ status: 'approved', external_reference: refB, transaction_amount: prices.MCKBOT.MENSAL / 100 });
    expect((await webhook(ok)).body.renewed).toBe(true);
    await webhook(ok); // aviso repetido
    await flushReferralNotifies();
    const ref = await prisma.referral.findUnique({ where: { referredOrgId: b.me.org.id } });
    expect(ref).toMatchObject({ status: 'CREDITADO', mpPaymentId: ok });
    expect(ref!.notifiedAt).toBeTruthy();
    const after = await subsOf(a.me.org.id);
    // Só teste (nenhum produto pago): os dois produtos ganham 30 dias.
    for (const p of ['MCKBOT', 'MCKMENSAGEM']) expect(after[p] - before[p]).toBe(30 * DAY);
    expect(await prisma.billingEvent.count({ where: { orgId: a.me.org.id, kind: 'INDICACAO' } })).toBe(1);
    // Segundo pagamento da indicada: não credita de novo.
    const ok2 = newPay({ status: 'approved', external_reference: refB, transaction_amount: prices.MCKBOT.MENSAL / 100 });
    await webhook(ok2);
    await flushReferralNotifies();
    expect(await subsOf(a.me.org.id)).toEqual(after);
    // Aviso: WhatsApp para o número de aviso e e-mail para o Proprietário.
    const wa = graph.calls.filter((c) => c.body?.to === AVISO).map((c) => String(c.body.text?.body ?? ''));
    expect(wa.filter((t) => t.includes('1 mês grátis'))).toHaveLength(1);
    expect(wa.find((t) => t.includes('1 mês grátis'))).toContain(`/cadastro?indica=${code}`);
    const mails = outbox.slice(outboxBefore).filter((m) => m.kind === 'referral_reward');
    expect(mails).toHaveLength(1);
    expect(mails[0].to).toBe(a.signup.email);
    expect(mails[0].text).toContain(b.signup.orgName);
    const s = (await a.get('/api/indicacao')).body;
    expect(s).toMatchObject({ indicados: 1, mesesGanhos: 1, diasGanhos: 30, aguardando: 0 });
  });

  it('quem já paga ganha os 30 dias só no produto pago; estorno do pagamento retira o crédito', async () => {
    const c = await registerClient();
    const refC = `mckbot|${c.me.org.id}|MCKMENSAGEM|MENSAL`;
    await webhook(newPay({ status: 'approved', external_reference: refC, transaction_amount: prices.MCKMENSAGEM.MENSAL / 100 }));
    const d = await registerClient({ indica: (await c.get('/api/indicacao')).body.code });
    const before = await subsOf(c.me.org.id);
    const pay = newPay({ status: 'approved', external_reference: `mckbot|${d.me.org.id}|COMBO|MENSAL`, transaction_amount: prices.COMBO.MENSAL / 100 });
    await webhook(pay);
    await flushReferralNotifies();
    const mid = await subsOf(c.me.org.id);
    expect(mid.MCKMENSAGEM - before.MCKMENSAGEM).toBe(30 * DAY);
    expect(mid.MCKBOT).toBe(before.MCKBOT);
    mp.payments.get(pay)!.status = 'refunded';
    await webhook(pay);
    expect((await prisma.referral.findUnique({ where: { referredOrgId: d.me.org.id } }))!.status).toBe('ESTORNADO');
    expect((await subsOf(c.me.org.id)).MCKMENSAGEM).toBe(before.MCKMENSAGEM);
  });

  it('pessoa em comum entre as duas organizações (autoindicação descoberta depois) não ganha', async () => {
    const e = await registerClient();
    const f = await registerClient({ indica: await getOrCreateReferralCode(e.me.org.id) });
    // O dono de "e" vira membro de "f" (mesma pessoa nas duas empresas).
    await prisma.membership.create({ data: { userId: e.me.user.id, orgId: f.me.org.id, role: 'ADMIN' } });
    await e.get('/api/billing/status');
    const before = await subsOf(e.me.org.id);
    await webhook(newPay({ status: 'approved', external_reference: `mckbot|${f.me.org.id}|MCKBOT|MENSAL`, transaction_amount: prices.MCKBOT.MENSAL / 100 }));
    expect(await prisma.referral.findUnique({ where: { referredOrgId: f.me.org.id } })).toMatchObject({ status: 'RECUSADO', reason: 'autoindicacao' });
    expect(await subsOf(e.me.org.id)).toEqual(before);
  });

  it('Painel Master lista as indicações (só superadmin)', async () => {
    expect((await a.get('/api/master/indicacoes')).status).toBe(403);
    const r = await admin.get('/api/master/indicacoes');
    expect(r.status).toBe(200);
    const row = r.body.items.find((i: any) => i.referredOrgId === b.me.org.id);
    expect(row).toMatchObject({ referrerName: a.signup.orgName, referredName: b.signup.orgName, status: 'CREDITADO', rewardDays: 30 });
    expect(r.body.totals.creditadas).toBeGreaterThanOrEqual(1);
    expect(r.body.totals.recusadas).toBeGreaterThanOrEqual(1);
  });

  it('cupom "só no primeiro pagamento": vale para quem nunca pagou, recusado para quem já pagou', async () => {
    const CODE = uniq('PARC').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 20);
    const cr = await admin.post('/api/master/coupons', { code: CODE, partner: 'Contadores', type: 'PERCENT', value: 20, product: 'ALL', cycles: 'MENSAL', firstPaymentOnly: true });
    expect(cr.status).toBe(201);
    expect(cr.body.firstPaymentOnly).toBe(true);
    const ok = await a.post('/api/billing/coupon', { code: CODE }); // "a" nunca pagou
    expect(ok.status).toBe(200);
    expect(ok.body.coupon.firstPaymentOnly).toBe(true);
    expect(ok.body.quotes.MCKBOT.MENSAL.finalCents).toBe(prices.MCKBOT.MENSAL - Math.round(prices.MCKBOT.MENSAL * 0.2));
    expect(ok.body.quotes.MCKBOT.ANUAL).toBeUndefined();
    const no = await b.post('/api/billing/coupon', { code: CODE }); // "b" já pagou
    expect(no.status).toBe(400);
    expect(no.body.reason).toBe('primeiro');
    expect((await b.post('/api/billing/checkout', { product: 'MCKBOT', cycle: 'MENSAL', coupon: CODE })).status).toBe(400);
  });

  it('cupom só anual, com limite de usos e validade (ex.: FUNDADOR50)', async () => {
    const CODE = uniq('FUND').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 20);
    const cr = await admin.post('/api/master/coupons', { code: CODE, type: 'PERCENT', value: 50, product: 'ALL', cycles: 'ANUAL', maxUses: 10, validUntil: '2099-11-30' });
    expect(cr.status).toBe(201);
    expect(cr.body).toMatchObject({ cycles: 'ANUAL', maxUses: 10, value: 50 });
    const q = await a.post('/api/billing/coupon', { code: CODE });
    expect(q.status).toBe(200);
    for (const p of ['MCKBOT', 'MCKMENSAGEM', 'COMBO'] as const) {
      expect(q.body.quotes[p].ANUAL.finalCents).toBe(prices[p].ANUAL - Math.round(prices[p].ANUAL * 0.5));
      expect(q.body.quotes[p].MENSAL).toBeUndefined();
    }
    expect((await a.post('/api/billing/checkout', { product: 'COMBO', cycle: 'MENSAL', coupon: CODE })).status).toBe(400);
  });
});
