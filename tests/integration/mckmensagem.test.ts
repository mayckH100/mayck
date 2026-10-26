import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { registerClient, Client, createTestChannel, installGraphMock, sendInbound, prisma } from '../helpers.js';
import { tick, setSender, setRandom, resetDispatcherState, personalize, inWindow } from '../../server/mckmensagem/dispatcher.js';

// 2026-10-26 13:00 em São Paulo (UTC-3) = 16:00 UTC
const at = (hhmmLocal: string, day = 26) => {
  const [h, m] = hhmmLocal.split(':').map(Number);
  return new Date(Date.UTC(2026, 9, day, h + 3, m, 0));
};

const sent: { to: string; text: string }[] = [];
let failNext = false;

describe('MCKMENSAGEM', () => {
  let owner: Client;
  let other: Client;
  let channelId: string;
  let ctx: Awaited<ReturnType<typeof createTestChannel>>;

  beforeAll(async () => {
    installGraphMock();
    setRandom(() => 0);
    setSender((async (args: any) => {
      sent.push({ to: args.contact.waId, text: args.payload.text });
      if (failNext) { failNext = false; return { status: 'FAILED', error: 'Erro simulado' } as any; }
      return { status: 'SENT', error: null } as any;
    }) as any);
    owner = await registerClient();
    other = await registerClient();
    ctx = await createTestChannel(owner.me.org.id);
    channelId = ctx.ch.id;
  });
  afterAll(() => { setSender(null); setRandom(null); });
  beforeEach(async () => {
    sent.length = 0;
    resetDispatcherState();
    // Isola as campanhas entre os testes: só a campanha do teste corrente fica em andamento.
    await prisma.campaign.updateMany({ where: { status: 'EM_ANDAMENTO' }, data: { status: 'PAUSADA' } });
  });

  it('funções puras: personalização e janela de horário', () => {
    expect(personalize('Oi {nome}, tudo bem?', { name: 'Ana Souza' })).toBe('Oi Ana, tudo bem?');
    expect(personalize('Oi {nome}, tudo bem?', { name: null })).toBe('Oi, tudo bem?');
    const c = { windowStart: '09:00', windowEnd: '20:00' };
    expect(inWindow(c, at('08:59'))).toBe(false);
    expect(inWindow(c, at('09:00'))).toBe(true);
    expect(inWindow(c, at('19:59'))).toBe(true);
    expect(inWindow(c, at('20:00'))).toBe(false);
  });

  it('exige consentimento ao criar lead e na importação CSV', async () => {
    expect((await owner.post('/api/mckmensagem/leads', { phone: '11911110000', name: 'Sem consentimento' })).status).toBe(400);
    const ok = await owner.post('/api/mckmensagem/leads', { phone: '(11) 91111-0001', name: 'Ana', consentSource: 'FORMULARIO' });
    expect(ok.status).toBe(201);
    expect(ok.body.phone).toBe('+5511911110001');
    expect(ok.body.consentAt).toBeTruthy();
    expect((await owner.post('/api/mckmensagem/leads', { phone: '5511911110001', consentSource: 'MANUAL' })).status).toBe(409);

    const csv = 'phone,name,tags\n11911110002,Bia,vip|sp\ninvalido,X,\n5511911110001,Ana,novo';
    expect((await owner.post('/api/mckmensagem/leads/import', { text: csv })).status).toBe(400);
    expect((await owner.post('/api/mckmensagem/leads/import', { text: csv, consentDeclared: false })).status).toBe(400);
    const imp = await owner.post('/api/mckmensagem/leads/import', { text: csv, consentDeclared: true });
    expect(imp.status).toBe(200);
    expect(imp.body).toMatchObject({ created: 1, updated: 1 });
    expect(imp.body.errors[0]).toMatch(/Linha 3/);
    const bia = await prisma.lead.findFirstOrThrow({ where: { orgId: owner.me.org.id, phone: '+5511911110002' } });
    expect(bia.consentSource).toBe('IMPORTACAO');
    expect(JSON.parse(bia.tags)).toEqual(['vip', 'sp']);

    const exp = await owner.get('/api/mckmensagem/leads/export');
    expect(exp.status).toBe(200);
    expect(exp.headers['content-type']).toMatch(/text\/csv/);
    expect(exp.text).toContain('+5511911110002,Bia,vip|sp,NOVO,IMPORTACAO');
  });

  it('respeita janela de horário, limite diário e intervalo; personaliza {nome}; marca CONTATADO', async () => {
    const camp = await owner.post('/api/mckmensagem/campaigns', { name: 'Black Friday', message: 'Oi {nome}! Temos novidades.', channelId, dailyLimit: 2, minIntervalSec: 45, maxIntervalSec: 120 });
    expect(camp.status).toBe(201);
    expect(camp.body).toMatchObject({ status: 'RASCUNHO', windowStart: '09:00', windowEnd: '20:00' });
    const id = camp.body.id;
    for (const [i, n] of ['Caio', 'Duda', 'Edu'].entries()) {
      expect((await owner.post('/api/mckmensagem/leads', { phone: `551192222000${i}`, name: n, consentSource: 'ANUNCIO_CTWA', campaignId: id })).status).toBe(201);
    }
    const st = await owner.post(`/api/mckmensagem/campaigns/${id}/start`, {});
    expect(st.status).toBe(200);
    expect(st.body).toMatchObject({ status: 'EM_ANDAMENTO', added: 3, pending: 3 });

    // Fora da janela (07:00 local): nada é enviado.
    expect((await tick(at('07:00'))).find((r) => r.campaignId === id)?.action).toBe('outside_window');
    expect(sent).toHaveLength(0);

    expect((await tick(at('10:00'))).find((r) => r.campaignId === id)?.action).toBe('sent');
    expect(sent[0]).toEqual({ to: '5511922220000', text: 'Oi Caio! Temos novidades.' });
    // Intervalo mínimo de 45 s ainda não passou.
    expect((await tick(new Date(at('10:00').getTime() + 30_000))).find((r) => r.campaignId === id)?.action).toBe('waiting_interval');
    expect((await tick(at('10:01'))).find((r) => r.campaignId === id)?.action).toBe('sent');
    // Limite diário (2) atingido.
    expect((await tick(at('10:05'))).find((r) => r.campaignId === id)?.action).toBe('daily_limit');
    expect(sent).toHaveLength(2);
    // Dia seguinte: volta a enviar e conclui a campanha.
    expect((await tick(at('09:30', 27))).find((r) => r.campaignId === id)?.action).toBe('sent');
    expect((await tick(at('09:35', 27))).find((r) => r.campaignId === id)?.action).toBe('completed');
    expect(sent.map((s) => s.text)).toEqual(['Oi Caio! Temos novidades.', 'Oi Duda! Temos novidades.', 'Oi Edu! Temos novidades.']);

    const leads = await prisma.lead.findMany({ where: { campaignId: id } });
    expect(leads.every((l) => l.status === 'CONTATADO' && l.contactId)).toBe(true);
    expect((await owner.get(`/api/mckmensagem/campaigns/${id}`)).body).toMatchObject({ status: 'CONCLUIDA', recipients: { ENVIADA: 3 } });
  });

  it('pula lead com opt-out e registra falha de envio', async () => {
    const camp = await owner.post('/api/mckmensagem/campaigns', { name: 'Opt-out', message: 'Olá {nome}', channelId, windowStart: '00:00', windowEnd: '23:59' });
    const id = camp.body.id;
    const a = await owner.post('/api/mckmensagem/leads', { phone: '5511933330000', name: 'Fábio', consentSource: 'FORMULARIO', campaignId: id });
    const b = await owner.post('/api/mckmensagem/leads', { phone: '5511933330001', name: 'Gabi', consentSource: 'FORMULARIO', campaignId: id });
    const c = await owner.post('/api/mckmensagem/leads', { phone: '5511933330002', name: 'Hugo', consentSource: 'FORMULARIO', campaignId: id });
    await owner.post(`/api/mckmensagem/campaigns/${id}/start`, {});
    // Opt-out depois de entrar na fila: deve ser ignorado no envio.
    expect((await owner.patch(`/api/mckmensagem/leads/${a.body.id}`, { optOut: true })).body.optOutAt).toBeTruthy();
    failNext = true;
    expect((await tick(at('12:00'))).find((r) => r.campaignId === id)?.action).toBe('failed');
    expect((await tick(at('12:05'))).find((r) => r.campaignId === id)?.action).toBe('sent');
    expect(sent.map((s) => s.to)).toEqual(['5511933330001', '5511933330002']);
    const recs = await prisma.campaignRecipient.findMany({ where: { campaignId: id } });
    const byLead = Object.fromEntries(recs.map((r) => [r.leadId, r]));
    expect(byLead[a.body.id].status).toBe('IGNORADA');
    expect(byLead[b.body.id]).toMatchObject({ status: 'FALHOU', error: 'Erro simulado' });
    expect(byLead[c.body.id].status).toBe('ENVIADA');
    // Lead com opt-out não entra em nova campanha.
    const camp2 = await owner.post('/api/mckmensagem/campaigns', { name: 'Só opt-out', message: 'x', channelId });
    expect((await owner.post(`/api/mckmensagem/campaigns/${camp2.body.id}/start`, { leadIds: [a.body.id] })).status).toBe(400);
  });

  it('resposta do lead marca RESPONDEU; "SAIR" registra opt-out; métricas', async () => {
    const camp = await owner.post('/api/mckmensagem/campaigns', { name: 'Respostas', message: 'Oi {nome}', channelId, windowStart: '00:00', windowEnd: '23:59' });
    const id = camp.body.id;
    await owner.post('/api/mckmensagem/leads', { phone: '5511944440000', name: 'Iris', consentSource: 'MANUAL', campaignId: id });
    await owner.post('/api/mckmensagem/leads', { phone: '5511944440001', name: 'João', consentSource: 'MANUAL', campaignId: id });
    await owner.post(`/api/mckmensagem/campaigns/${id}/start`, {});
    await tick(at('11:00'));
    await tick(at('11:05'));
    expect(sent).toHaveLength(2);

    expect((await sendInbound(ctx, '5511944440000', 'Tenho interesse!')).res.status).toBe(200);
    expect((await sendInbound(ctx, '5511944440001', 'SAIR')).res.status).toBe(200);
    const iris = await prisma.lead.findFirstOrThrow({ where: { orgId: owner.me.org.id, phone: '+5511944440000' } });
    const joao = await prisma.lead.findFirstOrThrow({ where: { orgId: owner.me.org.id, phone: '+5511944440001' } });
    expect(iris.status).toBe('RESPONDEU');
    expect(joao.optOutAt).toBeTruthy();
    expect(joao.status).toBe('CONTATADO');

    await owner.patch(`/api/mckmensagem/leads/${iris.id}`, { status: 'CONVERTIDO' });
    const m = await owner.get(`/api/mckmensagem/metrics?campaignId=${id}`);
    expect(m.body).toMatchObject({ totalLeads: 2, sent: 2, replies: 1, optOuts: 1, responseRate: 50, conversionRate: 50 });
    expect(m.body.byStatus).toMatchObject({ CONVERTIDO: 1, CONTATADO: 1 });
    expect((await owner.get('/api/mckmensagem/metrics')).status).toBe(200);
  });

  it('isolamento entre organizações', async () => {
    const lead = await owner.post('/api/mckmensagem/leads', { phone: '5511955550000', name: 'Privado', consentSource: 'MANUAL' });
    const camp = await owner.post('/api/mckmensagem/campaigns', { name: 'Privada', message: 'x', channelId });
    expect((await other.get(`/api/mckmensagem/leads/${lead.body.id}`)).status).toBe(404);
    expect((await other.patch(`/api/mckmensagem/leads/${lead.body.id}`, { name: 'hack' })).status).toBe(404);
    expect((await other.del(`/api/mckmensagem/leads/${lead.body.id}`)).status).toBe(404);
    expect((await other.get(`/api/mckmensagem/campaigns/${camp.body.id}`)).status).toBe(404);
    expect((await other.post(`/api/mckmensagem/campaigns/${camp.body.id}/start`, {})).status).toBe(404);
    expect((await other.post('/api/mckmensagem/campaigns', { name: 'Roubo', message: 'x', channelId })).status).toBe(400);
    expect((await other.get('/api/mckmensagem/leads')).body.items).toHaveLength(0);
    expect((await other.get('/api/mckmensagem/campaigns')).body).toHaveLength(0);
    expect((await other.get('/api/mckmensagem/metrics')).body.totalLeads).toBe(0);
    // Mesmo telefone pode existir como lead em outra organização.
    expect((await other.post('/api/mckmensagem/leads', { phone: '5511955550000', consentSource: 'MANUAL' })).status).toBe(201);
    expect((await other.post(`/api/mckmensagem/campaigns/${camp.body.id}/start`, { leadIds: [lead.body.id] })).status).toBe(404);
    // Sem login: 401.
    expect((await new Client().get('/api/mckmensagem/leads')).status).toBe(401);
  });
});
