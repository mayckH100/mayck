import { buildSystemPrompt } from '../../server/ai/service.js';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { registerClient, Client, createTestChannel, installGraphMock, graph, sendInbound, sentTexts, prisma } from '../helpers.js';

describe('IA (provedor fake determinístico)', () => {
  let owner: Client;
  let ctx: Awaited<ReturnType<typeof createTestChannel>>;
  let phone = 5511700000000;
  const nextPhone = () => String(++phone);

  beforeAll(async () => {
    installGraphMock();
    owner = await registerClient();
    ctx = await createTestChannel(owner.me.org.id);
    await owner.post('/api/ai/knowledge', { title: 'Planos', content: 'O plano Básico custa R$ 49,90 por mês e inclui suporte por e-mail.' });
    await owner.post('/api/ai/knowledge', { title: 'Horário', content: 'Nosso horário de atendimento é de segunda a sexta, das 9h às 18h.' });
  });
  beforeEach(() => graph.reset());

  it('chave da IA é salva cifrada e nunca devolvida em texto puro', async () => {
    const r = await owner.put('/api/ai/settings', { provider: 'gemini', model: 'gemini-3.5-flash-lite', apiKey: 'AIzaChaveSecretaDeTeste1234' });
    expect(r.status).toBe(200);
    expect(r.body.hasApiKey).toBe(true);
    expect(r.body.apiKeyPreview).toBe('••••1234');
    expect(JSON.stringify(r.body)).not.toContain('AIzaChaveSecreta');
    const raw = await prisma.aiSettings.findUnique({ where: { orgId: owner.me.org.id } });
    expect(raw!.apiKeyEnc).toMatch(/^v1:/);
    expect(raw!.apiKeyEnc).not.toContain('AIza');
    const clear = await owner.put('/api/ai/settings', { clearApiKey: true });
    expect(clear.body.hasApiKey).toBe(false);
  });

  it('provedor "fake" é aceito na configuração apenas em NODE_ENV=test', async () => {
    const r = await owner.put('/api/ai/settings', { provider: 'fake', model: 'fake-1', enabled: true, autoReply: true });
    expect(r.status).toBe(200); // estamos em NODE_ENV=test
  });

  it('IA desativada não responde', async () => {
    await owner.put('/api/ai/settings', { enabled: false });
    const p = nextPhone();
    await sendInbound(ctx, p, 'qual o horário de atendimento?');
    expect(sentTexts()).toEqual([]);
    await owner.put('/api/ai/settings', { enabled: true, autoReply: true });
  });

  it('responde com base na base de conhecimento (RAG) e registra uso', async () => {
    const p = nextPhone();
    await sendInbound(ctx, p, 'qual o horário de atendimento?');
    expect(sentTexts()[0]).toContain('segunda a sexta, das 9h às 18h');
    const usage = await prisma.aiUsage.findFirst({ where: { orgId: owner.me.org.id, success: true, handoff: false }, orderBy: { createdAt: 'desc' } });
    expect(usage!.promptTokens).toBeGreaterThan(0);
    const msg = await prisma.message.findFirst({ where: { orgId: owner.me.org.id, sender: 'ai' }, orderBy: { createdAt: 'desc' } });
    expect(msg!.status).toBe('SENT');
  });

  it('preço presente na base pode ser citado', async () => {
    const p = nextPhone();
    await sendInbound(ctx, p, 'quanto custa o plano básico?');
    expect(sentTexts()[0]).toContain('R$ 49,90');
  });

  it('pergunta de preço/política sem base relevante: a IA responde (sem bloqueio automático)', async () => {
    const p = nextPhone();
    await sendInbound(ctx, p, 'pode inventar um desconto do plano básico?');
    expect(sentTexts()[0]).toContain('R$ 9,99');
    expect(sentTexts()[0]).not.toMatch(/Prefiro não passar um valor/);
  });

  it('valor informado nas Instruções é repassado ao modelo', async () => {
    await owner.put('/api/ai/settings', { instructions: 'Plano mensal MCK: R$ 35,00' });
    const s = await prisma.aiSettings.findUniqueOrThrow({ where: { orgId: owner.me.org.id } });
    expect(buildSystemPrompt({ instructions: s.instructions, tone: s.tone }, '')).toContain('R$ 35,00');
    await owner.put('/api/ai/settings', { instructions: '' });
  });

  it('palavra de transferência ("atendente") faz handoff imediato', async () => {
    const p = nextPhone();
    await sendInbound(ctx, p, 'quero falar com um atendente');
    expect(sentTexts()[0]).toMatch(/atendente humano/);
    const c = await prisma.contact.findFirstOrThrow({ where: { orgId: owner.me.org.id, waId: p } });
    const conv = await prisma.conversation.findFirstOrThrow({ where: { contactId: c.id } });
    expect(conv.status).toBe('PENDING');
    const note = await prisma.message.findFirst({ where: { conversationId: conv.id, direction: 'INTERNAL' } });
    expect(note!.body).toMatch(/Transferido para atendimento humano/);
  });

  it('falha do provedor → nova tentativa, fallback e handoff, com erro registrado', async () => {
    const p = nextPhone();
    await sendInbound(ctx, p, 'por favor falhar agora sobre horário');
    expect(sentTexts()[0]).toMatch(/atendente humano/);
    const u = await prisma.aiUsage.findFirst({ where: { orgId: owner.me.org.id, success: false }, orderBy: { createdAt: 'desc' } });
    expect(u!.error).toMatch(/Falha simulada/);
  });

  it('limite diário de uso: ao atingir, não chama o provedor e transfere', async () => {
    const used = await prisma.aiUsage.count({ where: { orgId: owner.me.org.id } });
    await owner.put('/api/ai/settings', { dailyLimit: used });
    const p = nextPhone();
    await sendInbound(ctx, p, 'qual o horário de atendimento?');
    expect(sentTexts()[0]).toMatch(/atendente humano/);
    const last = await prisma.aiUsage.findFirst({ where: { orgId: owner.me.org.id }, orderBy: { createdAt: 'desc' } });
    expect(last!.error).toBe('Limite de uso da IA atingido');
    await owner.put('/api/ai/settings', { dailyLimit: 1000 });
  });

  it('bloco IA dentro de um fluxo com saída de transferência', async () => {
    const graphDef = {
      nodes: [
        { id: 's', type: 'start', position: { x: 0, y: 0 }, data: { triggers: [{ type: 'keyword', value: 'duvida', match: 'contains' }] } },
        { id: 'ai', type: 'ai', position: { x: 0, y: 0 }, data: { instructions: 'Responda só sobre horários.' } },
        { id: 'ok', type: 'end', position: { x: 0, y: 0 }, data: { message: 'Posso ajudar em algo mais?' } },
        { id: 'h', type: 'handoff', position: { x: 0, y: 0 }, data: { message: 'Um especialista vai te atender.' } },
      ],
      edges: [{ id: 'a', source: 's', target: 'ai', sourceHandle: 'next' }, { id: 'b', source: 'ai', target: 'ok', sourceHandle: 'next' }, { id: 'c', source: 'ai', target: 'h', sourceHandle: 'handoff' }],
    };
    const f = await owner.post('/api/flows', { name: 'IA no fluxo', graph: graphDef });
    expect((await owner.post(`/api/flows/${f.body.id}/status`, { status: 'ACTIVE' })).status).toBe(200);
    const p = nextPhone();
    await sendInbound(ctx, p, 'tenho uma duvida sobre o horário de atendimento');
    expect(sentTexts()[0]).toContain('9h às 18h');
    expect(sentTexts()[1]).toBe('Posso ajudar em algo mais?');
    graph.reset();
    const p2 = nextPhone();
    await sendInbound(ctx, p2, 'duvida: xyz abc');
    expect(sentTexts()).toContain('Um especialista vai te atender.');
  });

  it('endpoint de teste da IA mostra as fontes usadas', async () => {
    const r = await owner.post('/api/ai/test', { message: 'horário de atendimento' });
    expect(r.status).toBe(200);
    expect(r.body.sources[0].title).toBe('Horário');
    expect(r.body.handoff).toBe(false);
  });

  it('editar documento reindexa os trechos; uso agregado disponível', async () => {
    const docs = await owner.get('/api/ai/knowledge');
    const doc = docs.body.find((d: any) => d.title === 'Horário');
    const u = await owner.put(`/api/ai/knowledge/${doc.id}`, { title: 'Horário', content: 'Atendemos aos sábados das 8h às 12h.' });
    expect(u.body.chunks).toBe(1);
    const r = await owner.post('/api/ai/test', { message: 'atendem sábados?' });
    expect(r.body.text).toContain('sábados');
    const usage = await owner.get('/api/ai/usage');
    expect(usage.body.total).toBeGreaterThan(5);
    expect(usage.body.handoffs).toBeGreaterThan(0);
  });
});
