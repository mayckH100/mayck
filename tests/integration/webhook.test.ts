import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import request from 'supertest';
import { app, registerClient, Client, createTestChannel, installGraphMock, graph, sendInbound, postWebhook, statusPayload, inboundPayload, prisma } from '../helpers.js';
import { config } from '../../server/config.js';

describe('Webhook WhatsApp Cloud API (payloads simulados)', () => {
  let owner: Client;
  let ctx: Awaited<ReturnType<typeof createTestChannel>>;
  beforeAll(async () => {
    installGraphMock();
    owner = await registerClient();
    ctx = await createTestChannel(owner.me.org.id);
  });
  beforeEach(() => graph.reset());

  it('GET de verificação devolve o challenge com token correto', async () => {
    const r = await request(app).get(`/api/webhooks/whatsapp/${ctx.ch.id}`).query({ 'hub.mode': 'subscribe', 'hub.verify_token': ctx.ch.verifyToken, 'hub.challenge': '12345' });
    expect(r.status).toBe(200);
    expect(r.text).toBe('12345');
  });

  it('GET de verificação recusa token errado ou canal inexistente', async () => {
    expect((await request(app).get(`/api/webhooks/whatsapp/${ctx.ch.id}`).query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'errado', 'hub.challenge': '1' })).status).toBe(403);
    expect((await request(app).get('/api/webhooks/whatsapp/naoexiste').query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'x', 'hub.challenge': '1' })).status).toBe(403);
  });

  it('POST com assinatura inválida é rejeitado (401) e nada é gravado', async () => {
    const before = await prisma.message.count({ where: { orgId: owner.me.org.id } });
    const p = inboundPayload(ctx.phoneNumberId, '5511911110000', 'oi');
    const r = await postWebhook(ctx.ch.id, ctx.appSecret, p.body, true);
    expect(r.status).toBe(401);
    expect(await prisma.message.count({ where: { orgId: owner.me.org.id } })).toBe(before);
  });

  it('POST sem cabeçalho de assinatura é rejeitado', async () => {
    const r = await request(app).post(`/api/webhooks/whatsapp/${ctx.ch.id}`).set('content-type', 'application/json').send(JSON.stringify(inboundPayload(ctx.phoneNumberId, '1', 'x').body));
    expect(r.status).toBe(401);
  });

  it('mensagem válida cria contato, conversa e mensagem recebida', async () => {
    const { res, id } = await sendInbound(ctx, '5511922220000', 'Olá, tudo bem?');
    expect(res.status).toBe(200);
    expect(res.body.received).toBe(1);
    const msg = await prisma.message.findFirst({ where: { waMessageId: id } });
    expect(msg).toMatchObject({ direction: 'IN', body: 'Olá, tudo bem?', status: 'RECEIVED', orgId: owner.me.org.id });
    const contact = await prisma.contact.findFirst({ where: { orgId: owner.me.org.id, waId: '5511922220000' } });
    expect(contact!.name).toBe('Cliente Teste');
    const conv = await prisma.conversation.findFirst({ where: { contactId: contact!.id } });
    expect(conv!.status).toBe('OPEN');
    expect(conv!.unreadCount).toBe(1);
  });

  it('idempotência: o mesmo message id reenviado não duplica mensagem', async () => {
    const p = inboundPayload(ctx.phoneNumberId, '5511933330000', 'pedido');
    const r1 = await postWebhook(ctx.ch.id, ctx.appSecret, p.body);
    const r2 = await postWebhook(ctx.ch.id, ctx.appSecret, p.body);
    const r3 = await postWebhook(ctx.ch.id, ctx.appSecret, p.body);
    expect(r1.body.received).toBe(1);
    expect(r2.body.duplicates).toBe(1);
    expect(r3.body.duplicates).toBe(1);
    expect(await prisma.message.count({ where: { waMessageId: p.id } })).toBe(1);
  });

  it('idempotência sob concorrência: reenvios simultâneos geram uma só mensagem', async () => {
    const p = inboundPayload(ctx.phoneNumberId, '5511944440000', 'simultâneo');
    const rs = await Promise.all([1, 2, 3, 4].map(() => postWebhook(ctx.ch.id, ctx.appSecret, p.body)));
    expect(rs.every((r) => r.status === 200)).toBe(true);
    expect(await prisma.message.count({ where: { waMessageId: p.id } })).toBe(1);
  });

  it('atualizações de status avançam (sent→delivered→read) e não regridem', async () => {
    const contact = await prisma.contact.findFirstOrThrow({ where: { orgId: owner.me.org.id, waId: '5511922220000' } });
    const conv = await prisma.conversation.findFirstOrThrow({ where: { contactId: contact.id } });
    const send = await owner.post(`/api/conversations/${conv.id}/messages`, { type: 'text', text: 'Olá! Sou o atendente.' });
    expect(send.status).toBe(201);
    expect(send.body.status).toBe('SENT');
    const wamid = send.body.waMessageId;
    expect(graph.calls[0].body).toMatchObject({ to: '5511922220000', type: 'text', text: { body: 'Olá! Sou o atendente.' } });
    expect(graph.calls[0].headers.Authorization).toBe('Bearer EAAtokenDeTeste1234567890');
    await postWebhook(ctx.ch.id, ctx.appSecret, statusPayload(ctx.phoneNumberId, wamid, 'delivered'));
    expect((await prisma.message.findFirst({ where: { waMessageId: wamid } }))!.status).toBe('DELIVERED');
    await postWebhook(ctx.ch.id, ctx.appSecret, statusPayload(ctx.phoneNumberId, wamid, 'read'));
    await postWebhook(ctx.ch.id, ctx.appSecret, statusPayload(ctx.phoneNumberId, wamid, 'delivered'));
    expect((await prisma.message.findFirst({ where: { waMessageId: wamid } }))!.status).toBe('READ');
  });

  it('envio com falhas temporárias (500, 500) faz novas tentativas e conclui', async () => {
    const contact = await prisma.contact.findFirstOrThrow({ where: { orgId: owner.me.org.id, waId: '5511922220000' } });
    const conv = await prisma.conversation.findFirstOrThrow({ where: { contactId: contact.id } });
    graph.failNext = [500, 500];
    const r = await owner.post(`/api/conversations/${conv.id}/messages`, { type: 'text', text: 'tentativas' });
    expect(r.status).toBe(201);
    expect(r.body.attempts).toBe(3);
    expect(graph.calls).toHaveLength(3);
  });

  it('erro definitivo da Meta (400) marca a mensagem como FAILED sem repetir', async () => {
    const contact = await prisma.contact.findFirstOrThrow({ where: { orgId: owner.me.org.id, waId: '5511922220000' } });
    const conv = await prisma.conversation.findFirstOrThrow({ where: { contactId: contact.id } });
    graph.failNext = [400];
    const r = await owner.post(`/api/conversations/${conv.id}/messages`, { type: 'text', text: 'vai falhar' });
    expect(r.status).toBe(502);
    expect(r.body.status).toBe('FAILED');
    expect(r.body.error).toContain('Erro simulado 400');
    expect(graph.calls).toHaveLength(1);
  });

  it('fora da janela de 24h só permite modelo (template)', async () => {
    const contact = await prisma.contact.findFirstOrThrow({ where: { orgId: owner.me.org.id, waId: '5511922220000' } });
    const conv = await prisma.conversation.findFirstOrThrow({ where: { contactId: contact.id } });
    await prisma.conversation.update({ where: { id: conv.id }, data: { lastInboundAt: new Date(Date.now() - 25 * 3600e3) } });
    const t = await owner.post(`/api/conversations/${conv.id}/messages`, { type: 'text', text: 'oi' });
    expect(t.body.status).toBe('FAILED');
    expect(t.body.error).toMatch(/24 horas/);
    expect(graph.calls).toHaveLength(0);
    const tpl = await owner.post(`/api/conversations/${conv.id}/messages`, { type: 'template', name: 'hello_world', language: 'pt_BR' });
    expect(tpl.body.status).toBe('SENT');
    expect(graph.calls[0].body.type).toBe('template');
  });

  it('canal sem credenciais fica "não conectado" e nunca simula envio', async () => {
    const other = await registerClient();
    const ch = await other.post('/api/channels', { name: 'Novo' });
    expect(ch.body.status).toBe('NOT_CONNECTED');
    expect(ch.body.webhookUrl).toContain(`/api/webhooks/whatsapp/${ch.body.id}`);
    const c = await other.post('/api/contacts', { phone: '5511955550000' });
    const conv = await prisma.conversation.create({ data: { orgId: other.me.org.id, contactId: c.body.id, channelId: ch.body.id, lastInboundAt: new Date() } });
    const r = await other.post(`/api/conversations/${conv.id}/messages`, { type: 'text', text: 'oi' });
    expect(r.body.status).toBe('FAILED');
    expect(r.body.error).toMatch(/não conectado/);
    expect(graph.calls).toHaveLength(0);
  });

  it('verificação de credenciais consulta a Graph API e só então marca CONNECTED; segredos não vazam', async () => {
    const other = await registerClient();
    const ch = await other.post('/api/channels', { name: 'Principal' });
    const noCreds = await other.post(`/api/channels/${ch.body.id}/verify`);
    expect(noCreds.status).toBe(400);
    const upd = await other.patch(`/api/channels/${ch.body.id}`, { phoneNumberId: '123456789012', accessToken: 'EAAG' + 'x'.repeat(30), appSecret: 'segredoDoApp123' });
    expect(upd.body.status).toBe('NOT_CONNECTED');
    expect(JSON.stringify(upd.body)).not.toContain('segredoDoApp123');
    expect(JSON.stringify(upd.body)).not.toContain('x'.repeat(30));
    const raw = await prisma.channel.findUnique({ where: { id: ch.body.id } });
    expect(raw!.accessTokenEnc).not.toContain('EAAG');
    const v = await other.post(`/api/channels/${ch.body.id}/verify`);
    expect(v.body.status).toBe('CONNECTED');
    expect(graph.calls[0].url).toContain('/123456789012?fields=');
  });

  it('rate limit do webhook devolve 429 acima do limite', async () => {
    const prev = config.WEBHOOK_RATE_LIMIT;
    config.WEBHOOK_RATE_LIMIT = 2;
    try {
      const other = await createTestChannel(owner.me.org.id);
      const codes = [];
      for (let i = 0; i < 4; i++) codes.push((await request(app).get(`/api/webhooks/whatsapp/${other.ch.id}`)).status);
      expect(codes.filter((c) => c === 429).length).toBe(2);
    } finally {
      config.WEBHOOK_RATE_LIMIT = prev;
    }
  });

  it('opt-out ("SAIR") bloqueia mensagens automáticas ao contato', async () => {
    await sendInbound(ctx, '5511966660000', 'SAIR');
    const c = await prisma.contact.findFirstOrThrow({ where: { orgId: owner.me.org.id, waId: '5511966660000' } });
    expect(c.optOut).toBe(true);
  });
});
