import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { registerClient, Client, uniq, prisma, createTestChannel, installGraphMock, graph, sendInbound } from '../helpers.js';
import { createOrder } from '../../server/agenda/orders.js';

type Ctx = Awaited<ReturnType<typeof createTestChannel>>;
const TEAM = '5511955558800';
const EXTRA = '5511944447777';
const ENTREGA = { nome: 'Ana Souza', endereco: 'Rua das Flores, Centro, Carapicuíba', cep: '06300-000', numero: '120', complemento: null, telefone: '11 98888-7777' };

const sends = () => graph.calls.filter((c) => c.body?.to).map((c) => ({ to: String(c.body.to), text: String(c.body.text?.body ?? ''), url: c.url }));
const to = (phone: string) => sends().filter((m) => m.to === phone);

const cfg = (over: Record<string, unknown> = {}) => ({
  aiBooking: true, workStart: '00:00', workEnd: '23:30', workDays: [0, 1, 2, 3, 4, 5, 6], defaultDurationMin: 30, minNoticeMin: 0, notifyContact: true, reminderMin: 60,
  notifyOwner: false, teamContacts: [{ name: 'Equipe', phone: TEAM, active: true }], aiHandles: 'PEDIDO', ...over,
});

async function invite(owner: Client, role: 'AGENT' | 'ADMIN') {
  const inv = await owner.post('/api/team/invites', { email: `${uniq()}@t.dev`, role });
  const token = inv.body.link.split('/convite/')[1];
  const c = new Client();
  const r = await c.agent.post('/api/auth/accept-invite').set('x-requested-with', 'mckbot').send({ token, name: 'Membro Atendente', password: 'senhaMembro123' });
  c.csrf = r.body.csrfToken;
  c.me = r.body;
  return c;
}

let owner: Client; let admin: Client; let agent: Client; let orgId: string; let chA: Ctx; let chB: Ctx;
let seq = 0;

/** Cliente escreve no WhatsApp B (janela de 24 h aberta) e a loja registra o pedido dessa conversa. */
async function newOrder(over: Record<string, unknown> = {}, via: Ctx = chB) {
  const phone = `55119111${String(40000 + ++seq).padStart(5, '0')}`;
  await sendInbound(via, phone, 'oi, quero fazer um pedido');
  const contact = (await prisma.contact.findFirst({ where: { orgId, waId: phone } }))!;
  const conv = (await prisma.conversation.findFirst({ where: { orgId, contactId: contact.id } }))!;
  const o = await createOrder({ type: 'FISICO', items: [{ nome: 'Ração Golden 15kg', quantidade: 2, obs: null }], contactId: contact.id, conversationId: conv.id, extraContacts: [{ name: 'Vizinha', phone: EXTRA }], ...over } as any, { orgId, userId: owner.me.user.id, source: 'MANUAL' });
  graph.reset();
  return { o, phone, contact, conv };
}

beforeAll(async () => {
  installGraphMock();
  owner = await registerClient();
  orgId = owner.me.org.id;
  chA = await createTestChannel(orgId);
  chB = await createTestChannel(orgId);
  expect((await owner.put('/api/agenda/settings', cfg())).status).toBe(200);
  admin = await invite(owner, 'ADMIN');
  agent = await invite(owner, 'AGENT');
});
beforeEach(() => graph.reset());

describe('Pedidos: fluxo de status e histórico', () => {
  it('segue o fluxo, permite pular etapas (online), bloqueia finalizado/cancelar pelo seletor e grava o histórico', async () => {
    const { o } = await newOrder();
    expect(o.status).toBe('NOVO');
    expect(o.paymentStatus).toBe('AGUARDANDO');
    let r = await owner.patch(`/api/agenda/orders/${o.id}`, { status: 'CONFIRMADO', notify: false });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: 'CONFIRMADO', statusLabel: 'Confirmado' });
    r = await agent.patch(`/api/agenda/orders/${o.id}`, { status: 'EM_SEPARACAO', note: 'Separando no estoque', notify: false });
    expect(r.body.status).toBe('EM_SEPARACAO');
    expect((await owner.patch(`/api/agenda/orders/${o.id}`, { status: 'EM_SEPARACAO' })).status).toBe(400);
    expect((await owner.patch(`/api/agenda/orders/${o.id}`, { status: 'CANCELADO' })).status).toBe(400);
    expect((await owner.patch(`/api/agenda/orders/${o.id}`, { status: 'ATRASADO', notify: false })).body.status).toBe('ATRASADO');
    expect((await owner.patch(`/api/agenda/orders/${o.id}`, { status: 'FINALIZADO', notify: false })).body.status).toBe('FINALIZADO');
    const back = await owner.patch(`/api/agenda/orders/${o.id}`, { status: 'EM_SEPARACAO', notify: false });
    expect(back.status).toBe(400);
    expect(back.body.error ?? back.body.message).toMatch(/Devolvido/);
    expect((await owner.patch(`/api/agenda/orders/${o.id}`, { status: 'DEVOLVIDO', notify: false })).body.status).toBe('DEVOLVIDO');

    const h = (await owner.get(`/api/agenda/orders/${o.id}/history`)).body.items;
    expect(h.map((x: any) => `${x.from ?? '-'}>${x.to}`)).toEqual(['->NOVO', 'NOVO>CONFIRMADO', 'CONFIRMADO>EM_SEPARACAO', 'EM_SEPARACAO>ATRASADO', 'ATRASADO>FINALIZADO', 'FINALIZADO>DEVOLVIDO']);
    expect(h[2]).toMatchObject({ kind: 'STATUS', note: 'Separando no estoque', by: 'Membro Atendente', fromLabel: 'Confirmado', toLabel: 'Em separação (preparando)', notified: 0 });
    expect(h[1].by).toBe(owner.me.user.name);
    expect(sends()).toHaveLength(0);

    // Pedido online pula as etapas de envio.
    const on = (await newOrder({ type: 'ONLINE', items: [{ nome: 'E-book Adestramento', quantidade: 1, obs: null }] })).o;
    await owner.patch(`/api/agenda/orders/${on.id}`, { status: 'CONFIRMADO', notify: false });
    expect((await owner.patch(`/api/agenda/orders/${on.id}`, { status: 'ENTREGUE', notify: false })).body.status).toBe('ENTREGUE');
    expect((await owner.patch(`/api/agenda/orders/${on.id}`, { status: 'FINALIZADO', notify: false })).body.status).toBe('FINALIZADO');
    expect((await owner.get('/api/agenda/orders?group=concluidos')).body.items.map((x: any) => x.id)).toEqual(expect.arrayContaining([on.id]));
    expect((await owner.get('/api/agenda/orders?group=abertos')).body.items.map((x: any) => x.id)).not.toContain(on.id);
    expect((await owner.patch(`/api/agenda/orders/${on.id}`, { status: 'VOANDO' })).status).toBe(400);
  });

  it('pagamento é independente do status (padrão: não avisa) e tem filtro próprio', async () => {
    const { o } = await newOrder();
    const r = await owner.patch(`/api/agenda/orders/${o.id}`, { paymentStatus: 'PAGO' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: 'NOVO', paymentStatus: 'PAGO', paymentLabel: 'Pago', notifications: [] });
    expect(sends()).toHaveLength(0);
    expect((await owner.patch(`/api/agenda/orders/${o.id}`, { paymentStatus: 'PAGO' })).status).toBe(400);
    expect((await owner.patch(`/api/agenda/orders/${o.id}`, { paymentStatus: 'FIADO' })).status).toBe(400);
    // Mudar o status não mexe no pagamento.
    expect((await owner.patch(`/api/agenda/orders/${o.id}`, { status: 'CONFIRMADO', notify: false })).body.paymentStatus).toBe('PAGO');
    const ids = (q: string) => owner.get(`/api/agenda/orders?${q}`).then((x) => x.body.items.map((i: any) => i.id));
    expect(await ids('payment=PAGO')).toContain(o.id);
    expect(await ids('payment=AGUARDANDO')).not.toContain(o.id);
    expect(await ids('payment=PAGO&group=abertos')).toContain(o.id);
    const h = (await owner.get(`/api/agenda/orders/${o.id}/history`)).body.items;
    expect(h.find((x: any) => x.kind === 'PAGAMENTO')).toMatchObject({ from: 'AGUARDANDO', to: 'PAGO', fromLabel: 'Aguardando pagamento', toLabel: 'Pago' });
    // Avisar sobre pagamento só quando pedirem.
    const r2 = await owner.patch(`/api/agenda/orders/${o.id}`, { paymentStatus: 'ESTORNADO', notify: true });
    expect(r2.body.notifications.filter((n: any) => n.ok)).toHaveLength(2);
    expect(sends()[0].text).toMatch(/Pagamento do seu pedido \*P-\w+\*: \*Estornado\/Reembolsado\*/);
  });
});

describe('Pedidos: avisos por WhatsApp a cada mudança de status', () => {
  it('padrão ligado: cliente e contatos adicionais recebem (código, novo status, observação), pelo WhatsApp que recebeu o pedido', async () => {
    const { o, phone, conv } = await newOrder();
    const r = await owner.patch(`/api/agenda/orders/${o.id}`, { status: 'SAIU_ENTREGA', note: 'Chega até as 18h' });
    expect(r.status).toBe(200);
    expect(r.body.notifications).toEqual([{ target: 'cliente', ok: true }, { target: 'adicional', ok: true }]);
    const c = to(phone); const e = to(EXTRA);
    expect(c).toHaveLength(1);
    expect(e).toHaveLength(1);
    expect(c[0].text).toContain(`Atualização do seu pedido *${o.code}*`);
    expect(c[0].text).toContain('Novo status: *Saiu para entrega*');
    expect(c[0].text).toContain('Observação da loja: Chega até as 18h');
    expect(e[0].text).toContain(`Atualização do pedido *${o.code}*`);
    // Mesmo canal (WhatsApp B) que recebeu o pedido — nada sai pelo A.
    expect(sends().every((m) => m.url.includes(`/${chB.phoneNumberId}/messages`))).toBe(true);
    // A mensagem ao cliente fica registrada na conversa.
    const out = await prisma.message.findFirst({ where: { orgId, conversationId: conv.id, direction: 'OUT' }, orderBy: { createdAt: 'desc' } });
    expect(out!.body).toContain('Saiu para entrega');
    const h = (await owner.get(`/api/agenda/orders/${o.id}/history`)).body.items;
    expect(h[h.length - 1]).toMatchObject({ to: 'SAIU_ENTREGA', notified: 2 });
  });

  it('com "Notificar" desmarcado ninguém recebe', async () => {
    const { o } = await newOrder();
    const r = await owner.patch(`/api/agenda/orders/${o.id}`, { status: 'CONFIRMADO', notify: false });
    expect(r.body.notifications).toEqual([]);
    expect(sends()).toHaveLength(0);
  });

  it('sem canal no pedido usa o WhatsApp padrão da organização', async () => {
    const o = await createOrder({ type: 'ONLINE', items: [{ nome: 'Curso', quantidade: 1, obs: null }], extraContacts: [{ name: 'Sócio', phone: '11 93333-2222' }] }, { orgId, userId: owner.me.user.id });
    graph.reset();
    expect(o.channelId).toBeNull();
    const r = await owner.patch(`/api/agenda/orders/${o.id}`, { status: 'CONFIRMADO' });
    expect(r.body.notifications).toEqual([{ target: 'adicional', ok: true }]);
    expect(to('5511933332222')).toHaveLength(1);
    expect(to('5511933332222')[0].url).toContain(`/${chA.phoneNumberId}/messages`);
  });

  it('opt-out: cliente e contato adicional que pediram para não receber ficam de fora (inclusive sem o 9º dígito)', async () => {
    const { o, phone, contact } = await newOrder({ extraContacts: [{ name: 'Mãe', phone: '5511977776666' }, { name: 'Pai', phone: '5511966665555' }] });
    await prisma.contact.update({ where: { id: contact.id }, data: { optOut: true } });
    // Contato do CRM com opt-out cadastrado sem o 9º dígito.
    await prisma.contact.create({ data: { orgId, waId: '551177776666', phone: '551177776666', name: 'Mãe', optOut: true } });
    const r = await owner.patch(`/api/agenda/orders/${o.id}`, { status: 'CONFIRMADO' });
    expect(r.body.notifications).toEqual([{ target: 'cliente', ok: false, skipped: 'opt-out' }, { target: 'adicional', ok: false, skipped: 'opt-out' }, { target: 'adicional', ok: true }]);
    expect(to(phone)).toHaveLength(0);
    expect(to('5511977776666')).toHaveLength(0);
    expect(to('5511966665555')).toHaveLength(1);
    // Cancelamento também respeita o opt-out.
    graph.reset();
    await owner.post(`/api/agenda/orders/${o.id}/cancel`, { reason: 'Cliente desistiu' });
    expect(to(phone)).toHaveLength(0);
    expect(to('5511977776666')).toHaveLength(0);
  });
});

describe('Pedidos: edição pela loja', () => {
  it('edita itens/entrega/contatos; padrão sem aviso; com "Notificar" envia o resumo do que mudou', async () => {
    const { o, phone } = await newOrder();
    let r = await agent.put(`/api/agenda/orders/${o.id}`, { items: [{ nome: 'Ração Golden 15kg', quantidade: 3 }, { nome: 'Petisco', quantidade: 1 }] });
    expect(r.status).toBe(200);
    expect(r.body.items).toEqual([{ nome: 'Ração Golden 15kg', quantidade: 3, obs: null }, { nome: 'Petisco', quantidade: 1, obs: null }]);
    expect(r.body.notifications).toEqual([]);
    expect(sends()).toHaveLength(0);
    r = await owner.put(`/api/agenda/orders/${o.id}`, { delivery: ENTREGA, description: 'Entregar à tarde', extraContacts: [{ name: 'Portaria', phone: '11 92222-1111' }], notify: true, note: 'Ajustado a pedido do cliente' });
    expect(r.status).toBe(200);
    expect(r.body.changed).toEqual(['descrição', 'entrega', 'contatos adicionais']);
    expect(r.body.extraContacts).toEqual([{ name: 'Portaria', phone: '5511922221111' }]);
    const c = to(phone);
    expect(c).toHaveLength(1);
    expect(c[0].text).toContain(`Seu pedido *${o.code}* foi alterado pela loja`);
    expect(c[0].text).toContain('Entrega: Ana Souza — Rua das Flores');
    expect(c[0].text).toContain('Descrição: Entregar à tarde');
    expect(c[0].text).toContain('Ajustado a pedido do cliente');
    expect(to('5511922221111')).toHaveLength(1);
    expect(to(EXTRA)).toHaveLength(0); // removido dos contatos adicionais
    const h = (await owner.get(`/api/agenda/orders/${o.id}/history`)).body.items.filter((x: any) => x.kind === 'EDICAO');
    expect(h).toHaveLength(2);
    expect(h[0].note).toContain('Itens');
    expect(h[1]).toMatchObject({ notified: 2 });
    // Validações.
    expect((await owner.put(`/api/agenda/orders/${o.id}`, { items: [] })).status).toBe(400);
    expect((await owner.put(`/api/agenda/orders/${o.id}`, { delivery: { ...ENTREGA, cep: '1' } })).status).toBe(400);
    expect((await owner.put(`/api/agenda/orders/${o.id}`, { extraContacts: [{ phone: '123' }] })).status).toBe(400);
    expect((await owner.put(`/api/agenda/orders/${o.id}`, { extraContacts: Array.from({ length: 6 }, (_, i) => ({ phone: `1191111000${i}` })) })).status).toBe(400);
    expect((await owner.put(`/api/agenda/orders/${o.id}`, { description: 'Entregar à tarde' })).status).toBe(400); // nada mudou
  });

  it('pedido cancelado não pode ser editado', async () => {
    const { o } = await newOrder();
    await owner.post(`/api/agenda/orders/${o.id}/cancel`, { reason: 'Sem estoque' });
    expect((await owner.put(`/api/agenda/orders/${o.id}`, { description: 'x' })).status).toBe(400);
  });
});

describe('Pedidos: cancelamento', () => {
  it('Dono/Admin cancelam com motivo; sempre avisa cliente, adicionais e equipe; atendente não cancela', async () => {
    const { o, phone } = await newOrder();
    await owner.patch(`/api/agenda/orders/${o.id}`, { status: 'EM_SEPARACAO', notify: false });
    expect((await agent.post(`/api/agenda/orders/${o.id}/cancel`, { reason: 'Sem estoque' })).status).toBe(403);
    expect((await owner.post(`/api/agenda/orders/${o.id}/cancel`, { reason: '' })).status).toBe(400);
    const r = await admin.post(`/api/agenda/orders/${o.id}/cancel`, { reason: 'Produto sem estoque' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: 'CANCELADO', cancelReason: 'Produto sem estoque' });
    expect(to(phone)[0].text).toContain(`Seu pedido *${o.code}* foi cancelado pela loja.\nMotivo: Produto sem estoque`);
    expect(to(EXTRA)[0].text).toContain(`O pedido *${o.code}* foi cancelado`);
    const team = to(TEAM);
    expect(team).toHaveLength(1);
    expect(team[0].text).toContain(`Pedido *${o.code}* cancelado`);
    expect(team[0].text).toMatch(/📲 Via: WhatsApp 2/);
    expect(team[0].text).toContain('Cancelado por: Membro Atendente');
    expect((await owner.post(`/api/agenda/orders/${o.id}/cancel`, { reason: 'De novo' })).status).toBe(400);
    const h = (await owner.get(`/api/agenda/orders/${o.id}/history`)).body.items;
    expect(h[h.length - 1]).toMatchObject({ kind: 'CANCELAMENTO', from: 'EM_SEPARACAO', to: 'CANCELADO', note: 'Produto sem estoque', notified: 2 });
    // Auditoria sem dados pessoais (sem motivo, telefones ou nomes).
    const log = await prisma.auditLog.findFirst({ where: { orgId, action: 'pedido.cancel', entityId: o.id } });
    const meta = JSON.stringify(log!.meta ?? '');
    expect(meta).not.toMatch(/estoque|5511|Ana|Vizinha/);
    expect(meta).toContain(o.code);
    // Reabrir: só Dono/Admin.
    expect((await agent.patch(`/api/agenda/orders/${o.id}`, { status: 'NOVO', notify: false })).status).toBe(403);
    expect((await owner.patch(`/api/agenda/orders/${o.id}`, { status: 'CONFIRMADO', notify: false })).status).toBe(400);
    const re = await owner.patch(`/api/agenda/orders/${o.id}`, { status: 'NOVO', notify: false });
    expect(re.body).toMatchObject({ status: 'NOVO', cancelReason: null });
  });

  it('pedido finalizado não pode ser cancelado', async () => {
    const { o } = await newOrder();
    await owner.patch(`/api/agenda/orders/${o.id}`, { status: 'FINALIZADO', notify: false });
    expect((await owner.post(`/api/agenda/orders/${o.id}/cancel`, { reason: 'Tarde demais' })).status).toBe(400);
  });
});

describe('Pedidos: isolamento entre organizações', () => {
  it('outra organização não vê, não altera, não edita, não cancela e não lê o histórico', async () => {
    const { o } = await newOrder();
    const other = await registerClient();
    expect((await other.get('/api/agenda/orders')).body.items.map((x: any) => x.id)).not.toContain(o.id);
    expect((await other.patch(`/api/agenda/orders/${o.id}`, { status: 'CONFIRMADO' })).status).toBe(404);
    expect((await other.put(`/api/agenda/orders/${o.id}`, { description: 'invasão' })).status).toBe(404);
    expect((await other.post(`/api/agenda/orders/${o.id}/cancel`, { reason: 'invasão' })).status).toBe(404);
    expect((await other.get(`/api/agenda/orders/${o.id}/history`)).status).toBe(404);
    const cur = (await prisma.order.findUnique({ where: { id: o.id } }))!;
    expect(cur).toMatchObject({ status: 'NOVO', description: null });
    expect(sends()).toHaveLength(0);
  });
});
