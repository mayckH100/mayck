import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { registerClient, Client, prisma, uniq } from '../helpers.js';
import { qrManager, type QrSocket } from '../../server/whatsapp/qr/manager.js';
import { useDbAuthState, hasSavedSession, clearAuthState } from '../../server/whatsapp/qr/authState.js';

async function invite(owner: Client, role: 'AGENT' | 'ADMIN') {
  const inv = await owner.post('/api/team/invites', { email: `${uniq()}@t.dev`, role });
  const token = inv.body.link.split('/convite/')[1];
  const c = new Client();
  const r = await c.agent.post('/api/auth/accept-invite').set('x-requested-with', 'mckbot').send({ token, name: 'Membro', password: 'senhaMembro123' });
  c.csrf = r.body.csrfToken;
  c.me = r.body;
  return c;
}

describe('WhatsApp: conectar com número de telefone (código de pareamento)', () => {
  let owner: Client;
  let channelId: string;
  let asked: string[];
  let spy: ReturnType<typeof vi.spyOn>;

  const mockSock = (): QrSocket => ({
    user: null,
    async sendMessage() { return { key: { id: 'x' } }; },
    async requestPairingCode(phone: string) { asked.push(phone); return 'ABCD1234'; },
  });

  beforeAll(async () => {
    owner = await registerClient();
    const r = await owner.post('/api/channels', { name: 'Celular' });
    channelId = r.body.id;
  });
  beforeEach(async () => {
    asked = [];
    qrManager.resetForTests();
    await prisma.auditLog.deleteMany({ where: { entityId: channelId, action: { startsWith: 'channel.pairing_code' } } });
    // Simula o socket novo do Baileys pronto para parear (mesmo momento em que o QR apareceria).
    spy = vi.spyOn(qrManager as any, 'openForPairing').mockImplementation(async (s: any) => {
      s.stopped = false; s.generation++; s.pairing = null; s.status = 'QR_PENDING'; s.sock = mockSock();
    });
  });
  afterEach(() => spy.mockRestore());
  afterAll(() => qrManager.resetForTests());

  it('gera o código XXXX-XXXX para o número só com dígitos; o código não vai para a Auditoria', async () => {
    const r = await owner.post(`/api/channels/${channelId}/qr/pairing-code`, { phone: '+55 (11) 99999-0000' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ code: 'ABCD-1234', phone: '+55 11 *****-0000', remaining: 4 });
    expect(new Date(r.body.expiresAt).getTime()).toBeGreaterThan(Date.now() + 60_000);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(asked).toEqual(['5511999990000']);
    const logs = await prisma.auditLog.findMany({ where: { entityId: channelId, action: 'channel.pairing_code' } });
    expect(logs).toHaveLength(1);
    expect(logs[0].meta).not.toMatch(/ABCD|1234|999990000/);
    // Consulta de status mostra que há código ativo, mas nunca o código; e não mostra QR por cima.
    const st = await owner.get(`/api/channels/${channelId}/qr`);
    expect(st.body.pairing).toMatchObject({ phone: '+55 11 *****-0000' });
    expect(st.body.qr).toBeNull();
    expect(JSON.stringify(st.body)).not.toContain('ABCD');
  });

  it('valida o número e não chama o WhatsApp com número inválido', async () => {
    for (const phone of ['', '011999990000', '55 11 9999', '55 10 99999-0000']) {
      const r = await owner.post(`/api/channels/${channelId}/qr/pairing-code`, { phone });
      expect(r.status).toBe(400);
    }
    expect(asked).toHaveLength(0);
  });

  it('só Proprietário/Administrador e só da própria empresa', async () => {
    const agent = await invite(owner, 'AGENT');
    expect((await agent.post(`/api/channels/${channelId}/qr/pairing-code`, { phone: '5511999990000' })).status).toBe(403);
    const intruder = await registerClient();
    expect((await intruder.post(`/api/channels/${channelId}/qr/pairing-code`, { phone: '5511999990000' })).status).toBe(404);
    const admin = await invite(owner, 'ADMIN');
    expect((await admin.post(`/api/channels/${channelId}/qr/pairing-code`, { phone: '5511999990000' })).status).toBe(200);
    expect(asked).toHaveLength(1);
  });

  it('limite de 5 códigos por hora por canal', async () => {
    for (let i = 0; i < 5; i++) expect((await owner.post(`/api/channels/${channelId}/qr/pairing-code`, { phone: '5511999990000' })).status).toBe(200);
    const r = await owner.post(`/api/channels/${channelId}/qr/pairing-code`, { phone: '5511999990000' });
    expect(r.status).toBe(429);
    expect(r.body.error).toMatch(/5 códigos por hora/);
    expect(asked).toHaveLength(5);
  });

  it('canal já conectado ou com sessão salva não aceita código', async () => {
    qrManager.attachForTests(channelId, mockSock(), 'CONNECTED');
    expect((await owner.post(`/api/channels/${channelId}/qr/pairing-code`, { phone: '5511999990000' })).status).toBe(409);
    qrManager.resetForTests();
    const { state, saveCreds } = await useDbAuthState(channelId);
    state.creds.me = { id: '5511988887777:3@s.whatsapp.net' };
    await saveCreds();
    expect((await owner.post(`/api/channels/${channelId}/qr/pairing-code`, { phone: '5511999990000' })).status).toBe(409);
    expect(asked).toHaveLength(0);
    await clearAuthState(channelId);
  });

  it('servidor em atualização (trava do canal com outra instância) responde 503 sem gerar código', async () => {
    spy.mockImplementation(async (s: any) => { s.stopped = false; s.waitingLease = true; s.status = 'CONNECTING'; s.sock = null; });
    const r = await owner.post(`/api/channels/${channelId}/qr/pairing-code`, { phone: '5511999990000' });
    expect(r.status).toBe(503);
    expect(asked).toHaveLength(0);
    expect(await prisma.auditLog.count({ where: { entityId: channelId, action: 'channel.pairing_code_falha' } })).toBe(1);
  });

  it('pareamento por código não concluído é descartado: não restaura sessão nem faz login com ele', async () => {
    const { state, saveCreds } = await useDbAuthState(channelId);
    state.creds.me = { id: '5511999990000@s.whatsapp.net', name: '~' };
    state.creds.pairingCode = 'ABCD1234';
    await saveCreds();
    expect(await hasSavedSession(channelId)).toBe(false);
    const again = await useDbAuthState(channelId);
    expect(again.state.creds.me).toBeUndefined();
    expect(again.state.creds.pairingCode).toBeUndefined();
    // Concluído (registered) vale como sessão.
    again.state.creds.me = { id: '5511999990000:2@s.whatsapp.net' };
    again.state.creds.pairingCode = 'ABCD1234';
    again.state.creds.registered = true;
    await again.saveCreds();
    expect(await hasSavedSession(channelId)).toBe(true);
    await clearAuthState(channelId);
  });
});
