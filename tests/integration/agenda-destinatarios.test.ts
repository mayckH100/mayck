import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { registerClient, Client, prisma, createTestChannel, installGraphMock, graph, sendInbound } from '../helpers.js';
import { tickAgendaReminders } from '../../server/agenda/service.js';
import { toLocalIso } from '../../server/agenda/time.js';

const TZ = 'America/Sao_Paulo';
const localIn = (min: number) => toLocalIso(new Date(Date.now() + min * 60_000), TZ);
const CLIENTE = '5511955558001';
const DONO = '5511955558002';
const EXTRA1 = '5511955558003';
const EXTRA2 = '5521955558004';

/** Mensagens de texto enviadas pela Graph API: [destinatário, texto]. */
const sent = () => graph.calls.filter((c) => c.body?.to).map((c) => ({ to: String(c.body.to), text: String(c.body.text?.body ?? '') }));
const sentTo = (phone: string) => sent().filter((m) => m.to === phone);

describe('Agenda: contatos adicionais e destinatários dos avisos', () => {
  let owner: Client;
  let contactId: string;

  beforeAll(async () => {
    installGraphMock();
    owner = await registerClient();
    const ctx = await createTestChannel(owner.me.org.id);
    await sendInbound(ctx, CLIENTE, 'oi'); // janela de 24h aberta
    contactId = (await prisma.contact.findFirst({ where: { orgId: owner.me.org.id, waId: CLIENTE } }))!.id;
    await prisma.contact.update({ where: { id: contactId }, data: { name: 'Maria Cliente' } });
  });
  beforeEach(() => { graph.reset(); });

  it('padrões: cliente ligado, atendente desligado, adicionais ligado', async () => {
    const s = await owner.get('/api/agenda/settings');
    expect(s.body).toMatchObject({ notifyContact: true, notifyAssignee: false, notifyExtras: true });
    const r = await owner.post('/api/agenda', { title: 'Padrões', start: localIn(3 * 24 * 60), contactId, assignedUserId: owner.me.user.id });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ notifyContact: true, notifyAssignee: false, notifyExtras: true, extraContacts: [] });
  });

  it('valida contatos adicionais: máx. 5, telefone obrigatório/válido e sem repetidos (normalizados)', async () => {
    const six = Array.from({ length: 6 }, (_, i) => ({ phone: `119555590${10 + i}` }));
    expect((await owner.post('/api/agenda', { title: 'Seis', start: localIn(4000), extraContacts: six })).status).toBe(400);
    expect((await owner.post('/api/agenda', { title: 'Inválido', start: localIn(4000), extraContacts: [{ name: 'X', phone: '123' }] })).status).toBe(400);
    expect((await owner.post('/api/agenda', { title: 'Sem tel', start: localIn(4000), extraContacts: [{ name: 'X' }] })).status).toBe(400);
    const dup = await owner.post('/api/agenda', { title: 'Dup', start: localIn(4000), extraContacts: [{ phone: '(11) 95555-8003' }, { phone: EXTRA1 }] });
    expect(dup.status).toBe(400);
    expect(dup.body.error ?? dup.body.message).toMatch(/repetido/);
    const five = Array.from({ length: 5 }, (_, i) => ({ name: i ? '' : 'Ana', phone: `(11) 9555-590${i}` }));
    const ok = await owner.post('/api/agenda', { title: 'Cinco', start: localIn(4000), extraContacts: five, notifyExtras: false });
    expect(ok.status).toBe(201);
    expect(ok.body.extraContacts).toHaveLength(5);
    expect(ok.body.extraContacts[0]).toEqual({ name: 'Ana', phone: '551195555900' });
    expect(ok.body.extraContacts[1].name).toBeNull();
    // Edição também respeita o limite.
    expect((await owner.patch(`/api/agenda/${ok.body.id}`, { extraContacts: six })).status).toBe(400);
    const ed = await owner.patch(`/api/agenda/${ok.body.id}`, { extraContacts: [{ phone: EXTRA2 }] });
    expect(ed.status).toBe(200);
    expect(ed.body.extraContacts).toEqual([{ name: null, phone: EXTRA2 }]);
  });

  it('confirmação vai só para os destinatários marcados (equipe recebe a variante "Reunião com <cliente>" com o Meet/descrição)', async () => {
    await prisma.user.update({ where: { id: owner.me.user.id }, data: { phone: '(11) 95555-8002' } });
    const r = await owner.post('/api/agenda', {
      title: 'Kickoff', description: 'Pauta: escopo', start: localIn(5 * 24 * 60), contactId, assignedUserId: owner.me.user.id,
      notifyContact: false, notifyAssignee: true, notifyExtras: true, extraContacts: [{ name: 'Rafa', phone: EXTRA1 }, { phone: EXTRA2 }],
    });
    expect(r.status).toBe(201);
    expect(sentTo(CLIENTE)).toHaveLength(0);
    for (const p of [DONO, EXTRA1, EXTRA2]) {
      const m = sentTo(p);
      expect(m).toHaveLength(1);
      expect(m[0].text).toContain('Reunião com Maria Cliente');
      expect(m[0].text).toContain('Kickoff');
      expect(m[0].text).toContain('Pauta: escopo');
    }

    // Só o cliente.
    graph.reset();
    const c = await owner.post('/api/agenda', { title: 'Só cliente', start: localIn(6 * 24 * 60), contactId, assignedUserId: owner.me.user.id, notifyAssignee: false, notifyExtras: false, extraContacts: [{ phone: EXTRA1 }] });
    expect(c.status).toBe(201);
    expect(sentTo(CLIENTE)).toHaveLength(1);
    expect(sentTo(CLIENTE)[0].text).toContain('Só cliente');
    expect(sentTo(EXTRA1)).toHaveLength(0);
    expect(sentTo(DONO)).toHaveLength(0);

    // Reenviar respeita os destinatários.
    graph.reset();
    const re = await owner.post(`/api/agenda/${r.body.id}/send`, {});
    expect(re.status).toBe(200);
    expect(re.body).toMatchObject({ ok: true, sent: 3, total: 3 });
    expect(sentTo(CLIENTE)).toHaveLength(0);
  });

  it('falha de um destinatário não impede os demais; responsável sem telefone é pulado', async () => {
    await prisma.user.update({ where: { id: owner.me.user.id }, data: { phone: null } });
    graph.failNext = [400]; // erro definitivo (sem novas tentativas) no primeiro adicional
    const r = await owner.post('/api/agenda', { title: 'Com falha', start: localIn(7 * 24 * 60), assignedUserId: owner.me.user.id, notifyAssignee: true, extraContacts: [{ phone: EXTRA1 }, { phone: EXTRA2 }] });
    expect(r.status).toBe(201);
    // O primeiro envio falhou (com novas tentativas ou não), mas o segundo contato recebeu.
    expect(sentTo(EXTRA2).length).toBeGreaterThanOrEqual(1);
    expect(sentTo(DONO)).toHaveLength(0);
    const re = await owner.post(`/api/agenda/${r.body.id}/send`, {});
    expect(re.body.results.find((x: any) => x.target === 'atendente')).toMatchObject({ ok: false });
    expect(re.body.results.filter((x: any) => x.target === 'adicional' && x.ok)).toHaveLength(2);
  });

  it('lembrete vai para os mesmos destinatários, uma vez cada (sem duplicar em ticks seguidos)', async () => {
    await prisma.user.update({ where: { id: owner.me.user.id }, data: { phone: DONO } });
    const r = await owner.post('/api/agenda', {
      title: 'Lembrar equipe', start: localIn(30), reminderMin: 60, contactId, assignedUserId: owner.me.user.id,
      notifyContact: true, notifyAssignee: false, notifyExtras: true, extraContacts: [{ phone: EXTRA1 }, { phone: CLIENTE }],
    });
    expect(r.status).toBe(201);
    graph.reset();
    await Promise.all([tickAgendaReminders(new Date()), tickAgendaReminders(new Date())]);
    await tickAgendaReminders(new Date());
    const lembretes = (p: string) => sentTo(p).filter((m) => m.text.includes('Lembrete') && m.text.includes('Lembrar equipe'));
    expect(lembretes(CLIENTE)).toHaveLength(1); // o adicional com o mesmo número do cliente não recebe de novo
    expect(lembretes(CLIENTE)[0].text).not.toContain('Reunião com');
    expect(lembretes(EXTRA1)).toHaveLength(1);
    expect(lembretes(DONO)).toHaveLength(0);
    expect((await prisma.appointment.findUnique({ where: { id: r.body.id } }))!.reminderSentAt).not.toBeNull();
  });

  it('lembrete só para a equipe (sem cliente) também é enviado', async () => {
    const r = await owner.post('/api/agenda', { kind: 'TASK', title: 'Interna', start: localIn(20), reminderMin: 30, assignedUserId: owner.me.user.id, notifyAssignee: true, notifyExtras: false, extraContacts: [{ phone: EXTRA2 }] });
    expect(r.status).toBe(201);
    graph.reset();
    expect(await tickAgendaReminders(new Date())).toBeGreaterThanOrEqual(1);
    expect(sentTo(DONO).filter((m) => m.text.includes('Interna'))).toHaveLength(1);
    expect(sentTo(EXTRA2)).toHaveLength(0);
  });

  it('configuração da empresa (só admin) muda os padrões', async () => {
    const base = { aiBooking: false, workStart: '08:00', workEnd: '20:00', workDays: [1, 2, 3, 4, 5], defaultDurationMin: 30, minNoticeMin: 0, notifyContact: true, reminderMin: 60 };
    const s = await owner.put('/api/agenda/settings', { ...base, notifyAssignee: true, notifyExtras: false });
    expect(s.body).toMatchObject({ notifyAssignee: true, notifyExtras: false });
    const r = await owner.post('/api/agenda', { title: 'Novos padrões', start: localIn(9 * 24 * 60) });
    expect(r.body).toMatchObject({ notifyAssignee: true, notifyExtras: false });
  });
});
