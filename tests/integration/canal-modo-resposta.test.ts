import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { registerClient, Client, createTestChannel, installGraphMock, graph, sendInbound, sentTexts, prisma, uniq } from '../helpers.js';
import { qrManager, type QrSocket } from '../../server/whatsapp/qr/manager.js';
import { handleQrMessage } from '../../server/whatsapp/inbound.js';
import type { AnyMessageContent } from '@whiskeysockets/baileys';

const N = (id: string, type: string, data: any = {}) => ({ id, type, position: { x: 0, y: 0 }, data });
const E = (source: string, target: string, sourceHandle = 'next') => ({ id: `${source}-${sourceHandle}-${target}`, source, target, sourceHandle });

async function invite(owner: Client, role: 'AGENT' | 'ADMIN') {
  const inv = await owner.post('/api/team/invites', { email: `${uniq()}@t.dev`, role });
  const token = inv.body.link.split('/convite/')[1];
  const c = new Client();
  const r = await c.agent.post('/api/auth/accept-invite').set('x-requested-with', 'mckbot').send({ token, name: 'Membro', password: 'senhaMembro123' });
  c.csrf = r.body.csrfToken;
  c.me = r.body;
  return c;
}

const HORARIO = 'segunda a sexta, das 9h às 18h';

describe('Canal WhatsApp — "Quem responde automaticamente" (Só fluxos / Só IA / Fluxos + IA)', () => {
  let owner: Client;
  let ctx: Awaited<ReturnType<typeof createTestChannel>>;
  let flowId: string;
  let phone = 5511744000000;
  const nextPhone = () => String(++phone);
  const setMode = async (mode: string) => expect((await owner.patch(`/api/channels/${ctx.ch.id}`, { autoReplyMode: mode })).status).toBe(200);
  const runsOf = async (p: string) => {
    const contact = await prisma.contact.findUnique({ where: { orgId_waId: { orgId: owner.me.org.id, waId: p } } });
    if (!contact) return [];
    const convs = await prisma.conversation.findMany({ where: { contactId: contact.id }, select: { id: true } });
    return prisma.flowRun.findMany({ where: { conversationId: { in: convs.map((c) => c.id) } } });
  };

  beforeAll(async () => {
    installGraphMock();
    owner = await registerClient();
    ctx = await createTestChannel(owner.me.org.id);
    await owner.post('/api/ai/knowledge', { title: 'Horário', content: `Nosso horário de atendimento é de ${HORARIO}.` });
    expect((await owner.put('/api/ai/settings', { provider: 'fake', model: 'fake-1', enabled: true, autoReply: true })).status).toBe(200);
    const f = await owner.post('/api/flows', {
      name: 'Boas-vindas',
      graph: { nodes: [N('s', 'start', { triggers: [{ type: 'keyword', value: 'oi', match: 'contains' }] }), N('t', 'send_text', { text: 'Resposta do fluxo' }), N('e', 'end', {})], edges: [E('s', 't'), E('t', 'e')] },
    });
    flowId = f.body.id;
    expect((await owner.post(`/api/flows/${flowId}/status`, { status: 'ACTIVE' })).status).toBe(200);
  });
  beforeEach(async () => {
    graph.reset();
    await prisma.channel.update({ where: { id: ctx.ch.id }, data: { autoReplyMode: 'both' } });
  });
  afterAll(() => qrManager.resetForTests());

  it('padrão é "both" (Fluxos + IA) no GET de canais, inclusive para canais já existentes', async () => {
    const r = await owner.get('/api/channels');
    expect(r.body.find((c: any) => c.id === ctx.ch.id).autoReplyMode).toBe('both');
    expect((await prisma.channel.findUniqueOrThrow({ where: { id: ctx.ch.id } })).autoReplyMode).toBe('both');
  });

  it('"both" mantém o comportamento original: fluxo responde a palavra-chave e a IA responde o resto', async () => {
    const p = nextPhone();
    await sendInbound(ctx, p, 'oi');
    expect(sentTexts()).toEqual(['Resposta do fluxo']);
    graph.reset();
    await sendInbound(ctx, p, 'qual o horário de atendimento?');
    expect(sentTexts()[0]).toContain(HORARIO);
    expect(await runsOf(p)).toHaveLength(1);
  });

  it('"flows" (Só fluxos): fluxo responde, mas a IA nunca responde automaticamente', async () => {
    await setMode('flows');
    const p = nextPhone();
    const usageAntes = await prisma.aiUsage.count({ where: { orgId: owner.me.org.id } });
    await sendInbound(ctx, p, 'oi');
    expect(sentTexts()).toEqual(['Resposta do fluxo']);
    graph.reset();
    await sendInbound(ctx, p, 'qual o horário de atendimento?');
    expect(sentTexts()).toEqual([]);
    expect(await prisma.aiUsage.count({ where: { orgId: owner.me.org.id } })).toBe(usageAntes);
    // A mensagem continua no Inbox.
    const msgs = await prisma.message.findMany({ where: { channelId: ctx.ch.id, direction: 'IN', body: 'qual o horário de atendimento?' } });
    expect(msgs.length).toBeGreaterThan(0);
    await setMode('both');
  });

  it('"ai" (Só IA): nenhum fluxo é disparado, nem pela palavra-chave; a IA responde', async () => {
    await setMode('ai');
    const p = nextPhone();
    await sendInbound(ctx, p, 'oi, qual o horário de atendimento?');
    const t = sentTexts();
    expect(t).toHaveLength(1);
    expect(t[0]).toContain(HORARIO);
    expect(t).not.toContain('Resposta do fluxo');
    expect(await runsOf(p)).toHaveLength(0);
    await setMode('both');
  });

  it('"ai" com a IA desligada: nada é respondido (e nenhum fluxo roda)', async () => {
    await setMode('ai');
    await owner.put('/api/ai/settings', { enabled: false });
    const p = nextPhone();
    await sendInbound(ctx, p, 'oi');
    expect(sentTexts()).toEqual([]);
    expect(await runsOf(p)).toHaveLength(0);
    await owner.put('/api/ai/settings', { enabled: true, autoReply: true });
    await setMode('both');
  });

  it('"ai": fluxo que ficou esperando resposta (de antes da troca) é encerrado e a IA responde', async () => {
    const m = await owner.post('/api/flows', { name: 'Menu', graph: {
      nodes: [N('s', 'start', { triggers: [{ type: 'keyword', value: 'menuzao', match: 'equals' }] }), N('m', 'menu', { text: 'Escolha:', options: [{ id: 'a', label: 'Planos' }, { id: 'b', label: 'Suporte' }] }), N('a', 'send_text', { text: 'Planos escolhidos.' })],
      edges: [E('s', 'm'), E('m', 'a', 'opt-a')],
    } });
    expect((await owner.post(`/api/flows/${m.body.id}/status`, { status: 'ACTIVE' })).status).toBe(200);
    const p = nextPhone();
    await sendInbound(ctx, p, 'menuzao');
    let run = await prisma.flowRun.findFirstOrThrow({ where: { flowId: m.body.id }, orderBy: { startedAt: 'desc' } });
    expect(run.status).toBe('WAITING');
    await setMode('ai');
    graph.reset();
    await sendInbound(ctx, p, '1');
    run = await prisma.flowRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(run.status).toBe('CANCELLED');
    expect(sentTexts()).not.toContain('Planos escolhidos.');
    await owner.post(`/api/flows/${m.body.id}/status`, { status: 'PAUSED' });
    await setMode('both');
  });

  it('só Proprietário/Administrador altera; valor inválido é recusado; fica na Auditoria com antes/depois', async () => {
    const agent = await invite(owner, 'AGENT');
    expect((await agent.patch(`/api/channels/${ctx.ch.id}`, { autoReplyMode: 'ai' })).status).toBe(403);
    expect((await prisma.channel.findUniqueOrThrow({ where: { id: ctx.ch.id } })).autoReplyMode).toBe('both');
    expect((await agent.get('/api/channels')).body.find((c: any) => c.id === ctx.ch.id).autoReplyMode).toBe('both');
    const admin = await invite(owner, 'ADMIN');
    expect((await admin.patch(`/api/channels/${ctx.ch.id}`, { autoReplyMode: 'robo' })).status).toBe(400);
    const r = await admin.patch(`/api/channels/${ctx.ch.id}`, { autoReplyMode: 'flows' });
    expect(r.status).toBe(200);
    expect(r.body.autoReplyMode).toBe('flows');
    expect(r.body.status).toBe('CONNECTED'); // não mexe na conexão
    const log = await prisma.auditLog.findFirst({ where: { orgId: owner.me.org.id, action: 'channel.auto_reply_mode', entityId: ctx.ch.id }, orderBy: { createdAt: 'desc' } });
    expect(JSON.parse(log!.meta)).toMatchObject({ antes: 'both', depois: 'flows' });
    expect(await prisma.auditLog.count({ where: { orgId: owner.me.org.id, action: 'channel.update', entityId: ctx.ch.id } })).toBe(0);
    expect((await owner.patch(`/api/channels/${ctx.ch.id}`, { autoReplyMode: 'both' })).body.autoReplyMode).toBe('both');
    // Outra empresa não enxerga nem altera o canal.
    const other = await registerClient();
    expect((await other.patch(`/api/channels/${ctx.ch.id}`, { autoReplyMode: 'ai' })).status).toBe(404);
  });

  it('canal QR: contato salvo na agenda continua sem resposta automática em qualquer modo (caixa desmarcada)', async () => {
    const qr = await owner.post('/api/channels', { name: 'Celular' });
    const channelId = qr.body.id;
    expect(qr.body.autoReplyMode).toBe('both');
    await prisma.channel.update({ where: { id: channelId }, data: { status: 'CONNECTED' } });
    const sent: { jid: string; content: AnyMessageContent }[] = [];
    let k = 0;
    const sock: QrSocket = {
      user: { id: '5511993195300:7@s.whatsapp.net' },
      async sendMessage(jid, content) { sent.push({ jid, content }); return { key: { id: `MQ${++k}` } }; },
      signalRepository: { lidMapping: { async getPNForLID() { return null; }, async getLIDForPN() { return null; } } },
    };
    qrManager.attachForTests(channelId, sock, 'CONNECTED');
    await qrManager.phoneContactsForTests(channelId, sock, [{ id: '5511981220001@s.whatsapp.net', name: 'Tia' }]);
    let seq = 0;
    const raw = (from: string, text: string) => ({ key: { fromMe: false, id: `MIN${Date.now()}${seq++}`, remoteJid: `${from}@s.whatsapp.net` }, pushName: 'Cliente', messageTimestamp: Math.floor(Date.now() / 1000), message: { conversation: text } }) as any;
    for (const mode of ['ai', 'flows', 'both']) {
      expect((await owner.patch(`/api/channels/${channelId}`, { autoReplyMode: mode })).body.autoReplyMode).toBe(mode);
      expect(await handleQrMessage(channelId, raw('5511981220001', 'oi, qual o horário de atendimento?'))).toBe('ok');
    }
    expect(sent).toHaveLength(0);
    // Contato não salvo no modo "Só IA" recebe a IA (não o fluxo).
    await owner.patch(`/api/channels/${channelId}`, { autoReplyMode: 'ai' });
    expect(await handleQrMessage(channelId, raw('5511981229999', 'oi, qual o horário de atendimento?'))).toBe('ok');
    expect(sent).toHaveLength(1);
    expect(JSON.stringify(sent[0].content)).toContain(HORARIO);
  });
});
