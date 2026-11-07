import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import request from 'supertest';
import { app, registerClient, Client, createTestChannel, installGraphMock, graph, sendInbound, prisma, uniq } from '../helpers.js';
import { outbox } from '../../server/lib/mailer.js';
import { tickSdr } from '../../server/sdr/service.js';
import { flushSdr } from '../../server/sdr/ai.js';
import { clearSdrAccessCache } from '../../server/sdr/access.js';
import { fakeAi } from '../../server/ai/providers.js';

/** SDR com IA (v1.18.0): pedido do dono em 07/11/2026. */
const DAY = 24 * 3600 * 1000;
const soon = () => new Date(Date.now() + 1000);
const ALL_DAY = { workStart: '00:00', workEnd: '23:59', workDays: '0,1,2,3,4,5,6' };
const phone = () => `55119${Math.floor(10000000 + Math.random() * 89999999)}`;

async function lead(id: string) { return prisma.sdrLead.findUniqueOrThrow({ where: { id } }); }

describe('SDR com IA', () => {
  let a: Client; // empresa A (Plano Completo em teste)
  let b: Client; // empresa B (para isolamento)
  let ctx: Awaited<ReturnType<typeof createTestChannel>>;
  let formToken: string;
  const orgA = () => a.me.org.id;

  beforeAll(async () => {
    installGraphMock();
    a = await registerClient();
    b = await registerClient();
    ctx = await createTestChannel(orgA());
    expect((await a.put('/api/ai/settings', { provider: 'fake', model: 'fake-1', enabled: true, autoReply: false })).status).toBe(200);
    const r = await a.put('/api/sdr/config', { enabled: true, ...ALL_DAY });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ enabled: true, autoMode: true, captureWhatsapp: true, autoBook: true });
    formToken = r.body.formUrl.split('/f/')[1];
  });
  beforeEach(() => graph.reset());

  it('liberação: Plano Completo em teste libera; só um produto não (402); Master liga por plano', async () => {
    const r = await a.get('/api/sdr/acesso');
    expect(r.body).toMatchObject({ liberado: true, motivo: 'PLANO_COMPLETO', enabled: true });
    const c = await registerClient();
    const orgC = c.me.org.id;
    expect((await c.get('/api/sdr/acesso')).body.liberado).toBe(true); // teste do Plano Completo
    await prisma.subscription.update({ where: { orgId_product: { orgId: orgC, product: 'MCKMENSAGEM' } }, data: { validUntil: new Date(Date.now() - DAY) } });
    clearSdrAccessCache();
    expect((await c.get('/api/sdr/acesso')).body).toMatchObject({ liberado: false, motivo: 'SEM_PLANO' });
    const blocked = await c.get('/api/sdr/leads');
    expect(blocked.status).toBe(402);
    expect(blocked.body.code).toBe('SDR_PLANO');
    // Interruptor do Master: cliente comum não acessa; superadmin liga o SDR para quem tem só o MCKBOT.
    expect((await c.put('/api/master/sdr', { MCKBOT: true })).status).toBe(403);
    await prisma.user.update({ where: { id: b.me.user.id }, data: { isSuperAdmin: true } });
    try {
      expect((await b.get('/api/master/sdr')).body).toEqual({ COMBO: true, MCKBOT: false, MCKMENSAGEM: false });
      expect((await b.put('/api/master/sdr', { MCKBOT: true })).body.MCKBOT).toBe(true);
      expect((await c.get('/api/sdr/leads')).status).toBe(200);
      await b.put('/api/master/sdr', { MCKBOT: false });
      expect((await c.get('/api/sdr/leads')).status).toBe(402);
    } finally {
      await prisma.user.update({ where: { id: b.me.user.id }, data: { isSuperAdmin: false } });
      clearSdrAccessCache();
    }
  });

  it('cadências prontas por segmento já existem (cliente não configura nada)', async () => {
    const r = await a.get('/api/sdr/cadencias');
    expect(r.status).toBe(200);
    expect(r.body.items.length).toBeGreaterThanOrEqual(8);
    expect(r.body.items.every((c: any) => c.builtIn && c.steps.length >= 4)).toBe(true);
  });

  it('formulário público → lead com consentimento entra na cadência; WhatsApp dia 0 sai; quando responde, a cadência para', async () => {
    const page = await request(app).get(`/f/${formToken}`);
    expect(page.status).toBe(200);
    expect(page.text).toContain('Autorizo');
    expect((await request(app).get('/f/tokeninexistente123456')).status).toBe(404);
    const tel = phone();
    const semConsent = await request(app).post(`/f/${formToken}`).type('form').send({ nome: 'Ana', telefone: tel });
    expect(semConsent.status).toBe(400);
    const cross = await request(app).post(`/f/${formToken}`).set('Origin', 'https://site-malicioso.example').type('form').send({ nome: 'Ana', telefone: tel, consentimento: 'sim' });
    expect(cross.status).toBe(403);
    const ok = await request(app).post(`/f/${formToken}`).type('form').send({ nome: '<script>alert(1)</script>Ana', telefone: tel.slice(2), email: `${uniq('ana')}@loja.com.br`, segmento: 'varejo', consentimento: 'sim', mensagem: 'quero saber mais' });
    expect(ok.status).toBe(200);
    expect(ok.text).not.toContain('<script>alert');
    const l0 = await prisma.sdrLead.findFirstOrThrow({ where: { orgId: orgA(), phone: '+' + tel } });
    expect(l0).toMatchObject({ source: 'FORMULARIO', cadenceStatus: 'ATIVA', cadenceStep: 0, segment: 'varejo' });
    expect(l0.consentAt).toBeTruthy();
    expect(l0.contactId).toBeTruthy(); // ligado ao contato do MCKBOT
    // API oficial fora da janela de 24 h: primeiro contato livre é proibido pela Meta → passo pulado (sem insistir).
    await tickSdr(soon());
    const skip = await prisma.sdrEvent.findFirst({ where: { leadId: l0.id, type: 'PULO' } });
    expect(skip?.detail).toContain('janela de 24');
    expect(graph.calls.filter((c) => c.body?.to === tel)).toHaveLength(0);
    // Com a janela aberta (o lead falou com a empresa nas últimas 24 h), o WhatsApp do passo sai.
    await prisma.sdrLead.update({ where: { id: l0.id }, data: { cadenceStep: 0, nextStepAt: new Date() } });
    await prisma.conversation.updateMany({ where: { orgId: orgA(), contactId: l0.contactId! }, data: { lastInboundAt: new Date() } });
    await tickSdr(soon());
    const l1 = await lead(l0.id);
    expect(l1).toMatchObject({ stage: 'CONTATADO', cadenceStep: 1, cadenceStatus: 'ATIVA' });
    expect(graph.calls.some((c) => c.body?.to === tel && /^Oi /.test(c.body?.text?.body ?? ''))).toBe(true);
    await sendInbound(ctx, tel, 'oi, tenho interesse');
    await flushSdr();
    const l2 = await lead(l0.id);
    expect(l2).toMatchObject({ cadenceStatus: 'PARADA', stopReason: 'RESPONDEU', stage: 'RESPONDEU' });
    // Parada: o agendador não manda mais nada para ele.
    graph.reset();
    await tickSdr(new Date(Date.now() + 3 * DAY));
    expect(graph.calls.filter((c) => c.body?.to === tel)).toHaveLength(0);
  });

  it('importação CSV: lead frio só por e-mail (WhatsApp pulado), descadastro em todo e-mail, opt-out nunca sobrescrito', async () => {
    const optTel = phone(), coldTel = phone();
    await prisma.contact.create({ data: { orgId: orgA(), waId: optTel, phone: '+' + optTel, optOut: true } });
    const emailOnly = `${uniq('frio')}@empresa.com.br`, emailCold = `${uniq('frio2')}@empresa.com.br`;
    const csv = `nome;empresa;telefone;email\nFrio Email;Emp A;;${emailOnly}\nSaiu Antes;Emp B;${optTel};\nFrio Tel;Emp C;${coldTel};${emailCold}\n;;123;sem-email\n`;
    const r = await a.post('/api/sdr/importar', { csv });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ linhas: 4, criados: 3, comOptOut: 1 });
    expect(r.body.erros).toHaveLength(1);
    const lo = await prisma.sdrLead.findFirstOrThrow({ where: { orgId: orgA(), phone: '+' + optTel } });
    expect(lo.optOutAt).toBeTruthy();
    expect(lo.source).toBe('IMPORTACAO');
    expect(lo.cadenceStatus).toBe('SEM');
    const before = outbox.length;
    await tickSdr(soon());
    // "Frio Tel": passo de WhatsApp (dia 0) pulado por falta de consentimento; nenhum WhatsApp enviado.
    const lc = await prisma.sdrLead.findFirstOrThrow({ where: { orgId: orgA(), phone: '+' + coldTel } });
    expect(graph.calls.filter((c) => c.body?.to === coldTel)).toHaveLength(0);
    const pulo = await prisma.sdrEvent.findFirst({ where: { leadId: lc.id, type: 'PULO' } });
    expect(pulo?.detail).toContain('sem consentimento');
    expect(lc.contactId).toBeNull(); // sem consentimento não vira contato de WhatsApp
    // Passo de e-mail (dia 1) vence depois: e-mail com link de descadastro.
    await tickSdr(new Date(Date.now() + DAY + 1000));
    const mails = outbox.slice(before).filter((m) => m.kind === 'sdr' && m.to === emailOnly);
    expect(mails).toHaveLength(1);
    expect(mails[0].text).toMatch(/\/descadastro\/[A-Za-z0-9_-]{16,}/);
    expect(mails[0].html).toContain('Descadastrar');
    // Reimportar com consentimento não tira o opt-out.
    const again = await a.post('/api/sdr/importar', { csv, consentimento: true });
    expect(again.body.criados).toBe(0);
    expect((await lead(lo.id)).optOutAt).toBeTruthy();
    // Descadastro pelo link: GET só mostra a página; POST descadastra e para a cadência.
    const le = await prisma.sdrLead.findFirstOrThrow({ where: { orgId: orgA(), email: emailOnly } });
    const pg = await request(app).get(`/descadastro/${le.unsubToken}`);
    expect(pg.status).toBe(200);
    expect((await lead(le.id)).optOutAt).toBeNull();
    expect((await request(app).post(`/descadastro/${le.unsubToken}`).type('form').send({})).status).toBe(200);
    const le2 = await lead(le.id);
    expect(le2.optOutAt).toBeTruthy();
    expect(le2.cadenceStatus).toBe('PARADA');
    const n = outbox.length;
    await tickSdr(new Date(Date.now() + 8 * DAY));
    expect(outbox.slice(n).filter((m) => m.to === emailOnly)).toHaveLength(0);
  });

  it('SAIR no WhatsApp: opt-out e cadência parada', async () => {
    const tel = phone();
    const r = await a.post('/api/sdr/leads', { name: 'Caio', phone: tel, consent: true });
    expect(r.status).toBe(201);
    expect(r.body.cadenceStatus).toBe('ATIVA');
    await sendInbound(ctx, tel, 'SAIR');
    await flushSdr();
    const l = await lead(r.body.id);
    expect(l.optOutAt).toBeTruthy();
    expect(l).toMatchObject({ cadenceStatus: 'PARADA', stopReason: 'SAIU' });
    // Novo cadastro do mesmo número não tira o opt-out nem volta para a cadência.
    const again = await a.post('/api/sdr/leads', { phone: tel, consent: true });
    expect(again.body.optOut).toBe(true);
    expect(again.body.cadenceStatus).toBe('PARADA');
  });

  it('quem chama no WhatsApp vira lead; IA qualifica (0–100), lead quente gera aviso e NÃO transfere; reunião marcada para a cadência', async () => {
    const tel = phone();
    fakeAi.script = [];
    await sendInbound(ctx, tel, 'Preciso automatizar o atendimento urgente, somos 5 funcionários e tenho orçamento');
    await flushSdr();
    const l = await prisma.sdrLead.findFirstOrThrow({ where: { orgId: orgA(), phone: '+' + tel } });
    expect(l.source).toBe('WHATSAPP');
    expect(l.score).toBe(87);
    expect(l.temperature).toBe('QUENTE');
    expect(l.stage).toBe('QUALIFICADO');
    expect(l.hotAlertAt).toBeTruthy();
    expect(l.cadenceStatus).toBe('ESPERA'); // acompanhamento só se parar de responder
    expect(await prisma.sdrEvent.count({ where: { leadId: l.id, type: 'QUENTE' } })).toBe(1);
    const conv = await prisma.conversation.findFirstOrThrow({ where: { orgId: orgA(), contactId: l.contactId! } });
    expect(conv.mode).not.toBe('HUMAN');
    // Segunda mensagem quente não repete o aviso.
    await sendInbound(ctx, tel, 'tenho orçamento sim, é urgente');
    await flushSdr();
    expect(await prisma.sdrEvent.count({ where: { leadId: l.id, type: 'QUENTE' } })).toBe(1);
    // Reunião pela Agenda.
    const d = new Date(Date.now() + 2 * DAY);
    const inicio = `${d.toISOString().slice(0, 10)}T15:00`;
    const m = await a.post(`/api/sdr/leads/${l.id}/reuniao`, { inicio, duracao: 30 });
    expect(m.status).toBe(201);
    const l2 = await lead(l.id);
    expect(l2).toMatchObject({ stage: 'REUNIAO', cadenceStatus: 'PARADA', stopReason: 'AGENDOU', appointmentId: m.body.appointmentId });
    expect(await prisma.appointment.count({ where: { id: m.body.appointmentId, orgId: orgA(), contactId: l.contactId } })).toBe(1);
  });

  it('modo manual: passo espera aprovação; aprovar envia; limite diário respeitado', async () => {
    await a.put('/api/sdr/config', { autoMode: false, dailyLimit: 1000 });
    const e1 = `${uniq('man')}@cliente.com.br`;
    const r = await a.post('/api/sdr/leads', { name: 'Duda', email: e1, consent: true, segment: 'servicos' });
    const n = outbox.length;
    await tickSdr(new Date(Date.now() + DAY + 1000));
    expect((await lead(r.body.id)).cadenceStatus).toBe('APROVACAO');
    expect(outbox.slice(n).filter((m) => m.to === e1)).toHaveLength(0);
    const ok = await a.post(`/api/sdr/leads/${r.body.id}/aprovar`);
    expect(ok.status).toBe(200);
    expect(ok.body.sent).toBe(true);
    expect(outbox.slice(n).filter((m) => m.to === e1)).toHaveLength(1);
    // Limite diário: já há envios hoje → com limite 1, a próxima aprovação é recusada.
    await a.put('/api/sdr/config', { dailyLimit: 1 });
    const r2 = await a.post('/api/sdr/leads', { name: 'Edu', email: `${uniq('man')}@cliente.com.br`, consent: true });
    await tickSdr(new Date(Date.now() + DAY + 1000));
    expect((await lead(r2.body.id)).cadenceStatus).toBe('APROVACAO');
    expect((await a.post(`/api/sdr/leads/${r2.body.id}/aprovar`)).status).toBe(429);
    await a.put('/api/sdr/config', { autoMode: true, dailyLimit: 40 });
  });

  it('painel: funil, métricas, próximas ações e histórico por lead', async () => {
    const p = await a.get('/api/sdr/painel');
    expect(p.status).toBe(200);
    expect(p.body.funil.map((f: any) => f.id)).toEqual(['NOVO', 'CONTATADO', 'RESPONDEU', 'QUALIFICADO', 'REUNIAO', 'GANHO', 'PERDIDO']);
    expect(p.body.metricas.contatados).toBeGreaterThanOrEqual(1);
    expect(p.body.metricas.reunioes).toBeGreaterThanOrEqual(1);
    expect(p.body.quentes.length).toBeGreaterThanOrEqual(1);
    const list = await a.get('/api/sdr/leads?temperature=QUENTE');
    expect(list.body.items.length).toBeGreaterThanOrEqual(1);
    const h = await a.get(`/api/sdr/leads/${list.body.items[0].id}`);
    expect(h.body.events.map((e: any) => e.type)).toEqual(expect.arrayContaining(['CRIADO', 'QUALIFICACAO', 'QUENTE', 'REUNIAO']));
  });

  it('isolamento entre empresas (IDOR): B não lê nem altera nada de A', async () => {
    const r = await a.post('/api/sdr/leads', { name: 'Segredo', email: `${uniq('idor')}@a.com.br` });
    const id = r.body.id;
    const cad = (await a.get('/api/sdr/cadencias')).body.items[0].id;
    expect((await b.get(`/api/sdr/leads/${id}`)).status).toBe(404);
    expect((await b.patch(`/api/sdr/leads/${id}`, { stage: 'GANHO' })).status).toBe(404);
    expect((await b.post(`/api/sdr/leads/${id}/aprovar`)).status).toBe(404);
    expect((await b.post(`/api/sdr/leads/${id}/parar`)).status).toBe(404);
    expect((await b.post(`/api/sdr/leads/${id}/reuniao`, { inicio: '2030-01-10T10:00' })).status).toBe(404);
    expect((await b.put(`/api/sdr/cadencias/${cad}`, { name: 'Invadida' })).status).toBe(404);
    expect((await b.get('/api/sdr/leads')).body.items.some((l: any) => l.id === id)).toBe(false);
    // Responsável de outra empresa é recusado.
    expect((await a.patch(`/api/sdr/leads/${id}`, { ownerUserId: b.me.user.id })).status).toBe(400);
    expect((await lead(id)).stage).toBe('NOVO');
    // Sem login: 401.
    expect((await request(app).get('/api/sdr/leads')).status).toBe(401);
  });
});
