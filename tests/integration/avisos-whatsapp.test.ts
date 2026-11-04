import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { registerClient, Client, uniq, prisma, createTestChannel, installGraphMock, graph, sendInbound } from '../helpers.js';
import { toLocalIso } from '../../server/agenda/time.js';
import { createAppointment } from '../../server/agenda/service.js';
import { createOrder } from '../../server/agenda/orders.js';
import { avisarPedidoErp } from '../../server/erp/vendas/avisoPedido.js';
import { flushStaffAlerts, formatWhen, alertEnabled, appointmentAlertText, orderAlertText, notifyStaffEvent } from '../../server/whatsapp/staffAlerts.js';
import { flushHandoffNotifies } from '../../server/whatsapp/handoffNotify.js';

/**
 * Pedido do Mayck (2026-11-03): o proprietário recebe no WhatsApp que informou (Números de aviso) quando a IA
 * transfere para humano, ou quando é marcada uma reunião, criada uma tarefa ou feito um pedido.
 */
const TZ = 'America/Sao_Paulo';
const localIn = (min: number) => toLocalIso(new Date(Date.now() + min * 60_000), TZ);
const AVISO = '5511955550001';
const AVISO2 = '5511955550002';
const CLIENTE = '5511955550100';

const sent = () => graph.calls.filter((c) => c.body?.to).map((c) => ({ to: String(c.body.to), text: String(c.body.text?.body ?? '') }));
const sentTo = (phone: string) => sent().filter((m) => m.to === phone);

async function invite(owner: Client, role: 'AGENT' | 'ADMIN') {
  const inv = await owner.post('/api/team/invites', { email: `${uniq()}@t.dev`, role });
  const token = inv.body.link.split('/convite/')[1];
  const c = new Client();
  const r = await c.agent.post('/api/auth/accept-invite').set('x-requested-with', 'mckbot').send({ token, name: 'Membro Equipe', password: 'senhaMembro123' });
  c.csrf = r.body.csrfToken;
  c.me = r.body;
  return c;
}

describe('Números de aviso (WhatsApp): textos e opções', () => {
  it('data no formato dd/mm/aaaa às HH:MM (horário de Brasília)', () => {
    expect(formatWhen(new Date('2026-11-05T17:00:00Z'), TZ)).toBe('05/11/2026 às 14:00 (horário de Brasília)');
    expect(formatWhen(new Date('2026-11-05T17:00:00Z'), 'America/Manaus')).toBe('05/11/2026 às 13:00 (fuso America/Manaus)');
  });
  it('opção ausente/nula conta como ligada; false desliga só aquele tipo', () => {
    expect(alertEnabled({}, 'meeting')).toBe(true);
    expect(alertEnabled({ alertMeeting: null }, 'meeting')).toBe(true);
    expect(alertEnabled({ alertMeeting: false }, 'meeting')).toBe(false);
    expect(alertEnabled({ alertMeeting: false }, 'order')).toBe(true);
  });
  it('textos curtos com emoji e link', () => {
    const r = appointmentAlertText({ kind: 'MEETING', title: 'Demonstração', who: 'Ana (5511…)', when: '05/11/2026 às 14:00 (horário de Brasília)', by: 'IA (WhatsApp)', url: 'https://x/inbox/1' });
    expect(r.split('\n')[0]).toBe('📅 Nova reunião marcada');
    expect(r).toContain('Quando: 05/11/2026 às 14:00 (horário de Brasília)');
    expect(r).toContain('Abrir: https://x/inbox/1');
    expect(appointmentAlertText({ kind: 'TASK', title: 'Ligar', who: null, when: 'x', url: 'u' }).split('\n')[0]).toBe('📝 Nova tarefa');
    const o = orderAlertText({ title: '🛒 Novo pedido P-1', who: 'Ana', items: '2x Pizza', total: 'R$ 10,00', url: 'u' });
    expect(o).toMatch(/^🛒 Novo pedido P-1\nContato: Ana\nItens: 2x Pizza\nTotal: R\$ 10,00\nAbrir: u$/);
  });
});

describe('Números de aviso (WhatsApp): reunião, tarefa, pedido e transferência', () => {
  let owner: Client;
  let agent: Client;
  let orgId: string;
  let ctx: Awaited<ReturnType<typeof createTestChannel>>;
  let contactId: string;

  beforeAll(async () => {
    installGraphMock();
    owner = await registerClient();
    orgId = owner.me.org.id;
    agent = await invite(owner, 'AGENT');
    ctx = await createTestChannel(orgId);
    await prisma.channel.update({ where: { id: ctx.ch.id }, data: { displayPhone: '+5511900005400' } });
    await sendInbound(ctx, CLIENTE, 'oi');
    contactId = (await prisma.contact.findFirstOrThrow({ where: { orgId, waId: CLIENTE } })).id;
    await prisma.contact.update({ where: { id: contactId }, data: { name: 'Maria Cliente' } });
    // Agenda sem dono/equipe para isolar os novos avisos.
    await prisma.agendaSettings.upsert({ where: { orgId }, update: { notifyOwner: false, notifyContact: false }, create: { orgId, notifyOwner: false, notifyContact: false } });
  });
  beforeEach(() => graph.reset());
  // O banco de teste é compartilhado: não deixa conversas "aguardando" nem números de aviso para o tick dos outros arquivos.
  afterAll(async () => {
    await prisma.conversation.updateMany({ where: { orgId }, data: { waitingSince: null, mode: 'BOT', status: 'CLOSED' } });
    await prisma.organization.update({ where: { id: orgId }, data: { handoffNotifyPhones: '[]', backupPhone: null } });
  });

  it('Perfil: opções ligadas por padrão, salvam e voltam no GET', async () => {
    const g = await owner.get('/api/org/handoff-notify');
    expect(g.body.alerts).toEqual({ handoff: true, meeting: true, task: true, order: true, aiFailure: true });
    const r = await owner.patch('/api/org', { handoffNotifyPhones: [`+${AVISO}`, `+${AVISO2}`], alertTask: false });
    expect(r.status).toBe(200);
    expect((await owner.get('/api/org/handoff-notify')).body.alerts).toEqual({ handoff: true, meeting: true, task: false, order: true, aiFailure: true });
    expect((await agent.patch('/api/org', { alertTask: true })).status).toBe(403);
    expect((await owner.patch('/api/org', { alertTask: true })).status).toBe(200);
  });

  it('reunião marcada pela IA: os números recebem 1 aviso cada, com contato, data e link da conversa', async () => {
    const conv = await prisma.conversation.findFirstOrThrow({ where: { orgId, contactId } });
    const a = await createAppointment({ title: 'Demonstração', startAt: new Date('2030-03-10T17:30:00Z'), contactId, conversationId: conv.id }, { orgId, source: 'AI', force: true });
    await flushStaffAlerts();
    for (const p of [AVISO, AVISO2]) {
      const m = sentTo(p);
      expect(m).toHaveLength(1);
      expect(m[0].text).toMatch(/^📅 Nova reunião marcada/);
      expect(m[0].text).toContain('Contato: Maria Cliente');
      expect(m[0].text).toContain('Quando: 10/03/2030 às 14:30 (horário de Brasília)');
      expect(m[0].text).toContain('Marcada por: IA (WhatsApp)');
      expect(m[0].text).toContain(`/inbox/${conv.id}`);
    }
    const st = JSON.parse((await prisma.organization.findUniqueOrThrow({ where: { id: orgId } })).handoffNotifyStatus!);
    expect(st).toMatchObject({ ok: true, kind: 'meeting' });
    // Um aviso por evento: chamar de novo para o mesmo compromisso não reenvia.
    graph.reset();
    expect(await notifyStaffEvent({ orgId, event: 'meeting', key: a.id, text: () => 'x' })).toBeNull();
    expect(sent()).toHaveLength(0);
  });

  it('tarefa criada por um atendente no app avisa; criada pelo próprio Proprietário não avisa', async () => {
    const r = await agent.post('/api/agenda', { kind: 'TASK', title: 'Ligar para o fornecedor', start: localIn(120) });
    expect(r.status).toBe(201);
    await flushStaffAlerts();
    const m = sentTo(AVISO);
    expect(m).toHaveLength(1);
    expect(m[0].text).toMatch(/^📝 Nova tarefa\nTarefa: Ligar para o fornecedor/);
    expect(m[0].text).toContain('Criada por: Membro Equipe');
    expect(m[0].text).toContain('/agenda');

    graph.reset();
    expect((await owner.post('/api/agenda', { kind: 'TASK', title: 'Tarefa do dono', start: localIn(180) })).status).toBe(201);
    await flushStaffAlerts();
    expect(sentTo(AVISO)).toHaveLength(0);
  });

  it('opção desligada: tarefa não avisa (reunião continua avisando)', async () => {
    await owner.patch('/api/org', { alertTask: false });
    expect((await agent.post('/api/agenda', { kind: 'TASK', title: 'Sem aviso', start: localIn(240) })).status).toBe(201);
    await flushStaffAlerts();
    expect(sentTo(AVISO)).toHaveLength(0);
    expect((await agent.post('/api/agenda', { title: 'Reunião da equipe', start: localIn(300), force: true })).status).toBe(201);
    await flushStaffAlerts();
    expect(sentTo(AVISO).map((m) => m.text.split('\n')[0])).toEqual(['📅 Nova reunião marcada']);
    await owner.patch('/api/org', { alertTask: true });
  });

  it('número que já recebeu o aviso da Agenda (dono) não recebe de novo', async () => {
    await prisma.user.update({ where: { id: owner.me.user.id }, data: { phone: `+${AVISO}` } });
    await prisma.agendaSettings.update({ where: { orgId }, data: { notifyOwner: true } });
    await createAppointment({ title: 'Visita', startAt: new Date(Date.now() + 9 * 86_400_000), contactId }, { orgId, source: 'AI', force: true });
    await flushStaffAlerts();
    expect(sentTo(AVISO)).toHaveLength(1); // só o aviso da Agenda
    expect(sentTo(AVISO2)).toHaveLength(1);
    expect(sentTo(AVISO2)[0].text).toMatch(/^📅 Nova reunião marcada/);
    await prisma.agendaSettings.update({ where: { orgId }, data: { notifyOwner: false } });
    await prisma.user.update({ where: { id: owner.me.user.id }, data: { phone: null } });
  });

  it('pedido feito pelo cliente no WhatsApp (IA): aviso com itens e link', async () => {
    const conv = await prisma.conversation.findFirstOrThrow({ where: { orgId, contactId } });
    const o = await createOrder({ type: 'ONLINE', items: [{ nome: 'Pizza', quantidade: 2, obs: null }, { nome: 'Refri', quantidade: 1, obs: 'gelado' }], contactId, conversationId: conv.id }, { orgId, source: 'AI' });
    await flushStaffAlerts();
    const m = sentTo(AVISO);
    expect(m).toHaveLength(1);
    expect(m[0].text).toMatch(new RegExp(`^🛒 Novo pedido ${o.code}`));
    expect(m[0].text).toContain('Itens: 2x Pizza, 1x Refri (gelado)');
    expect(m[0].text).toContain('Registrado por: IA (WhatsApp)');
    expect(m[0].text).toContain(`/inbox/${conv.id}`);
  });

  it('pedido do MCK ERP criado por funcionário: aviso com total; pelo Proprietário: sem aviso', async () => {
    avisarPedidoErp({ id: 'erp-teste-1', orgId, numero: 42, parceiroId: 'nao-existe', vendedorId: agent.me.user.id, totalCents: 12345 });
    await flushStaffAlerts();
    const m = sentTo(AVISO);
    expect(m).toHaveLength(1);
    expect(m[0].text).toMatch(/^🛒 Novo pedido nº 42 \(MCK ERP\)/);
    expect(m[0].text).toContain('Total: R$ 123,45');
    expect(m[0].text).toContain('/erp/pedidos/erp-teste-1');
    graph.reset();
    avisarPedidoErp({ id: 'erp-teste-2', orgId, numero: 43, parceiroId: 'nao-existe', vendedorId: owner.me.user.id, totalCents: 100 }, { balcao: true });
    await flushStaffAlerts();
    expect(sent()).toHaveLength(0);
  });

  it('transferência feita pela IA avisa; com "Transferência para humano" desligada, não avisa', async () => {
    await owner.put('/api/ai/settings', { provider: 'fake', model: 'fake-1', enabled: true, autoReply: true });
    await sendInbound(ctx, '5511955550200', 'quero falar com um atendente');
    await flushHandoffNotifies();
    expect(sentTo(AVISO).map((m) => m.text.split('\n')[0])).toEqual(['🔔 Novo atendimento humano']);

    graph.reset();
    await owner.patch('/api/org', { alertHandoff: false });
    await sendInbound(ctx, '5511955550201', 'quero falar com um atendente');
    await flushHandoffNotifies();
    expect(sentTo(AVISO)).toHaveLength(0);
    const c2 = await prisma.contact.findFirstOrThrow({ where: { orgId, waId: '5511955550201' } });
    expect((await prisma.conversation.findFirstOrThrow({ where: { orgId, contactId: c2.id } })).mode).toBe('HUMAN');
    await owner.patch('/api/org', { alertHandoff: true });
  });

  it('nunca lança: org inexistente devolve null', async () => {
    expect(await notifyStaffEvent({ orgId: 'nao-existe', event: 'order', key: 'z', text: () => 'x' })).toBeNull();
  });
});
