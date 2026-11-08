import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import request from 'supertest';
import { app, registerClient, Client, createTestChannel, installGraphMock, graph, sendInbound, sentTexts, prisma, uniq } from '../helpers.js';
import { tickSdr } from '../../server/sdr/service.js';
import { flushSdr } from '../../server/sdr/ai.js';
import { fakeAi } from '../../server/ai/providers.js';
import { openConversationFor } from '../../server/whatsapp/multiCanal.js';
import { getAutoReplyConfig } from '../../server/sdr/autoReplyConfig.js';
import { outbox } from '../../server/lib/mailer.js';

/**
 * v1.22.0: resposta automática do lead não conta como resposta (não qualifica, não muda etapa, não para a cadência,
 * a IA não responde). Caso real (texto genérico): campanha enviada e a saudação do WhatsApp Business no mesmo minuto.
 */
const CASO_REAL = '*Clínica Médica agradece seu contato* ⚠️ Importante: neste canal *não atendemos chamadas via Whatsapp, não ouvimos mensagens de voz.* Para agilizar seu atendimento, pedimos que envie sua solicitação por *mensagem de texto.* Agradecemos a compreensão!';
const ALL_DAY = { workStart: '00:00', workEnd: '23:59', workDays: '0,1,2,3,4,5,6' };
const DAY = 86400e3;
const phone = () => `55119${Math.floor(10000000 + Math.random() * 89999999)}`;
const soon = () => new Date(Date.now() + 1000);
const sdrLead = (id: string) => prisma.sdrLead.findUniqueOrThrow({ where: { id } });

describe('SDR — resposta automática', () => {
  let a: Client;
  let ctx: Awaited<ReturnType<typeof createTestChannel>>;
  const orgA = () => a.me.org.id;

  beforeAll(async () => {
    installGraphMock();
    a = await registerClient();
    ctx = await createTestChannel(orgA());
    // IA do MCKBOT ligada e respondendo sozinha: se a resposta automática passasse, a IA responderia.
    expect((await a.put('/api/ai/settings', { provider: 'fake', model: 'fake-1', enabled: true, autoReply: true })).status).toBe(200);
    expect((await a.put('/api/sdr/config', { enabled: true, ...ALL_DAY })).status).toBe(200);
    expect((await a.put('/api/mckmensagem/ia-leads', { enabled: true, positiveAction: 'BOT' })).status).toBe(200);
  });
  beforeEach(() => { graph.reset(); fakeAi.script = []; });

  /** Lead de campanha do MCK Mensagens já abordado: contato, conversa e a mensagem da campanha (há poucos segundos). */
  async function campanha(tel: string) {
    const r = await a.post('/api/mckmensagem/leads', { phone: tel, name: 'Lead Campanha', consentSource: 'MANUAL' });
    expect(r.status).toBe(201);
    const contact = await prisma.contact.upsert({ where: { orgId_waId: { orgId: orgA(), waId: tel } }, update: {}, create: { orgId: orgA(), waId: tel, phone: '+' + tel, name: 'Lead Campanha' } });
    await prisma.lead.update({ where: { id: r.body.id }, data: { status: 'CONTATADO', contactId: contact.id } });
    const conv = await openConversationFor(orgA(), contact.id, ctx.ch.id);
    await prisma.conversation.update({ where: { id: conv.id }, data: { lastInboundAt: new Date() } });
    await prisma.message.create({ data: { orgId: orgA(), conversationId: conv.id, channelId: ctx.ch.id, direction: 'OUT', sender: 'bot', type: 'text', body: 'Olá! Temos uma condição especial para clínicas. Posso te explicar?', status: 'SENT', createdAt: new Date(Date.now() - 5_000) } });
    return { leadId: r.body.id as string, contact, conv };
  }

  it('padrão ligado para todas as empresas (inclusive quem nunca salvou) e configuração na aba Inteligência', async () => {
    const b = await registerClient();
    expect(await getAutoReplyConfig(b.me.org.id)).toMatchObject({ enabled: true, acao: 'SEGUIR', iaDuvida: false });
    const g = await a.get('/api/sdr/inteligencia');
    expect(g.body.autoResposta).toMatchObject({ enabled: true, frases: [], acao: 'SEGUIR', pausaHoras: 24 });
    const p = await a.put('/api/sdr/inteligencia', { autoResposta: { frases: 'Bem vindos ao Studio Exemplo\nok', acao: 'SEGUIR' } });
    expect(p.status).toBe(200);
    expect(p.body.autoResposta.frases).toEqual(['Bem vindos ao Studio Exemplo']);
    expect(await prisma.auditLog.findFirst({ where: { orgId: orgA(), action: 'sdr.autoresposta.config' } })).toBeTruthy();
    expect((await a.put('/api/sdr/inteligencia', { autoResposta: { pausaHoras: 500 } })).status).toBe(400);
  });

  it('caso real: saudação da clínica logo após a campanha → IA não responde, lead não muda; humano depois qualifica normalmente', async () => {
    const tel = phone();
    const { leadId, conv } = await campanha(tel);
    const callsBefore = fakeAi.calls.length;
    await sendInbound(ctx, tel, CASO_REAL);
    await flushSdr();
    expect(sentTexts()).toEqual([]); // nenhuma resposta da IA, do fluxo ou da qualificação
    expect(fakeAi.calls.length).toBe(callsBefore); // a IA nem foi chamada (sem gastar cota)
    const lead = await prisma.lead.findUniqueOrThrow({ where: { id: leadId } });
    expect(lead).toMatchObject({ status: 'CONTATADO', qualifyAttempts: 0 });
    const msg = await prisma.message.findFirstOrThrow({ where: { conversationId: conv.id, direction: 'IN' }, orderBy: { createdAt: 'desc' } });
    expect(msg.error).toMatch(/^AUTORESPOSTA: /);
    const note = await prisma.message.findFirstOrThrow({ where: { conversationId: conv.id, direction: 'INTERNAL' }, orderBy: { createdAt: 'desc' } });
    expect(note.body).toContain('Resposta automática identificada');
    expect((await prisma.conversation.findUniqueOrThrow({ where: { id: conv.id } })).mode).not.toBe('HUMAN');
    // Inbox mostra a mensagem com a marca (selo no app).
    const inbox = await a.get(`/api/conversations/${conv.id}`);
    expect(inbox.body.messages.find((m: any) => m.id === msg.id).error).toMatch(/^AUTORESPOSTA/);

    // Agora uma pessoa responde: qualificação normal, e a IA não vê a saudação automática no histórico.
    graph.reset();
    await sendInbound(ctx, tel, 'Oi, sou a responsável. Tenho interesse, quero sim saber o valor');
    await flushSdr();
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: leadId } })).status).toBe('QUALIFICADO');
    expect(sentTexts()).toContain('Resposta positivo da IA');
    const lastCall = fakeAi.calls.at(-1)!.map((m) => m.content).join('\n');
    expect(lastCall).not.toContain('agradece seu contato');
  });

  it('cadência do SDR: resposta automática não para a cadência nem muda etapa; resposta humana depois para', async () => {
    const tel = phone();
    const r = await a.post('/api/sdr/leads', { name: 'Lead SDR', phone: tel, consent: true, segment: 'saude' });
    expect(r.status).toBe(201);
    const l0 = await sdrLead(r.body.id);
    const conv = await openConversationFor(orgA(), l0.contactId!, ctx.ch.id);
    await prisma.conversation.update({ where: { id: conv.id }, data: { lastInboundAt: new Date() } });
    await tickSdr(soon());
    const l1 = await sdrLead(l0.id);
    expect(l1).toMatchObject({ stage: 'CONTATADO', cadenceStatus: 'ATIVA', cadenceStep: 1 });
    graph.reset();
    const callsBefore = fakeAi.calls.length;

    // Celular pessoal (resposta rápida do Android) e repetição do mesmo texto.
    await sendInbound(ctx, tel, 'Estou dirigindo, respondo depois.');
    await flushSdr();
    let l2 = await sdrLead(l0.id);
    expect(l2).toMatchObject({ stage: 'CONTATADO', cadenceStatus: 'ATIVA', cadenceStep: 1, score: 0 });
    expect(l2.lastReplyAt).toBeNull();
    expect(l2.nextStepAt?.getTime()).toBe(l1.nextStepAt?.getTime());
    expect(sentTexts()).toEqual([]);
    expect(fakeAi.calls.length).toBe(callsBefore);
    const ev = await prisma.sdrEvent.findMany({ where: { leadId: l0.id }, orderBy: { createdAt: 'asc' } });
    expect(ev.map((e) => e.type)).toContain('AUTORESPOSTA');
    expect(ev.map((e) => e.type)).not.toContain('RESPOSTA');
    expect(ev.find((e) => e.type === 'AUTORESPOSTA')?.detail).toContain('A cadência segue normalmente');
    // Lead do SDR mostra o selo no histórico.
    const det = await a.get(`/api/sdr/leads/${l0.id}`);
    expect(det.body.events.some((e: any) => e.type === 'AUTORESPOSTA')).toBe(true);

    // Opção "pausar X horas": a próxima automática adia o passo.
    await a.put('/api/sdr/inteligencia', { autoResposta: { acao: 'PAUSAR', pausaHoras: 48 } });
    await sendInbound(ctx, tel, 'No momento não posso atender. Te ligo depois.');
    await flushSdr();
    l2 = await sdrLead(l0.id);
    expect(l2.cadenceStatus).toBe('ATIVA');
    expect(l2.nextStepAt!.getTime()).toBeGreaterThan(Date.now() + 47 * 3600e3);
    await a.put('/api/sdr/inteligencia', { autoResposta: { acao: 'SEGUIR' } });

    // Falso positivo a evitar: pessoa em reunião, mas com interesse → resposta de verdade.
    await sendInbound(ctx, tel, 'Estou em reunião, mas tenho interesse, me manda o valor');
    await flushSdr();
    const l3 = await sdrLead(l0.id);
    expect(l3).toMatchObject({ cadenceStatus: 'PARADA', stopReason: 'RESPONDEU' });
    expect(['RESPONDEU', 'QUALIFICADO']).toContain(l3.stage);
    expect(sentTexts().length).toBeGreaterThan(0); // agora a IA responde normalmente

    // Relatórios: contador de respostas automáticas ignoradas.
    const rel = await a.get('/api/sdr/relatorio?dias=7');
    expect(rel.body.respostasAutomaticas.whatsapp).toBeGreaterThanOrEqual(3);
  });

  it('desligado pela empresa: volta ao comportamento antigo; quem chama primeiro nunca é marcado', async () => {
    const b = await registerClient();
    const cb = await createTestChannel(b.me.org.id);
    await b.put('/api/ai/settings', { provider: 'fake', model: 'fake-1', enabled: true, autoReply: true });
    // Sem envio nosso antes: mesmo um texto de saudação entra como mensagem normal.
    const tel = phone();
    await sendInbound(cb, tel, 'Olá, seja bem-vindo! Retornaremos em breve.');
    const m = await prisma.message.findFirstOrThrow({ where: { orgId: b.me.org.id, direction: 'IN' }, orderBy: { createdAt: 'desc' } });
    expect(m.error).toBeNull();
    // Interruptor desligado (empresa A): a saudação do caso real volta a ser tratada como resposta.
    await a.put('/api/sdr/inteligencia', { autoResposta: { enabled: false } });
    try {
      const t2 = phone();
      const { leadId } = await campanha(t2);
      await sendInbound(ctx, t2, CASO_REAL);
      expect((await prisma.lead.findUniqueOrThrow({ where: { id: leadId } })).status).not.toBe('CONTATADO');
      // Não deixa reabordagem pendente para o agendador global de outros testes (tickLeadRetries).
      await prisma.lead.update({ where: { id: leadId }, data: { status: 'DESCARTADO', nextAttemptAt: null } });
    } finally {
      await a.put('/api/sdr/inteligencia', { autoResposta: { enabled: true } });
    }
  });

  it('e-mail: "fora do escritório" pelo texto fica no histórico como automática e a cadência segue', async () => {
    const SECRET = 'segredo-de-teste-autoresp-123';
    process.env.SDR_INBOUND_SECRET = SECRET;
    try {
      const email = `${uniq('ooo')}@cliente.com.br`;
      const r = await a.post('/api/sdr/leads', { name: 'Lead Email', email, consent: true });
      await tickSdr(new Date(Date.now() + DAY + 1000));
      expect(outbox.some((x) => x.to === email)).toBe(true);
      const before = await sdrLead(r.body.id);
      const post = (body: unknown) => request(app).post('/api/public/sdr/email').set('Authorization', `Bearer ${SECRET}`).send(body as object);
      const ooo = await post({ items: [{ From: { Address: email }, Subject: 'Re: posso te ajudar?', ExtractedMarkdownMessage: 'Olá, estou de férias até 20/11 e responderei quando voltar.' }] });
      expect(ooo.body.itens).toEqual(['automatica']);
      const after = await sdrLead(r.body.id);
      expect(after.cadenceStatus).toBe(before.cadenceStatus);
      expect(after.stage).toBe(before.stage);
      expect(await prisma.sdrEvent.findFirst({ where: { leadId: r.body.id, type: 'AUTORESPOSTA', channel: 'EMAIL' } })).toBeTruthy();
      const rel = await a.get('/api/sdr/relatorio?dias=7');
      expect(rel.body.respostasAutomaticas.email).toBeGreaterThanOrEqual(1);
    } finally {
      delete process.env.SDR_INBOUND_SECRET;
    }
  });
});
