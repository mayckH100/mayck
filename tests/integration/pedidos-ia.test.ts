import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { registerClient, Client, uniq, prisma, createTestChannel, installGraphMock, graph, sendInbound } from '../helpers.js';
import { fakeAi } from '../../server/ai/providers.js';
import { ordersPromptSection } from '../../server/agenda/orders.js';

const TEAM = '5511955559900';
const ENTREGA = { nome: 'Ana Souza', endereco: 'Rua das Flores, Centro, Carapicuíba', cep: '06300-000', numero: '120', complemento: 'Apto 12', telefone: '11 98888-7777' };
const pedidoTag = (itens: any[], extra: Record<string, unknown> = {}) => `[PEDIDO:${JSON.stringify({ itens, descricao: 'Pedido pelo WhatsApp', ...extra })}]`;

const sent = () => graph.calls.filter((c) => c.body?.to).map((c) => ({ to: String(c.body.to), text: String(c.body.text?.body ?? '') }));

/** Configuração completa da Agenda (PUT exige os campos básicos). */
const cfg = (over: Record<string, unknown> = {}) => ({
  aiBooking: true, workStart: '00:00', workEnd: '23:30', workDays: [0, 1, 2, 3, 4, 5, 6], defaultDurationMin: 30, minNoticeMin: 0, notifyContact: true, reminderMin: 60,
  notifyOwner: false, teamContacts: [{ name: 'Equipe', phone: TEAM, active: true }], ...over,
});

async function setupOrg(over: Record<string, unknown>) {
  const owner = await registerClient();
  const orgId = owner.me.org.id as string;
  const ctx = await createTestChannel(orgId);
  await owner.put('/api/ai/settings', { provider: 'fake', model: 'fake-1', enabled: true, autoReply: true });
  const r = await owner.put('/api/agenda/settings', cfg(over));
  expect(r.status).toBe(200);
  return { owner, orgId, ctx };
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

function turner(ctx: Awaited<ReturnType<typeof createTestChannel>>) {
  return async (phone: string, clientText: string, aiText: string) => {
    graph.reset();
    fakeAi.script.push(aiText);
    await sendInbound(ctx, phone, clientText);
    return sent().filter((m) => m.to === phone).map((m) => m.text);
  };
}
const ordersOf = async (orgId: string, phone: string) => {
  const c = await prisma.contact.findFirst({ where: { orgId, waId: phone } });
  return c ? prisma.order.findMany({ where: { orgId, contactId: c.id }, orderBy: { createdAt: 'asc' } }) : [];
};
const convOf = async (orgId: string, phone: string) => {
  const c = await prisma.contact.findFirst({ where: { orgId, waId: phone } });
  return prisma.conversation.findFirst({ where: { orgId, contactId: c!.id } });
};

beforeAll(() => installGraphMock());
beforeEach(() => { graph.reset(); fakeAi.script.length = 0; fakeAi.calls.length = 0; });

describe('Pedidos pela IA: configuração "O que a IA atende" (permissões)', () => {
  it('padrão é Reunião; dono e admin alteram; atendente não; valor inválido é recusado', async () => {
    const owner = await registerClient();
    const s0 = await owner.get('/api/agenda/settings');
    expect(s0.body).toMatchObject({ aiHandles: 'REUNIAO', orderType: 'FISICO', orderAskDelivery: false });
    const r = await owner.put('/api/agenda/settings', cfg({ aiHandles: 'PEDIDO', orderType: 'ONLINE', orderAskDelivery: true }));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ aiHandles: 'PEDIDO', orderType: 'ONLINE', orderAskDelivery: true });
    const admin = await invite(owner, 'ADMIN');
    expect((await admin.put('/api/agenda/settings', cfg({ aiHandles: 'AMBOS', orderType: 'AMBOS' }))).status).toBe(200);
    const agent = await invite(owner, 'AGENT');
    expect((await agent.put('/api/agenda/settings', cfg({ aiHandles: 'REUNIAO' }))).status).toBe(403);
    expect((await owner.put('/api/agenda/settings', cfg({ aiHandles: 'LOJA' }))).status).toBe(400);
    expect((await owner.put('/api/agenda/settings', cfg({ orderType: 'DIGITAL' }))).status).toBe(400);
    const s1 = await agent.get('/api/agenda/settings');
    expect(s1.body).toMatchObject({ aiHandles: 'AMBOS', orderType: 'AMBOS' });
    // Sem os campos novos, o PUT antigo continua funcionando e não muda o modo.
    expect((await owner.put('/api/agenda/settings', cfg())).body.aiHandles).toBe('AMBOS');
  });
});

describe('Pedidos pela IA: prompt conforme o modo', () => {
  it('Reunião: agenda como hoje e avisa que não registra pedidos; Pedido: sem horários; Os dois: ambos + classificação', async () => {
    const { owner, orgId, ctx } = await setupOrg({ aiHandles: 'REUNIAO' });
    let p = await ordersPromptSection(orgId);
    expect(p).toMatch(/não registra pedidos/);
    expect(p).not.toContain('[PEDIDO:');
    expect(p).toContain('[TIPO:reuniao]');
    const turn = turner(ctx);
    await turn('5511911110001', 'oi', 'Olá!');
    let sys = fakeAi.calls.at(-1)!.find((m) => m.role === 'system')!.content;
    expect(sys).toContain('HORÁRIOS LIVRES:');
    expect(sys).not.toContain('[PEDIDO:');

    await owner.put('/api/agenda/settings', cfg({ aiHandles: 'PEDIDO', orderType: 'FISICO' }));
    p = await ordersPromptSection(orgId);
    expect(p).toContain('[PEDIDO:');
    expect(p).toMatch(/Não agende reuniões/);
    expect(p).toMatch(/Sempre peça os dados de entrega/);
    expect(p).toMatch(/Nunca invente produtos, preços/);
    await turn('5511911110001', 'quero comprar', 'Claro!');
    sys = fakeAi.calls.at(-1)!.find((m) => m.role === 'system')!.content;
    expect(sys).not.toContain('HORÁRIOS LIVRES:');
    expect(sys).toContain('[PEDIDO:');

    await owner.put('/api/agenda/settings', cfg({ aiHandles: 'AMBOS', orderType: 'ONLINE', orderAskDelivery: false }));
    p = await ordersPromptSection(orgId);
    expect(p).toMatch(/Não peça dados de entrega/);
    await owner.put('/api/agenda/settings', cfg({ aiHandles: 'AMBOS', orderType: 'ONLINE', orderAskDelivery: true }));
    p = await ordersPromptSection(orgId);
    expect(p).toMatch(/Mesmo sendo online, peça os dados de entrega/);
    await turn('5511911110001', 'quero marcar e comprar', 'Claro!');
    sys = fakeAi.calls.at(-1)!.find((m) => m.role === 'system')!.content;
    expect(sys).toContain('HORÁRIOS LIVRES:');
    expect(sys).toContain('[PEDIDO:');
    expect(sys).toContain('[TIPO:ambos]');
  });

  it('modo desligado (IA de agenda off e Reunião): nada novo no prompt', async () => {
    const { orgId } = await setupOrg({ aiBooking: false, aiHandles: 'REUNIAO' });
    expect(await ordersPromptSection(orgId)).toBe('');
  });
});

describe('Pedidos pela IA: classificação da conversa (tag no card)', () => {
  it('[TIPO:pedido] marca a conversa, não aparece para o cliente, e reunião + pedido vira "os dois"', async () => {
    const { orgId, ctx } = await setupOrg({ aiHandles: 'AMBOS', orderType: 'ONLINE' });
    const turn = turner(ctx);
    const P = '5511911120001';
    let out = await turn(P, 'quero comprar o e-book', 'Ótimo! Qual e-book você quer?\n[TIPO:pedido]');
    expect(out[0]).not.toContain('[TIPO');
    expect((await convOf(orgId, P))!.aiIntent).toBe('PEDIDO');
    out = await turn(P, 'e quero marcar uma conversa', 'Claro, qual dia?\n[TIPO:reuniao]');
    expect(out[0]).not.toContain('[TIPO');
    expect((await convOf(orgId, P))!.aiIntent).toBe('AMBOS');
  });

  it('reunião agendada pela IA marca a conversa como Reunião e o card da agenda traz a tag', async () => {
    const { owner, orgId, ctx } = await setupOrg({ aiHandles: 'AMBOS' });
    const turn = turner(ctx);
    const P = '5511911120002';
    const day = new Date(Date.now() + 2 * 24 * 3600e3).toISOString().slice(0, 10);
    await turn(P, `quero marcar ${day} às 10:00`, `Agendado!\n[AGENDAR:{"inicio":"${day}T10:00","duracao":30,"titulo":"Reunião"}]`);
    expect((await convOf(orgId, P))!.aiIntent).toBe('REUNIAO');
    const list = await owner.get('/api/agenda?from=' + day.slice(0, 10) + '&to=' + day);
    expect(list.body.items[0].intent).toBe('REUNIAO');
  });
});

describe('Pedidos pela IA: Físico (pet shop) — dados de entrega, confirmação e sem duplicata', () => {
  let orgId: string, owner: Client;
  let turn: ReturnType<typeof turner>;
  beforeAll(async () => {
    const s = await setupOrg({ aiHandles: 'PEDIDO', orderType: 'FISICO' });
    orgId = s.orgId; owner = s.owner; turn = turner(s.ctx);
  });

  it('sem dados de entrega não registra e pede o que falta', async () => {
    const P = '5511911130001';
    await turn(P, 'quero 2 rações Golden 15kg', 'Resumo: 2x Ração Golden 15kg. Posso registrar o seu pedido?');
    const out = await turn(P, 'sim', `Pedido confirmado!\n${pedidoTag([{ nome: 'Ração Golden 15kg', quantidade: 2 }], { tipo: 'fisico' })}`);
    expect(out[0]).toMatch(/preciso dos dados de entrega: nome de quem recebe, endereço .*CEP, número, telefone/);
    expect(out[0]).not.toContain('[PEDIDO');
    expect(await ordersOf(orgId, P)).toHaveLength(0);
  });

  it('com entrega mas sem "sim" do cliente: o sistema pergunta antes de registrar', async () => {
    const P = '5511911130002';
    const out = await turn(P, 'quero 1 coleira azul, entrega na Rua das Flores 120', `Pedido registrado!\n${pedidoTag([{ nome: 'Coleira azul', quantidade: 1 }], { entrega: ENTREGA })}`);
    expect(out[0]).toMatch(/Só para confirmar, posso registrar o seu pedido\?/);
    expect(out[0]).toContain('1x Coleira azul');
    expect(out[0]).toContain('CEP 06300-000');
    expect(await ordersOf(orgId, P)).toHaveLength(0);
    // Cliente confirma a pergunta do sistema → registra uma vez.
    const ok = await turn(P, 'sim', `Pedido confirmado!\n${pedidoTag([{ nome: 'Coleira azul', quantidade: 1 }], { entrega: ENTREGA })}`);
    const orders = await ordersOf(orgId, P);
    expect(orders).toHaveLength(1);
    expect(ok[0]).toContain(orders[0].code);
  });

  it('confirmado com entrega: registra, avisa a equipe com "📲 Via", nota interna, e repetir não duplica', async () => {
    const P = '5511911130003';
    await turn(P, 'quero 2 rações Golden 15kg', `Resumo do pedido: 2x Ração Golden 15kg, entrega para ${ENTREGA.nome}, ${ENTREGA.endereco}, nº 120, CEP 06300-000. Posso registrar o seu pedido?`);
    const out = await turn(P, 'sim, pode', `Perfeito, pedido confirmado!\n${pedidoTag([{ nome: 'Ração Golden 15kg', quantidade: 2 }], { entrega: ENTREGA })}\n[TIPO:pedido]`);
    const orders = await ordersOf(orgId, P);
    expect(orders).toHaveLength(1);
    const o = orders[0];
    expect(o).toMatchObject({ type: 'FISICO', status: 'NOVO', source: 'AI' });
    expect(JSON.parse(o.items)).toEqual([{ nome: 'Ração Golden 15kg', quantidade: 2, obs: null }]);
    expect(JSON.parse(o.delivery!)).toEqual({ nome: 'Ana Souza', endereco: 'Rua das Flores, Centro, Carapicuíba', cep: '06300000', numero: '120', complemento: 'Apto 12', telefone: '11988887777' });
    expect(out).toHaveLength(1);
    expect(out[0]).toContain(`Pedido *${o.code}* registrado`);
    expect(out[0]).not.toMatch(/\[PEDIDO|\[TIPO/);
    // Equipe avisada pelo WhatsApp com o canal de origem.
    const team = sent().filter((m) => m.to === TEAM);
    expect(team).toHaveLength(1);
    expect(team[0].text).toContain(`Novo pedido`);
    expect(team[0].text).toContain(o.code);
    expect(team[0].text).toMatch(/📲 Via: WhatsApp 1/);
    // Nota interna na conversa (como nas reuniões).
    const note = await prisma.message.findFirst({ where: { orgId, conversationId: o.conversationId!, direction: 'INTERNAL' }, orderBy: { createdAt: 'desc' } });
    expect(note!.body).toMatch(/🛒 Pedido .* registrado pela IA/);
    expect(note!.body).toMatch(/📲 Via: WhatsApp 1/);
    // Card do painel com Via e tag.
    const list = await owner.get('/api/agenda/orders');
    const card = list.body.items.find((x: any) => x.id === o.id);
    expect(card).toMatchObject({ code: o.code, intent: 'PEDIDO', type: 'FISICO', status: 'NOVO' });
    expect(card.channel.via).toMatch(/^WhatsApp 1/);
    expect(card.delivery.cep).toBe('06300000');
    // Repetição do marcador: reaproveita, sem novo pedido nem novo aviso.
    const again = await turn(P, 'sim', `Pedido confirmado!\n${pedidoTag([{ nome: 'Ração Golden 15kg', quantidade: 2 }], { entrega: ENTREGA })}`);
    expect(await ordersOf(orgId, P)).toHaveLength(1);
    expect(again[0]).toContain(o.code);
    expect(sent().filter((m) => m.to === TEAM)).toHaveLength(0);
    expect(await prisma.auditLog.count({ where: { orgId, action: 'pedido.ai_create', entityId: o.id } })).toBe(1);
  });

  it('CEP inválido é recusado', async () => {
    const P = '5511911130004';
    await turn(P, 'quero 1 osso', 'Resumo: 1x Osso. Posso registrar o seu pedido?');
    const out = await turn(P, 'sim', `Ok!\n${pedidoTag([{ nome: 'Osso', quantidade: 1 }], { entrega: { ...ENTREGA, cep: '123' } })}`);
    expect(out[0]).toMatch(/CEP válido/);
    expect(await ordersOf(orgId, P)).toHaveLength(0);
  });

  it('equipe muda o status no painel; atendente também pode', async () => {
    const o = (await prisma.order.findFirst({ where: { orgId } }))!;
    const r = await owner.patch(`/api/agenda/orders/${o.id}`, { status: 'EM_ANDAMENTO' });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('EM_ANDAMENTO');
    const agent = await invite(owner, 'AGENT');
    expect((await agent.patch(`/api/agenda/orders/${o.id}`, { status: 'CONCLUIDO' })).body.status).toBe('CONCLUIDO');
    expect((await owner.patch(`/api/agenda/orders/${o.id}`, { status: 'PAGO' })).status).toBe(400);
    expect((await owner.get('/api/agenda/orders?status=CONCLUIDO')).body.items.map((x: any) => x.id)).toContain(o.id);
  });
});

describe('Pedidos pela IA: Online (e-book) — com e sem "Solicitar dados de entrega"', () => {
  it('Online sem a opção: registra sem entrega (mesmo se a IA mandar endereço)', async () => {
    const { orgId, ctx } = await setupOrg({ aiHandles: 'PEDIDO', orderType: 'ONLINE', orderAskDelivery: false });
    const turn = turner(ctx);
    const P = '5511911140001';
    await turn(P, 'quero o e-book Receitas Fit', 'Resumo: 1x E-book Receitas Fit. Posso registrar o seu pedido?');
    const out = await turn(P, 'sim', `Pedido confirmado!\n${pedidoTag([{ nome: 'E-book Receitas Fit', quantidade: 1 }], { tipo: 'fisico', entrega: ENTREGA })}`);
    const orders = await ordersOf(orgId, P);
    expect(orders).toHaveLength(1);
    expect(orders[0].type).toBe('ONLINE');
    expect(orders[0].delivery).toBeNull();
    expect(out[0]).toContain(orders[0].code);
  });

  it('Online + "Solicitar dados de entrega": pede os dados e registra com entrega', async () => {
    const { orgId, ctx } = await setupOrg({ aiHandles: 'PEDIDO', orderType: 'ONLINE', orderAskDelivery: true });
    const turn = turner(ctx);
    const P = '5511911140002';
    await turn(P, 'quero o e-book Receitas Fit', 'Resumo: 1x E-book Receitas Fit. Posso registrar o seu pedido?');
    let out = await turn(P, 'sim', `Pedido confirmado!\n${pedidoTag([{ nome: 'E-book Receitas Fit', quantidade: 1 }])}`);
    expect(out[0]).toMatch(/preciso dos dados de entrega/);
    expect(await ordersOf(orgId, P)).toHaveLength(0);
    await turn(P, `Ana Souza, Rua das Flores 120, CEP 06300-000, tel 11988887777`, `Resumo: 1x E-book Receitas Fit, entrega para Ana Souza, Rua das Flores, nº 120. Posso registrar o seu pedido?`);
    out = await turn(P, 'sim', `Pedido confirmado!\n${pedidoTag([{ nome: 'E-book Receitas Fit', quantidade: 1 }], { entrega: ENTREGA })}`);
    const orders = await ordersOf(orgId, P);
    expect(orders).toHaveLength(1);
    expect(orders[0].type).toBe('ONLINE');
    expect(JSON.parse(orders[0].delivery!).cep).toBe('06300000');
    expect(out[0]).toContain(orders[0].code);
  });

  it('"Os dois": item online sem entrega; item físico exige entrega', async () => {
    const { orgId, ctx } = await setupOrg({ aiHandles: 'PEDIDO', orderType: 'AMBOS', orderAskDelivery: false });
    const turn = turner(ctx);
    const P = '5511911140003';
    await turn(P, 'quero o curso online', 'Resumo: 1x Curso de adestramento. Posso registrar o seu pedido?');
    await turn(P, 'sim', `Ok!\n${pedidoTag([{ nome: 'Curso de adestramento', quantidade: 1 }], { tipo: 'online' })}`);
    let orders = await ordersOf(orgId, P);
    expect(orders).toHaveLength(1);
    expect(orders[0]).toMatchObject({ type: 'ONLINE', delivery: null });
    await turn(P, 'e 1 caminha', 'Resumo: 1x Caminha M. Posso registrar o seu pedido?');
    const out = await turn(P, 'sim', `Ok!\n${pedidoTag([{ nome: 'Caminha M', quantidade: 1 }], { tipo: 'fisico' })}`);
    expect(out[0]).toMatch(/preciso dos dados de entrega/);
    expect(await ordersOf(orgId, P)).toHaveLength(1);
    await turn(P, 'segue o endereço', 'Resumo: 1x Caminha M com entrega. Posso registrar o seu pedido?');
    await turn(P, 'sim', `Ok!\n${pedidoTag([{ nome: 'Caminha M', quantidade: 1 }], { tipo: 'fisico', entrega: ENTREGA })}`);
    orders = await ordersOf(orgId, P);
    expect(orders).toHaveLength(2);
    expect(orders[1]).toMatchObject({ type: 'FISICO' });
    expect(orders[1].delivery).not.toBeNull();
  });
});

describe('Pedidos pela IA: modo restringe o que a IA faz', () => {
  it('modo Reunião: marcador de pedido é ignorado e some da resposta', async () => {
    const { orgId, ctx } = await setupOrg({ aiHandles: 'REUNIAO' });
    const turn = turner(ctx);
    const P = '5511911150001';
    await turn(P, 'quero 1 ração', 'Resumo: 1x Ração. Posso registrar o seu pedido?');
    const out = await turn(P, 'sim', `Certo!\n${pedidoTag([{ nome: 'Ração', quantidade: 1 }], { entrega: ENTREGA })}`);
    expect(out[0]).toBe('Certo!');
    expect(await ordersOf(orgId, P)).toHaveLength(0);
  });

  it('modo Pedido: marcador de agendamento é ignorado (nenhuma reunião)', async () => {
    const { orgId, ctx } = await setupOrg({ aiHandles: 'PEDIDO' });
    const turn = turner(ctx);
    const P = '5511911150002';
    const day = new Date(Date.now() + 2 * 24 * 3600e3).toISOString().slice(0, 10);
    const out = await turn(P, `marca ${day} às 10:00`, `Agendado!\n[AGENDAR:{"inicio":"${day}T10:00","duracao":30,"titulo":"Reunião"}]`);
    expect(out[0]).toBe('Agendado!');
    expect(await prisma.appointment.count({ where: { orgId } })).toBe(0);
  });
});

describe('Pedidos pela IA: isolamento entre organizações', () => {
  it('outra organização não vê nem altera os pedidos', async () => {
    const a = await setupOrg({ aiHandles: 'PEDIDO', orderType: 'ONLINE' });
    const turn = turner(a.ctx);
    const P = '5511911160001';
    await turn(P, 'quero o e-book', 'Resumo: 1x E-book Pets. Posso registrar o seu pedido?');
    await turn(P, 'sim', `Ok!\n${pedidoTag([{ nome: 'E-book Pets', quantidade: 1 }])}`);
    const o = (await ordersOf(a.orgId, P))[0];
    expect(o).toBeTruthy();
    const b = await registerClient();
    expect((await b.get('/api/agenda/orders')).body.items).toHaveLength(0);
    expect((await b.patch(`/api/agenda/orders/${o.id}`, { status: 'CANCELADO' })).status).toBe(404);
    expect((await prisma.order.findUnique({ where: { id: o.id } }))!.status).toBe('NOVO');
    expect((await a.owner.get('/api/agenda/orders')).body.items.map((x: any) => x.id)).toEqual([o.id]);
  });
});
