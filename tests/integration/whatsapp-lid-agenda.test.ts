import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { registerClient, Client, prisma, uniq } from '../helpers.js';
import { qrManager, resolveSenderPn, type QrSocket } from '../../server/whatsapp/qr/manager.js';
import { handleQrMessage } from '../../server/whatsapp/inbound.js';
import { useDbAuthState, clearAuthState } from '../../server/whatsapp/qr/authState.js';
import { isSavedInPhone } from '../../server/whatsapp/qr/addressBook.js';
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

let n = 0;
function mockSocket(lidMap: Record<string, string> = {}) {
  const sent: { jid: string; content: AnyMessageContent; id: string }[] = [];
  const sock: QrSocket = {
    user: { id: '5511993195300:7@s.whatsapp.net' },
    async sendMessage(jid, content) { const id = `LQ${++n}`; sent.push({ jid, content, id }); return { key: { id } }; },
    signalRepository: { lidMapping: {
      async getPNForLID(lid: string) { return lidMap[lid] ?? null; },
      async getLIDForPN(pn: string) { return Object.entries(lidMap).find(([, p]) => p === pn)?.[0] ?? null; },
    } },
  };
  return { sock, sent };
}

let seq = 0;
const raw = (key: Record<string, unknown>, text: string) => ({
  key: { fromMe: false, id: `LIN${Date.now()}${seq++}`, ...key },
  pushName: 'Cliente', messageTimestamp: Math.floor(Date.now() / 1000), message: { conversation: text },
}) as any;

describe('WhatsApp QR — Baileys 7 (LID) e contatos salvos na agenda do celular', () => {
  let owner: Client;
  let channelId: string;
  let mock: ReturnType<typeof mockSocket>;

  beforeAll(async () => {
    owner = await registerClient();
    const r = await owner.post('/api/channels', { name: 'Celular' });
    channelId = r.body.id;
    await prisma.channel.update({ where: { id: channelId }, data: { status: 'CONNECTED' } });
    // Fluxo que responde qualquer "oi" — mede se houve resposta automática.
    const f = await owner.post('/api/flows', {
      name: 'Resposta',
      graph: { nodes: [N('s', 'start', { triggers: [{ type: 'keyword', value: 'oi', match: 'contains' }] }), N('t', 'send_text', { text: 'Resposta automática' }), N('e', 'end', {})], edges: [E('s', 't'), E('t', 'e')] },
    });
    await owner.post(`/api/flows/${f.body.id}/status`, { status: 'ACTIVE' });
  });
  beforeEach(() => {
    mock = mockSocket({ '880001@lid': '5511981110001@s.whatsapp.net' });
    qrManager.attachForTests(channelId, mock.sock, 'CONNECTED');
  });
  afterAll(() => qrManager.resetForTests());

  const contactsOf = (waIds: string[]) => prisma.contact.findMany({ where: { orgId: owner.me.org.id, waId: { in: waIds } } });

  it('mensagem com remoteJid @lid + remoteJidAlt vira o contato do número (sem duplicar) e a resposta vai para o número', async () => {
    expect(await handleQrMessage(channelId, raw({ remoteJid: '880002@lid', remoteJidAlt: '5511981110002@s.whatsapp.net' }, 'oi'))).toBe('ok');
    expect(await handleQrMessage(channelId, raw({ remoteJid: '5511981110002@s.whatsapp.net' }, 'oi de novo'))).toBe('ok');
    const cs = await contactsOf(['5511981110002', '880002@lid']);
    expect(cs.map((c) => c.waId)).toEqual(['5511981110002']);
    expect(mock.sent[0].jid).toBe('5511981110002@s.whatsapp.net');
  });

  it('contato criado antes só com o LID passa a ser o contato do número quando ele fica conhecido', async () => {
    expect(await handleQrMessage(channelId, raw({ remoteJid: '880003@lid' }, 'primeira'))).toBe('ok');
    const antes = await prisma.contact.findUniqueOrThrow({ where: { orgId_waId: { orgId: owner.me.org.id, waId: '880003@lid' } } });
    expect(await handleQrMessage(channelId, raw({ remoteJid: '880003@lid', remoteJidAlt: '5511981110003@s.whatsapp.net' }, 'segunda'))).toBe('ok');
    const cs = await contactsOf(['5511981110003', '880003@lid']);
    expect(cs).toHaveLength(1);
    expect(cs[0]).toMatchObject({ id: antes.id, waId: '5511981110003', phone: '+5511981110003' });
    expect(await prisma.conversation.count({ where: { contactId: antes.id } })).toBe(1);
  });

  it('padrão (desmarcado): contato salvo na agenda NÃO recebe resposta automática, mas a mensagem entra no Inbox', async () => {
    const ch = await owner.get('/api/channels');
    expect(ch.body.find((c: any) => c.id === channelId).replySavedContacts).toBe(false);
    // Agenda sincronizada: contato salvo pelo número; ele escreve pelo LID (par conhecido pelo Baileys).
    await qrManager.phoneContactsForTests(channelId, mock.sock, [{ id: '5511981110001@s.whatsapp.net', name: 'Tia Ana' }]);
    expect(await isSavedInPhone(channelId, ['880001@lid'])).toBe(true);

    // Como no socket: antes do pipeline, o LID sem número é resolvido pelo mapeamento do Baileys.
    const m = raw({ remoteJid: '880001@lid' }, 'oi');
    await resolveSenderPn(mock.sock, m);
    expect(await handleQrMessage(channelId, m)).toBe('ok');
    expect(mock.sent).toHaveLength(0);
    const contact = await prisma.contact.findUniqueOrThrow({ where: { orgId_waId: { orgId: owner.me.org.id, waId: '5511981110001' } } });
    expect(contact.savedInPhone).toBe(true);
    const conv = await prisma.conversation.findFirstOrThrow({ where: { contactId: contact.id } });
    const msgs = await prisma.message.findMany({ where: { channelId, direction: 'IN', conversationId: conv.id } });
    expect(msgs.map((m) => m.body)).toContain('oi');
    // Contato não salvo continua recebendo resposta.
    expect(await handleQrMessage(channelId, raw({ remoteJid: '5511981119999@s.whatsapp.net' }, 'oi'))).toBe('ok');
    expect(mock.sent.map((s) => s.jid)).toEqual(['5511981119999@s.whatsapp.net']);
  });

  it('pushName/notify sozinho não marca como salvo; apagar da agenda volta a responder', async () => {
    await qrManager.phoneContactsForTests(channelId, mock.sock, [{ id: '5511981110005@s.whatsapp.net', notify: 'Perfil' } as any]);
    expect(await isSavedInPhone(channelId, ['5511981110005'])).toBe(false);
    await qrManager.phoneContactsForTests(channelId, mock.sock, [{ id: '5511981110006@s.whatsapp.net', name: 'Primo' }]);
    expect(await handleQrMessage(channelId, raw({ remoteJid: '5511981110006@s.whatsapp.net' }, 'oi'))).toBe('ok');
    expect(mock.sent).toHaveLength(0);
    // Removido da agenda no celular (contactAction sem nome).
    await qrManager.phoneContactsForTests(channelId, mock.sock, [{ id: '5511981110006@s.whatsapp.net', name: undefined }]);
    expect(await isSavedInPhone(channelId, ['5511981110006'])).toBe(false);
    expect((await prisma.contact.findUniqueOrThrow({ where: { orgId_waId: { orgId: owner.me.org.id, waId: '5511981110006' } } })).savedInPhone).toBe(false);
  });

  it('opção marcada: responde todo mundo, inclusive salvos; só Proprietário/Administrador altera e fica na Auditoria', async () => {
    const agent = await invite(owner, 'AGENT');
    expect((await agent.patch(`/api/channels/${channelId}`, { replySavedContacts: true })).status).toBe(403);
    const admin = await invite(owner, 'ADMIN');
    const r = await admin.patch(`/api/channels/${channelId}`, { replySavedContacts: true });
    expect(r.status).toBe(200);
    expect(r.body.replySavedContacts).toBe(true);
    expect(r.body.provider).toBe('whatsapp_qr'); // não vira API oficial
    const log = await prisma.auditLog.findFirst({ where: { orgId: owner.me.org.id, action: 'channel.reply_saved_contacts', entityId: channelId }, orderBy: { createdAt: 'desc' } });
    expect(JSON.parse(log!.meta)).toMatchObject({ antes: false, depois: true });

    await qrManager.phoneContactsForTests(channelId, mock.sock, [{ id: '5511981110007@s.whatsapp.net', name: 'Vizinho' }]);
    expect(await handleQrMessage(channelId, raw({ remoteJid: '5511981110007@s.whatsapp.net' }, 'oi'))).toBe('ok');
    expect(mock.sent.map((s) => s.jid)).toEqual(['5511981110007@s.whatsapp.net']);

    expect((await owner.patch(`/api/channels/${channelId}`, { replySavedContacts: false })).body.replySavedContacts).toBe(false);
  });

  it('sessão já pareada: puxa a agenda completa do celular uma única vez (snapshot da coleção de contatos)', async () => {
    const calls: string[] = [];
    const sock: QrSocket = {
      ...mock.sock,
      authState: { keys: { async set(d) { calls.push(`set:${JSON.stringify(d)}`); } } },
      async resyncAppState(cols, initial) {
        calls.push(`resync:${cols.join(',')}:${initial}`);
        // o Baileys emitiria contacts.upsert para cada contato do snapshot
        await qrManager.phoneContactsForTests(channelId, sock, [{ id: '5511981110010@s.whatsapp.net', name: 'Do snapshot' }]);
      },
      appStatePatchMutex: { mutex: (fn) => fn() },
    };
    qrManager.attachForTests(channelId, sock, 'CONNECTED');
    await prisma.channel.update({ where: { id: channelId }, data: { addressBookSyncedAt: null } });
    expect(await qrManager.syncAddressBook(channelId)).toBe(true);
    expect(calls).toEqual(['set:{"app-state-sync-version":{"critical_unblock_low":null}}', 'resync:critical_unblock_low:false']);
    expect(await isSavedInPhone(channelId, ['5511981110010'])).toBe(true);
    expect((await prisma.channel.findUniqueOrThrow({ where: { id: channelId } })).addressBookSyncedAt).not.toBeNull();
    expect(await qrManager.syncAddressBook(channelId)).toBe(false); // já sincronizada
    expect(calls).toHaveLength(2);
    const v = (await owner.get('/api/channels')).body.find((c: any) => c.id === channelId);
    expect(v.addressBook.savedContacts).toBeGreaterThan(0);
  });

  it('agenda é por canal e isolada por empresa', async () => {
    const other = await registerClient();
    const o = await other.post('/api/channels', { name: 'Outro' });
    expect((await other.patch(`/api/channels/${channelId}`, { replySavedContacts: true })).status).toBe(404);
    await qrManager.phoneContactsForTests(channelId, mock.sock, [{ id: '5511981110008@s.whatsapp.net', name: 'X' }]);
    expect(await isSavedInPhone(o.body.id, ['5511981110008'])).toBe(false);
    expect(await isSavedInPhone(channelId, ['5511981110008'])).toBe(true);
  });
});

describe('Estado de autenticação no banco — chaves novas do Baileys 7', () => {
  const ch = `auth-${Date.now()}`;
  afterAll(() => clearAuthState(ch));

  it('guarda e lê lid-mapping, device-list, tctoken e identity-key (genérico, com Buffer)', async () => {
    const { state } = await useDbAuthState(ch);
    await state.keys.set({
      'lid-mapping': { '5511900000000': '123456', '123456_reverse': '5511900000000' },
      'device-list': { '5511900000000': ['0', '12'] },
      tctoken: { '5511900000000@s.whatsapp.net': { token: Buffer.from([1, 2, 3]), timestamp: '1761400000' } },
      'identity-key': { '123456.0': new Uint8Array([9, 8, 7]) },
    } as any);
    const again = (await useDbAuthState(ch)).state;
    expect(await again.keys.get('lid-mapping', ['5511900000000', '123456_reverse'])).toEqual({ '5511900000000': '123456', '123456_reverse': '5511900000000' });
    expect(await again.keys.get('device-list', ['5511900000000'])).toEqual({ '5511900000000': ['0', '12'] });
    const tc = (await again.keys.get('tctoken', ['5511900000000@s.whatsapp.net']))['5511900000000@s.whatsapp.net'];
    expect(Buffer.isBuffer(tc.token) && [...tc.token]).toEqual([1, 2, 3]);
    const ik = (await again.keys.get('identity-key', ['123456.0']))['123456.0'];
    expect([...ik]).toEqual([9, 8, 7]);
    // null apaga a chave
    await again.keys.set({ 'device-list': { '5511900000000': null } } as any);
    expect(await again.keys.get('device-list', ['5511900000000'])).toEqual({});
  });
});
