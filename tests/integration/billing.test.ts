import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { app, registerClient, Client, createTestChannel, installGraphMock, graph, sendInbound, prisma } from '../helpers.js';
import { hmacSha256Hex } from '../../server/lib/crypto.js';
import { block, unblock, isProductActive, renew, updateSettings, effectiveStatus } from '../../server/billing/service.js';
import { verifySignature, buildManifest } from '../../server/billing/mercadopago.js';
import { sendOutbound } from '../../server/whatsapp/messaging.js';
import { tick, resetDispatcherState, setRandom } from '../../server/mckmensagem/dispatcher.js';

// ---------- Mercado Pago simulado ----------
type Pay = { id: string; status: string; external_reference: string; transaction_amount: number; currency_id?: string };
const mp = { prefs: [] as any[], payments: new Map<string, Pay>(), gets: 0 };
let payId = 900000;
const newPay = (p: Omit<Pay, 'id'>) => { const id = String(++payId); mp.payments.set(id, { id, currency_id: 'BRL', ...p }); return id; };

const DAY = 86400000;
const SECRET = 'segredo-webhook-mp';

function webhook(id: string, opts: { sign?: boolean | 'bad'; requestId?: string } = {}) {
  const ts = String(Math.floor(Date.now() / 1000));
  const requestId = opts.requestId ?? 'req-' + id;
  const r = request(app).post(`/api/billing/mp/webhook?data.id=${id}&type=payment`).set('content-type', 'application/json').set('x-request-id', requestId);
  if (opts.sign) {
    const v1 = opts.sign === 'bad' ? 'deadbeef' : hmacSha256Hex(SECRET, buildManifest(id, requestId, ts));
    r.set('x-signature', `ts=${ts},v1=${v1}`);
  }
  return r.send({ type: 'payment', action: 'payment.updated', data: { id } });
}

describe('Cobrança Mercado Pago por produto', () => {
  let owner: Client;
  let orgId: string;

  beforeAll(async () => {
    installGraphMock();
    process.env.MP_ACCESS_TOKEN = 'TEST-token-mp';
    graph.other = async (url, init) => {
      if (url === 'https://api.mercadopago.com/checkout/preferences' && init?.method === 'POST') {
        const body = JSON.parse(String(init.body));
        mp.prefs.push({ body, headers: init.headers });
        return new Response(JSON.stringify({ id: 'pref-' + mp.prefs.length, init_point: 'https://www.mercadopago.com.br/checkout/v1/redirect?pref_id=pref-' + mp.prefs.length }), { status: 201 });
      }
      const m = url.match(/^https:\/\/api\.mercadopago\.com\/v1\/payments\/(\d+)$/);
      if (m) {
        mp.gets++;
        const p = mp.payments.get(m[1]);
        return p ? new Response(JSON.stringify(p), { status: 200 }) : new Response(JSON.stringify({ message: 'not found' }), { status: 404 });
      }
      return null;
    };
    owner = await registerClient();
    orgId = owner.me.org.id;
  });
  afterAll(async () => {
    delete process.env.MP_ACCESS_TOKEN;
    graph.other = null;
    await updateSettings({ mpWebhookSecret: null });
  });
  beforeEach(async () => {
    mp.prefs = [];
    await updateSettings({ mpWebhookSecret: null });
  });

  it('status: cria TRIAL sob demanda para cada produto e expõe preços', async () => {
    const r = await owner.get('/api/billing/status');
    expect(r.status).toBe(200);
    expect(r.body.configured).toBe(true);
    expect(r.body.subscriptions.map((s: any) => [s.product, s.status, s.active])).toEqual([['MCKBOT', 'TRIAL', true], ['MCKMENSAGEM', 'TRIAL', true]]);
    expect(r.body.prices.MCKBOT.MENSAL).toBe(3990);
    expect(r.body.prices.COMBO.ANUAL).toBeGreaterThan(0);
    const plans = await owner.get('/api/plans');
    expect(plans.body.billingConfigured).toBe(true);
  });

  it('checkout gera preferência com referência, notification_url e back_urls', async () => {
    const r = await owner.post('/api/billing/checkout', { product: 'MCKBOT', cycle: 'MENSAL' });
    expect(r.status).toBe(200);
    expect(r.body.init_point).toMatch(/^https:\/\/www\.mercadopago\.com\.br\//);
    const { body, headers } = mp.prefs[0];
    expect(headers.authorization).toBe('Bearer TEST-token-mp');
    expect(body.external_reference).toBe(`mckbot|${orgId}|MCKBOT|MENSAL`);
    expect(body.items[0]).toMatchObject({ quantity: 1, currency_id: 'BRL', unit_price: 39.9 });
    expect(body.notification_url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/api\/billing\/mp\/webhook$/);
    expect(body.back_urls.success).toMatch(/billing=success/);
    expect(body.auto_return).toBe('approved');
    expect((await owner.post('/api/billing/checkout', { product: 'XPTO', cycle: 'MENSAL' })).status).toBe(400);
    // Pagamento iniciado pelo MCK Mensagens volta para /mensagem/assinatura.
    const m = await owner.post('/api/billing/checkout', { product: 'MCKMENSAGEM', cycle: 'MENSAL', app: 'mensagem' });
    expect(m.status).toBe(200);
    const last = mp.prefs[mp.prefs.length - 1].body;
    expect(last.back_urls.success).toMatch(/\/mensagem\/assinatura\?billing=success$/);
    expect(last.back_urls.failure).toMatch(/\/mensagem\/assinatura\?billing=failure$/);
    expect(body.back_urls.success).not.toContain('/mensagem');
  });

  it('webhook aprovado renova a partir do vencimento; duplicado não renova duas vezes', async () => {
    const before = await prisma.subscription.findUniqueOrThrow({ where: { orgId_product: { orgId, product: 'MCKBOT' } } });
    const id = newPay({ status: 'approved', external_reference: `mckbot|${orgId}|MCKBOT|MENSAL`, transaction_amount: 39.9 });
    const r1 = await webhook(id);
    expect(r1.status).toBe(200);
    expect(r1.body.renewed).toBe(true);
    const after = await prisma.subscription.findUniqueOrThrow({ where: { orgId_product: { orgId, product: 'MCKBOT' } } });
    expect(after.status).toBe('ATIVA');
    expect(after.source).toBe('MP');
    const diffDays = (after.validUntil.getTime() - before.validUntil.getTime()) / DAY;
    expect(diffDays).toBeGreaterThanOrEqual(28);
    expect(diffDays).toBeLessThanOrEqual(31);

    const r2 = await webhook(id);
    expect(r2.status).toBe(200);
    expect(r2.body).toMatchObject({ renewed: false, duplicated: true });
    const again = await prisma.subscription.findUniqueOrThrow({ where: { orgId_product: { orgId, product: 'MCKBOT' } } });
    expect(again.validUntil.getTime()).toBe(after.validUntil.getTime());
    expect(await prisma.billingEvent.count({ where: { mpPaymentId: id } })).toBe(1);
    // MCKMENSAGEM não foi tocado
    expect((await prisma.subscription.findUniqueOrThrow({ where: { orgId_product: { orgId, product: 'MCKMENSAGEM' } } })).status).toBe('TRIAL');
  });

  it('pagamento rejeitado, valor menor ou referência inválida não renovam', async () => {
    const snap = async () => (await prisma.subscription.findUniqueOrThrow({ where: { orgId_product: { orgId, product: 'MCKBOT' } } })).validUntil.getTime();
    const v0 = await snap();
    const rej = newPay({ status: 'rejected', external_reference: `mckbot|${orgId}|MCKBOT|MENSAL`, transaction_amount: 39.9 });
    const low = newPay({ status: 'approved', external_reference: `mckbot|${orgId}|MCKBOT|ANUAL`, transaction_amount: 39.9 });
    const bad = newPay({ status: 'approved', external_reference: 'outra-coisa', transaction_amount: 999 });
    for (const id of [rej, low, bad]) {
      const r = await webhook(id);
      expect(r.status).toBe(200);
      expect(r.body.renewed).toBe(false);
    }
    expect(await snap()).toBe(v0);
    expect((await webhook('123456789')).status).toBe(200); // inexistente → ignora
  });

  it('com segredo configurado, assinatura inválida ou ausente → 401; válida → processa', async () => {
    await updateSettings({ mpWebhookSecret: SECRET });
    const id = newPay({ status: 'approved', external_reference: `mckbot|${orgId}|MCKMENSAGEM|MENSAL`, transaction_amount: 45 });
    const gets = mp.gets;
    expect((await webhook(id, { sign: 'bad' })).status).toBe(401);
    expect((await webhook(id)).status).toBe(401);
    expect(mp.gets).toBe(gets); // nem consultou o MP
    const ok = await webhook(id, { sign: true });
    expect(ok.status).toBe(200);
    expect(ok.body.renewed).toBe(true);
    // verificação unitária do manifesto (id em minúsculas, partes ausentes omitidas)
    const ts = '1700000000';
    expect(buildManifest('ABC', null, ts)).toBe('id:abc;ts:1700000000;');
    expect(verifySignature({ secret: SECRET, dataId: 'ABC', xSignature: `ts=${ts},v1=${hmacSha256Hex(SECRET, 'id:abc;ts:1700000000;')}` })).toBe(true);
  });

  it('COMBO renova os dois produtos', async () => {
    const c = await registerClient();
    const oid = c.me.org.id;
    await c.get('/api/billing/status');
    const ck = await c.post('/api/billing/checkout', { product: 'COMBO', cycle: 'ANUAL' });
    expect(ck.status).toBe(200);
    expect(mp.prefs.at(-1).body.external_reference).toBe(`mckbot|${oid}|COMBO|ANUAL`);
    const id = newPay({ status: 'approved', external_reference: `mckbot|${oid}|COMBO|ANUAL`, transaction_amount: 699 });
    // confirmação manual pelo retorno (back_url) — mesma validação do webhook
    const r = await c.post('/api/billing/confirm', { paymentId: id });
    expect(r.status).toBe(200);
    expect(r.body.renewed).toBe(true);
    for (const s of r.body.subscriptions) {
      expect(s.status).toBe('ATIVA');
      expect((new Date(s.validUntil).getTime() - Date.now()) / DAY).toBeGreaterThan(365);
    }
    // outra organização não confirma pagamento alheio
    expect((await owner.post('/api/billing/confirm', { paymentId: id })).body).toMatchObject({ renewed: false, reason: 'outra_organizacao' });
    // webhook do mesmo pagamento depois: idempotente
    expect((await webhook(id)).body.duplicated).toBe(true);
  });

  it('status efetivo: vencida e bloqueada', async () => {
    expect(effectiveStatus({ status: 'ATIVA', validUntil: new Date(Date.now() - 1000) })).toBe('VENCIDA');
    expect(effectiveStatus({ status: 'BLOQUEADA', validUntil: new Date(Date.now() + DAY) })).toBe('BLOQUEADA');
    const c = await registerClient();
    const oid = c.me.org.id;
    await renew(oid, 'MCKBOT', 'MENSAL', { source: 'MANUAL' });
    await block(oid, 'MCKBOT');
    expect(await isProductActive(oid, 'MCKBOT')).toBe(false);
    await unblock(oid, 'MCKBOT');
    expect(await isProductActive(oid, 'MCKBOT')).toBe(true);
    await prisma.subscription.update({ where: { orgId_product: { orgId: oid, product: 'MCKBOT' } }, data: { validUntil: new Date(Date.now() - DAY) } });
    expect(await isProductActive(oid, 'MCKBOT')).toBe(false);
  });

  it('bloqueio do MCKBOT pausa envio e automação; mensagem recebida continua gravada', async () => {
    const c = await registerClient();
    const oid = c.me.org.id;
    const ctx = await createTestChannel(oid);
    await prisma.aiSettings.upsert({ where: { orgId: oid }, update: {}, create: { orgId: oid } }).catch(() => null);
    await block(oid, 'MCKBOT');
    graph.reset();
    const { res, id } = await sendInbound(ctx, '5511933330000', 'oi, quero saber o preço');
    expect(res.status).toBe(200);
    expect(await prisma.message.count({ where: { orgId: oid, waMessageId: id } })).toBe(1);
    expect(graph.calls.filter((g) => g.body)).toHaveLength(0);

    const conv = await prisma.conversation.findFirstOrThrow({ where: { orgId: oid } });
    const contact = await prisma.contact.findFirstOrThrow({ where: { orgId: oid } });
    const msg = await sendOutbound({ conversation: conv, contact, payload: { type: 'text', text: 'teste' }, sender: 'agent' });
    expect(msg.status).toBe('FAILED');
    expect(msg.error).toBe('Assinatura inativa');
    expect(graph.calls.filter((g) => g.body)).toHaveLength(0);

    await unblock(oid, 'MCKBOT');
    const ok = await sendOutbound({ conversation: conv, contact, payload: { type: 'text', text: 'teste' }, sender: 'agent' });
    expect(ok.status).not.toBe('FAILED');
  });

  it('MCKMENSAGEM inativo: disparador não envia nem consome destinatários', async () => {
    const c = await registerClient();
    const oid = c.me.org.id;
    const ctx = await createTestChannel(oid);
    setRandom(() => 0);
    resetDispatcherState();
    await prisma.campaign.updateMany({ where: { status: 'EM_ANDAMENTO' }, data: { status: 'PAUSADA' } });
    const camp = await c.post('/api/mckmensagem/campaigns', { name: 'Teste', message: 'Oi {nome}', channelId: ctx.ch.id });
    expect(camp.status).toBe(201);
    expect((await c.post('/api/mckmensagem/leads', { phone: '5511944440000', name: 'Gil', consentSource: 'MANUAL', campaignId: camp.body.id })).status).toBe(201);
    expect((await c.post(`/api/mckmensagem/campaigns/${camp.body.id}/start`, {})).status).toBe(200);
    await block(oid, 'MCKMENSAGEM');
    const at10 = new Date(Date.UTC(2026, 9, 26, 13, 0, 0)); // 10:00 em São Paulo
    graph.reset();
    expect((await tick(at10)).find((r) => r.campaignId === camp.body.id)?.action).toBe('subscription_inactive');
    expect(graph.calls.filter((g) => g.body)).toHaveLength(0);
    expect(await prisma.campaignRecipient.count({ where: { campaignId: camp.body.id, status: 'PENDENTE' } })).toBe(1);
    // MCKBOT bloqueado não afeta o MCKMENSAGEM (e vice-versa)
    await unblock(oid, 'MCKMENSAGEM');
    await block(oid, 'MCKBOT');
    // Passa pelo controle de assinatura (aqui o canal Cloud recusa por estar fora da janela de 24 h, sem template —
    // o importante é que o bloqueio do MCKBOT não barrou o envio do MCKMENSAGEM).
    const t2 = (await tick(at10)).find((r) => r.campaignId === camp.body.id)?.action;
    expect(t2).not.toBe('subscription_inactive');
    const rec = await prisma.campaignRecipient.findFirstOrThrow({ where: { campaignId: camp.body.id } });
    expect(rec.status).not.toBe('PENDENTE');
    expect(rec.error ?? '').not.toBe('Assinatura inativa');
    setRandom(null);
  });
});

describe('Vencimento, estorno e bloqueio de escrita do MCKBOT', () => {
  let owner: Client; let orgId: string;
  beforeAll(async () => {
    installGraphMock();
    process.env.MP_ACCESS_TOKEN = 'TEST-token-mp';
    graph.other = async (url) => {
      const m = url.match(/^https:\/\/api\.mercadopago\.com\/v1\/payments\/(\d+)$/);
      if (m) { const p = mp.payments.get(m[1]); return p ? new Response(JSON.stringify(p), { status: 200 }) : new Response('{}', { status: 404 }); }
      return null;
    };
    await updateSettings({ mpWebhookSecret: null });
    owner = await registerClient(); orgId = owner.me.org.id;
  });
  afterAll(() => { delete process.env.MP_ACCESS_TOKEN; graph.other = null; });
  const sub = () => prisma.subscription.findUniqueOrThrow({ where: { orgId_product: { orgId, product: 'MCKBOT' } } });

  it('vencido: escrita do MCKBOT → 402, leitura ok; pagamento aprovado reativa; estorno desfaz e corta de novo', async () => {
    await owner.get('/api/billing/status');
    await prisma.subscription.update({ where: { orgId_product: { orgId, product: 'MCKBOT' } }, data: { validUntil: new Date(Date.now() - DAY) } });
    expect(effectiveStatus(await sub())).toBe('VENCIDA');
    expect((await owner.post('/api/contacts', { name: 'X', phone: '5511999990000' })).status).toBe(402);
    expect((await owner.get('/api/contacts')).status).toBe(200);

    const id = newPay({ status: 'approved', external_reference: `mckbot|${orgId}|MCKBOT|MENSAL`, transaction_amount: 39.9 });
    expect((await webhook(id)).body.renewed).toBe(true);
    expect(effectiveStatus(await sub())).toBe('ATIVA');
    expect((await owner.post('/api/contacts', { name: 'X', phone: '5511999990000' })).status).not.toBe(402);

    mp.payments.get(id)!.status = 'refunded';
    const r = await webhook(id);
    expect(r.body.revoked).toBe(true);
    expect(effectiveStatus(await sub())).toBe('VENCIDA');
    expect((await webhook(id)).body.revoked).toBe(false); // idempotente
    expect((await owner.post('/api/contacts', { name: 'Y', phone: '5511999990001' })).status).toBe(402);
  });

  it('Pix pendente não ativa; quando aprova, ativa', async () => {
    await prisma.subscription.update({ where: { orgId_product: { orgId, product: 'MCKBOT' } }, data: { validUntil: new Date(Date.now() - DAY) } });
    const id = newPay({ status: 'pending', external_reference: `mckbot|${orgId}|MCKBOT|MENSAL`, transaction_amount: 39.9 });
    expect((await webhook(id)).body.renewed).toBe(false);
    expect(effectiveStatus(await sub())).toBe('VENCIDA');
    mp.payments.get(id)!.status = 'approved';
    expect((await webhook(id)).body.renewed).toBe(true);
    expect(effectiveStatus(await sub())).toBe('ATIVA');
  });
});
