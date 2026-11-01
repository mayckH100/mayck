import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { registerClient, Client, uniq, prisma, createTestChannel, installGraphMock, graph, sendInbound } from '../helpers.js';
import { tickAgendaReminders } from '../../server/agenda/service.js';
import { tickHandoffAlerts } from '../../server/whatsapp/handoffAlerts.js';
import { toLocalIso } from '../../server/agenda/time.js';

const TZ = 'America/Sao_Paulo';
const localIn = (min: number) => toLocalIso(new Date(Date.now() + min * 60_000), TZ);
const CLIENTE_IA = '5511955550001';
const CLIENTE_TAREFA = '5511955550002';
const CLIENTE_HUMANO = '5511955550003';
const DONO = '5511955550010';
const MEMBRO = '5511955550011';
const RESERVA = '5511955550099';
const VIA = '📲 Via: WhatsApp 1 · Carla (11 98765-4321)';

const sent = () => graph.calls.filter((c) => c.body?.to).map((c) => ({ to: String(c.body.to), text: String(c.body.text?.body ?? '') }));
const sentTo = (phone: string) => sent().filter((m) => m.to === phone);

async function invite(owner: Client, role: 'AGENT' | 'ADMIN') {
  const inv = await owner.post('/api/team/invites', { email: `${uniq()}@t.dev`, role });
  const token = inv.body.link.split('/convite/')[1];
  const c = new Client();
  const r = await c.agent.post('/api/auth/accept-invite').set('x-requested-with', 'mckbot').send({ token, name: 'Membro', password: 'senhaMembro123' });
  c.csrf = r.body.csrfToken;
  c.me = r.body;
  return c;
}

const BASE = { aiBooking: true, workStart: '00:00', workEnd: '23:30', workDays: [0, 1, 2, 3, 4, 5, 6], defaultDurationMin: 30, minNoticeMin: 0, notifyContact: true, reminderMin: 60 };

describe('Nome do WhatsApp: "WhatsApp 1 · Carla" nos canais e nos avisos internos', () => {
  let owner: Client;
  let admin: Client;
  let agent: Client;
  let ctx: Awaited<ReturnType<typeof createTestChannel>>;

  beforeAll(async () => {
    installGraphMock();
    owner = await registerClient();
    admin = await invite(owner, 'ADMIN');
    agent = await invite(owner, 'AGENT');
    ctx = await createTestChannel(owner.me.org.id);
    // Canal antigo com nome padrão e número conectado.
    await prisma.channel.update({ where: { id: ctx.ch.id }, data: { name: 'WhatsApp principal', displayPhone: '+5511987654321' } });
    await prisma.user.update({ where: { id: owner.me.user.id }, data: { phone: DONO } });
    expect((await owner.put('/api/agenda/settings', { ...BASE, notifyOwner: true, teamContacts: [{ name: 'Ana', phone: MEMBRO, active: true }] })).status).toBe(200);
  });
  beforeEach(() => graph.reset());

  it('canal sem nome próprio aparece como "WhatsApp 1"; criar pede o nome (limpo, 1–40) e sem nome vira "WhatsApp N"', async () => {
    const l0 = await owner.get('/api/channels');
    expect(l0.body[0]).toMatchObject({ ordinal: 1, label: 'WhatsApp 1', displayName: '' });

    expect((await agent.post('/api/channels', { name: 'Amanda' })).status).toBe(403);
    const c2 = await owner.post('/api/channels', { name: '  Ama\u200bnda <b> ', provider: 'whatsapp_qr' });
    expect(c2.status).toBe(201);
    expect(c2.body).toMatchObject({ name: 'Amanda b', displayName: 'Amanda b', ordinal: 2, label: 'WhatsApp 2 · Amanda b' });
    expect((await owner.post('/api/channels', { name: 'x'.repeat(41) })).status).toBe(400);
    const c3 = await owner.post('/api/channels', {});
    expect(c3.status).toBe(201);
    expect(c3.body).toMatchObject({ name: 'WhatsApp 3', displayName: '', label: 'WhatsApp 3' });

    const l1 = await owner.get('/api/channels');
    expect(l1.body.map((c: any) => c.label)).toEqual(['WhatsApp 1', 'WhatsApp 2 · Amanda b', 'WhatsApp 3']);
    await owner.del(`/api/channels/${c3.body.id}`);
    await owner.del(`/api/channels/${c2.body.id}`);
  });

  it('renomear: só Proprietário/Administrador, 1–40 caracteres, auditado; outra organização não altera', async () => {
    expect((await agent.patch(`/api/channels/${ctx.ch.id}`, { name: 'Carla' })).status).toBe(403);
    expect((await owner.patch(`/api/channels/${ctx.ch.id}`, { name: '   ' })).status).toBe(400);
    expect((await owner.patch(`/api/channels/${ctx.ch.id}`, { name: 'y'.repeat(41) })).status).toBe(400);
    const other = await registerClient();
    expect((await other.patch(`/api/channels/${ctx.ch.id}`, { name: 'Invasor' })).status).toBe(404);

    const r = await admin.patch(`/api/channels/${ctx.ch.id}`, { name: ' Carla ' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ name: 'Carla', displayName: 'Carla', label: 'WhatsApp 1 · Carla' });
    const log = await prisma.auditLog.findFirst({ where: { orgId: owner.me.org.id, action: 'channel.rename', entityId: ctx.ch.id } });
    expect(JSON.parse(log!.meta)).toMatchObject({ antes: 'WhatsApp principal', depois: 'Carla' });
    expect((await prisma.channel.findUniqueOrThrow({ where: { id: ctx.ch.id } })).name).toBe('Carla');
    expect((await other.get('/api/channels')).body).toHaveLength(0);
  });

  it('reunião marcada pela IA: aviso ao dono/equipe, nota no Inbox, agenda e lembrete dizem por qual WhatsApp; cliente não recebe o "Via"', async () => {
    await owner.put('/api/ai/settings', { provider: 'fake', model: 'fake-1', enabled: true, autoReply: true });
    await sendInbound(ctx, CLIENTE_IA, 'quero agendar uma reunião');
    await sendInbound(ctx, CLIENTE_IA, 'sim, pode agendar');
    const appt = await prisma.appointment.findFirst({ where: { orgId: owner.me.org.id, source: 'AI' } });
    expect(appt).toBeTruthy();
    expect(appt!.channelId).toBe(ctx.ch.id);
    for (const p of [DONO, MEMBRO]) {
      const m = sentTo(p);
      expect(m).toHaveLength(1);
      expect(m[0].text).toContain('📅 Nova reunião marcada com');
      expect(m[0].text).toContain(VIA);
    }
    expect(sentTo(CLIENTE_IA).every((m) => !m.text.includes('📲 Via'))).toBe(true);

    const note = await prisma.message.findFirst({ where: { conversationId: appt!.conversationId!, direction: 'INTERNAL', body: { contains: 'agendada pela IA' } } });
    expect(note!.body).toContain(VIA);

    const list = await owner.get('/api/agenda?status=all');
    const item = list.body.items?.find?.((a: any) => a.id === appt!.id) ?? list.body.find?.((a: any) => a.id === appt!.id);
    expect(item.channel).toMatchObject({ label: 'WhatsApp 1 · Carla', via: 'WhatsApp 1 · Carla (11 98765-4321)' });

    graph.reset();
    await prisma.appointment.update({ where: { id: appt!.id }, data: { startAt: new Date(Date.now() + 30 * 60_000), reminderMin: 60, reminderSentAt: null } });
    await tickAgendaReminders();
    expect(sentTo(MEMBRO)[0].text).toContain('⏰ Lembrete');
    expect(sentTo(MEMBRO)[0].text).toContain(VIA);
  });

  it('tarefa criada para um contato (Kanban) guarda o WhatsApp da conversa e o aviso à equipe informa o "Via"', async () => {
    await sendInbound(ctx, CLIENTE_TAREFA, 'oi');
    const contact = await prisma.contact.findFirstOrThrow({ where: { orgId: owner.me.org.id, waId: CLIENTE_TAREFA } });
    graph.reset();
    const r = await owner.post('/api/agenda', { kind: 'TASK', title: 'Retornar cliente', start: localIn(600), contactId: contact.id, notifyContact: false, teamPhones: [MEMBRO], source: 'KANBAN' });
    expect(r.status).toBe(201);
    expect(r.body.channelId).toBe(ctx.ch.id);
    expect(r.body.channel.label).toBe('WhatsApp 1 · Carla');
    const m = sentTo(MEMBRO);
    expect(m).toHaveLength(1);
    expect(m[0].text).toContain('Nova tarefa marcada');
    expect(m[0].text).toContain(VIA);

    // Canal de outra organização é recusado.
    const other = await registerClient();
    const otherCh = await createTestChannel(other.me.org.id);
    expect((await owner.post('/api/agenda', { kind: 'TASK', title: 'X', start: localIn(700), channelId: otherCh.ch.id })).status).toBe(404);
  });

  it('atendimento humano: nota, pop-up (/conversations/waiting), Inbox e aviso ao número reserva dizem por qual WhatsApp', async () => {
    expect((await owner.put('/api/ai/settings', { provider: 'fake', model: 'fake-1', enabled: true, autoReply: true, handoffKeywords: ['atendente'] })).status).toBe(200);
    await sendInbound(ctx, CLIENTE_HUMANO, 'quero falar com um atendente');
    const contact = await prisma.contact.findFirstOrThrow({ where: { orgId: owner.me.org.id, waId: CLIENTE_HUMANO } });
    const conv = await prisma.conversation.findFirstOrThrow({ where: { contactId: contact.id }, orderBy: { createdAt: 'desc' } });
    expect(conv.waitingSince).toBeInstanceOf(Date);
    const note = await prisma.message.findFirst({ where: { conversationId: conv.id, direction: 'INTERNAL', body: { contains: 'Transferido para atendimento humano' } } });
    expect(note!.body).toContain(VIA);

    const w = await owner.get('/api/conversations/waiting');
    expect(w.body.items.find((i: any) => i.id === conv.id).channel).toMatchObject({ label: 'WhatsApp 1 · Carla', via: 'WhatsApp 1 · Carla (11 98765-4321)' });
    const inbox = await owner.get('/api/conversations?status=pending');
    expect(inbox.body.items.find((i: any) => i.id === conv.id).channel.label).toBe('WhatsApp 1 · Carla');
    // Filtro por WhatsApp.
    expect((await owner.get(`/api/conversations?status=all&channelId=${ctx.ch.id}`)).body.items.some((i: any) => i.id === conv.id)).toBe(true);
    expect((await owner.get('/api/conversations?status=all&channelId=outro')).body.items).toHaveLength(0);

    await prisma.organization.update({ where: { id: owner.me.org.id }, data: { backupPhone: `+${RESERVA}`, handoffAlertMinutes: 5 } });
    await prisma.conversation.update({ where: { id: conv.id }, data: { waitingSince: new Date(Date.now() - 10 * 60_000), handoffAlertSentAt: null } });
    graph.reset();
    await tickHandoffAlerts();
    const alert = sentTo(RESERVA);
    expect(alert).toHaveLength(1);
    expect(alert[0].text).toContain('⚠️ Atendimento aguardando');
    expect(alert[0].text).toContain(VIA);
  });
});
