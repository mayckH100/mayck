import { describe, it, expect } from 'vitest';
import { parseBaileysMessage, buildQrContent, mapBaileysStatus, waIdToJid, jidToNumber, numberedOptions, senderIdentities, lidOf } from '../../server/whatsapp/qr/parse.js';
import { backoffDelay, resolveSenderPn, completeContactPairs, type QrSocket } from '../../server/whatsapp/qr/manager.js';
import { phoneContactKey, contactWaIdKey, phoneContactEntries } from '../../server/whatsapp/qr/addressBook.js';
import { TtlCache } from '../../server/whatsapp/qr/ttlCache.js';
import * as baileys from '@whiskeysockets/baileys';

const base = (message: any, key: any = {}) => ({
  key: { remoteJid: '5511988887777@s.whatsapp.net', fromMe: false, id: 'ABC123', ...key },
  pushName: 'Maria', messageTimestamp: 1761400000, message,
}) as any;

describe('Parser de mensagens do Baileys', () => {
  it('texto simples e texto estendido', () => {
    expect(parseBaileysMessage(base({ conversation: 'Oi' }))).toMatchObject({ waMessageId: 'ABC123', from: '5511988887777', text: 'Oi', type: 'text', profileName: 'Maria' });
    expect(parseBaileysMessage(base({ extendedTextMessage: { text: 'Veja https://x.y' } }))?.text).toBe('Veja https://x.y');
    expect(parseBaileysMessage(base({ conversation: 'x' }))?.timestamp.getTime()).toBe(1761400000 * 1000);
  });
  it('legenda de mídia e mensagens temporárias/visualização única', () => {
    expect(parseBaileysMessage(base({ imageMessage: { caption: 'Foto do produto' } }))).toMatchObject({ type: 'image', text: 'Foto do produto' });
    expect(parseBaileysMessage(base({ documentMessage: { caption: 'Orçamento' } }))).toMatchObject({ type: 'document', text: 'Orçamento' });
    expect(parseBaileysMessage(base({ audioMessage: {} }))).toMatchObject({ type: 'audio', text: '' });
    expect(parseBaileysMessage(base({ ephemeralMessage: { message: { conversation: 'some' } } }))?.text).toBe('some');
    expect(parseBaileysMessage(base({ viewOnceMessageV2: { message: { imageMessage: { caption: 'uma vez' } } } }))).toMatchObject({ type: 'image', text: 'uma vez' });
  });
  it('respostas de botão/lista viram interactive com replyId', () => {
    expect(parseBaileysMessage(base({ buttonsResponseMessage: { selectedButtonId: 'opt1', selectedDisplayText: 'Vendas' } }))).toMatchObject({ type: 'interactive', text: 'Vendas', replyId: 'opt1' });
  });
  it('ignora mensagens próprias, grupos, status, broadcast, canais e reações', () => {
    expect(parseBaileysMessage(base({ conversation: 'x' }, { fromMe: true }))).toBeNull();
    expect(parseBaileysMessage(base({ conversation: 'x' }, { remoteJid: '120363000000@g.us' }))).toBeNull();
    expect(parseBaileysMessage(base({ conversation: 'x' }, { remoteJid: 'status@broadcast' }))).toBeNull();
    expect(parseBaileysMessage(base({ conversation: 'x' }, { remoteJid: '12345@broadcast' }))).toBeNull();
    expect(parseBaileysMessage(base({ conversation: 'x' }, { remoteJid: '1203@newsletter' }))).toBeNull();
    expect(parseBaileysMessage(base({ reactionMessage: { text: '👍' } }))).toBeNull();
    expect(parseBaileysMessage(base(null))).toBeNull();
  });
  it('contato identificado por LID usa o número real (senderPn) quando disponível', () => {
    expect(parseBaileysMessage(base({ conversation: 'oi' }, { remoteJid: '9876543210@lid', senderPn: '5511977776666@s.whatsapp.net' }))?.from).toBe('5511977776666');
    expect(parseBaileysMessage(base({ conversation: 'oi' }, { remoteJid: '9876543210@lid' }))?.from).toBe('9876543210@lid');
  });
  it('Baileys 7 (LID): remoteJid @lid com remoteJidAlt traz o número e guarda o LID', () => {
    const m = parseBaileysMessage(base({ conversation: 'oi' }, { remoteJid: '9876543210@lid', remoteJidAlt: '5511977776666@s.whatsapp.net' }));
    expect(m).toMatchObject({ from: '5511977776666', lid: '9876543210@lid' });
    // e o inverso: remoteJid é o número e o LID vem no alternativo
    expect(parseBaileysMessage(base({ conversation: 'oi' }, { remoteJidAlt: '9876543210@lid' }))).toMatchObject({ from: '5511988887777', lid: '9876543210@lid' });
    // aparelho no JID (":12") não muda a identidade
    expect(senderIdentities({ remoteJid: '9876543210:12@lid', remoteJidAlt: '5511977776666:12@s.whatsapp.net' })).toEqual({ phone: '5511977776666', lid: '9876543210@lid' });
    expect(lidOf('5511977776666@s.whatsapp.net')).toBeNull();
  });
  it('Baileys 7: helpers renomeados existem (isPnUser/isLidUser) e isJidUser foi removido', () => {
    expect(typeof baileys.isPnUser).toBe('function');
    expect(typeof baileys.isLidUser).toBe('function');
    expect((baileys as any).isJidUser).toBeUndefined();
  });
  it('JIDs e números', () => {
    expect(jidToNumber('5511993195300:12@s.whatsapp.net')).toBe('5511993195300');
    expect(jidToNumber('1203@g.us')).toBeNull();
    expect(waIdToJid('5511993195300')).toBe('5511993195300@s.whatsapp.net');
    expect(waIdToJid('9876@lid')).toBe('9876@lid');
  });
});

describe('Conteúdo de envio (modo QR)', () => {
  it('texto, botões numerados, mídia por link e documento com mimetype', () => {
    expect(buildQrContent({ type: 'text', text: 'oi' })).toEqual({ text: 'oi' });
    expect(numberedOptions('Menu', [{ title: 'A' }, { title: 'B' }])).toBe('Menu\n\n1. A\n2. B\n\nResponda com o número da opção.');
    expect(buildQrContent({ type: 'buttons', text: 'Menu', buttons: [{ id: '1', title: 'A' }] })).toEqual({ text: 'Menu\n\n1. A\n\nResponda com o número da opção.' });
    expect(buildQrContent({ type: 'video', link: 'https://x.y/v.mp4', caption: 'c' })).toEqual({ video: { url: 'https://x.y/v.mp4' }, caption: 'c' });
    expect(buildQrContent({ type: 'document', link: 'https://x.y/files/tabela.pdf?t=1' })).toMatchObject({ document: { url: 'https://x.y/files/tabela.pdf?t=1' }, fileName: 'tabela.pdf', mimetype: 'application/pdf' });
    expect(() => buildQrContent({ type: 'template', name: 'x', language: 'pt_BR' })).toThrow(/API oficial/);
  });
  it('status do Baileys → status interno', () => {
    expect([0, 1, 2, 3, 4, 5].map(mapBaileysStatus)).toEqual(['failed', null, 'sent', 'delivered', 'read', 'read']);
  });
  it('backoff de reconexão cresce e tem teto de 5 minutos', () => {
    expect(backoffDelay(1)).toBe(2000);
    expect(backoffDelay(2)).toBe(4000);
    expect(backoffDelay(20)).toBe(300000);
  });
});


describe('LID → número (Baileys 7)', () => {
  const sockWith = (map: Record<string, string>): QrSocket => ({
    async sendMessage() { return { key: { id: 'x' } }; },
    signalRepository: { lidMapping: {
      async getPNForLID(lid: string) { return map[lid] ?? null; },
      async getLIDForPN(pn: string) { return Object.entries(map).find(([, p]) => p === pn)?.[0] ?? null; },
    } },
  });
  it('mensagem só com LID: resolve o número pelo mapeamento conhecido e o parser usa o número', async () => {
    const raw: any = base({ conversation: 'oi' }, { remoteJid: '555000111@lid' });
    await resolveSenderPn(sockWith({ '555000111@lid': '5511966665555:3@s.whatsapp.net' }), raw);
    expect(raw.key.remoteJidAlt).toBe('5511966665555@s.whatsapp.net');
    expect(parseBaileysMessage(raw)).toMatchObject({ from: '5511966665555', lid: '555000111@lid' });
  });
  it('LID desconhecido: o contato fica identificado pelo LID (envio para @lid funciona)', async () => {
    const raw: any = base({ conversation: 'oi' }, { remoteJid: '555000222@lid' });
    await resolveSenderPn(sockWith({}), raw);
    expect(raw.key.remoteJidAlt).toBeUndefined();
    expect(parseBaileysMessage(raw)?.from).toBe('555000222@lid');
    expect(waIdToJid('555000222@lid')).toBe('555000222@lid');
  });
  it('não consulta o mapeamento quando o número já veio', async () => {
    let calls = 0;
    const sock: QrSocket = { async sendMessage() { return undefined; }, signalRepository: { lidMapping: { async getPNForLID() { calls++; return null; } } } };
    await resolveSenderPn(sock, base({ conversation: 'oi' }, { remoteJid: '555@lid', remoteJidAlt: '5511900001111@s.whatsapp.net' }));
    await resolveSenderPn(sock, base({ conversation: 'oi' }));
    expect(calls).toBe(0);
  });
  it('agenda: completa o par número↔LID dos contatos sincronizados', async () => {
    const out = await completeContactPairs(sockWith({ '777@lid': '5511955554444@s.whatsapp.net' }), [
      { id: '777@lid', name: 'Fulano' },
      { id: '5511955554444@s.whatsapp.net', name: 'Fulano' },
    ]);
    expect(out[0]).toMatchObject({ lid: '777@lid', phoneNumber: '5511955554444@s.whatsapp.net' });
    expect(out[1]).toMatchObject({ lid: '777@lid' });
  });
});

describe('Agenda do celular (contatos salvos)', () => {
  it('chaves: número → dígitos; LID → "lid:<id>"; grupos/outros → null', () => {
    expect(phoneContactKey('5511999990000@s.whatsapp.net')).toBe('5511999990000');
    expect(phoneContactKey('5511999990000:4@s.whatsapp.net')).toBe('5511999990000');
    expect(phoneContactKey('12345@lid')).toBe('lid:12345');
    expect(phoneContactKey('1203@g.us')).toBeNull();
    expect(phoneContactKey(undefined)).toBeNull();
    expect(contactWaIdKey('5511999990000')).toBe('5511999990000');
    expect(contactWaIdKey('12345@lid')).toBe('lid:12345');
  });
  it('só a sincronização da agenda (campo name) conta; pushName/notify não marca como salvo', () => {
    const e = phoneContactEntries([
      { id: '5511911110000@s.whatsapp.net', name: 'Cliente Salvo', lid: '111@lid' },
      { id: '5511922220000@s.whatsapp.net', name: undefined }, // apagado da agenda
      { id: '5511933330000@s.whatsapp.net', notify: 'Nome do perfil' } as any, // só pushName
    ]);
    expect(e.get('5511911110000')).toBe(true);
    expect(e.get('lid:111')).toBe(true);
    expect(e.get('5511922220000')).toBe(false);
    expect(e.has('5511933330000')).toBe(false);
  });
  it('cache com validade (lista de aparelhos / reenvios)', async () => {
    const c = new TtlCache(30, 2);
    c.set('a', 1); c.set('b', 2); c.set('c', 3);
    expect(c.get('a')).toBeUndefined(); // limite de tamanho
    expect(await c.mget(['b', 'c'])).toEqual({ b: 2, c: 3 });
    await new Promise((r) => setTimeout(r, 40));
    expect(c.get('b')).toBeUndefined(); // venceu
  });
});
