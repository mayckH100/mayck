import { describe, it, expect } from 'vitest';
import { parseBaileysMessage, buildQrContent, mapBaileysStatus, waIdToJid, jidToNumber, numberedOptions } from '../../server/whatsapp/qr/parse.js';
import { backoffDelay } from '../../server/whatsapp/qr/manager.js';

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
