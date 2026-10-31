import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { registerClient, Client, uniq, prisma, createTestChannel, installGraphMock, graph, sendInbound } from '../helpers.js';
import { tickAgendaReminders } from '../../server/agenda/service.js';
import { toLocalIso } from '../../server/agenda/time.js';

const TZ = 'America/Sao_Paulo';
const localIn = (min: number) => toLocalIso(new Date(Date.now() + min * 60_000), TZ);
const CLIENTE = '5511944440001';
const CLIENTE_IA = '5511944440002';
const DONO = '5511944440010';
const M1 = '5511944440011';
const M2 = '5511944440012';
const M3 = '5511944440013';

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

describe('Agenda: dono e equipe pré-configurada recebem avisos de reunião por WhatsApp', () => {
  let owner: Client;
  let admin: Client;
  let agent: Client;
  let ctx: Awaited<ReturnType<typeof createTestChannel>>;
  let contactId: string;
  const stageOf = async (id: string) => {
    const c = await prisma.contact.findUnique({ where: { id } });
    return c?.stageId ? (await prisma.kanbanStage.findUnique({ where: { id: c.stageId } }))?.name : null;
  };

  beforeAll(async () => {
    installGraphMock();
    owner = await registerClient();
    admin = await invite(owner, 'ADMIN');
    agent = await invite(owner, 'AGENT');
    ctx = await createTestChannel(owner.me.org.id);
    await sendInbound(ctx, CLIENTE, 'oi');
    contactId = (await prisma.contact.findFirst({ where: { orgId: owner.me.org.id, waId: CLIENTE } }))!.id;
    await prisma.contact.update({ where: { id: contactId }, data: { name: 'João Cliente' } });
  });
  beforeEach(() => { graph.reset(); });

  it('equipe: só dono/admin editam; máx. 5, nome e telefone válidos, sem repetidos', async () => {
    const s0 = await owner.get('/api/agenda/settings');
    expect(s0.body).toMatchObject({ notifyOwner: true, teamContacts: [] });
    expect(s0.body.owners).toEqual([expect.objectContaining({ hasPhone: false })]);
    const team = [{ name: 'Ana', phone: M1 }];
    expect((await agent.put('/api/agenda/settings', { ...BASE, teamContacts: team })).status).toBe(403);
    const six = Array.from({ length: 6 }, (_, i) => ({ name: `M${i}`, phone: `55119444401${20 + i}` }));
    expect((await owner.put('/api/agenda/settings', { ...BASE, teamContacts: six })).status).toBe(400);
    expect((await owner.put('/api/agenda/settings', { ...BASE, teamContacts: [{ name: 'X', phone: '123' }] })).status).toBe(400);
    expect((await owner.put('/api/agenda/settings', { ...BASE, teamContacts: [{ name: '', phone: M1 }] })).status).toBe(400);
    const dup = await owner.put('/api/agenda/settings', { ...BASE, teamContacts: [{ name: 'A', phone: '(11) 94444-0011' }, { name: 'B', phone: M1 }] });
    expect(dup.status).toBe(400);
    expect(dup.body.error ?? dup.body.message).toMatch(/repetido/);

    await prisma.user.update({ where: { id: owner.me.user.id }, data: { phone: '(11) 94444-0010' } });
    const ok = await admin.put('/api/agenda/settings', {
      ...BASE, notifyOwner: true,
      teamContacts: [
        { name: 'Ana', phone: '(11) 94444-0011', active: true },
        { name: 'Bruno', phone: M2 },
        { name: 'Carla', phone: M3, active: false },
        { name: 'Dono de novo', phone: DONO, active: true }, // mesmo número do dono: recebe uma vez só
      ],
    });
    expect(ok.status).toBe(200);
    expect(ok.body.teamContacts).toEqual([
      { name: 'Ana', phone: M1, active: true }, { name: 'Bruno', phone: M2, active: true },
      { name: 'Carla', phone: M3, active: false }, { name: 'Dono de novo', phone: DONO, active: true },
    ]);
    expect((await agent.get('/api/agenda/settings')).body.owners[0].hasPhone).toBe(true);
  });

  it('reunião marcada pela IA avisa o dono e só os membros ativos (sem duplicar), com cliente, Meet/descrição e "IA"; contato vai para "Reunião agendada"', async () => {
    await owner.put('/api/ai/settings', { provider: 'fake', model: 'fake-1', enabled: true, autoReply: true });
    await sendInbound(ctx, CLIENTE_IA, 'quero agendar uma reunião');
    const appt = await prisma.appointment.findFirst({ where: { orgId: owner.me.org.id, source: 'AI' } });
    expect(appt).toBeTruthy();
    expect(appt!.notifyOwner).toBe(true);
    expect(JSON.parse(appt!.teamContacts).map((m: any) => m.phone)).toEqual([M1, M2, DONO]);
    for (const p of [DONO, M1, M2]) {
      const m = sentTo(p);
      expect(m).toHaveLength(1);
      expect(m[0].text).toContain('📅 Nova reunião marcada com');
      expect(m[0].text).toContain('Agendado por: IA');
    }
    expect(sentTo(M3)).toHaveLength(0);
    // Kanban: contato do cliente da IA foi para "Reunião agendada" (criada no fim do funil).
    expect(await stageOf(appt!.contactId!)).toBe('Reunião agendada');
    const stages = await prisma.kanbanStage.findMany({ where: { orgId: owner.me.org.id }, orderBy: { position: 'asc' } });
    expect(stages[stages.length - 1].name).toBe('Reunião agendada');
  });

  it('formulário: membro desmarcado não recebe; vale para lembrete, remarcação, cancelamento e Reenviar', async () => {
    const r = await owner.post('/api/agenda', { force: true, title: 'Proposta', description: 'Pauta: preço', start: localIn(30), reminderMin: 60, contactId, teamPhones: ['(11) 94444-0011'] });
    expect(r.status).toBe(201);
    expect(r.body.teamContacts).toEqual([{ name: 'Ana', phone: M1 }]);
    expect(r.body.notifyOwner).toBe(true);
    expect(sentTo(CLIENTE)).toHaveLength(1);
    expect(sentTo(M1)).toHaveLength(1);
    expect(sentTo(M1)[0].text).toContain('Nova reunião marcada com João Cliente');
    expect(sentTo(M1)[0].text).toContain('Pauta: preço');
    expect(sentTo(M1)[0].text).toContain(`Agendado por: ${owner.me.user.name}`);
    expect(sentTo(DONO)).toHaveLength(1);
    expect(sentTo(M2)).toHaveLength(0);
    // Membro fora da equipe configurada é recusado.
    expect((await owner.post('/api/agenda', { force: true, title: 'X', start: localIn(5000), teamPhones: ['5511999990000'] })).status).toBe(400);

    graph.reset();
    await tickAgendaReminders(new Date());
    const lemb = (p: string) => sentTo(p).filter((m) => m.text.includes('Lembrete') && m.text.includes('Proposta'));
    expect(lemb(M1)).toHaveLength(1);
    expect(lemb(DONO)).toHaveLength(1);
    expect(lemb(M2)).toHaveLength(0);

    graph.reset();
    expect((await owner.patch(`/api/agenda/${r.body.id}`, { start: localIn(3 * 24 * 60) })).status).toBe(200);
    expect(sentTo(M1).filter((m) => m.text.includes('remarcada'))).toHaveLength(1);
    expect(sentTo(M2)).toHaveLength(0);

    graph.reset();
    const re = await owner.post(`/api/agenda/${r.body.id}/send`, {});
    expect(re.body.results.map((x: any) => x.target).sort()).toEqual(['cliente', 'dono', 'equipe']);

    graph.reset();
    expect((await owner.patch(`/api/agenda/${r.body.id}`, { status: 'CANCELLED' })).status).toBe(200);
    expect(sentTo(M1).filter((m) => m.text.includes('cancelada'))).toHaveLength(1);
    expect(sentTo(DONO).filter((m) => m.text.includes('cancelada'))).toHaveLength(1);
    expect(sentTo(M2)).toHaveLength(0);
  });

  it('dono desmarcado e nenhum membro: só o cliente; tarefas não avisam o dono por padrão', async () => {
    const r = await owner.post('/api/agenda', { force: true, title: 'Sem equipe', start: localIn(6000), contactId, notifyOwner: false, teamPhones: [] });
    expect(r.status).toBe(201);
    expect(sentTo(CLIENTE)).toHaveLength(1);
    for (const p of [DONO, M1, M2]) expect(sentTo(p)).toHaveLength(0);
    graph.reset();
    const t = await owner.post('/api/agenda', { force: true, kind: 'TASK', title: 'Tarefa interna', start: localIn(6100) });
    expect(t.status).toBe(201);
    expect(t.body).toMatchObject({ notifyOwner: false, teamContacts: [] });
    expect(sent()).toHaveLength(0);
  });

  it('Kanban: reunião move para "Reunião agendada", mas nunca tira de Ganho/Perdido', async () => {
    const ganho = await prisma.kanbanStage.findFirst({ where: { orgId: owner.me.org.id, name: 'Ganho' } });
    const perdido = await prisma.kanbanStage.findFirst({ where: { orgId: owner.me.org.id, name: 'Perdido' } });
    await prisma.contact.update({ where: { id: contactId }, data: { stageId: ganho!.id } });
    expect((await owner.post('/api/agenda', { force: true, title: 'Pós-venda', start: localIn(7000), contactId, source: 'KANBAN' })).status).toBe(201);
    expect(await stageOf(contactId)).toBe('Ganho');
    await prisma.contact.update({ where: { id: contactId }, data: { stageId: perdido!.id } });
    expect((await owner.post('/api/agenda', { force: true, title: 'Retomada', start: localIn(7100), contactId })).status).toBe(201);
    expect(await stageOf(contactId)).toBe('Perdido');
    const novo = await prisma.kanbanStage.findFirst({ where: { orgId: owner.me.org.id, name: 'Novo' } });
    await prisma.contact.update({ where: { id: contactId }, data: { stageId: novo!.id } });
    expect((await owner.post('/api/agenda', { force: true, title: 'Demo', start: localIn(7200), contactId })).status).toBe(201);
    expect(await stageOf(contactId)).toBe('Reunião agendada');
    expect(await prisma.kanbanStage.count({ where: { orgId: owner.me.org.id, name: 'Reunião agendada' } })).toBe(1);
  });
});
