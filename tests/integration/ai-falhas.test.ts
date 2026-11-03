import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { registerClient, Client, createTestChannel, installGraphMock, graph, sendInbound, sentTexts, prisma } from '../helpers.js';
import { fakeAi } from '../../server/ai/providers.js';

const FALLBACK = 'Vou chamar uma pessoa da equipe para te atender.';
// Regra do dono (2026-11-03): falha da IA NUNCA transfere; vai o texto de falha e a IA continua.
const FAIL = 'Desculpe, tive um problema aqui. Pode repetir?';

describe('IA: travamentos, bloqueios e respostas vazias nunca deixam o cliente sem resposta', () => {
  let owner: Client;
  let ctx: Awaited<ReturnType<typeof createTestChannel>>;
  let phone = 5511710000000;
  const nextPhone = () => String(++phone);
  const prevTimeout = process.env.AI_TIMEOUT_MS;
  const prevTotal = process.env.AI_TOTAL_TIMEOUT_MS;

  beforeAll(async () => {
    process.env.AI_TIMEOUT_MS = '300';
    process.env.AI_TOTAL_TIMEOUT_MS = '1500';
    installGraphMock();
    owner = await registerClient();
    ctx = await createTestChannel(owner.me.org.id);
    const r = await owner.put('/api/ai/settings', { provider: 'fake', model: 'fake-1', enabled: true, autoReply: true, fallbackMessage: FALLBACK, failureMessage: FAIL });
    expect(r.status).toBe(200);
  });
  afterAll(() => {
    process.env.AI_TIMEOUT_MS = prevTimeout; if (prevTimeout === undefined) delete process.env.AI_TIMEOUT_MS;
    process.env.AI_TOTAL_TIMEOUT_MS = prevTotal; if (prevTotal === undefined) delete process.env.AI_TOTAL_TIMEOUT_MS;
  });
  beforeEach(() => { graph.reset(); fakeAi.script = []; fakeAi.calls = []; });

  it('Testar: bloqueio SAFETY nas duas tentativas → responde com fallback e motivo legível (não trava)', async () => {
    fakeAi.script = ['__SAFETY__', '__SAFETY__'];
    const r = await owner.post('/api/ai/test', { message: 'Vocês são a MCK Desenvolvimento de Sistemas LTDA?' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ text: FAIL, handoff: false, failed: true, reason: 'Resposta bloqueada pelo filtro de segurança do provedor' });
    expect(r.body.error).toMatch(/SAFETY/);
    expect(fakeAi.calls).toHaveLength(2);
    const u = await prisma.aiUsage.findFirst({ where: { orgId: owner.me.org.id, success: false }, orderBy: { createdAt: 'desc' } });
    expect(u!.error).toMatch(/SAFETY/);
  });

  it('Testar: resposta vazia na 1ª tentativa e texto na 2ª → devolve o texto (nova tentativa automática)', async () => {
    fakeAi.script = ['__EMPTY__', 'Temos o MCKBOT, que responde seus clientes no WhatsApp 24 h.'];
    const r = await owner.post('/api/ai/test', { message: 'Tenho uma loja e demoro para responder no WhatsApp, o que vocês têm?' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ handoff: false, text: 'Temos o MCKBOT, que responde seus clientes no WhatsApp 24 h.' });
    expect(fakeAi.calls).toHaveLength(2);
  });

  it('Testar: texto vazio ("") também é tratado como resposta vazia e repetido', async () => {
    fakeAi.script = ['', '   '];
    const r = await owner.post('/api/ai/test', { message: 'oi' });
    expect(r.body).toMatchObject({ text: FAIL, handoff: false, failed: true, reason: 'Provedor de IA devolveu resposta vazia' });
  });

  it('Testar: provedor que nunca responde → timeout, fallback, e a requisição termina rápido', async () => {
    fakeAi.script = ['__HANG__', '__HANG__'];
    const t0 = Date.now();
    const r = await owner.post('/api/ai/test', { message: 'Vocês são a MCK Desenvolvimento de Sistemas LTDA?' });
    expect(r.status).toBe(200);
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(r.body).toMatchObject({ text: FAIL, handoff: false, failed: true, reason: 'Provedor de IA não respondeu a tempo' });
  });

  it('WhatsApp real: bloqueio nas duas tentativas → cliente recebe o texto de falha e a conversa CONTINUA com a IA (sem transferir)', async () => {
    fakeAi.script = ['__SAFETY__', '__SAFETY__'];
    const p = nextPhone();
    await sendInbound(ctx, p, 'Vocês são a MCK Desenvolvimento de Sistemas LTDA?');
    expect(sentTexts()).toEqual([FAIL]);
    const c = await prisma.contact.findFirstOrThrow({ where: { orgId: owner.me.org.id, waId: p } });
    const conv = await prisma.conversation.findFirstOrThrow({ where: { contactId: c.id } });
    expect(conv.mode).toBe('BOT');
    expect(conv.waitingSince).toBeNull();
    const n = await prisma.message.findFirst({ where: { conversationId: conv.id, direction: 'INTERNAL' } });
    expect(n!.body).toMatch(/IA não conseguiu responder/);
  });

  it('sem texto de falha próprio e fallback que promete humano → usa o texto padrão (não promete transferência)', async () => {
    await owner.put('/api/ai/settings', { failureMessage: '' });
    fakeAi.script = ['__SAFETY__', '__SAFETY__'];
    const r = await owner.post('/api/ai/test', { message: 'oi' });
    expect(r.body.handoff).toBe(false);
    expect(r.body.text).toMatch(/não consegui responder agora.*"atendente"/);
    await owner.put('/api/ai/settings', { failureMessage: FAIL });
  });

  it('IA responde [TRANSFERIR] sem o cliente pedir → bloqueado: texto de falha, sem transferir', async () => {
    fakeAi.script = ['[TRANSFERIR]'];
    const p = nextPhone();
    await sendInbound(ctx, p, 'quero reagendar minha reunião de amanhã');
    expect(sentTexts()).toEqual([FAIL]);
    const c = await prisma.contact.findFirstOrThrow({ where: { orgId: owner.me.org.id, waId: p } });
    const conv = await prisma.conversation.findFirstOrThrow({ where: { contactId: c.id } });
    expect(conv.mode).toBe('BOT');
  });

  it('cliente pede explicitamente um atendente → transfere (única transferência da IA)', async () => {
    const p = nextPhone();
    await sendInbound(ctx, p, 'quero falar com um atendente, por favor');
    expect(sentTexts()).toEqual([FALLBACK]);
    expect(fakeAi.calls).toHaveLength(0);
    const c = await prisma.contact.findFirstOrThrow({ where: { orgId: owner.me.org.id, waId: p } });
    const conv = await prisma.conversation.findFirstOrThrow({ where: { contactId: c.id } });
    expect(conv.mode).toBe('HUMAN');
  });

  it('WhatsApp real: provedor travado → fallback em vez de silêncio', async () => {
    fakeAi.script = ['__HANG__', '__HANG__'];
    const p = nextPhone();
    await sendInbound(ctx, p, 'Tenho uma loja e demoro para responder no WhatsApp, o que vocês têm?');
    expect(sentTexts()).toEqual([FAIL]);
  });

  it('WhatsApp real: vazio e depois resposta → cliente recebe a resposta, sem transferência', async () => {
    fakeAi.script = ['__EMPTY__', 'Temos o MCKBOT!'];
    const p = nextPhone();
    await sendInbound(ctx, p, 'o que vocês têm?');
    expect(sentTexts()).toEqual(['Temos o MCKBOT!']);
    const c = await prisma.contact.findFirstOrThrow({ where: { orgId: owner.me.org.id, waId: p } });
    const conv = await prisma.conversation.findFirstOrThrow({ where: { contactId: c.id } });
    expect(conv.mode).not.toBe('HUMAN');
  });
});
