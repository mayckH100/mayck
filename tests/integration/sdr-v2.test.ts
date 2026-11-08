import { describe, it, expect, beforeAll } from 'vitest';
import { app, registerClient, Client, prisma, uniq } from '../helpers.js';
import { syncSdrStageToKanban } from '../../server/sdr/kanbanSync.js';
import { tickSdr, registerReply, getSdrSettings } from '../../server/sdr/service.js';
import { outbox } from '../../server/lib/mailer.js';
import request from 'supertest';

/** SDR v2 (v1.19.0): Kanban, rodízio, relatórios, resposta por e-mail e formulário incorporável. */
const ALL_DAY = { workStart: '00:00', workEnd: '23:59', workDays: '0,1,2,3,4,5,6' };
const phone = () => `55119${Math.floor(10000000 + Math.random() * 89999999)}`;
const lead = (id: string) => prisma.sdrLead.findUniqueOrThrow({ where: { id } });
const DAY = 24 * 3600 * 1000;

describe('SDR v2', () => {
  let a: Client;
  const orgA = () => a.me.org.id;
  const stageId = async (name: string) => (await prisma.kanbanStage.findFirstOrThrow({ where: { orgId: orgA(), name } })).id;
  const contactStage = async (contactId: string) => {
    const c = await prisma.contact.findUniqueOrThrow({ where: { id: contactId } });
    return c.stageId ? (await prisma.kanbanStage.findUniqueOrThrow({ where: { id: c.stageId } })).name : null;
  };

  beforeAll(async () => {
    a = await registerClient();
    const r = await a.put('/api/sdr/config', { enabled: true, ...ALL_DAY });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ kanbanSync: true, rodizio: { enabled: false, members: [] }, embedDomains: [] });
  });

  it('1) etapa do SDR ↔ Kanban do MCKBOT (contato ligado)', async () => {
    const r = await a.post('/api/sdr/leads', { name: 'Kátia', phone: phone(), consent: true });
    expect(r.status).toBe(201);
    const l0 = await lead(r.body.id);
    expect(l0.contactId).toBeTruthy();
    const cid = l0.contactId!;
    // SDR → Kanban (manual na tela do SDR).
    expect((await a.patch(`/api/sdr/leads/${l0.id}`, { stage: 'QUALIFICADO' })).status).toBe(200);
    expect(await contactStage(cid)).toBe('Qualificado');
    expect(await prisma.sdrEvent.count({ where: { leadId: l0.id, type: 'KANBAN' } })).toBe(1);
    // Kanban → SDR (equipe arrasta para Ganho): lead vira GANHO e a cadência para.
    expect((await a.post('/api/kanban/move', { contactId: cid, stageId: await stageId('Ganho') })).status).toBe(200);
    const l1 = await lead(l0.id);
    expect(l1).toMatchObject({ stage: 'GANHO', cadenceStatus: 'PARADA', stopReason: 'GANHO' });
    expect(await contactStage(cid)).toBe('Ganho');
    // Automação não tira o contato de Ganho no Kanban.
    expect(await syncSdrStageToKanban(l1, 'QUALIFICADO')).toBeNull();
    expect(await contactStage(cid)).toBe('Ganho');
    // Etapa sem nome correspondente no Kanban ("Em atendimento") não mexe no SDR.
    expect((await a.patch(`/api/contacts/${cid}`, { stageId: await stageId('Em atendimento') })).status).toBe(200);
    expect((await lead(l0.id)).stage).toBe('GANHO');
    // Reunião sem etapa no Kanban: usa "Reunião agendada" (a mesma da Agenda).
    expect((await a.patch(`/api/sdr/leads/${l0.id}`, { stage: 'REUNIAO' })).status).toBe(200);
    expect(await contactStage(cid)).toBe('Reunião agendada');
    // Desligado: nada sincroniza.
    expect((await a.put('/api/sdr/config', { kanbanSync: false })).body.kanbanSync).toBe(false);
    expect((await a.patch(`/api/sdr/leads/${l0.id}`, { stage: 'PERDIDO' })).status).toBe(200);
    expect(await contactStage(cid)).toBe('Reunião agendada');
    await a.post('/api/kanban/move', { contactId: cid, stageId: await stageId('Qualificado') });
    expect((await lead(l0.id)).stage).toBe('PERDIDO');
    expect((await a.put('/api/sdr/config', { kanbanSync: true })).body.kanbanSync).toBe(true);
  });

  it('2) rodízio: leads novos sem dono vão um para cada membro escolhido, em ordem', async () => {
    const u2 = await prisma.user.create({ data: { email: `${uniq('rod')}@t.com.br`, name: 'Bia Rodízio', passwordHash: 'x' } });
    await prisma.membership.create({ data: { userId: u2.id, orgId: orgA(), role: 'AGENT' } });
    const me = a.me.user.id;
    const outsider = await registerClient();
    expect((await a.put('/api/sdr/config', { rodizio: { enabled: true, members: [me, outsider.me.user.id] } })).status).toBe(400);
    expect((await a.put('/api/sdr/config', { rodizio: { enabled: true, members: [] } })).status).toBe(400);
    const cfg = await a.put('/api/sdr/config', { rodizio: { enabled: true, members: [me, u2.id] } });
    expect(cfg.status).toBe(200);
    expect(cfg.body.rodizio).toEqual({ enabled: true, members: [me, u2.id] });
    expect(cfg.body.team.map((t: any) => t.id)).toEqual(expect.arrayContaining([me, u2.id]));
    const owners: string[] = [];
    for (let i = 0; i < 4; i++) owners.push((await a.post('/api/sdr/leads', { name: `R${i}`, email: `${uniq('rod')}@x.com.br` })).body.ownerUserId);
    expect(new Set([owners[0], owners[1]])).toEqual(new Set([me, u2.id]));
    expect(owners[2]).toBe(owners[0]);
    expect(owners[3]).toBe(owners[1]);
    // Quem já vem com dono não entra no rodízio.
    expect((await a.post('/api/sdr/leads', { email: `${uniq('rod')}@x.com.br`, ownerUserId: me })).body.ownerUserId).toBe(me);
    // Histórico mostra o rodízio sem marca interna.
    const fr = await a.post('/api/sdr/leads', { email: `${uniq('rod')}@x.com.br` });
    const h = await a.get(`/api/sdr/leads/${fr.body.id}`);
    const dono = h.body.events.find((e: any) => e.type === 'DONO');
    expect(dono.detail).toMatch(/^Rodízio: /);
    // Distribuir os antigos sem dono.
    await a.put('/api/sdr/config', { rodizio: { enabled: false, members: [me, u2.id] } });
    const semDono = await a.post('/api/sdr/leads', { email: `${uniq('rod')}@x.com.br` });
    expect(semDono.body.ownerUserId).toBeNull();
    expect((await a.post('/api/sdr/rodizio/distribuir')).status).toBe(400);
    await a.put('/api/sdr/config', { rodizio: { enabled: true, members: [me, u2.id] } });
    const d = await a.post('/api/sdr/rodizio/distribuir');
    expect(d.body.distribuidos).toBeGreaterThanOrEqual(1);
    expect((await lead(semDono.body.id)).ownerUserId).toBeTruthy();
    await a.put('/api/sdr/config', { rodizio: { enabled: false, members: [] } });
  });

  it('3) relatório por cadência e por passo, com CSV', async () => {
    const email = `${uniq('rel')}@cliente.com.br`;
    const r = await a.post('/api/sdr/leads', { name: 'Rel', email, consent: true, segment: 'seguros' });
    await tickSdr(new Date(Date.now() + DAY + 1000)); // dia 0 (WhatsApp) pulado: sem telefone; dia 1: e-mail
    expect(outbox.some((m) => m.to === email && m.kind === 'sdr')).toBe(true);
    const ev = await prisma.sdrEvent.findFirstOrThrow({ where: { leadId: r.body.id, type: 'ENVIO' } });
    expect(ev.detail).toMatch(/^\[c:[^#]+#1\] Passo do dia 1/);
    await registerReply(await lead(r.body.id), 'EMAIL', await getSdrSettings(orgA()));
    const rel = await a.get('/api/sdr/relatorio?dias=7');
    expect(rel.status).toBe(200);
    const c = rel.body.cadencias.find((x: any) => x.segment === 'seguros');
    expect(c).toMatchObject({ leads: 1, enviados: 1, respondidos: 1, taxaResposta: 100, segmentLabel: 'Corretora de seguros' });
    expect(c.passos[1]).toMatchObject({ indice: 1, canal: 'EMAIL', enviados: 1, respondidos: 1 });
    // Histórico do lead sem a marca interna.
    const h = await a.get(`/api/sdr/leads/${r.body.id}`);
    expect(h.body.events.find((e: any) => e.type === 'ENVIO').detail).toBe('Passo do dia 1');
    const csv = await a.get('/api/sdr/relatorio.csv?dias=7');
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.headers['content-disposition']).toContain('sdr-cadencias-7-dias.csv');
    expect(csv.text).toContain('Corretora de seguros;Total;;;1;1;1;0;0;100');
    expect((await request(app).get('/api/sdr/relatorio.csv')).status).toBe(401);
  });

  it('4) resposta por e-mail (webhook de entrada do Brevo) para a cadência; desligado sem segredo', async () => {
    const SECRET = 'segredo-de-teste-123456';
    const post = (body: unknown, auth?: string) => { const r = request(app).post('/api/public/sdr/email').send(body as object); return auth ? r.set('Authorization', auth) : r; };
    delete process.env.SDR_INBOUND_SECRET;
    expect((await post({ items: [] })).status).toBe(404);
    process.env.SDR_INBOUND_SECRET = SECRET;
    process.env.SDR_INBOUND_DOMAIN = 'resposta.exemplo.com.br';
    try {
      expect((await post({ items: [] })).status).toBe(401);
      expect((await post({ items: [] }, 'Bearer errado-errado-errado-errado')).status).toBe(401);
      expect((await post({ items: [] }, `Bearer ${SECRET}`)).status).toBe(200);
      expect((await request(app).post(`/api/public/sdr/email?token=${SECRET}`).send({ items: [] })).status).toBe(200);
      expect((await a.get('/api/sdr/config')).body.emailReplies).toBe(true);
      // E-mail do SDR sai com "Responder para" ligado ao lead.
      const mk = async (tag: string) => {
        const email = `${uniq(tag)}@cliente.com.br`;
        const r = await a.post('/api/sdr/leads', { name: tag, email, consent: true });
        await tickSdr(new Date(Date.now() + DAY + 1000));
        const l = await lead(r.body.id);
        const m = outbox.filter((x) => x.to === email).at(-1)!;
        expect(m.replyTo).toBe(`sdr-${l.unsubToken}@resposta.exemplo.com.br`);
        expect(l.cadenceStatus).toBe('ATIVA');
        return { l, email, replyTo: m.replyTo! };
      };
      const x = await mk('resp');
      // Resposta automática (férias) não conta como resposta: fica no histórico marcada (v1.22.0) e a cadência segue.
      const auto = await post({ items: [{ From: { Address: x.email }, To: [{ Address: x.replyTo }], Subject: 'Resposta automática: estou de férias', Headers: { 'Auto-Submitted': 'auto-replied' }, ExtractedMarkdownMessage: 'Volto dia 20.' }] }, `Bearer ${SECRET}`);
      expect(auto.body.itens).toEqual(['automatica']);
      expect((await lead(x.l.id)).cadenceStatus).toBe('ATIVA');
      expect(await prisma.sdrEvent.findFirst({ where: { leadId: x.l.id, type: 'AUTORESPOSTA' } })).toBeTruthy();
      // Resposta de verdade: cadência para e o texto fica no histórico.
      const ok = await post({ items: [{ From: { Name: 'Resp', Address: 'outro-endereco@cliente.com.br' }, To: [{ Address: x.replyTo }], Subject: 'Re: posso te ajudar?', ExtractedMarkdownMessage: 'Tenho interesse, me liga amanhã.', RawTextBody: 'Tenho interesse\n> citação' }] }, `Bearer ${SECRET}`);
      expect(ok.body.itens).toEqual(['resposta']);
      expect(await lead(x.l.id)).toMatchObject({ cadenceStatus: 'PARADA', stopReason: 'RESPONDEU', stage: 'RESPONDEU' });
      expect((await prisma.sdrEvent.findFirstOrThrow({ where: { leadId: x.l.id, type: 'NOTA', channel: 'EMAIL' } })).detail).toContain('Tenho interesse');
      // Sem token no endereço: vale o remetente que já recebeu e-mail do SDR; "descadastrar" = pedido para sair.
      const y = await mk('desc');
      const un = await post({ items: [{ From: { Address: y.email }, To: [{ Address: 'contato@outra.com.br' }], Subject: 'Re: oi', ExtractedMarkdownMessage: 'Por favor, me descadastre.' }] }, `Bearer ${SECRET}`);
      expect(un.body.itens).toEqual(['descadastro']);
      const ly = await lead(y.l.id);
      expect(ly.optOutAt).toBeTruthy();
      expect(ly).toMatchObject({ cadenceStatus: 'PARADA', stopReason: 'SAIU' });
      // Remetente desconhecido ou nunca contatado por e-mail: nada muda.
      const nada = await post({ items: [{ From: { Address: `${uniq('x')}@nada.com.br` }, ExtractedMarkdownMessage: 'oi' }, { From: { Address: 'MAILER-DAEMON@x.com' }, Subject: 'Undeliverable' }] }, 'Basic ' + Buffer.from(`brevo:${SECRET}`).toString('base64'));
      expect(nada.body.itens).toEqual(['sem_lead', 'ignorado']);
    } finally {
      delete process.env.SDR_INBOUND_SECRET;
      delete process.env.SDR_INBOUND_DOMAIN;
    }
    expect((await a.get('/api/sdr/config')).body.emailReplies).toBe(false);
  });

  it('5) formulário incorporável: só a página do formulário em ?embed=1 libera o iframe; resto continua bloqueado', async () => {
    const cfg = (await a.get('/api/sdr/config')).body;
    const token = cfg.formUrl.split('/f/')[1];
    expect(cfg.embedSnippet).toContain(`/f/${token}?embed=1`);
    expect(cfg.embedSnippet).toMatch(/^<iframe src="[^"]+" title="[^"]*" style="[^"]+" loading="lazy"><\/iframe>$/);
    const normal = await request(app).get(`/f/${token}`);
    expect(normal.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(normal.headers['x-frame-options']).toBe('DENY');
    const emb = await request(app).get(`/f/${token}?embed=1`);
    expect(emb.status).toBe(200);
    expect(emb.headers['content-security-policy']).toContain('frame-ancestors https:;');
    expect(emb.headers['content-security-policy']).toContain("script-src 'self'");
    expect(emb.headers['x-frame-options']).toBeUndefined();
    expect(emb.text).toContain(`action="/f/${token}?embed=1"`);
    // Lista de sites: só eles podem mostrar.
    const put = await a.put('/api/sdr/config', { embedDomains: ['https://www.minhaloja.com.br/contato', 'javascript:x', '*.parceiro.com'] });
    expect(put.body.embedDomains).toEqual(['www.minhaloja.com.br', '*.parceiro.com']);
    const emb2 = await request(app).get(`/f/${token}?embed=1`);
    expect(emb2.headers['content-security-policy']).toContain('frame-ancestors https://www.minhaloja.com.br https://*.parceiro.com');
    // Envio de dentro do iframe (origem do próprio formulário): lead criado, agradecimento também liberado no iframe.
    const tel = phone();
    const ok = await request(app).post(`/f/${token}?embed=1`).type('form').send({ nome: 'Iframe', telefone: tel, consentimento: 'sim' });
    expect(ok.status).toBe(200);
    expect(ok.text).toContain('Recebido');
    expect(ok.headers['x-frame-options']).toBeUndefined();
    const l = await prisma.sdrLead.findFirstOrThrow({ where: { orgId: orgA(), phone: '+' + tel } });
    expect(l.source).toBe('FORMULARIO');
    // Outra origem continua recusada; outras rotas continuam sem iframe.
    expect((await request(app).post(`/f/${token}?embed=1`).set('Origin', 'https://www.minhaloja.com.br').type('form').send({ nome: 'X', telefone: phone(), consentimento: 'sim' })).status).toBe(403);
    expect((await request(app).get('/api/versao?embed=1')).headers['x-frame-options']).toBe('DENY');
    await a.put('/api/sdr/config', { embedDomains: [] });
  });
});
