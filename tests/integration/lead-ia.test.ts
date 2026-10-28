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

  it('prompt editável: salva o do cliente, mantém a parte fixa e volta ao padrão', async () => {
    const r = await owner.put('/api/mckmensagem/ia-leads', { promptTemplate: 'Você vende carros. Próximo passo: {proximo_passo}. Lead: {nome}.' });
    expect(r.status).toBe(200);
    expect(r.body.settings.promptTemplate).toContain('Você vende carros');
    expect(r.body.prompt).toContain('Você vende carros. Próximo passo: teste grátis de 1 hora. Lead: {nome}.'.replace('{nome}', '{nome}'));
    expect(r.body.prompt).toContain('FORMATO DA SUA SAÍDA');
    const t = await owner.post('/api/mckmensagem/ia-leads/testar', { texto: 'quero sim' });
    expect(t.body.intent).toBe('POSITIVO');
    const back = await owner.put('/api/mckmensagem/ia-leads', { promptTemplate: r.body.defaultPromptTemplate });
    expect(back.body.settings.promptTemplate).toBeNull();
  });

  it('campos por resultado: etiquetas próprias, mensagem extra e negativo descarta direto', async () => {
    await owner.put('/api/mckmensagem/ia-leads', { tagPositive: 'quer-test-drive', positiveMessage: 'Agende aqui, {nome}: https://exemplo.com', positiveAction: 'BOT', negativeAction: 'DISCARD', tagDiscarded: 'frio' });
    const a = await leadContatado('5511933330010', 'Elias');
    await sendInbound(ctx, '5511933330010', 'quero sim');
    const la = await prisma.lead.findUniqueOrThrow({ where: { id: a } });
    expect(la.status).toBe('QUALIFICADO');
    const ca = await prisma.contact.findUniqueOrThrow({ where: { id: la.contactId! } });
    expect(JSON.parse(ca.tags)).toContain('quer-test-drive');
    expect(sentTexts()).toContain('Agende aqui, Elias: https://exemplo.com');
    expect((await prisma.conversation.findFirstOrThrow({ where: { contactId: ca.id } })).mode).toBe('BOT');

    const b = await leadContatado('5511933330011', 'Fabi');
    await sendInbound(ctx, '5511933330011', 'não quero');
    const lb = await prisma.lead.findUniqueOrThrow({ where: { id: b } });
    expect(lb.status).toBe('DESCARTADO');
    expect(lb.nextAttemptAt).toBeNull();
    const cb = await prisma.contact.findUniqueOrThrow({ where: { id: lb.contactId! } });
    expect(JSON.parse(cb.tags)).toContain('frio');
    await owner.put('/api/mckmensagem/ia-leads', { negativeAction: 'RETRY', positiveMessage: '', positiveAction: 'HANDOFF' });
  });

  it('testar: classifica sem enviar nada', async () => {
    const r = await owner.post('/api/mckmensagem/ia-leads/testar', { texto: 'pode mandar o teste' });
    expect(r.status).toBe(200);
    expect(r.body.intent).toBe('POSITIVO');
    expect(sentTexts()).toEqual([]);
  });
});
