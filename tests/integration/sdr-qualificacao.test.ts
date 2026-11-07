import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { registerClient, Client, createTestChannel, installGraphMock, graph, sendInbound, sentTexts, prisma } from '../helpers.js';
import { clearSdrAccessCache } from '../../server/sdr/access.js';
import { SDR_QUALI_ACTION } from '../../server/sdr/qualificacao.js';

/**
 * v1.20.0: "IA de qualificação" do MCK Mensagens + "SDR com IA" do MCKBOT viram um só produto. A configuração antiga
 * continua valendo (lida em código, sem migração), o fluxo das campanhas continua igual, a tela do SDR passa a ser a
 * única configuração e quem tem só o MCK Mensagens mantém a qualificação.
 */
const DAY = 24 * 3600 * 1000;

describe('SDR com IA — qualificação unificada', () => {
  let a: Client;
  let ctx: Awaited<ReturnType<typeof createTestChannel>>;
  const orgA = () => a.me.org.id;

  async function leadContatado(c: Client, phone: string, name: string) {
    const r = await c.post('/api/mckmensagem/leads', { phone, name, consentSource: 'MANUAL' });
    expect(r.status).toBe(201);
    await prisma.lead.update({ where: { id: r.body.id }, data: { status: 'CONTATADO' } });
    return r.body.id as string;
  }

  beforeAll(async () => {
    installGraphMock();
    a = await registerClient();
    ctx = await createTestChannel(orgA());
    expect((await a.put('/api/ai/settings', { provider: 'fake', model: 'fake-1', enabled: true, autoReply: false })).status).toBe(200);
  });
  beforeEach(() => { graph.reset(); clearSdrAccessCache(); });

  it('empresa já configurada antes do deploy: a configuração antiga vale no SDR sem gravar nada, e a campanha continua igual', async () => {
    // Como uma corretora que configurou a IA de qualificação na versão anterior (linha antiga, sem configuração do SDR).
    await prisma.leadAiSettings.create({ data: { orgId: orgA(), enabled: true, instructions: 'Descubra o veículo e o vencimento.', offer: 'cotação sem compromisso', positiveAction: 'HANDOFF', tagPositive: 'quer-cotacao', retryDays: 4, maxAttempts: 2 } });
    const logs0 = await prisma.auditLog.count({ where: { orgId: orgA(), action: SDR_QUALI_ACTION } });

    const v = await a.get('/api/sdr/qualificacao');
    expect(v.status).toBe(200);
    expect(v.body.origem).toBe('LEGADO');
    expect(v.body.settings).toMatchObject({ enabled: true, instructions: 'Descubra o veículo e o vencimento.', offer: 'cotação sem compromisso', tagPositive: 'quer-cotacao', retryDays: 4, maxAttempts: 2 });
    expect(v.body.prompt).toContain('cotação sem compromisso');
    // A rota antiga mostra a mesma coisa.
    expect((await a.get('/api/mckmensagem/ia-leads')).body.settings).toEqual(v.body.settings);
    // Ler não grava nada.
    expect(await prisma.auditLog.count({ where: { orgId: orgA(), action: SDR_QUALI_ACTION } })).toBe(logs0);

    // Fluxo antigo: lead da campanha responde "quero sim" → Qualificado, etiqueta, atendente.
    const id = await leadContatado(a, '5511944440001', 'Gabi');
    await sendInbound(ctx, '5511944440001', 'quero sim, como funciona?');
    const lead = await prisma.lead.findUniqueOrThrow({ where: { id } });
    expect(lead.status).toBe('QUALIFICADO');
    expect(sentTexts()).toContain('Resposta positivo da IA');
    const c = await prisma.contact.findUniqueOrThrow({ where: { id: lead.contactId! } });
    expect(JSON.parse(c.tags)).toContain('quer-cotacao');
    expect((await prisma.conversation.findFirstOrThrow({ where: { contactId: c.id } })).mode).toBe('HUMAN');
  });

  it('salvar pela tela do SDR: vira a fonte de verdade, espelha na tabela antiga e o motor das campanhas usa', async () => {
    const r = await a.put('/api/sdr/qualificacao', { tagPositive: 'quente-sdr', positiveAction: 'BOT' });
    expect(r.status).toBe(200);
    expect(r.body.origem).toBe('SDR');
    expect(r.body.settings).toMatchObject({ enabled: true, instructions: 'Descubra o veículo e o vencimento.', tagPositive: 'quente-sdr', positiveAction: 'BOT', retryDays: 4 });
    const row = await prisma.leadAiSettings.findUniqueOrThrow({ where: { orgId: orgA() } });
    expect(row).toMatchObject({ tagPositive: 'quente-sdr', positiveAction: 'BOT', instructions: 'Descubra o veículo e o vencimento.' });
    expect((await a.get('/api/mckmensagem/ia-leads')).body.settings.tagPositive).toBe('quente-sdr');

    const id = await leadContatado(a, '5511944440002', 'Hugo');
    await sendInbound(ctx, '5511944440002', 'quero sim');
    const lead = await prisma.lead.findUniqueOrThrow({ where: { id } });
    expect(lead.status).toBe('QUALIFICADO');
    const c = await prisma.contact.findUniqueOrThrow({ where: { id: lead.contactId! } });
    expect(JSON.parse(c.tags)).toContain('quente-sdr');
    expect((await prisma.conversation.findFirstOrThrow({ where: { contactId: c.id } })).mode).toBe('BOT');

    // A rota antiga também grava na mesma fonte (apps abertos antes do deploy).
    expect((await a.put('/api/mckmensagem/ia-leads', { offer: 'cotação em 5 minutos' })).status).toBe(200);
    expect((await a.get('/api/sdr/qualificacao')).body.settings.offer).toBe('cotação em 5 minutos');
    // Validação de fluxo continua.
    expect((await a.put('/api/sdr/qualificacao', { positiveAction: 'FLOW', positiveFlowId: null })).status).toBe(400);
  });

  it('resposta de campanha vai para o lead do SDR da mesma pessoa (etapa Qualificado + histórico)', async () => {
    expect((await a.put('/api/sdr/config', { enabled: true })).status).toBe(200);
    const sl = await a.post('/api/sdr/leads', { name: 'Iris', phone: '11944440003', consent: true });
    expect(sl.status).toBe(201);
    // O SDR já ligou a pessoa ao contato e ao lead do MCK Mensagens (mesmo telefone): a campanha abordou esse lead.
    const mm = await prisma.lead.findFirstOrThrow({ where: { orgId: orgA(), phone: '+5511944440003' } });
    await prisma.lead.update({ where: { id: mm.id }, data: { status: 'CONTATADO' } });
    await sendInbound(ctx, '5511944440003', 'quero sim');
    const { flushSdr } = await import('../../server/sdr/ai.js');
    await flushSdr();
    const s = await prisma.sdrLead.findUniqueOrThrow({ where: { id: sl.body.id } });
    expect(s.stage).toBe('QUALIFICADO');
    expect(await prisma.sdrEvent.count({ where: { leadId: s.id, type: 'QUALIFICACAO', detail: { startsWith: 'Resposta de campanha: interessado' } } })).toBe(1);
  });

  it('acesso: só MCK Mensagens mantém a qualificação; extras do SDR seguem o Plano Completo; MCK Mensagens vencido só consulta', async () => {
    const c = await registerClient();
    const orgC = c.me.org.id;
    await prisma.subscription.update({ where: { orgId_product: { orgId: orgC, product: 'MCKBOT' } }, data: { validUntil: new Date(Date.now() - DAY) } });
    clearSdrAccessCache();
    const acc = await c.get('/api/sdr/acesso');
    expect(acc.body).toMatchObject({ liberado: false, qualificacao: { liberado: true, motivo: 'MCK_MENSAGENS' } });
    expect((await c.get('/api/sdr/leads')).status).toBe(402); // extras do SDR: Plano Completo
    expect((await c.get('/api/sdr/qualificacao')).status).toBe(200);
    expect((await c.put('/api/sdr/qualificacao', { enabled: true, offer: 'visita grátis' })).status).toBe(200);

    // MCK Mensagens vencido: consulta, mas não salva (como antes).
    await prisma.subscription.update({ where: { orgId_product: { orgId: orgC, product: 'MCKMENSAGEM' } }, data: { validUntil: new Date(Date.now() - DAY) } });
    clearSdrAccessCache();
    expect((await c.get('/api/sdr/qualificacao')).body.settings.offer).toBe('visita grátis');
    expect((await c.put('/api/sdr/qualificacao', { offer: 'outra' })).status).toBe(402);
    expect((await c.get('/api/sdr/acesso')).body.qualificacao).toMatchObject({ liberado: false, leitura: true });

  });
});
