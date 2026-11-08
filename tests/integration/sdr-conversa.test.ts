import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { registerClient, Client, createTestChannel, installGraphMock, graph, prisma, sendInbound, sentTexts } from '../helpers.js';
import { flushSdr } from '../../server/sdr/ai.js';
import { fakeAi } from '../../server/ai/providers.js';
import { generateAiReply } from '../../server/ai/service.js';
import { applyExtraction } from '../../server/sdr/ai.js';
import { getSdrSettings, logEvent } from '../../server/sdr/service.js';
import { getIntelConfig, SDR_INTEL_ACTION } from '../../server/sdr/intelConfig.js';
import { openConversationFor } from '../../server/whatsapp/multiCanal.js';

/** v1.26.0: IA conversacional avançada (dados fictícios). */
const ALL_DAY = { workStart: '00:00', workEnd: '23:59', workDays: '0,1,2,3,4,5,6' };
const phone = () => `55119${Math.floor(10000000 + Math.random() * 89999999)}`;
const systemOf = (call: { role: string; content: string }[]) => call.find((m) => m.role === 'system')!.content;

describe('IA conversacional avançada', () => {
  let a: Client;
  let ctx: Awaited<ReturnType<typeof createTestChannel>>;
  const orgA = () => a.me.org.id;

  beforeAll(async () => {
    installGraphMock();
    a = await registerClient();
    ctx = await createTestChannel(orgA());
    expect((await a.put('/api/ai/settings', { provider: 'fake', model: 'fake-1', enabled: true, autoReply: true, instructions: 'Corretora Exemplo. Seguro empresarial a partir de R$ 89,90 por mês. Vistoria em até 2 dias úteis.' })).status).toBe(200);
    expect((await a.put('/api/sdr/config', { enabled: true, ...ALL_DAY })).status).toBe(200);
  });
  beforeEach(() => { graph.reset(); fakeAi.script = []; fakeAi.calls = []; });

  /** Lead do SDR com conversa aberta, histórico e (opcional) respostas já dadas. */
  async function leadComConversa(opts: { answers?: Record<string, unknown>; history?: [string, string][] } = {}) {
    const tel = phone();
    const r = await a.post('/api/sdr/leads', { name: 'Paula Teste', phone: tel, consent: true, company: 'Clínica Fictícia' });
    expect(r.status).toBe(201);
    let lead = await prisma.sdrLead.findUniqueOrThrow({ where: { id: r.body.id } });
    const conv = await openConversationFor(orgA(), lead.contactId!, ctx.ch.id);
    let t = Date.now() - 60_000;
    for (const [dir, body] of opts.history ?? []) await prisma.message.create({ data: { orgId: orgA(), conversationId: conv.id, channelId: ctx.ch.id, direction: dir, sender: dir === 'IN' ? 'contact' : 'ai', type: 'text', body, status: 'SENT', createdAt: new Date((t += 1000)) } });
    if (opts.answers) lead = await applyExtraction(lead, await getSdrSettings(orgA()), { respostas: opts.answers, resumo: 'quer seguro para a clínica' });
    return { lead, conv };
  }

  it('interruptor: configuração nova liga; quem já usava (registro salvo antes) fica desligado e o prompt não muda', async () => {
    expect((await getIntelConfig(orgA())).conversa).toEqual({ enabled: true, autoverificacao: true, handoff: true });
    const g = await a.get('/api/sdr/inteligencia');
    expect(g.body.conversa.enabled).toBe(true);
    // Empresa que já usava: registro da v1.21 sem o campo → desligado.
    const b = await registerClient();
    await prisma.auditLog.create({ data: { orgId: b.me.org.id, action: SDR_INTEL_ACTION, entity: 'sdr_settings', entityId: b.me.org.id, meta: JSON.stringify({ metodo: 'BANT', resumo: true }) } });
    expect((await getIntelConfig(b.me.org.id)).conversa.enabled).toBe(false);
    // Desligada: nada da IA avançada no prompt.
    expect((await a.put('/api/sdr/inteligencia', { conversa: { enabled: false } })).body.conversa.enabled).toBe(false);
    const { conv } = await leadComConversa();
    fakeAi.script = ['Oi! Posso ajudar.'];
    await generateAiReply({ orgId: orgA(), conversationId: conv.id, text: 'oi' });
    expect(systemOf(fakeAi.calls[0])).not.toContain('IA CONVERSACIONAL AVANÇADA');
    expect((await a.put('/api/sdr/inteligencia', { conversa: { enabled: true } })).body.conversa).toEqual({ enabled: true, autoverificacao: true, handoff: true });
  });

  it('1) contexto rico: dados do lead, respostas já dadas (nunca perguntar de novo), objeções e histórico maior', async () => {
    const hist: [string, string][] = Array.from({ length: 24 }, (_, i) => [i % 2 ? 'OUT' : 'IN', `mensagem antiga ${i}`] as [string, string]);
    const { lead, conv } = await leadComConversa({ answers: { necessidade: { resposta: 'seguro para a clínica', nota: 90 } }, history: hist });
    await logEvent(orgA(), lead.id, 'OBJECAO', 'WHATSAPP', 'Está caro');
    fakeAi.script = ['Certo.'];
    await generateAiReply({ orgId: orgA(), conversationId: conv.id, text: 'e aí?' });
    const sys = systemOf(fakeAi.calls[0]);
    expect(sys).toContain('DADOS DO LEAD');
    expect(sys).toContain('- Nome: Paula Teste');
    expect(sys).toContain('- Empresa: Clínica Fictícia');
    expect(sys).toMatch(/Objeções que ele já levantou: Está caro/);
    expect(sys).toMatch(/JÁ RESPONDIDO PELO LEAD \(NUNCA pergunte de novo[\s\S]*→ seguro para a clínica/);
    expect(sys).toContain('AINDA NÃO SABEMOS');
    // Histórico: mais de 10 mensagens anteriores vão ao prompt (antes eram 10).
    expect(fakeAi.calls[0].filter((m) => m.role !== 'system').length).toBeGreaterThan(20);
  });

  it('2) estilo WhatsApp: regras no prompt e texto final sem frase de robô nem emoji (empresa não usa)', async () => {
    const { conv } = await leadComConversa();
    fakeAi.script = ['Entendido perfeitamente! 😊 O seguro empresarial começa em R$ 89,90 por mês.'];
    const r = await generateAiReply({ orgId: orgA(), conversationId: conv.id, text: 'quanto custa?' });
    expect(r.text).toBe('O seguro empresarial começa em R$ 89,90 por mês.');
    const sys = systemOf(fakeAi.calls[0]);
    expect(sys).toContain('No máximo UMA pergunta por mensagem');
    expect(sys).toContain('Não use emojis.');
  });

  it('3) planejamento: método escolhido no prompt e o plano interno nunca chega ao lead', async () => {
    await a.put('/api/sdr/inteligencia', { metodo: 'BANT' });
    const { conv } = await leadComConversa();
    fakeAi.script = ['[PLANO: intencao=duvida; objetivo=QUALIFICAR]\nCobre sim. Quem decide a contratação aí?'];
    const r = await generateAiReply({ orgId: orgA(), conversationId: conv.id, text: 'cobre incêndio?' });
    expect(r.text).toBe('Cobre sim. Quem decide a contratação aí?');
    const sys = systemOf(fakeAi.calls[0]);
    expect(sys).toContain('ANTES DE RESPONDER, PLANEJE');
    expect(sys).toMatch(/Objetivo sugerido pelo estado do lead: QUALIFICAR\. Método: BANT/);
    await a.put('/api/sdr/inteligencia', { metodo: 'PADRAO' });
  });

  it('4) guardrails: valor inventado → 1 nova tentativa; persistiu → "confirmo com o especialista" + tarefa; sem cota, não tenta de novo', async () => {
    const { conv, lead } = await leadComConversa();
    // Nova tentativa corrige.
    fakeAi.script = ['[PLANO: intencao=preco; objetivo=QUALIFICAR]\nSai R$ 59,90 por mês.', '[PLANO: intencao=preco; objetivo=QUALIFICAR]\nComeça em R$ 89,90 por mês. É para quantos funcionários?'];
    const r1 = await generateAiReply({ orgId: orgA(), conversationId: conv.id, text: 'quanto fica?' });
    expect(r1.text).toBe('Começa em R$ 89,90 por mês. É para quantos funcionários?');
    expect(fakeAi.calls).toHaveLength(2);
    expect(systemOf(fakeAi.calls[1])).toContain('"R$ 59,90" não está nas Instruções');
    // Insistiu no erro: nunca envia o valor inventado.
    fakeAi.calls = [];
    fakeAi.script = ['A cobertura de enchente sai R$ 15 a mais.', 'Enchente custa R$ 15 a mais.'];
    const r2 = await generateAiReply({ orgId: orgA(), conversationId: conv.id, text: 'cobre enchente?' });
    expect(r2.text).toMatch(/confirmar com o especialista/);
    expect(r2.text).not.toContain('R$ 15');
    expect(fakeAi.calls).toHaveLength(2);
    expect((await prisma.message.findFirstOrThrow({ where: { conversationId: conv.id, direction: 'INTERNAL' }, orderBy: { createdAt: 'desc' } })).body).toContain('Tarefa para a equipe');
    expect(await prisma.sdrEvent.findFirst({ where: { leadId: lead.id, type: 'TAREFA' } })).toBeTruthy();
    // Cota no fim: sem chamada extra (só a checagem local).
    await a.put('/api/ai/settings', { dailyLimit: (await prisma.aiUsage.count({ where: { orgId: orgA() } })) + 1 });
    fakeAi.calls = [];
    fakeAi.script = ['Sai R$ 59,90.'];
    const r3 = await generateAiReply({ orgId: orgA(), conversationId: conv.id, text: 'e o valor?' });
    expect(fakeAi.calls).toHaveLength(1);
    expect(r3.text).toMatch(/especialista/);
    await a.put('/api/ai/settings', { dailyLimit: 1000 });
  });

  it('5) handoff inteligente: irritação, lead quente, plano PASSAR_VENDEDOR e pedido de pessoa levam o resumo; desligado não transfere', async () => {
    const { conv } = await leadComConversa({ answers: { necessidade: { resposta: 'seguro para a clínica', nota: 90 } } });
    fakeAi.script = ['Desculpe a demora, já te explico.'];
    const r1 = await generateAiReply({ orgId: orgA(), conversationId: conv.id, text: 'já falei isso duas vezes, que saco' });
    expect(r1.handoff).toBe(true);
    expect(r1.text).toBe('Desculpe a demora, já te explico. Vou chamar um especialista da equipe para continuar com você por aqui.');
    expect(r1.reason).toMatch(/^IA conversacional: lead irritado · Lead: Paula Teste \(Clínica Fictícia\)[\s\S]*Já disse: seguro para a clínica/);
    fakeAi.script = ['[PLANO: intencao=cobertura; objetivo=PASSAR_VENDEDOR]\nIsso o especialista da equipe te explica melhor, ele já te chama.'];
    const r2 = await generateAiReply({ orgId: orgA(), conversationId: conv.id, text: 'vocês fazem seguro de frota internacional?' });
    expect(r2).toMatchObject({ handoff: true, text: 'Isso o especialista da equipe te explica melhor, ele já te chama.' });
    expect(r2.reason).toContain('hora do vendedor');
    const quente = await leadComConversa();
    await prisma.sdrLead.update({ where: { id: quente.lead.id }, data: { temperature: 'QUENTE', score: 85 } });
    fakeAi.script = ['Perfeito, dá para começar ainda este mês.'];
    const r3 = await generateAiReply({ orgId: orgA(), conversationId: quente.conv.id, text: 'e quando começa?' });
    expect(r3.handoff).toBe(true);
    expect(r3.reason).toMatch(/lead quente[\s\S]*Pontuação 85\/100 \(quente\)/);
    const r4 = await generateAiReply({ orgId: orgA(), conversationId: conv.id, text: 'quero falar com um atendente' });
    expect(r4.handoff).toBe(true);
    expect(r4.reason).toMatch(/^IA conversacional: pedido de atendente/);
    // Handoff desligado: segue com a IA.
    await a.put('/api/sdr/inteligencia', { conversa: { handoff: false } });
    fakeAi.script = ['Entendo. Me conta o que aconteceu?'];
    const r5 = await generateAiReply({ orgId: orgA(), conversationId: conv.id, text: 'que saco' });
    expect(r5.handoff).toBe(false);
    expect(systemOf(fakeAi.calls.at(-1)!)).toContain('Não use PASSAR_VENDEDOR');
    await a.put('/api/sdr/inteligencia', { conversa: { handoff: true } });
  });

  it('5) campanhas (MCK Mensagens): pedido de pessoa passa ao vendedor sem gastar IA', async () => {
    expect((await a.put('/api/mckmensagem/ia-leads', { enabled: true, positiveAction: 'BOT' })).status).toBe(200);
    const tel = phone();
    const r = await a.post('/api/mckmensagem/leads', { phone: tel, name: 'Rafa Campanha', consentSource: 'MANUAL' });
    expect(r.status).toBe(201);
    const contact = await prisma.contact.upsert({ where: { orgId_waId: { orgId: orgA(), waId: tel } }, update: {}, create: { orgId: orgA(), waId: tel, phone: '+' + tel, name: 'Rafa Campanha', lastMessageAt: new Date(Date.now() - 3600e3) } });
    await prisma.lead.update({ where: { id: r.body.id }, data: { status: 'CONTATADO', contactId: contact.id } });
    const conv = await openConversationFor(orgA(), contact.id, ctx.ch.id);
    await prisma.conversation.update({ where: { id: conv.id }, data: { lastInboundAt: new Date() } });
    await prisma.message.create({ data: { orgId: orgA(), conversationId: conv.id, channelId: ctx.ch.id, direction: 'OUT', sender: 'bot', type: 'text', body: 'Oi! Temos uma condição para clínicas. Posso te explicar?', status: 'SENT', createdAt: new Date(Date.now() - 600_000) } });
    const before = fakeAi.calls.length;
    await sendInbound(ctx, tel, 'prefiro falar com uma pessoa');
    await flushSdr();
    expect(sentTexts()).toEqual(['Vou chamar um especialista da equipe para continuar com você por aqui.']);
    expect(fakeAi.calls.length).toBe(before);
    const c = await prisma.conversation.findUniqueOrThrow({ where: { id: conv.id } });
    expect(c.mode).toBe('HUMAN');
    const n = await prisma.message.findFirstOrThrow({ where: { conversationId: conv.id, direction: 'INTERNAL', body: { contains: 'Transferido' } } });
    expect(n.body).toContain('IA conversacional: pedido de atendente · Lead: Rafa Campanha');
  });
});
