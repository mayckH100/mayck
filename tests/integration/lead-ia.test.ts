import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { registerClient, Client, createTestChannel, installGraphMock, graph, sendInbound, sentTexts, prisma } from '../helpers.js';
import { tickLeadRetries, parseQualifyOutput } from '../../server/mckmensagem/qualificacao.js';

describe('MCK Mensagens — IA de qualificação de leads', () => {
  let owner: Client;
  let ctx: Awaited<ReturnType<typeof createTestChannel>>;
  const orgId = () => owner.me.org.id;

  async function leadContatado(phone: string, name: string) {
    const r = await owner.post('/api/mckmensagem/leads', { phone, name, consentSource: 'MANUAL' });
    expect(r.status).toBe(201);
    await prisma.lead.update({ where: { id: r.body.id }, data: { status: 'CONTATADO' } });
    return r.body.id as string;
  }

  beforeAll(async () => {
    installGraphMock();
    owner = await registerClient();
    ctx = await createTestChannel(orgId());
    expect((await owner.put('/api/ai/settings', { provider: 'fake', model: 'fake-1', enabled: true, autoReply: false })).status).toBe(200);
  });
  beforeEach(() => graph.reset());

  it('lê o JSON da IA com tolerância', () => {
    expect(parseQualifyOutput('```json\n{"intencao":"positivo","resposta":"Oba!","resumo":"quer teste"}\n```')).toEqual({ intencao: 'POSITIVO', resposta: 'Oba!', resumo: 'quer teste' });
    expect(parseQualifyOutput('sem json')).toBeNull();
    expect(parseQualifyOutput('{"intencao":"TALVEZ","resposta":"x"}')).toBeNull();
  });

  it('desligada: lead que responde segue o fluxo normal (RESPONDEU)', async () => {
    const id = await leadContatado('5511933330000', 'Ana');
    await sendInbound(ctx, '5511933330000', 'quero sim');
    expect((await prisma.lead.findUniqueOrThrow({ where: { id } })).status).toBe('RESPONDEU');
  });

  it('configuração: salva, valida fluxo e mostra o prompt', async () => {
    const bad = await owner.put('/api/mckmensagem/ia-leads', { positiveAction: 'FLOW', positiveFlowId: null });
    expect(bad.status).toBe(400);
    const r = await owner.put('/api/mckmensagem/ia-leads', { enabled: true, positiveAction: 'HANDOFF', retryDays: 2, maxAttempts: 2, offer: 'teste grátis de 1 hora' });
    expect(r.status).toBe(200);
    expect(r.body.settings).toMatchObject({ enabled: true, retryDays: 2, maxAttempts: 2 });
    expect(r.body.prompt).toContain('teste grátis de 1 hora');
    expect(r.body.aiReady).toBe(true);
  });

  it('positivo: lead QUALIFICADO, IA responde e conversa vai para atendente', async () => {
    const id = await leadContatado('5511933330001', 'Bruno');
    await sendInbound(ctx, '5511933330001', 'quero sim, como funciona?');
    const lead = await prisma.lead.findUniqueOrThrow({ where: { id } });
    expect(lead.status).toBe('QUALIFICADO');
    expect(lead.qualifiedAt).toBeTruthy();
    expect(sentTexts()).toContain('Resposta positivo da IA');
    const conv = await prisma.conversation.findFirstOrThrow({ where: { contactId: lead.contactId! } });
    expect(conv.mode).toBe('HUMAN');
  });

  it('negativo: AGUARDANDO com nova tentativa; no limite vira DESCARTADO', async () => {
    const id = await leadContatado('5511933330002', 'Carla');
    await sendInbound(ctx, '5511933330002', 'não, agora não');
    let lead = await prisma.lead.findUniqueOrThrow({ where: { id } });
    expect(lead.status).toBe('AGUARDANDO');
    expect(lead.qualifyAttempts).toBe(1);
    const dias = (lead.nextAttemptAt!.getTime() - Date.now()) / 86400e3;
    expect(dias).toBeGreaterThan(1.9);
    expect(sentTexts()).toContain('Resposta negativo da IA');

    // Antes da data: nada acontece. Depois (13:00 em São Paulo): reabordagem personalizada.
    graph.reset();
    expect(await tickLeadRetries(new Date())).toBe(0);
    const depois = new Date(lead.nextAttemptAt!.getTime() + 86400e3);
    depois.setUTCHours(16, 0, 0, 0);
    expect(await tickLeadRetries(depois)).toBe(1);
    expect(sentTexts()[0]).toMatch(/^Oi Carla!/);
    lead = await prisma.lead.findUniqueOrThrow({ where: { id } });
    expect(lead.status).toBe('CONTATADO');
    expect(lead.nextAttemptAt).toBeNull();
    expect(await tickLeadRetries(depois)).toBe(0); // não reenvia

    await sendInbound(ctx, '5511933330002', 'não quero');
    lead = await prisma.lead.findUniqueOrThrow({ where: { id } });
    expect(lead.status).toBe('DESCARTADO');
    expect(lead.nextAttemptAt).toBeNull();
  });

  it('pedido para sair: opt-out e DESCARTADO', async () => {
    const id = await leadContatado('5511933330003', 'Davi');
    await sendInbound(ctx, '5511933330003', 'me remove dessa lista');
    const lead = await prisma.lead.findUniqueOrThrow({ where: { id } });
    expect(lead.status).toBe('DESCARTADO');
    expect(lead.optOutAt).toBeTruthy();
  });

  it('testar: classifica sem enviar nada', async () => {
    const r = await owner.post('/api/mckmensagem/ia-leads/testar', { texto: 'pode mandar o teste' });
    expect(r.status).toBe(200);
    expect(r.body.intent).toBe('POSITIVO');
    expect(sentTexts()).toEqual([]);
  });
});
