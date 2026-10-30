import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest';
import { registerClient, createTestChannel, prisma } from '../helpers.js';
import { qrManager, channelLogger, type QrSocket } from '../../server/whatsapp/qr/manager.js';
import { acquireLease, renewLease, releaseLease, INSTANCE_ID } from '../../server/whatsapp/qr/lease.js';
import { saveSent, loadSent, pruneSent } from '../../server/whatsapp/qr/sentStore.js';
import { useDbAuthState, flushAuthState } from '../../server/whatsapp/qr/authState.js';
import { describeEvent, recordDeliveryEvent, resetDeliveryLogForTests } from '../../server/whatsapp/qr/deliveryLog.js';
import type { AnyMessageContent } from '@whiskeysockets/baileys';

/** Socket simulado que devolve a mensagem "como o Baileys", com horário de cada envio. */
let n = 0;
function mockSocket() {
  const sent: { jid: string; content: AnyMessageContent; id: string; at: number }[] = [];
  const sock: QrSocket = {
    user: { id: '5511993195300:7@s.whatsapp.net' },
    async sendMessage(jid, content) {
      const id = `ENT${++n}`;
      sent.push({ jid, content, id, at: Date.now() });
      const message = 'text' in content ? { extendedTextMessage: { text: (content as { text: string }).text } } : { imageMessage: { url: 'https://cdn.exemplo.test/f.jpg', caption: 'Catálogo', mimetype: 'image/jpeg', fileLength: 1234, mediaKey: Buffer.from('chave-midia-1234567890') } };
      return { key: { id }, message };
    },
  };
  return { sock, sent };
}

describe('WhatsApp QR — entrega confiável ("Aguardando mensagem")', () => {
  let channelId: string;
  let orgId: string;

  beforeAll(async () => {
    const owner = await registerClient();
    orgId = owner.me.org.id;
    const { ch } = await createTestChannel(orgId);
    await prisma.channel.update({ where: { id: ch.id }, data: { provider: 'whatsapp_qr' } });
    channelId = ch.id;
  });
  afterEach(() => {
    delete process.env.QR_SEND_GAP_MS;
    delete process.env.QR_SEND_WAIT_MS;
    qrManager.resetForTests();
  });
  afterAll(() => qrManager.resetForTests());

  it('trava única por canal: outra instância com trava válida bloqueia; trava vencida pode ser assumida', async () => {
    expect(await acquireLease(channelId)).toBe(true);
    expect(await renewLease(channelId)).toBe(true);
    await prisma.channel.update({ where: { id: channelId }, data: { qrLeaseOwner: 'instancia-antiga', qrLeaseUntil: new Date(Date.now() + 60_000) } });
    expect(await acquireLease(channelId)).toBe(false);
    expect(await renewLease(channelId)).toBe(false);
    await releaseLease(channelId); // não libera a trava de outra instância
    expect((await prisma.channel.findUnique({ where: { id: channelId } }))?.qrLeaseOwner).toBe('instancia-antiga');
    await prisma.channel.update({ where: { id: channelId }, data: { qrLeaseUntil: new Date(Date.now() - 1000) } });
    expect(await acquireLease(channelId)).toBe(true);
    expect((await prisma.channel.findUnique({ where: { id: channelId } }))?.qrLeaseOwner).toBe(INSTANCE_ID);
    await releaseLease(channelId);
    expect((await prisma.channel.findUnique({ where: { id: channelId } }))?.qrLeaseOwner).toBeNull();
  });

  it('chaves do Signal gravadas em lote atômico e aguardadas (flush)', async () => {
    const { state } = await useDbAuthState(channelId);
    const p = state.keys.set({ session: { 'a.0': Buffer.from('sessao-a') as never, 'b.0': Buffer.from('sessao-b') as never }, 'pre-key': { '1': { public: Buffer.from('p'), private: Buffer.from('q') } as never } });
    await flushAuthState(channelId);
    await p;
    const got = await state.keys.get('session', ['a.0', 'b.0', 'c.0']);
    expect(Object.keys(got).sort()).toEqual(['a.0', 'b.0']);
    expect(Buffer.from(got['a.0'] as never).toString()).toBe('sessao-a');
    await state.keys.set({ session: { 'a.0': null as never } });
    expect(Object.keys(await state.keys.get('session', ['a.0', 'b.0']))).toEqual(['b.0']);
  });

  it('mensagem enviada é guardada completa (mídia incluída) para reenvio após reinício', async () => {
    const { sock } = mockSocket();
    qrManager.attachForTests(channelId, sock, 'CONNECTED');
    const r = await qrManager.send(channelId, '5511970001001', { type: 'image', link: 'https://cdn.exemplo.test/f.jpg', caption: 'Catálogo' });
    const back = await loadSent(channelId, r.waMessageId);
    expect(back?.imageMessage?.caption).toBe('Catálogo');
    expect(Buffer.from(back!.imageMessage!.mediaKey!).toString()).toBe('chave-midia-1234567890');
    const t = await qrManager.send(channelId, '5511970001001', { type: 'buttons', text: 'Menu', buttons: [{ id: 'a', title: 'Vendas' }] });
    expect((await loadSent(channelId, t.waMessageId))?.extendedTextMessage?.text).toBe('Menu\n\n1. Vendas\n\nResponda com o número da opção.');
    // retenção: apaga o que tem mais de 14 dias
    await saveSent(channelId, 'VELHA1', { conversation: 'antiga' });
    await prisma.waSentMessage.update({ where: { channelId_waMessageId: { channelId, waMessageId: 'VELHA1' } }, data: { createdAt: new Date(Date.now() - 15 * 86400e3) } });
    expect(await pruneSent(true)).toBe(1);
    expect(await loadSent(channelId, 'VELHA1')).toBeUndefined();
    expect(await loadSent(channelId, r.waMessageId)).toBeTruthy();
  });

  it('logo após conectar, o envio espera as notificações pendentes; mesmo contato tem intervalo entre mensagens', async () => {
    process.env.QR_SEND_GAP_MS = '200';
    const { sock, sent } = mockSocket();
    const t0 = Date.now();
    qrManager.connectForTests(channelId, sock, false); // fica pronto em ~300 ms
    await Promise.all([
      qrManager.send(channelId, '5511970002001', { type: 'text', text: '1' }),
      qrManager.send(channelId, '5511970002001', { type: 'text', text: '2' }),
      qrManager.send(channelId, '5511970002002', { type: 'text', text: 'outro' }),
    ]);
    expect(sent[0].at - t0).toBeGreaterThanOrEqual(250);
    const mesmo = sent.filter((m) => m.jid === '5511970002001@s.whatsapp.net');
    expect(mesmo.map((m) => (m.content as { text: string }).text)).toEqual(['1', '2']); // ordem preservada
    expect(mesmo[1].at - mesmo[0].at).toBeGreaterThanOrEqual(180);
    const outro = sent.find((m) => m.jid === '5511970002002@s.whatsapp.net')!;
    expect(outro.at - t0).toBeLessThan(mesmo[1].at - t0); // outro contato não espera a fila do primeiro
  });

  it('reconectando: o envio aguarda a conexão abrir em vez de falhar', async () => {
    process.env.QR_SEND_WAIT_MS = '3000';
    qrManager.setConnectingForTests(channelId);
    expect(qrManager.canSend(channelId)).toBe(true);
    const { sock, sent } = mockSocket();
    setTimeout(() => qrManager.attachForTests(channelId, sock, 'CONNECTED'), 300);
    const r = await qrManager.send(channelId, '5511970003001', { type: 'text', text: 'voltei' });
    expect(r.waMessageId).toBe(sent[0].id);
  });

  it('desconectado de vez: falha na hora com motivo claro', async () => {
    qrManager.attachForTests(channelId, null, 'NOT_CONNECTED');
    expect(qrManager.canSend(channelId)).toBe(false);
    await expect(qrManager.send(channelId, '5511970004001', { type: 'text', text: 'x' })).rejects.toThrow(/não conectado/);
  });

  it('desligamento (SIGTERM): fecha o socket, grava as chaves e libera a trava', async () => {
    expect(await acquireLease(channelId)).toBe(true);
    let ended = false;
    const { sock } = mockSocket();
    sock.end = () => { ended = true; };
    qrManager.connectForTests(channelId, sock, true);
    await qrManager.shutdown();
    expect(ended).toBe(true);
    expect((await prisma.channel.findUnique({ where: { id: channelId } }))?.qrLeaseOwner).toBeNull();
    expect(qrManager.isConnected(channelId)).toBe(false);
  });

  it('pedidos de reenvio e falhas de descriptografia viram eventos na Auditoria, por contato e sem duplicar', async () => {
    resetDeliveryLogForTests();
    expect(describeEvent({ attrs: { from: '5511970005001@s.whatsapp.net' }, key: { remoteJid: '5511970005001@s.whatsapp.net', id: 'M1' } }, 'recv retry request'))
      .toEqual({ action: 'whatsapp.retry_pedido', jid: '5511970005001@s.whatsapp.net', msgId: 'M1' });
    expect(describeEvent({ jid: '5511970005001@s.whatsapp.net', id: 'M2' }, 'recv retry request, but message not available')?.action).toBe('whatsapp.retry_sem_mensagem');
    expect(describeEvent({}, 'outra coisa qualquer')).toBeNull();

    const logger = channelLogger(channelId, () => orgId);
    logger.debug({ attrs: {}, key: { remoteJid: '5511970005001@s.whatsapp.net', id: 'M1', fromMe: true } }, 'recv retry request');
    logger.debug({ attrs: {}, key: { remoteJid: '5511970005001@s.whatsapp.net', id: 'M1', fromMe: true } }, 'recv retry request'); // duplicado
    logger.info({ attrs: {}, key: { remoteJid: '5511970005001@s.whatsapp.net', id: 'M1' } }, 'will not send message again, as sent too many times');
    await recordDeliveryEvent(channelId, orgId, { action: 'whatsapp.decrypt_falha', jid: '5511970005002@s.whatsapp.net', msgId: 'IN9' });
    await new Promise((r) => setTimeout(r, 100));
    const rows = await prisma.auditLog.findMany({ where: { orgId, action: { startsWith: 'whatsapp.' } }, orderBy: { createdAt: 'asc' } });
    // Eventos gravados no mesmo milissegundo podem vir em qualquer ordem: compara sem depender dela.
    expect(rows.map((r) => [r.action, r.entityId]).sort()).toEqual([
      ['whatsapp.decrypt_falha', '5511970005002'],
      ['whatsapp.retry_limite', '5511970005001'],
      ['whatsapp.retry_pedido', '5511970005001'],
    ]);
    expect(JSON.parse(rows.find((r) => r.action === 'whatsapp.retry_pedido')!.meta)).toMatchObject({ channelId, msgId: 'M1' });
  });
});
