import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { registerClient, Client, createTestChannel, installGraphMock, graph, prisma } from '../helpers.js';
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
});
