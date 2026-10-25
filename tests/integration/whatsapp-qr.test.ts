import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { registerClient, Client, createTestChannel, installGraphMock, graph, prisma } from '../helpers.js';
import { qrManager, type QrSocket } from '../../server/whatsapp/qr/manager.js';
import { handleQrMessage, handleQrStatus } from '../../server/whatsapp/inbound.js';
import { sendOutbound } from '../../server/whatsapp/messaging.js';
import type { AnyMessageContent } from '@whiskeysockets/baileys';

const N = (id: string, type: string, data: any = {}) => ({ id, type, position: { x: 0, y: 0 }, data });
const E = (source: string, target: string, sourceHandle = 'next') => ({ id: `${source}-${sourceHandle}-${target}`, source, target, sourceHandle });

/** Socket do Baileys simulado: registra o que seria enviado. */
let n = 0;
function mockSocket() {
  const sent: { jid: string; content: AnyMessageContent; id: string }[] = [];
  const sock: QrSocket = {
    user: { id: '5511993195300:7@s.whatsapp.net' },
    async sendMessage(jid, content) { const id = `QR${++n}`; sent.push({ jid, content, id }); return { key: { id } }; },
  };
  return { sock, sent };
}

let seq = 0;
const rawText = (from: string, text: string, extra: any = {}) => ({
  key: { remoteJid: `${from}@s.whatsapp.net`, fromMe: false, id: `IN${Date.now()}${seq++}`, ...extra },
  pushName: 'Cliente QR', messageTimestamp: Math.floor(Date.now() / 1000), message: { conversation: text },
}) as any;

describe('WhatsApp por QR code (Baileys) — roteamento e pipeline', () => {
  let owner: Client;
  let qrChannelId: string;
  let mock: ReturnType<typeof mockSocket>;

  beforeAll(async () => {
    installGraphMock();
    owner = await registerClient();
    const r = await owner.post('/api/channels', { name: 'Celular' });
    expect(r.status).toBe(201);
    expect(r.body.provider).toBe('whatsapp_qr'); // novo padrão
    qrChannelId = r.body.id;
    await prisma.channel.update({ where: { id: qrChannelId }, data: { status: 'CONNECTED' } });
  });
  beforeEach(() => {
    graph.reset();
    mock = mockSocket();
    qrManager.attachForTests(qrChannelId, mock.sock, 'CONNECTED');
  });
  afterAll(() => qrManager.resetForTests());

  async function conversationFor(orgId: string, channelId: string, phone: string, lastInboundAt: Date | null = null) {
    const contact = await prisma.contact.create({ data: { orgId, waId: phone, phone: '+' + phone } });
    const conversation = await prisma.conversation.create({ data: { orgId, contactId: contact.id, channelId, lastInboundAt } });
    return { contact, conversation };
  }

  it('canal QR envia pelo socket, sem a regra da janela de 24h', async () => {
    const { contact, conversation } = await conversationFor(owner.me.org.id, qrChannelId, '5511970000001', null);
    const m = await sendOutbound({ conversation, contact, payload: { type: 'text', text: 'Olá!' }, sender: 'agent' });
    expect(m.status).toBe('SENT');
    expect(m.waMessageId).toBe(mock.sent[0].id);
    expect(mock.sent[0]).toMatchObject({ jid: '5511970000001@s.whatsapp.net', content: { text: 'Olá!' } });
    expect(graph.calls).toHaveLength(0); // nada vai para a Graph API
  });

  it('botões viram texto com opções numeradas no QR', async () => {
    const { contact, conversation } = await conversationFor(owner.me.org.id, qrChannelId, '5511970000002');
    const m = await sendOutbound({ conversation, contact, payload: { type: 'buttons', text: 'Escolha:', buttons: [{ id: 'a', title: 'Vendas' }, { id: 'b', title: 'Suporte' }] }, sender: 'bot' });
    expect(m.status).toBe('SENT');
    expect(m.type).toBe('text');
    expect((mock.sent[0].content as any).text).toContain('1. Vendas\n2. Suporte');
  });

  it('modelo (template) não existe no QR e falha com motivo claro', async () => {
    const { contact, conversation } = await conversationFor(owner.me.org.id, qrChannelId, '5511970000003');
    const m = await sendOutbound({ conversation, contact, payload: { type: 'template', name: 'hello_world', language: 'pt_BR' }, sender: 'agent' });
    expect(m.status).toBe('FAILED');
    expect(m.error).toMatch(/API oficial/);
    expect(mock.sent).toHaveLength(0);
  });

  it('mídia por link é enviada como URL; link interno é recusado (SSRF)', async () => {
    const { contact, conversation } = await conversationFor(owner.me.org.id, qrChannelId, '5511970000004');
    const ok = await sendOutbound({ conversation, contact, payload: { type: 'image', link: 'https://cdn.exemplo.test/foto.jpg', caption: 'Catálogo' }, sender: 'agent' });
    expect(ok.status).toBe('SENT');
    expect(mock.sent[0].content).toMatchObject({ image: { url: 'https://cdn.exemplo.test/foto.jpg' }, caption: 'Catálogo' });
    const bad = await sendOutbound({ conversation, contact, payload: { type: 'image', link: 'https://painel.interno.test/x.jpg' }, sender: 'agent' });
    expect(bad.status).toBe('FAILED');
    expect(mock.sent).toHaveLength(1);
  });

  it('socket ausente: mensagem fica FAILED "não conectado" (nunca simula envio)', async () => {
    qrManager.attachForTests(qrChannelId, null, 'NOT_CONNECTED');
    const { contact, conversation } = await conversationFor(owner.me.org.id, qrChannelId, '5511970000005');
    const m = await sendOutbound({ conversation, contact, payload: { type: 'text', text: 'oi' }, sender: 'agent' });
    expect(m.status).toBe('FAILED');
    expect(m.error).toMatch(/não conectado/);
  });

  it('canal da API oficial continua usando a Graph API e a janela de 24h', async () => {
    const other = await registerClient();
    const cloud = await createTestChannel(other.me.org.id);
    const out = await conversationFor(other.me.org.id, cloud.ch.id, '5511970000006', null);
    const blocked = await sendOutbound({ conversation: out.conversation, contact: out.contact, payload: { type: 'text', text: 'oi' }, sender: 'agent' });
    expect(blocked.status).toBe('FAILED');
    expect(blocked.error).toMatch(/janela de 24 horas/);
    const inside = await conversationFor(other.me.org.id, cloud.ch.id, '5511970000007', new Date());
    const sent = await sendOutbound({ conversation: inside.conversation, contact: inside.contact, payload: { type: 'text', text: 'oi' }, sender: 'agent' });
    expect(sent.status).toBe('SENT');
    expect(graph.calls.length).toBeGreaterThan(0);
    expect(mock.sent).toHaveLength(0);
  });

  it('mensagem recebida pelo Baileys entra no pipeline: contato, conversa, fluxo e resposta pelo socket', async () => {
    const f = await owner.post('/api/flows', {
      name: 'Boas-vindas QR',
      graph: { nodes: [N('s', 'start', { triggers: [{ type: 'keyword', value: 'preço', match: 'contains' }] }), N('t', 'send_text', { text: 'Nossa tabela de preços: …' }), N('e', 'end', {})], edges: [E('s', 't'), E('t', 'e')] },
    });
    expect(f.status).toBe(201);
    expect((await owner.post(`/api/flows/${f.body.id}/status`, { status: 'ACTIVE' })).status).toBe(200);

    const raw = rawText('5511970000008', 'Qual o preço?');
    expect(await handleQrMessage(qrChannelId, raw)).toBe('ok');
    expect(await handleQrMessage(qrChannelId, raw)).toBe('duplicate'); // idempotente

    const contact = await prisma.contact.findUniqueOrThrow({ where: { orgId_waId: { orgId: owner.me.org.id, waId: '5511970000008' } } });
    expect(contact.name).toBe('Cliente QR');
    const msgs = await prisma.message.findMany({ where: { orgId: owner.me.org.id, channelId: qrChannelId, direction: 'IN' } });
    expect(msgs.some((m) => m.body === 'Qual o preço?')).toBe(true);
    expect(mock.sent.map((s) => (s.content as any).text)).toContain('Nossa tabela de preços: …');
    expect(mock.sent[0].jid).toBe('5511970000008@s.whatsapp.net');

    // Status de entrega/leitura vindo do Baileys
    const wid = mock.sent[0].id;
    const out = await prisma.message.findFirstOrThrow({ where: { channelId: qrChannelId, waMessageId: wid } });
    expect(await handleQrStatus(qrChannelId, { key: { id: wid, fromMe: true, remoteJid: '5511970000008@s.whatsapp.net' }, update: { status: 3 } } as any)).toBe(true);
    expect(await handleQrStatus(qrChannelId, { key: { id: wid, fromMe: true }, update: { status: 4 } } as any)).toBe(true);
    expect((await prisma.message.findUniqueOrThrow({ where: { id: out.id } })).status).toBe('READ');
  });

  it('ignora grupos, status e mensagens próprias', async () => {
    expect(await handleQrMessage(qrChannelId, rawText('5511970000009', 'oi', { remoteJid: '1203630@g.us' }))).toBe('ignored');
    expect(await handleQrMessage(qrChannelId, rawText('5511970000009', 'oi', { remoteJid: 'status@broadcast' }))).toBe('ignored');
    expect(await handleQrMessage(qrChannelId, rawText('5511970000009', 'oi', { fromMe: true }))).toBe('ignored');
    expect(await prisma.contact.findUnique({ where: { orgId_waId: { orgId: owner.me.org.id, waId: '5511970000009' } } })).toBeNull();
  });

  it('endpoints de QR respeitam RBAC e isolamento por organização', async () => {
    const intruder = await registerClient();
    expect((await intruder.get(`/api/channels/${qrChannelId}/qr`)).status).toBe(404);
    expect((await intruder.post(`/api/channels/${qrChannelId}/qr/start`)).status).toBe(404);
    expect((await intruder.post(`/api/channels/${qrChannelId}/qr/disconnect`)).status).toBe(404);
    const st = await owner.get(`/api/channels/${qrChannelId}/qr`);
    expect(st.status).toBe(200);
    expect(st.body).toMatchObject({ channelId: qrChannelId, provider: 'whatsapp_qr' });
    // Verificar (Graph API) não se aplica a canal QR
    expect((await owner.post(`/api/channels/${qrChannelId}/verify`)).status).toBe(400);
  });

  it('conversa em canal QR não mostra bloqueio de janela de 24h no Inbox', async () => {
    const { conversation } = await conversationFor(owner.me.org.id, qrChannelId, '5511970000010', null);
    const r = await owner.get(`/api/conversations/${conversation.id}`);
    expect(r.body.conversation.withinWindow).toBe(true);
  });
});
