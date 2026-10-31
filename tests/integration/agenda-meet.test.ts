import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { registerClient, Client, prisma, createTestChannel, installGraphMock, graph, sendInbound, sentTexts } from '../helpers.js';
import { tickAgendaReminders } from '../../server/agenda/service.js';
import { toLocalIso } from '../../server/agenda/time.js';
import { encrypt } from '../../server/lib/crypto.js';

const TZ = 'America/Sao_Paulo';
const MEET = 'https://meet.google.com/abc-defg-hij';
/** Hora local (fuso da empresa) daqui a N minutos. */
const localIn = (min: number) => toLocalIso(new Date(Date.now() + min * 60_000), TZ);

describe('Agenda: link automático do Google Meet', () => {
  let owner: Client;
  let contactId: string;
  let mode: 'ok' | 'fail' = 'ok';
  const calls: { method: string; url: string; body: any }[] = [];

  const mockGoogle = () => {
    graph.other = async (url, init) => {
      const method = init?.method ?? 'GET';
      if (url.startsWith('https://oauth2.googleapis.com/token')) return new Response(JSON.stringify({ access_token: 'at-meet', expires_in: 3600 }), { status: 200 });
      if (url.startsWith('https://www.googleapis.com/calendar/v3')) {
        const body = init?.body ? JSON.parse(String(init.body)) : null;
        calls.push({ method, url, body });
        if (url.endsWith('/freeBusy')) return new Response(JSON.stringify({ calendars: { primary: { busy: [] } } }), { status: 200 });
        if (mode === 'fail') return new Response(JSON.stringify({ error: { message: 'Erro simulado do Google' } }), { status: 500 });
        if (method === 'DELETE') return new Response(null, { status: 204 });
        const conf = body?.conferenceData?.createRequest
          ? { hangoutLink: MEET, conferenceData: { entryPoints: [{ entryPointType: 'video', uri: MEET }, { entryPointType: 'phone', uri: 'tel:+55-11-0000-0000' }] } }
          : {};
        return new Response(JSON.stringify({ id: `gmeet${calls.length}`, ...conf }), { status: 200 });
      }
      return null;
    };
  };

  beforeAll(async () => {
    installGraphMock();
    process.env.GOOGLE_CLIENT_ID = 'cid.apps.googleusercontent.com';
    process.env.GOOGLE_CLIENT_SECRET = 'segredo-google';
    owner = await registerClient();
    const ctx = await createTestChannel(owner.me.org.id);
    await sendInbound(ctx, '5511955557001', 'oi'); // contato com janela de 24h aberta
    contactId = (await prisma.contact.findFirst({ where: { orgId: owner.me.org.id, waId: '5511955557001' } }))!.id;
  });
  beforeEach(() => { graph.reset(); mockGoogle(); calls.length = 0; mode = 'ok'; });
  afterAll(() => { delete process.env.GOOGLE_CLIENT_ID; delete process.env.GOOGLE_CLIENT_SECRET; graph.reset(); });

  it('sem Google conectado: cria o compromisso sem link do Meet', async () => {
    const r = await owner.post('/api/agenda', { title: 'Sem Google', start: localIn(3 * 24 * 60), contactId });
    expect(r.status).toBe(201);
    expect(r.body.meetLink).toBeNull();
    expect(r.body.googleSynced).toBe(false);
    expect(calls.filter((c) => c.method === 'POST' && c.url.includes('/events'))).toHaveLength(0);
    expect(sentTexts().some((t: string) => t.includes('Sem Google') && !t.includes('meet.google.com'))).toBe(true);
  });

  it('com Google conectado: pede o Meet, guarda o link e envia na confirmação e no lembrete', async () => {
    await prisma.googleCalendarAccount.create({ data: { orgId: owner.me.org.id, userId: owner.me.user.id, email: 'dono@gmail.com', refreshTokenEnc: encrypt('rt-meet') } });
    const r = await owner.post('/api/agenda', { title: 'Reunião com Meet', start: localIn(30), durationMin: 30, reminderMin: 60, contactId });
    expect(r.status).toBe(201);
    expect(r.body.meetLink).toBe(MEET);
    const insert = calls.find((c) => c.method === 'POST' && c.url.split('?')[0].endsWith('/calendars/primary/events'))!;
    expect(insert.url).toContain('conferenceDataVersion=1');
    expect(insert.body.conferenceData.createRequest.conferenceSolutionKey).toEqual({ type: 'hangoutsMeet' });
    expect(insert.body.conferenceData.createRequest.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect((await prisma.appointment.findUnique({ where: { id: r.body.id } }))!.meetLink).toBe(MEET);
    expect(sentTexts().some((t: string) => t.includes('Reunião com Meet') && t.includes(MEET))).toBe(true);

    // Editar não pede outro Meet e mantém o link.
    calls.length = 0;
    const e = await owner.patch(`/api/agenda/${r.body.id}`, { title: 'Reunião com Meet 2' });
    expect(e.body.meetLink).toBe(MEET);
    const p = calls.find((c) => c.method === 'PATCH')!;
    expect(p.body.conferenceData).toBeUndefined();

    graph.calls = [];
    expect(await tickAgendaReminders(new Date())).toBeGreaterThanOrEqual(1);
    expect(sentTexts().some((t: string) => t.includes('Lembrete') && t.includes('Reunião com Meet 2') && t.includes(MEET))).toBe(true);
  });

  it('opção "Gerar link do Google Meet" desligada: sincroniza sem pedir conferência', async () => {
    const r = await owner.post('/api/agenda', { title: 'Presencial', start: localIn(4 * 24 * 60), generateMeet: false });
    expect(r.status).toBe(201);
    expect(r.body.googleSynced).toBe(true);
    expect(r.body.meetLink).toBeNull();
    const insert = calls.find((c) => c.method === 'POST' && c.url.includes('/events'))!;
    expect(insert.url).not.toContain('conferenceDataVersion');
    expect(insert.body.conferenceData).toBeUndefined();
  });

  it('erro no Google: o compromisso é criado mesmo assim, sem link', async () => {
    mode = 'fail';
    const r = await owner.post('/api/agenda', { title: 'Google fora do ar', start: localIn(5 * 24 * 60), contactId });
    expect(r.status).toBe(201);
    expect(r.body.meetLink).toBeNull();
    expect(r.body.googleSynced).toBe(false);
    expect(await prisma.appointment.count({ where: { id: r.body.id } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { orgId: owner.me.org.id, action: 'agenda.google_falha', entityId: r.body.id } })).toBe(1);
    expect(sentTexts().some((t: string) => t.includes('Google fora do ar') && !t.includes('meet.google.com'))).toBe(true);
  });
});
