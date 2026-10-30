import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { registerClient, Client, uniq, prisma, app, createTestChannel, installGraphMock, graph, sendInbound, sentTexts } from '../helpers.js';
import { tickAgendaReminders } from '../../server/agenda/service.js';
import { makeState } from '../../server/agenda/google.js';
import { toLocalIso } from '../../server/agenda/time.js';

const TZ = 'America/Sao_Paulo';
/** Hora local (fuso da empresa) daqui a N dias às HH:MM. */
function localAt(days: number, hhmm: string) {
  const d = new Date(Date.now() + days * 24 * 3600e3);
  return `${toLocalIso(d, TZ).slice(0, 10)}T${hhmm}`;
}

async function invite(owner: Client, role: 'AGENT' | 'ADMIN') {
  const inv = await owner.post('/api/team/invites', { email: `${uniq()}@t.dev`, role });
  const token = inv.body.link.split('/convite/')[1];
  const c = new Client();
  const r = await c.agent.post('/api/auth/accept-invite').set('x-requested-with', 'mckbot').send({ token, name: 'Membro', password: 'senhaMembro123' });
  c.csrf = r.body.csrfToken;
  c.me = r.body;
  return c;
}

describe('Agenda: compromissos, conflitos e avisos', () => {
  let owner: Client;
  let ctx: Awaited<ReturnType<typeof createTestChannel>>;
  let contactId: string;
  beforeAll(async () => {
    installGraphMock();
    owner = await registerClient();
    ctx = await createTestChannel(owner.me.org.id);
    await sendInbound(ctx, '5511955550001', 'oi'); // contato com janela de 24h aberta
    contactId = (await prisma.contact.findFirst({ where: { orgId: owner.me.org.id, waId: '5511955550001' } }))!.id;
  });
  beforeEach(() => graph.reset());

  it('cria reunião com contato, gera links e avisa o contato por WhatsApp', async () => {
    const r = await owner.post('/api/agenda', { title: 'Apresentação do plano', start: localAt(2, '10:00'), durationMin: 45, contactId, location: 'Google Meet' });
    expect(r.status).toBe(201);
    expect(r.body.localStart).toBe(localAt(2, '10:00'));
    expect(r.body.links.google).toContain('calendar.google.com');
    expect(r.body.links.ics).toMatch(/\/api\/public\/agenda\/e\/.+\.ics$/);
    const texts = sentTexts();
    expect(texts.some((t: string) => t.includes('Apresentação do plano') && t.includes('/api/public/agenda/e/'))).toBe(true);
    const log = await prisma.auditLog.findFirst({ where: { orgId: owner.me.org.id, action: 'agenda.create', entityId: r.body.id } });
    expect(log).toBeTruthy();
  });

  it('recusa reunião em horário ocupado (409), aceita com force e tarefa não bloqueia', async () => {
    const start = localAt(3, '15:00');
    expect((await owner.post('/api/agenda', { title: 'A', start, durationMin: 60 })).status).toBe(201);
    const clash = await owner.post('/api/agenda', { title: 'B', start: localAt(3, '15:30'), durationMin: 30 });
    expect(clash.status).toBe(409);
    expect(clash.body.details.conflicts[0].title).toBe('A');
    expect((await owner.post('/api/agenda/check', { start: localAt(3, '16:00'), durationMin: 30 })).body.ok).toBe(true);
    expect((await owner.post('/api/agenda', { title: 'B', start: localAt(3, '15:30'), durationMin: 30, force: true })).status).toBe(201);
    expect((await owner.post('/api/agenda', { kind: 'TASK', title: 'Enviar proposta', start: localAt(3, '15:15') })).status).toBe(201);
  });

  it('remarcar avisa o contato e sobe a versão; cancelar sai no .ics como CANCELLED', async () => {
    const a = (await owner.post('/api/agenda', { title: 'Visita', start: localAt(4, '09:00'), contactId })).body;
    graph.reset();
    const moved = await owner.patch(`/api/agenda/${a.id}`, { start: localAt(4, '11:00') });
    expect(moved.status).toBe(200);
    expect(sentTexts().some((t: string) => t.includes('remarcado'))).toBe(true);
    const c = await owner.patch(`/api/agenda/${a.id}`, { status: 'CANCELLED' });
    expect(c.body.status).toBe('CANCELLED');
    const ics = await request(app).get(new URL(c.body.links.ics).pathname);
    expect(ics.status).toBe(200);
    expect(ics.headers['content-type']).toContain('text/calendar');
    expect(ics.text).toContain('STATUS:CANCELLED');
    expect(ics.text).toContain('SEQUENCE:2');
  });

  it('página pública do evento tem botões Google/iPhone/Outlook; token falso dá 404', async () => {
    const a = (await owner.post('/api/agenda', { title: 'Demo <b>MCK</b>', start: localAt(5, '14:00') })).body;
    const page = await request(app).get(new URL(a.links.page).pathname);
    expect(page.status).toBe(200);
    expect(page.text).toContain('Adicionar ao Google Agenda');
    expect(page.text).toContain('iPhone');
    expect(page.text).toContain('Demo &lt;b&gt;MCK&lt;/b&gt;');
    expect((await request(app).get(`/api/public/agenda/e/${a.id}.falso`)).status).toBe(404);
  });

  it('lembrete por WhatsApp sai uma única vez antes do horário', async () => {
    const a = await prisma.appointment.create({ data: { orgId: owner.me.org.id, title: 'Ligação rápida', startAt: new Date(Date.now() + 20 * 60_000), reminderMin: 30, contactId } });
    graph.reset();
    await tickAgendaReminders();
    expect(sentTexts().some((t: string) => t.includes('Lembrete') && t.includes('Ligação rápida'))).toBe(true);
    graph.reset();
    await tickAgendaReminders();
    expect(sentTexts().some((t: string) => t.includes('Ligação rápida'))).toBe(false);
    expect((await prisma.appointment.findUnique({ where: { id: a.id } }))!.reminderSentAt).toBeTruthy();
  });
});

describe('Agenda: feed assinável (webcal)', () => {
  let owner: Client;
  beforeAll(async () => { owner = await registerClient(); });

  it('feed da empresa traz os compromissos e gerar de novo invalida o link antigo', async () => {
    await owner.post('/api/agenda', { title: 'Reunião do feed', start: localAt(1, '10:00') });
    const f = await owner.post('/api/agenda/feeds', { scope: 'org' });
    expect(f.status).toBe(201);
    expect(f.body.webcal).toMatch(/^webcal:\/\//);
    const path = new URL(f.body.https).pathname;
    const ics = await request(app).get(path);
    expect(ics.status).toBe(200);
    expect(ics.text).toContain('SUMMARY:Reunião do feed');
    expect(ics.text).toContain('X-WR-CALNAME:');
    const f2 = await owner.post('/api/agenda/feeds', { scope: 'org' });
    expect((await request(app).get(path)).status).toBe(404);
    expect((await request(app).get(new URL(f2.body.https).pathname)).status).toBe(200);
    expect((await request(app).get('/api/public/agenda/feed/token-inventado-qualquer-123.ics')).status).toBe(404);
    const list = await owner.get('/api/agenda/feeds');
    expect(list.body).toHaveLength(1);
  });
});

describe('Agenda: isolamento e permissões', () => {
  let a: Client, b: Client, agent: Client;
  let apptId: string;
  beforeAll(async () => {
    a = await registerClient();
    b = await registerClient();
    agent = await invite(a, 'AGENT');
    apptId = (await a.post('/api/agenda', { title: 'Segredo A', start: localAt(2, '10:00'), assignedUserId: a.me.user.id })).body.id;
  });

  it('outra empresa não vê, não altera e não exclui', async () => {
    expect((await b.get('/api/agenda')).body.items).toHaveLength(0);
    expect((await b.get(`/api/agenda/${apptId}`)).status).toBe(404);
    expect((await b.get(`/api/agenda/${apptId}/ics`)).status).toBe(404);
    expect((await b.patch(`/api/agenda/${apptId}`, { title: 'hack' })).status).toBe(404);
    expect((await b.del(`/api/agenda/${apptId}`)).status).toBe(404);
    const f = await b.post('/api/agenda/feeds', { scope: 'org' });
    expect((await request(app).get(new URL(f.body.https).pathname)).text).not.toContain('Segredo A');
    const contactB = (await b.post('/api/contacts', { phone: '5511944443333' })).body.id;
    expect((await a.post('/api/agenda', { title: 'x', start: localAt(6, '10:00'), contactId: contactB })).status).toBe(404);
  });

  it('atendente agenda para si, mas não para outros, não exclui e não mexe no que é do dono', async () => {
    expect((await agent.get('/api/agenda')).body.items.find((i: any) => i.id === apptId)).toBeUndefined();
    expect((await agent.get(`/api/agenda/${apptId}`)).status).toBe(404);
    const mine = await agent.post('/api/agenda', { title: 'Minha visita', start: localAt(7, '10:00') });
    expect(mine.status).toBe(201);
    expect((await agent.post('/api/agenda', { title: 'x', start: localAt(7, '12:00'), assignedUserId: a.me.user.id })).status).toBe(403);
    expect((await agent.patch(`/api/agenda/${mine.body.id}`, { title: 'Minha visita (ok)' })).status).toBe(200);
    expect((await agent.del(`/api/agenda/${mine.body.id}`)).status).toBe(403);
    expect((await agent.post('/api/agenda/feeds', { scope: 'org' })).status).toBe(403);
    expect((await agent.post('/api/agenda/feeds', { scope: 'me' })).status).toBe(201);
    expect((await agent.put('/api/agenda/settings', { aiBooking: true, workStart: '09:00', workEnd: '18:00', workDays: [1], defaultDurationMin: 30, minNoticeMin: 0, notifyContact: true, reminderMin: 60 })).status).toBe(403);
    expect((await a.del(`/api/agenda/${mine.body.id}`)).status).toBe(200);
    expect(await prisma.auditLog.count({ where: { orgId: a.me.org.id, action: 'agenda.delete' } })).toBe(1);
  });
});

describe('Agenda: IA agenda na conversa do WhatsApp', () => {
  let owner: Client;
  let ctx: Awaited<ReturnType<typeof createTestChannel>>;
  beforeAll(async () => {
    installGraphMock();
    owner = await registerClient();
    ctx = await createTestChannel(owner.me.org.id);
    await owner.put('/api/ai/settings', { provider: 'fake', model: 'fake-1', enabled: true, autoReply: true });
    const s = await owner.put('/api/agenda/settings', { aiBooking: true, workStart: '08:00', workEnd: '20:00', workDays: [0, 1, 2, 3, 4, 5, 6], defaultDurationMin: 30, minNoticeMin: 0, notifyContact: true, reminderMin: 60 });
    expect(s.status).toBe(200);
  });
  beforeEach(() => graph.reset());

  it('cliente confirma horário → IA cria o compromisso e manda o link da agenda', async () => {
    await sendInbound(ctx, '5511966660001', 'quero agendar uma reunião');
    const reply = sentTexts().find((t: string) => t.includes('/api/public/agenda/e/'));
    expect(reply).toBeTruthy();
    expect(reply).not.toContain('[AGENDAR');
    const appt = await prisma.appointment.findFirst({ where: { orgId: owner.me.org.id, source: 'AI' } });
    expect(appt).toBeTruthy();
    expect(appt!.contactId).toBeTruthy();
    expect(await prisma.auditLog.count({ where: { orgId: owner.me.org.id, action: 'agenda.ai_create' } })).toBe(1);
  });

  it('horário que acabou de ser ocupado não é agendado de novo (checa conflito)', async () => {
    const taken = await prisma.appointment.findFirst({ where: { orgId: owner.me.org.id, source: 'AI' } });
    const local = toLocalIso(taken!.startAt, TZ);
    await sendInbound(ctx, '5511966660002', `confirmar ${local}`);
    expect(sentTexts().some((t: string) => t.includes('acabou de ser ocupado'))).toBe(true);
    expect(await prisma.appointment.count({ where: { orgId: owner.me.org.id, source: 'AI' } })).toBe(1);
  });

  it('com o agendamento pela IA desligado, o marcador é ignorado', async () => {
    await owner.put('/api/agenda/settings', { aiBooking: false, workStart: '08:00', workEnd: '20:00', workDays: [1, 2, 3, 4, 5], defaultDurationMin: 30, minNoticeMin: 0, notifyContact: true, reminderMin: 60 });
    await sendInbound(ctx, '5511966660003', 'quero agendar');
    expect(await prisma.appointment.count({ where: { orgId: owner.me.org.id, source: 'AI' } })).toBe(1);
  });
});

describe('Agenda: Google Agenda (OAuth) — simulado', () => {
  let owner: Client;
  const calls: { method: string; url: string; body: any }[] = [];
  let busy: { start: string; end: string }[] = [];
  beforeAll(async () => {
    installGraphMock();
    process.env.GOOGLE_CLIENT_ID = 'cid.apps.googleusercontent.com';
    process.env.GOOGLE_CLIENT_SECRET = 'segredo-google';
    owner = await registerClient();
    graph.other = async (url, init) => {
      const method = init?.method ?? 'GET';
      if (url.startsWith('https://oauth2.googleapis.com/token')) {
        const p = new URLSearchParams(String(init?.body));
        calls.push({ method, url, body: Object.fromEntries(p) });
        const idToken = `x.${Buffer.from(JSON.stringify({ email: 'dono@gmail.com' })).toString('base64url')}.y`;
        return new Response(JSON.stringify(p.get('grant_type') === 'authorization_code' ? { access_token: 'at1', refresh_token: 'rt-secreto', expires_in: 3600, id_token: idToken } : { access_token: 'at2', expires_in: 3600 }), { status: 200 });
      }
      if (url.startsWith('https://www.googleapis.com/calendar/v3')) {
        const body = init?.body ? JSON.parse(String(init.body)) : null;
        calls.push({ method, url, body });
        if (url.endsWith('/freeBusy')) return new Response(JSON.stringify({ calendars: { primary: { busy } } }), { status: 200 });
        if (method === 'DELETE') return new Response(null, { status: 204 });
        return new Response(JSON.stringify({ id: 'gev1' }), { status: 200 });
      }
      if (url.startsWith('https://oauth2.googleapis.com/revoke')) return new Response('{}', { status: 200 });
      return null;
    };
  });
  afterAll(() => { delete process.env.GOOGLE_CLIENT_ID; delete process.env.GOOGLE_CLIENT_SECRET; graph.reset(); });

  it('conecta a conta (state ligado ao usuário) e guarda só o refresh token cifrado', async () => {
    expect((await owner.get('/api/agenda/google/status')).body).toMatchObject({ configured: true, connected: false });
    const c = await owner.post('/api/agenda/google/connect', {});
    expect(new URL(c.body.url).hostname).toBe('accounts.google.com');
    // state de outro usuário é recusado
    const other = await owner.agent.get(`/api/agenda/google/callback?code=abc&state=${encodeURIComponent(makeState('outro', owner.me.org.id, 'mckbot'))}`);
    expect(other.headers.location).toContain('google=erro');
    const state = new URL(c.body.url).searchParams.get('state')!;
    const cb = await owner.agent.get(`/api/agenda/google/callback?code=abc&state=${encodeURIComponent(state)}`);
    expect(cb.status).toBe(302);
    expect(cb.headers.location).toBe('/agenda?google=ok');
    const acc = await prisma.googleCalendarAccount.findFirst({ where: { orgId: owner.me.org.id } });
    expect(acc!.email).toBe('dono@gmail.com');
    expect(acc!.refreshTokenEnc).toMatch(/^v1:/);
    expect(acc!.refreshTokenEnc).not.toContain('rt-secreto');
    expect((await owner.get('/api/agenda/google/status')).body).toMatchObject({ connected: true, email: 'dono@gmail.com' });
  });

  it('cria, atualiza e cancela o evento no Google; horário ocupado no Google gera conflito', async () => {
    const a = await owner.post('/api/agenda', { title: 'Com Google', start: localAt(2, '10:00') });
    expect(a.status).toBe(201);
    expect(a.body.googleSynced).toBe(true);
    expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/calendars/primary/events') && c.body.summary === 'Com Google')).toBe(true);
    await owner.patch(`/api/agenda/${a.body.id}`, { title: 'Com Google 2' });
    expect(calls.some((c) => c.method === 'PATCH' && c.url.endsWith('/events/gev1') && c.body.summary === 'Com Google 2')).toBe(true);
    await owner.patch(`/api/agenda/${a.body.id}`, { status: 'CANCELLED' });
    expect(calls.some((c) => c.method === 'DELETE' && c.url.endsWith('/events/gev1'))).toBe(true);

    const s = new Date(Date.now() + 3 * 24 * 3600e3);
    const startLocal = toLocalIso(s, TZ);
    busy = [{ start: new Date(s.getTime() - 10 * 60_000).toISOString(), end: new Date(s.getTime() + 20 * 60_000).toISOString() }];
    const clash = await owner.post('/api/agenda', { title: 'Choque', start: startLocal, durationMin: 30 });
    expect(clash.status).toBe(409);
    expect(clash.body.details.conflicts[0].source).toBe('google');
    busy = [];
  });

  it('desconectar revoga e apaga a conta', async () => {
    expect((await owner.del('/api/agenda/google')).status).toBe(200);
    expect(await prisma.googleCalendarAccount.count({ where: { orgId: owner.me.org.id } })).toBe(0);
    expect(await prisma.auditLog.count({ where: { orgId: owner.me.org.id, action: { in: ['agenda.google_connect', 'agenda.google_disconnect'] } } })).toBe(2);
  });
});
