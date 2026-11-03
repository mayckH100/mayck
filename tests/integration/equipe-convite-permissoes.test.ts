import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { registerClient, Client, uniq, prisma, createTestChannel, installGraphMock, sendInbound } from '../helpers.js';
import { setFetch } from '../../server/lib/fetcher.js';
import { outbox, setRealSendInTests } from '../../server/lib/mailer.js';

const H = { 'x-requested-with': 'mckbot' };

async function accept(link: string) {
  const token = link.split('/convite/')[1];
  const c = new Client();
  const r = await c.agent.post('/api/auth/accept-invite').set(H).send({ token, name: 'Membro', password: 'senhaMembro123' });
  expect(r.status).toBe(200);
  c.csrf = r.body.csrfToken;
  c.me = r.body;
  return c;
}
async function invite(owner: Client, body: Record<string, unknown>) {
  const r = await owner.post('/api/team/invites', { email: `${uniq()}@t.dev`, ...body });
  expect(r.status).toBe(201);
  return { res: r, member: await accept(r.body.link) };
}
async function bigPlan(c: Client) { await prisma.organization.update({ where: { id: c.me.org.id }, data: { plan: 'profissional' } }); }

describe('Convite da equipe por e-mail (mesmo provedor dos códigos de cadastro: API do Brevo)', () => {
  const saved = { BREVO_API_KEY: process.env.BREVO_API_KEY, MAIL_FROM: process.env.MAIL_FROM, SMTP_HOST: process.env.SMTP_HOST };
  let brevo: { url: string; body: any; headers: any }[] = [];
  let brevoStatus = 201;
  let owner: Client;
  let other: Client;
  const logs: string[] = [];
  const origInfo = console.info, origErr = console.error, origWarn = console.warn;

  beforeAll(async () => {
    owner = await registerClient();
    other = await registerClient();
    await bigPlan(owner);
    setFetch(async (input, init) => {
      const url = String(input);
      if (url.startsWith('https://api.brevo.com/')) {
        brevo.push({ url, body: JSON.parse(String(init?.body ?? '{}')), headers: init?.headers });
        return new Response(JSON.stringify(brevoStatus < 300 ? { messageId: '<m1@brevo>' } : { code: 'unauthorized', message: 'Key not found' }), { status: brevoStatus, headers: { 'content-type': 'application/json' } });
      }
      throw new Error('rede bloqueada no teste: ' + url);
    });
    setRealSendInTests(true);
    const capture = (...a: unknown[]) => { logs.push(a.map(String).join(' ')); };
    console.info = capture; console.error = capture; console.warn = capture;
  });
  afterAll(() => {
    setRealSendInTests(false);
    console.info = origInfo; console.error = origErr; console.warn = origWarn;
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });
  beforeEach(() => {
    brevo = []; brevoStatus = 201;
    process.env.BREVO_API_KEY = 'xkeysib-teste'; process.env.MAIL_FROM = 'MCKBOT <no-reply@mck.dev>'; delete process.env.SMTP_HOST;
  });

  it('provedor configurado: envia pela API do Brevo, em português, com quem convidou, organização, papel, permissões, botão e validade', async () => {
    const email = `${uniq()}@t.dev`;
    const r = await owner.post('/api/team/invites', { email, role: 'AGENT', modules: ['inbox', 'contatos'] });
    expect(r.status).toBe(201);
    expect(r.body.emailSent).toBe(true);
    expect(r.body.message).toBe(`Convite enviado para ${email}.`);
    expect(r.body.link).toMatch(/\/convite\/.+/); // link continua disponível como alternativa
    expect(brevo).toHaveLength(1);
    const b = brevo[0].body;
    expect(brevo[0].url).toBe('https://api.brevo.com/v3/smtp/email');
    expect(b.to).toEqual([{ email }]);
    expect(b.subject).toContain('convidou você para a equipe');
    expect(b.htmlContent).toContain(owner.me.org.name);
    expect(b.htmlContent).toContain(owner.me.user.name);
    expect(b.htmlContent).toContain('Atendente');
    expect(b.htmlContent).toContain('Inbox (conversas)');
    expect(b.htmlContent).toContain('Contatos');
    expect(b.htmlContent).not.toContain('Kanban');
    expect(b.htmlContent).toContain('7 dias');
    expect(b.htmlContent).toContain('só pode ser usado uma vez');
    expect(b.htmlContent).toContain('Aceitar convite');
    expect(b.htmlContent).toContain(r.body.link);
    // Nunca registra o token/link do convite no log.
    const token = r.body.link.split('/convite/')[1];
    expect(logs.join('\n')).not.toContain(token);
    const audit = await prisma.auditLog.findMany({ where: { orgId: owner.me.org.id, action: 'team.invite' } });
    expect(JSON.stringify(audit)).not.toContain(token);
  });

  it('falha no envio: mensagem de fallback real e link para copiar', async () => {
    brevoStatus = 401;
    const email = `${uniq()}@t.dev`;
    const r = await owner.post('/api/team/invites', { email, role: 'AGENT' });
    expect(r.status).toBe(201);
    expect(r.body.emailSent).toBe(false);
    expect(r.body.emailStatus).toBe('failed');
    expect(r.body.message).toBe(`Não foi possível enviar o e-mail para ${email}: copie o link e envie para a pessoa.`);
    expect(r.body.link).toMatch(/\/convite\//);
    expect(logs.join('\n')).not.toContain(r.body.link.split('/convite/')[1]);
  });

  it('sem provedor configurado: avisa que o envio não está configurado', async () => {
    delete process.env.BREVO_API_KEY; delete process.env.SMTP_HOST;
    const r = await owner.post('/api/team/invites', { email: `${uniq()}@t.dev`, role: 'AGENT' });
    expect(r.status).toBe(201);
    expect(r.body.emailStatus).toBe('not_configured');
    expect(r.body.message).toContain('não está configurado');
    expect(brevo).toHaveLength(0);
  });

  it('reenviar convite: novo link (o antigo deixa de valer), respeita intervalo e limite de envios', async () => {
    const r = await owner.post('/api/team/invites', { email: `${uniq()}@t.dev`, role: 'AGENT' });
    const id = r.body.id;
    const oldToken = r.body.link.split('/convite/')[1];
    // Logo em seguida: bloqueado pelo intervalo mínimo.
    const tooSoon = await owner.post(`/api/team/invites/${id}/resend`);
    expect(tooSoon.status).toBe(429);
    await prisma.invitation.update({ where: { id }, data: { lastSentAt: new Date(Date.now() - 61_000) } });
    const ok = await owner.post(`/api/team/invites/${id}/resend`);
    expect(ok.status).toBe(200);
    expect(ok.body.emailSent).toBe(true);
    const newToken = ok.body.link.split('/convite/')[1];
    expect(newToken).not.toBe(oldToken);
    expect((await owner.agent.get(`/api/auth/invite/${oldToken}`)).status).toBe(404);
    expect((await owner.agent.get(`/api/auth/invite/${newToken}`)).status).toBe(200);
    // Limite total de envios por convite.
    await prisma.invitation.update({ where: { id }, data: { sendCount: 5, lastSentAt: new Date(Date.now() - 3600_000) } });
    const capped = await owner.post(`/api/team/invites/${id}/resend`);
    expect(capped.status).toBe(429);
  });

  it('permissões: atendente não cria nem reenvia convites; admin não reenvia convite de administrador', async () => {
    process.env.BREVO_API_KEY = 'xkeysib-teste';
    const { member: agent } = await invite(owner, { role: 'AGENT' });
    expect((await agent.post('/api/team/invites', { email: `${uniq()}@t.dev`, role: 'AGENT' })).status).toBe(403);
    const pend = await owner.post('/api/team/invites', { email: `${uniq()}@t.dev`, role: 'ADMIN' });
    await prisma.invitation.update({ where: { id: pend.body.id }, data: { lastSentAt: new Date(Date.now() - 3600_000) } });
    expect((await agent.post(`/api/team/invites/${pend.body.id}/resend`)).status).toBe(403);
    const { member: admin } = await invite(owner, { role: 'ADMIN' });
    expect((await admin.post(`/api/team/invites/${pend.body.id}/resend`)).status).toBe(403);
    // Convite de outra organização: não existe para esta.
    expect((await other.post(`/api/team/invites/${pend.body.id}/resend`)).status).toBe(404);
  });
});

describe('Permissões por módulo e por canal WhatsApp (aplicadas no servidor)', () => {
  let owner: Client;
  let ch1: Awaited<ReturnType<typeof createTestChannel>>;
  let ch2: Awaited<ReturnType<typeof createTestChannel>>;
  const C1 = '5511955550001';
  const C2 = '5511955550002';

  beforeAll(async () => {
    installGraphMock();
    owner = await registerClient();
    await bigPlan(owner);
    ch1 = await createTestChannel(owner.me.org.id);
    ch2 = await createTestChannel(owner.me.org.id);
    await sendInbound(ch1, C1, 'oi pelo canal 1');
    await sendInbound(ch2, C2, 'oi pelo canal 2');
    outbox.length = 0;
  });

  it('membros antigos (sem permissões gravadas) mantêm o acesso de antes', async () => {
    const { member: agent } = await invite(owner, { role: 'AGENT' }); // sem lista: comportamento antigo
    const m = await prisma.membership.findFirst({ where: { userId: agent.me.user.id } });
    expect(m!.modules).toBeNull();
    expect(m!.channelIds).toBeNull();
    for (const url of ['/api/conversations', '/api/kanban', '/api/contacts', '/api/agenda/settings', '/api/reports', '/api/flows', '/api/plans']) {
      expect((await agent.get(url)).status, url).toBe(200);
    }
    expect(agent.me.access.modules).toContain('agenda');
  });

  it('módulo não liberado responde 403; o liberado funciona; /auth/me devolve os módulos para o menu', async () => {
    const { member: agent } = await invite(owner, { role: 'AGENT', modules: ['inbox', 'kanban', 'contatos'] });
    expect(agent.me.access.modules.sort()).toEqual(['contatos', 'inbox', 'kanban']);
    expect((await agent.get('/api/conversations')).status).toBe(200);
    expect((await agent.get('/api/kanban')).status).toBe(200);
    expect((await agent.get('/api/contacts')).status).toBe(200);
    for (const url of ['/api/agenda/settings', '/api/reports', '/api/flows/menu-settings', '/api/ai/settings', '/api/plans', '/api/team/invites/x/resend']) {
      const r = url.endsWith('resend') ? await agent.post(url) : await agent.get(url);
      expect(r.status, url).toBe(403);
    }
    // Leituras usadas pelo Inbox e pelo topo continuam liberadas.
    expect((await agent.get('/api/channels')).status).toBe(200);
    expect((await agent.get('/api/flows')).status).toBe(200);
    expect((await agent.get('/api/billing/status')).status).toBe(200);
    // Sem Inbox: conversas bloqueadas.
    const { member: onlyContacts } = await invite(owner, { role: 'AGENT', modules: ['contatos'] });
    expect((await onlyContacts.get('/api/conversations')).status).toBe(403);
    expect((await onlyContacts.get('/api/kanban')).status).toBe(403);
  });

  it('canais limitados: Inbox, Contatos, Kanban e lista de canais só mostram o canal liberado', async () => {
    const { member: agent } = await invite(owner, { role: 'AGENT', modules: ['inbox', 'kanban', 'contatos'], channelIds: [ch1.ch.id] });
    const convs = await agent.get('/api/conversations?status=all');
    expect(convs.status).toBe(200);
    const phones = convs.body.items.map((i: any) => i.contact.phone);
    expect(phones.some((p: string) => p.includes(C1))).toBe(true);
    expect(phones.some((p: string) => p.includes(C2))).toBe(false);
    const c2conv = await prisma.conversation.findFirst({ where: { orgId: owner.me.org.id, channelId: ch2.ch.id } });
    expect((await agent.get(`/api/conversations/${c2conv!.id}`)).status).toBe(404);
    expect((await agent.post(`/api/conversations/${c2conv!.id}/messages`, { type: 'text', text: 'oi' })).status).toBe(404);
    expect((await agent.get(`/api/conversations?status=all&channelId=${ch2.ch.id}`)).body.items).toHaveLength(0);
    const contacts = await agent.get('/api/contacts');
    expect(contacts.body.items.map((c: any) => c.phone).join()).toContain(C1);
    expect(contacts.body.items.map((c: any) => c.phone).join()).not.toContain(C2);
    const c2 = await prisma.contact.findFirst({ where: { orgId: owner.me.org.id, waId: C2 } });
    expect((await agent.get(`/api/contacts/${c2!.id}`)).status).toBe(404);
    expect((await agent.patch(`/api/contacts/${c2!.id}`, { name: 'x' })).status).toBe(404);
    const kb = await agent.get('/api/kanban');
    expect(kb.body.contacts.map((c: any) => c.phone).join()).not.toContain(C2);
    expect((await agent.post('/api/kanban/move', { contactId: c2!.id, stageId: null })).status).toBe(404);
    const chs = await agent.get('/api/channels');
    expect(chs.body.map((c: any) => c.id)).toEqual([ch1.ch.id]);
    // O dono continua vendo tudo.
    expect((await owner.get('/api/conversations?status=all')).body.items.length).toBeGreaterThanOrEqual(2);
  });

  it('sem escalada de privilégio: admin não concede o que não tem, não edita a si mesmo nem outros admins; dono não pode ser restringido', async () => {
    const { member: admin } = await invite(owner, { role: 'ADMIN', modules: ['inbox', 'contatos', 'equipe'], channelIds: [ch1.ch.id] });
    // Concede módulo que não tem.
    const r1 = await admin.post('/api/team/invites', { email: `${uniq()}@t.dev`, role: 'AGENT', modules: ['inbox', 'agenda'] });
    expect(r1.status).toBe(403);
    // Concede canal que não atende.
    const r2 = await admin.post('/api/team/invites', { email: `${uniq()}@t.dev`, role: 'AGENT', modules: ['inbox'], channelIds: [ch2.ch.id] });
    expect(r2.status).toBe(403);
    // "Todos os canais" vindo de quem é limitado vira só os canais dele; sem lista de módulos, só os módulos dele.
    const r3 = await admin.post('/api/team/invites', { email: `${uniq()}@t.dev`, role: 'AGENT', channelIds: null });
    expect(r3.status).toBe(201);
    const inv = await prisma.invitation.findUnique({ where: { id: r3.body.id } });
    expect(JSON.parse(inv!.channelIds!)).toEqual([ch1.ch.id]);
    expect(JSON.parse(inv!.modules!).sort()).toEqual(['contatos', 'equipe', 'inbox']);
    // Edita membro: dentro do que tem → ok; além → 403.
    const { member: agent } = await invite(owner, { role: 'AGENT', modules: ['inbox'] });
    const agentM = await prisma.membership.findFirst({ where: { userId: agent.me.user.id, orgId: owner.me.org.id } });
    expect((await admin.patch(`/api/team/members/${agentM!.id}`, { modules: ['inbox', 'contatos'] })).status).toBe(200);
    expect((await admin.patch(`/api/team/members/${agentM!.id}`, { modules: ['inbox', 'relatorios'] })).status).toBe(403);
    expect((await admin.patch(`/api/team/members/${agentM!.id}`, { role: 'ADMIN' })).status).toBe(403);
    // A si mesmo / outro admin / dono.
    const adminM = await prisma.membership.findFirst({ where: { userId: admin.me.user.id, orgId: owner.me.org.id } });
    expect((await admin.patch(`/api/team/members/${adminM!.id}`, { modules: ['inbox', 'contatos', 'equipe', 'plano'] })).status).toBe(403);
    const { member: admin2 } = await invite(owner, { role: 'ADMIN' });
    const admin2M = await prisma.membership.findFirst({ where: { userId: admin2.me.user.id, orgId: owner.me.org.id } });
    expect((await admin.patch(`/api/team/members/${admin2M!.id}`, { modules: ['inbox'] })).status).toBe(403);
    const ownerM = await prisma.membership.findFirst({ where: { userId: owner.me.user.id, orgId: owner.me.org.id } });
    expect((await admin.patch(`/api/team/members/${ownerM!.id}`, { modules: ['inbox'] })).status).toBe(403);
    expect((await owner.patch(`/api/team/members/${ownerM!.id}`, { modules: ['inbox'] })).status).toBe(403);
    // Atendente não edita permissões de ninguém.
    expect((await agent.patch(`/api/team/members/${agentM!.id}`, { modules: ['inbox', 'kanban', 'contatos'] })).status).toBe(403);
    // Dono restringe e a mudança vale na hora (servidor).
    expect((await owner.patch(`/api/team/members/${agentM!.id}`, { modules: ['kanban'] })).status).toBe(200);
    expect((await agent.get('/api/conversations')).status).toBe(403);
    expect((await agent.get('/api/kanban')).status).toBe(200);
  });

  it('admin sem o módulo Plano não acessa cobrança; dono pode liberar', async () => {
    const { member: admin } = await invite(owner, { role: 'ADMIN', modules: ['inbox', 'equipe'] });
    expect((await admin.get('/api/plans')).status).toBe(403);
    expect((await admin.post('/api/billing/checkout', {})).status).toBe(403);
    const m = await prisma.membership.findFirst({ where: { userId: admin.me.user.id, orgId: owner.me.org.id } });
    expect((await owner.patch(`/api/team/members/${m!.id}`, { modules: ['inbox', 'equipe', 'plano'] })).status).toBe(200);
    expect((await admin.get('/api/plans')).status).toBe(200);
  });
});
