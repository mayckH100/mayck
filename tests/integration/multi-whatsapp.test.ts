import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { registerClient, Client, createTestChannel, installGraphMock, graph, sendInbound, prisma } from '../helpers.js';
import { qrManager, type QrSocket } from '../../server/whatsapp/qr/manager.js';
import { handleQrMessage } from '../../server/whatsapp/inbound.js';
import { useDbAuthState, clearAuthState } from '../../server/whatsapp/qr/authState.js';
import { ATENDIMENTO_ATIVO_JANELA_MS, NOTA_DESVIO_PREFIXO, redirectText } from '../../server/whatsapp/multiCanal.js';

const HORARIO = 'segunda a sexta, das 8h às 17h';
const AVISO = 'Seu atendimento já está em andamento';

type Ctx = Awaited<ReturnType<typeof createTestChannel>>;

/** Textos enviados pela Graph API por um canal específico (a URL leva o Phone Number ID do canal). */
const sentBy = (ctx: Ctx) => graph.calls.filter((c) => c.body && c.url.includes(`/${ctx.phoneNumberId}/messages`)).map((c) => c.body.text?.body ?? c.body.type);

describe('Vários WhatsApps conectados: todos respondem com a IA, cada um pela sua conversa', () => {
  let owner: Client;
  let a: Ctx;
  let b: Ctx;
  let phone = 5511733000000;
  const nextPhone = () => String(++phone);
  const contactOf = (p: string) => prisma.contact.findUniqueOrThrow({ where: { orgId_waId: { orgId: owner.me.org.id, waId: p } } });
  const convsOf = async (p: string) => prisma.conversation.findMany({ where: { contactId: (await contactOf(p)).id }, orderBy: { createdAt: 'asc' } });
  const notesOf = (convId: string) => prisma.message.findMany({ where: { conversationId: convId, direction: 'INTERNAL', body: { startsWith: NOTA_DESVIO_PREFIXO } } });

  beforeAll(async () => {
    installGraphMock();
    owner = await registerClient();
    await owner.post('/api/ai/knowledge', { title: 'Horário', content: `Nosso horário de atendimento é de ${HORARIO}.` });
    expect((await owner.put('/api/ai/settings', { provider: 'fake', model: 'fake-1', enabled: true, autoReply: true })).status).toBe(200);
    a = await createTestChannel(owner.me.org.id);
    b = await createTestChannel(owner.me.org.id);
    await prisma.channel.update({ where: { id: a.ch.id }, data: { name: 'Carla', displayPhone: '+55 11 98765-4321', createdAt: new Date(Date.now() - 60_000) } });
    await prisma.channel.update({ where: { id: b.ch.id }, data: { name: 'Vendas', displayPhone: '+55 11 91234-5678' } });
  });
  beforeEach(() => graph.reset());
  afterAll(() => qrManager.resetForTests());

  it('cada número responde com a IA pelo próprio número (conversas separadas por canal)', async () => {
    const pa = nextPhone(), pb = nextPhone();
    await sendInbound(a, pa, 'qual o horário de atendimento?');
    await sendInbound(b, pb, 'qual o horário de atendimento?');
    expect(sentBy(a)).toHaveLength(1);
    expect(sentBy(a)[0]).toContain(HORARIO);
    expect(sentBy(b)).toHaveLength(1);
    expect(sentBy(b)[0]).toContain(HORARIO);
    expect((await convsOf(pa)).map((c) => c.channelId)).toEqual([a.ch.id]);
    expect((await convsOf(pb)).map((c) => c.channelId)).toEqual([b.ch.id]);
  });

  it('atendimento em andamento no WhatsApp 1: o WhatsApp 2 avisa uma vez para continuar por lá e não abre atendimento paralelo', async () => {
    const p = nextPhone();
    await sendInbound(a, p, 'qual o horário de atendimento?');
    expect(sentBy(a)).toHaveLength(1);
    graph.reset();
    const usoAntes = await prisma.aiUsage.count({ where: { orgId: owner.me.org.id } });
    await sendInbound(b, p, 'oi, qual o horário?');
    expect(sentBy(a)).toHaveLength(0);
    expect(sentBy(b)).toEqual([`${AVISO} pelo nosso WhatsApp Carla (11 98765-4321). Por favor, continue a conversa por lá 😊`]);
    expect(await prisma.aiUsage.count({ where: { orgId: owner.me.org.id } })).toBe(usoAntes);
    const [convA, convB] = await convsOf(p);
    expect(convA.channelId).toBe(a.ch.id);
    expect(convB.channelId).toBe(b.ch.id);
    for (const c of [convA, convB]) {
      const notas = await notesOf(c.id);
      expect(notas).toHaveLength(1);
      expect(notas[0].body).toContain('cliente escreveu pelo WhatsApp 2 · Vendas (11 91234-5678)');
      expect(notas[0].body).toContain('orientado a voltar ao WhatsApp 1 · Carla (11 98765-4321)');
    }
    // Não repete o aviso nem chama a IA nas próximas mensagens da janela (elas ficam no Inbox).
    graph.reset();
    await sendInbound(b, p, 'alguém aí?');
    await sendInbound(b, p, 'oi?');
    expect(graph.calls.filter((c) => c.body)).toHaveLength(0);
    expect(await notesOf(convB.id)).toHaveLength(1);
    expect(await prisma.message.count({ where: { conversationId: convB.id, direction: 'IN' } })).toBe(3);
    // O WhatsApp 1 continua atendendo normalmente.
    await sendInbound(a, p, 'qual o horário de atendimento?');
    expect(sentBy(a)[0]).toContain(HORARIO);
  });

  it('"Aguardando atendente" no outro número também conta, mesmo sem atividade recente', async () => {
    const p = nextPhone();
    const ct = await prisma.contact.create({ data: { orgId: owner.me.org.id, waId: p, phone: '+' + p, lastMessageAt: new Date() } });
    const velho = new Date(Date.now() - 5 * ATENDIMENTO_ATIVO_JANELA_MS);
    await prisma.conversation.create({ data: { orgId: owner.me.org.id, contactId: ct.id, channelId: a.ch.id, status: 'PENDING', mode: 'HUMAN', waitingSince: velho, lastMessageAt: velho } });
    await sendInbound(b, p, 'oi');
    expect(sentBy(b)).toHaveLength(1);
    expect(sentBy(b)[0]).toContain(AVISO);
  });

  it('conversa encerrada (ou parada há mais que a janela) no outro número não desvia: a IA atende normalmente', async () => {
    const p1 = nextPhone(), p2 = nextPhone();
    await sendInbound(a, p1, 'qual o horário de atendimento?');
    await prisma.conversation.updateMany({ where: { contactId: (await contactOf(p1)).id }, data: { status: 'CLOSED', closedAt: new Date() } });
    const ct = await prisma.contact.create({ data: { orgId: owner.me.org.id, waId: p2, phone: '+' + p2, lastMessageAt: new Date() } });
    const velho = new Date(Date.now() - 2 * ATENDIMENTO_ATIVO_JANELA_MS);
    await prisma.conversation.create({ data: { orgId: owner.me.org.id, contactId: ct.id, channelId: a.ch.id, lastMessageAt: velho, lastInboundAt: velho } });
    graph.reset();
    await sendInbound(b, p1, 'qual o horário de atendimento?');
    await sendInbound(b, p2, 'qual o horário de atendimento?');
    expect(sentBy(b)).toHaveLength(2);
    for (const t of sentBy(b)) { expect(t).toContain(HORARIO); expect(t).not.toContain(AVISO); }
  });

  it('outro número desconectado não desvia (não manda o cliente para um WhatsApp fora do ar)', async () => {
    const p = nextPhone();
    await sendInbound(a, p, 'qual o horário de atendimento?');
    await prisma.channel.update({ where: { id: a.ch.id }, data: { status: 'NOT_CONNECTED' } });
    try {
      graph.reset();
      await sendInbound(b, p, 'qual o horário de atendimento?');
      expect(sentBy(b)).toHaveLength(1);
      expect(sentBy(b)[0]).toContain(HORARIO);
    } finally {
      await prisma.channel.update({ where: { id: a.ch.id }, data: { status: 'CONNECTED' } });
    }
  });

  it('isolado por organização: atendimento em outra empresa nunca desvia', async () => {
    const other = await registerClient();
    const oc = await createTestChannel(other.me.org.id);
    const p = nextPhone();
    await sendInbound(oc, p, 'oi');
    await prisma.conversation.updateMany({ where: { orgId: other.me.org.id }, data: { mode: 'HUMAN', waitingSince: new Date() } });
    graph.reset();
    await sendInbound(b, p, 'qual o horário de atendimento?');
    expect(sentBy(b)).toHaveLength(1);
    expect(sentBy(b)[0]).toContain(HORARIO);
  });

  it('texto do aviso: com nome e número, só número, ou nenhum dos dois', () => {
    expect(redirectText({ name: '', phone: '11 98765-4321' })).toBe(`${AVISO} pelo nosso WhatsApp (11 98765-4321). Por favor, continue a conversa por lá 😊`);
    expect(redirectText({ name: 'Carla', phone: null })).toBe(`${AVISO} pelo nosso WhatsApp Carla. Por favor, continue a conversa por lá 😊`);
    expect(redirectText(null)).toBe(`${AVISO} pelo nosso outro WhatsApp. Por favor, continue a conversa por lá 😊`);
  });

  it('canal novo: "Só IA" com a IA da empresa ligada, "Fluxos + IA" sem ela; escolha do dono é mantida', async () => {
    const novo = await owner.post('/api/channels', { name: 'Suporte' });
    expect(novo.body.autoReplyMode).toBe('ai');
    expect((await owner.patch(`/api/channels/${novo.body.id}`, { autoReplyMode: 'flows' })).body.autoReplyMode).toBe('flows');
    expect((await prisma.channel.findUniqueOrThrow({ where: { id: novo.body.id } })).autoReplyMode).toBe('flows');
    const semIa = await registerClient();
    expect((await semIa.post('/api/channels', {})).body.autoReplyMode).toBe('both');
    await prisma.channel.deleteMany({ where: { id: novo.body.id } });
  });

  it('dois WhatsApps por QR code: cada um responde com a IA pelo próprio aparelho', async () => {
    const org = await registerClient();
    expect((await org.put('/api/ai/settings', { provider: 'fake', model: 'fake-1', enabled: true, autoReply: true })).status).toBe(200);
    await org.post('/api/ai/knowledge', { title: 'Horário', content: `Nosso horário de atendimento é de ${HORARIO}.` });
    const ids: string[] = [];
    const sent: Record<string, string[]> = {};
    for (const n of [1, 2]) {
      const r = await org.post('/api/channels', { name: `Cel ${n}` });
      const id = r.body.id as string;
      ids.push(id);
      sent[id] = [];
      await prisma.channel.update({ where: { id }, data: { status: 'CONNECTED' } });
      let k = 0;
      const sock: QrSocket = {
        user: { id: `551199000000${n}:1@s.whatsapp.net` },
        async sendMessage(_jid, content) { sent[id].push(JSON.stringify(content)); return { key: { id: `Q${n}-${++k}` } }; },
        signalRepository: { lidMapping: { async getPNForLID() { return null; }, async getLIDForPN() { return null; } } },
      };
      qrManager.attachForTests(id, sock, 'CONNECTED');
    }
    let seq = 0;
    const raw = (from: string, text: string) => ({ key: { fromMe: false, id: `MQIN${Date.now()}${seq++}`, remoteJid: `${from}@s.whatsapp.net` }, pushName: 'Cliente', messageTimestamp: Math.floor(Date.now() / 1000), message: { conversation: text } }) as any;
    expect(await handleQrMessage(ids[0], raw(nextPhone(), 'qual o horário de atendimento?'))).toBe('ok');
    expect(await handleQrMessage(ids[1], raw(nextPhone(), 'qual o horário de atendimento?'))).toBe('ok');
    expect(sent[ids[0]]).toHaveLength(1);
    expect(sent[ids[0]][0]).toContain(HORARIO);
    expect(sent[ids[1]]).toHaveLength(1);
    expect(sent[ids[1]][0]).toContain(HORARIO);
  });
});

describe('Reinício do servidor: todas as sessões QR salvas são restauradas, cada uma independente', () => {
  it('restaura todos os canais com sessão salva; falha em um não impede os outros', async () => {
    const owner = await registerClient();
    const ids: string[] = [];
    for (const n of [1, 2, 3]) {
      const c = await prisma.channel.create({ data: { orgId: owner.me.org.id, name: `QR ${n}`, provider: 'whatsapp_qr', verifyToken: `v-${Date.now()}-${n}`, status: 'CONNECTED' } });
      ids.push(c.id);
    }
    // Canais 1 e 2 com sessão salva; canal 3 sem sessão (precisa do QR).
    for (const id of ids.slice(0, 2)) {
      const { state, saveCreds } = await useDbAuthState(id);
      state.creds.me = { id: `55119${id.length}0000000:3@s.whatsapp.net` };
      await saveCreds();
    }
    const started: string[] = [];
    const startSpy = vi.spyOn(qrManager, 'start').mockImplementation(async (id: string) => {
      started.push(id);
      if (id === ids[0]) throw new Error('falha simulada');
      return qrManager.info(id);
    });
    const retrySpy = vi.spyOn(qrManager as any, 'scheduleRetry').mockImplementation(() => undefined);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      await qrManager.restoreAll();
      const deadline = Date.now() + 8000;
      while (!(started.includes(ids[0]) && started.includes(ids[1])) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
      expect(started).toContain(ids[0]);
      expect(started).toContain(ids[1]);
      expect(started).not.toContain(ids[2]);
      // O canal que falhou ao restaurar entra em nova tentativa sozinho.
      await new Promise((r) => setTimeout(r, 20));
      expect(retrySpy.mock.calls.some((c) => (c[0] as any)?.channelId === ids[0])).toBe(true);
      expect((await prisma.channel.findUniqueOrThrow({ where: { id: ids[2] } })).status).toBe('NOT_CONNECTED');
    } finally {
      startSpy.mockRestore(); retrySpy.mockRestore(); errSpy.mockRestore(); logSpy.mockRestore();
      for (const id of ids) await clearAuthState(id);
      qrManager.resetForTests();
    }
  }, 20_000);
});
