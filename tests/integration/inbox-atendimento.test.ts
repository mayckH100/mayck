import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { registerClient, Client, createTestChannel, installGraphMock, graph, sendInbound, sentTexts, prisma, uniq } from '../helpers.js';
import { tickMensagensAgendadas } from '../../server/inbox/service.js';
import { localDiaMin } from '../../server/inbox/core.js';

const N = (id: string, type: string, data: any = {}) => ({ id, type, position: { x: 0, y: 0 }, data });
const E = (source: string, target: string, sourceHandle = 'next') => ({ id: `${source}-${sourceHandle}-${target}`, source, target, sourceHandle });

async function invite(owner: Client, role: 'AGENT' | 'ADMIN') {
  const inv = await owner.post('/api/team/invites', { email: `${uniq()}@t.dev`, role });
  const token = inv.body.link.split('/convite/')[1];
  const c = new Client();
  const r = await c.agent.post('/api/auth/accept-invite').set('x-requested-with', 'mckbot').send({ token, name: `Membro ${uniq()}`, password: 'senhaMembro123' });
  c.csrf = r.body.csrfToken;
  c.me = r.body;
  return c;
}

let phone = 5511744000000;
const nextPhone = () => String(++phone);
async function convOf(orgId: string, p: string) {
  const contact = await prisma.contact.findUniqueOrThrow({ where: { orgId_waId: { orgId, waId: p } } });
  const conv = await prisma.conversation.findFirstOrThrow({ where: { contactId: contact.id }, orderBy: { createdAt: 'desc' } });
  return { contact, conv };
}
async function fluxoTransferir(owner: Client) {
  const f = await owner.post('/api/flows', {
    name: 'Transferir',
    graph: { nodes: [N('s', 'start', { triggers: [{ type: 'keyword', value: 'humano', match: 'contains' }] }), N('h', 'handoff', { reason: 'Cliente pediu' })], edges: [E('s', 'h')] },
  });
  expect((await owner.post(`/api/flows/${f.body.id}/status`, { status: 'ACTIVE' })).status).toBe(200);
}
/** Faixa que NÃO inclui agora (outro dia da semana) e faixa que inclui o dia todo hoje. */
const hoje = () => localDiaMin(new Date(), 'America/Sao_Paulo').dia;

describe('Inbox v1.41.0 — respostas rápidas (CRUD, permissão e isolamento)', () => {
  let owner: Client; let agent: Client;
  beforeAll(async () => { installGraphMock(); owner = await registerClient(); agent = await invite(owner, 'AGENT'); });

  it('administrador cria, edita e exclui; atendente só lê; outra empresa não enxerga', async () => {
    const c = await owner.post('/api/inbox/respostas-rapidas', { shortcut: '/Preço', text: 'Olá {nome}! Nossos planos começam em R$ 22.' });
    expect(c.status).toBe(201);
    expect(c.body.shortcut).toBe('preco');
    expect((await owner.post('/api/inbox/respostas-rapidas', { shortcut: 'preco', text: 'outro' })).status).toBe(409);
    expect((await owner.post('/api/inbox/respostas-rapidas', { shortcut: '###', text: 'x' })).status).toBe(400);
    const e = await owner.put(`/api/inbox/respostas-rapidas/${c.body.id}`, { shortcut: 'precos', text: 'Planos a partir de R$ 22.' });
    expect(e.status).toBe(200);
    expect(e.body.shortcut).toBe('precos');

    const lista = await agent.get('/api/inbox/respostas-rapidas');
    expect(lista.status).toBe(200);
    expect(lista.body.items.map((i: any) => i.shortcut)).toEqual(['precos']);
    expect((await agent.post('/api/inbox/respostas-rapidas', { shortcut: 'x', text: 'y' })).status).toBe(403);
    expect((await agent.del(`/api/inbox/respostas-rapidas/${c.body.id}`)).status).toBe(403);
    expect((await agent.get('/api/inbox/config')).status).toBe(403);

    const outra = await registerClient();
    expect((await outra.get('/api/inbox/respostas-rapidas')).body.items).toEqual([]);
    expect((await outra.put(`/api/inbox/respostas-rapidas/${c.body.id}`, { shortcut: 'z', text: 'z' })).status).toBe(404);
    expect((await outra.del(`/api/inbox/respostas-rapidas/${c.body.id}`)).status).toBe(404);
    // O mesmo atalho pode existir em outra empresa.
    expect((await outra.post('/api/inbox/respostas-rapidas', { shortcut: 'precos', text: 'abc' })).status).toBe(201);

    expect((await owner.del(`/api/inbox/respostas-rapidas/${c.body.id}`)).status).toBe(200);
    expect((await owner.get('/api/inbox/respostas-rapidas')).body.items).toEqual([]);
  });
});

describe('Inbox v1.41.0 — distribuição automática', () => {
  let owner: Client; let a1: Client; let a2: Client;
  let ctx: Awaited<ReturnType<typeof createTestChannel>>;
  beforeAll(async () => {
    installGraphMock();
    owner = await registerClient();
    ctx = await createTestChannel(owner.me.org.id);
    a1 = await invite(owner, 'AGENT');
    a2 = await invite(owner, 'AGENT');
    await fluxoTransferir(owner);
  });
  beforeEach(() => graph.reset());

  it('desligada (padrão): transferência não atribui ninguém', async () => {
    const p = nextPhone();
    await sendInbound(ctx, p, 'quero humano');
    const { conv } = await convOf(owner.me.org.id, p);
    expect(conv.mode).toBe('HUMAN');
    expect(conv.assignedUserId).toBeNull();
  });

  it('rodízio entre os participantes; respeita o canal permitido do membro', async () => {
    const orgId = owner.me.org.id;
    // a2 só atende outro WhatsApp: não recebe conversas deste canal.
    const outro = await createTestChannel(orgId);
    await prisma.membership.updateMany({ where: { orgId, userId: a2.me.user.id }, data: { channelIds: JSON.stringify([outro.ch.id]) } });
    const r = await owner.put('/api/inbox/config', { autoAssign: true, assignStrategy: 'rodizio', assignOnlineOnly: false, assignUserIds: [owner.me.user.id, a1.me.user.id, a2.me.user.id] });
    expect(r.status).toBe(200);
    expect(r.body.autoAssign).toBe(true);

    const donos: string[] = [];
    for (let i = 0; i < 4; i++) {
      const p = nextPhone();
      await sendInbound(ctx, p, 'quero humano');
      const { conv } = await convOf(orgId, p);
      expect(conv.assignedUserId).toBeTruthy();
      expect(conv.assignedAt).toBeInstanceOf(Date);
      donos.push(conv.assignedUserId!);
    }
    expect(new Set(donos)).toEqual(new Set([owner.me.user.id, a1.me.user.id]));
    expect(donos).not.toContain(a2.me.user.id);
    for (let i = 1; i < donos.length; i++) expect(donos[i]).not.toBe(donos[i - 1]);
    const nota = await prisma.message.findFirst({ where: { orgId, direction: 'INTERNAL', body: { startsWith: 'Conversa distribuída automaticamente' } } });
    expect(nota).toBeTruthy();

    // Conversa do outro canal vai para a2 (único com acesso além do proprietário/a1 que atendem todos) dentro do rodízio.
    const p = nextPhone();
    await sendInbound(outro, p, 'quero humano');
    const { conv } = await convOf(orgId, p);
    expect([owner.me.user.id, a1.me.user.id, a2.me.user.id]).toContain(conv.assignedUserId);
  });

  it('menos ocupado escolhe quem tem menos conversas abertas', async () => {
    const orgId = owner.me.org.id;
    await prisma.membership.updateMany({ where: { orgId, userId: a2.me.user.id }, data: { channelIds: null } });
    await owner.put('/api/inbox/config', { autoAssign: true, assignStrategy: 'menos_ocupado', assignOnlineOnly: false, assignUserIds: [a1.me.user.id, a2.me.user.id] });
    const abertas = async (u: string) => prisma.conversation.count({ where: { orgId, assignedUserId: u, status: { not: 'CLOSED' } } });
    const n1 = await abertas(a1.me.user.id); const n2 = await abertas(a2.me.user.id);
    const p = nextPhone();
    await sendInbound(ctx, p, 'quero humano');
    const { conv } = await convOf(orgId, p);
    expect(conv.assignedUserId).toBe(n2 < n1 ? a2.me.user.id : n1 < n2 ? a1.me.user.id : conv.assignedUserId);
    if (n1 !== n2) expect(conv.assignedUserId).toBe(n2 < n1 ? a2.me.user.id : a1.me.user.id);
  });

  it('só online: sem sessão ativa, a conversa fica na fila; atendente sem acesso ao Inbox não recebe', async () => {
    const orgId = owner.me.org.id;
    await prisma.membership.updateMany({ where: { orgId, userId: a1.me.user.id }, data: { modules: JSON.stringify(['kanban']) } });
    await owner.put('/api/inbox/config', { autoAssign: true, assignStrategy: 'rodizio', assignOnlineOnly: true, assignUserIds: [a1.me.user.id, a2.me.user.id] });
    await prisma.session.updateMany({ where: { userId: a2.me.user.id }, data: { lastSeenAt: new Date(Date.now() - 3600_000), createdAt: new Date(Date.now() - 3600_000) } });
    const p = nextPhone();
    await sendInbound(ctx, p, 'quero humano');
    expect((await convOf(orgId, p)).conv.assignedUserId).toBeNull();
    // a2 volta a ficar online: a próxima mensagem do cliente distribui.
    await prisma.session.updateMany({ where: { userId: a2.me.user.id }, data: { lastSeenAt: new Date() } });
    await sendInbound(ctx, p, 'alguém aí?');
    expect((await convOf(orgId, p)).conv.assignedUserId).toBe(a2.me.user.id);
    await prisma.membership.updateMany({ where: { orgId, userId: a1.me.user.id }, data: { modules: null } });
  });
});

describe('Inbox v1.41.0 — horário de atendimento', () => {
  let owner: Client;
  let ctx: Awaited<ReturnType<typeof createTestChannel>>;
  beforeAll(async () => { installGraphMock(); owner = await registerClient(); ctx = await createTestChannel(owner.me.org.id); await fluxoTransferir(owner); });
  beforeEach(() => graph.reset());

  it('não deixa ligar sem faixa e recusa faixa inválida', async () => {
    expect((await owner.put('/api/inbox/config', { hoursEnabled: true, hours: [] })).status).toBe(400);
    expect((await owner.put('/api/inbox/config', { hoursEnabled: true, hours: [{ dia: 1, inicio: '18:00', fim: '08:00' }] })).status).toBe(400);
  });

  it('fora do horário: avisa quando a conversa vai para humano, 1 vez a cada X horas por contato', async () => {
    const outroDia = (hoje() + 3) % 7;
    const r = await owner.put('/api/inbox/config', { hoursEnabled: true, hours: [{ dia: outroDia, inicio: '08:00', fim: '18:00' }], awayMessage: 'Oi {nome}! Fora do horário. Voltamos: {horario}.', awayEveryHours: 12 });
    expect(r.status).toBe(200);
    const p = nextPhone();
    // Sem IA e sem fluxo para "oi": ninguém responde → fica para a equipe → aviso.
    await sendInbound(ctx, p, 'oi, tudo bem?');
    const textos = sentTexts();
    expect(textos.some((t: string) => /Fora do horário/.test(t))).toBe(true);
    const { contact, conv } = await convOf(owner.me.org.id, p);
    expect(contact.awayMessageAt).toBeInstanceOf(Date);
    // O aviso automático não conta como primeira resposta da equipe.
    expect(conv.firstResponseAt).toBeNull();
    graph.reset();
    await sendInbound(ctx, p, 'quero humano');
    expect(sentTexts().some((t: string) => /Fora do horário/.test(t))).toBe(false);
    // Passou o intervalo: avisa de novo.
    await prisma.contact.update({ where: { id: contact.id }, data: { awayMessageAt: new Date(Date.now() - 13 * 3600_000) } });
    await sendInbound(ctx, p, 'oi de novo');
    expect(sentTexts().filter((t: string) => /Fora do horário/.test(t))).toHaveLength(1);
  });

  it('com a IA respondendo no canal, a IA continua e não sai mensagem de fora do horário', async () => {
    expect((await owner.put('/api/ai/settings', { provider: 'fake', model: 'fake-1', enabled: true, autoReply: true })).status).toBe(200);
    const p = nextPhone();
    await sendInbound(ctx, p, 'qual o preço?');
    const textos = sentTexts();
    expect(textos.length).toBeGreaterThan(0);
    expect(textos.some((t: string) => /Fora do horário/.test(t))).toBe(false);
    const { contact } = await convOf(owner.me.org.id, p);
    expect(contact.awayMessageAt).toBeNull();
    await owner.put('/api/ai/settings', { enabled: false, autoReply: false });
  });

  it('dentro do horário: nada é enviado', async () => {
    await owner.put('/api/inbox/config', { hoursEnabled: true, hours: [{ dia: hoje(), inicio: '00:00', fim: '24:00' }] });
    const p = nextPhone();
    await sendInbound(ctx, p, 'bom dia');
    expect(sentTexts().some((t: string) => /Fora do horário/.test(t))).toBe(false);
  });
});

describe('Inbox v1.41.0 — pesquisa de satisfação', () => {
  let owner: Client;
  let ctx: Awaited<ReturnType<typeof createTestChannel>>;
  beforeAll(async () => { installGraphMock(); owner = await registerClient(); ctx = await createTestChannel(owner.me.org.id); });
  beforeEach(() => graph.reset());

  async function conversaEncerrada() {
    const p = nextPhone();
    await sendInbound(ctx, p, 'preciso de ajuda');
    const { conv } = await convOf(owner.me.org.id, p);
    expect((await owner.post(`/api/conversations/${conv.id}/action`, { action: 'take' })).status).toBe(200);
    expect((await owner.post(`/api/conversations/${conv.id}/action`, { action: 'close' })).status).toBe(200);
    return { p, conv };
  }

  it('desligada (padrão): encerrar não envia nada', async () => {
    graph.reset();
    await conversaEncerrada();
    expect(sentTexts().some((t: string) => /De 1 a 5/.test(t))).toBe(false);
  });

  it('ligada: pergunta ao encerrar, grava a nota 1–5 da resposta seguinte e mostra em Relatórios', async () => {
    expect((await owner.put('/api/inbox/config', { csatEnabled: true })).status).toBe(200);
    graph.reset();
    const { p, conv } = await conversaEncerrada();
    expect(sentTexts().some((t: string) => /De 1 a 5, como foi seu atendimento/.test(t))).toBe(true);
    const pend = await prisma.csatRating.findFirstOrThrow({ where: { conversationId: conv.id } });
    expect(pend.status).toBe('PENDENTE');
    expect(pend.assignedUserId).toBe(owner.me.user.id);

    graph.reset();
    await sendInbound(ctx, p, '5');
    const r = await prisma.csatRating.findUniqueOrThrow({ where: { id: pend.id } });
    expect(r.status).toBe('RESPONDIDA');
    expect(r.score).toBe(5);
    // A nota entra na conversa encerrada (sem abrir outra) e o cliente recebe o agradecimento.
    expect(await prisma.conversation.count({ where: { contactId: conv.contactId } })).toBe(1);
    expect(sentTexts().some((t: string) => /Obrigado pela sua avaliação/.test(t))).toBe(true);
    // Resposta seguinte já não é nota.
    graph.reset();
    await sendInbound(ctx, p, '4');
    expect(await prisma.csatRating.count({ where: { contactId: conv.contactId, status: 'RESPONDIDA' } })).toBe(1);
    expect(await prisma.conversation.count({ where: { contactId: conv.contactId } })).toBe(2);

    const rep = await owner.get('/api/reports?days=7');
    expect(rep.status).toBe(200);
    expect(rep.body.csat.count).toBe(1);
    expect(rep.body.csat.average).toBe(5);
    expect(rep.body.csat.distribution.find((x: any) => x.score === 5).count).toBe(1);
    expect(rep.body.agents.find((a: any) => a.id === owner.me.user.id).csatAverage).toBe(5);
  });

  it('resposta que não é nota encerra a espera e segue o atendimento normal; depois de 24 h não vale', async () => {
    const a = await conversaEncerrada();
    await sendInbound(ctx, a.p, 'quero comprar mais um');
    const r1 = await prisma.csatRating.findFirstOrThrow({ where: { conversationId: a.conv.id } });
    expect(r1.status).toBe('IGNORADA');
    expect(r1.score).toBeNull();
    expect(await prisma.conversation.count({ where: { contactId: a.conv.contactId, status: { not: 'CLOSED' } } })).toBe(1);

    const b = await conversaEncerrada();
    await prisma.csatRating.updateMany({ where: { conversationId: b.conv.id }, data: { askedAt: new Date(Date.now() - 25 * 3600_000) } });
    await sendInbound(ctx, b.p, '3');
    const r2 = await prisma.csatRating.findFirstOrThrow({ where: { conversationId: b.conv.id } });
    expect(r2.status).toBe('EXPIRADA');
    expect(r2.score).toBeNull();
  });
});

describe('Inbox v1.41.0 — mensagens agendadas', () => {
  let owner: Client; let agent: Client;
  let ctx: Awaited<ReturnType<typeof createTestChannel>>;
  beforeAll(async () => { installGraphMock(); owner = await registerClient(); agent = await invite(owner, 'AGENT'); ctx = await createTestChannel(owner.me.org.id); });
  beforeEach(() => graph.reset());

  it('agenda, lista, cancela e envia na hora (uma vez só); outra empresa não acessa', async () => {
    const p = nextPhone();
    await sendInbound(ctx, p, 'me lembra amanhã');
    const { conv } = await convOf(owner.me.org.id, p);
    expect((await owner.post(`/api/inbox/conversas/${conv.id}/agendadas`, { text: 'x', sendAt: '2020-01-01T10:00' })).status).toBe(400);
    const quando = new Date(Date.now() + 2 * 3600_000).toISOString();
    const a = await agent.post(`/api/inbox/conversas/${conv.id}/agendadas`, { text: 'Lembrete: seu horário é amanhã às 10h.', sendAt: quando });
    expect(a.status).toBe(201);
    const b = await owner.post(`/api/inbox/conversas/${conv.id}/agendadas`, { text: 'Esta será cancelada', sendAt: quando });
    expect(b.status).toBe(201);
    const lista = await owner.get(`/api/inbox/conversas/${conv.id}/agendadas`);
    expect(lista.body.items).toHaveLength(2);

    const outra = await registerClient();
    expect((await outra.get(`/api/inbox/conversas/${conv.id}/agendadas`)).status).toBe(404);
    expect((await outra.del(`/api/inbox/agendadas/${b.body.id}`)).status).toBe(404);
    expect((await owner.del(`/api/inbox/agendadas/${b.body.id}`)).status).toBe(200);
    expect((await owner.del(`/api/inbox/agendadas/${b.body.id}`)).status).toBe(400);

    // Antes da hora: nada sai.
    expect(await tickMensagensAgendadas(new Date())).toBe(0);
    expect(sentTexts()).toEqual([]);
    const depois = new Date(Date.now() + 3 * 3600_000);
    expect(await tickMensagensAgendadas(depois)).toBe(1);
    expect(sentTexts()).toEqual(['Lembrete: seu horário é amanhã às 10h.']);
    expect(await tickMensagensAgendadas(depois)).toBe(0);
    const sm = await prisma.scheduledMessage.findUniqueOrThrow({ where: { id: a.body.id } });
    expect(sm.status).toBe('ENVIADA');
    const msg = await prisma.message.findUniqueOrThrow({ where: { id: sm.messageId! } });
    expect(msg.sender).toBe('agent');
    expect(msg.authorUserId).toBe(agent.me.user.id);
    expect((await prisma.scheduledMessage.findUniqueOrThrow({ where: { id: b.body.id } })).status).toBe('CANCELADA');
  });
});
