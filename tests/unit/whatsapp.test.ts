import { describe, it, expect, afterEach } from 'vitest';
import { verifyHubSignature } from '../../server/whatsapp/signature.js';
import { parseWebhook, buildGraphBody, sendCloudMessage } from '../../server/whatsapp/cloudClient.js';
import { hmacSha256Hex } from '../../server/lib/crypto.js';
import { setFetch, resetFetch } from '../../server/lib/fetcher.js';
import { isPrivateAddress, assertPublicUrl } from '../../server/lib/ssrf.js';
import { inboundPayload, statusPayload } from '../helpers.js';

afterEach(() => resetFetch());

describe('Assinatura X-Hub-Signature-256', () => {
  const body = Buffer.from('{"a":1}');
  it('aceita assinatura correta', () => {
    expect(verifyHubSignature(body, 'sha256=' + hmacSha256Hex('seg', body), 'seg')).toBe(true);
  });
  it('rejeita assinatura errada, ausente ou malformada', () => {
    expect(verifyHubSignature(body, 'sha256=' + hmacSha256Hex('outro', body), 'seg')).toBe(false);
    expect(verifyHubSignature(body, undefined, 'seg')).toBe(false);
    expect(verifyHubSignature(body, 'md5=abc', 'seg')).toBe(false);
  });
});

describe('Parsing do webhook', () => {
  it('extrai mensagens de texto, respostas interativas e status', () => {
    const p = inboundPayload('123', '5511999990000', 'Oi', { id: 'wamid.A', name: 'Ana' });
    const r = parseWebhook(p.body);
    expect(r.messages[0]).toMatchObject({ waMessageId: 'wamid.A', from: '5511999990000', text: 'Oi', profileName: 'Ana', phoneNumberId: '123' });
    const i = parseWebhook(inboundPayload('123', '55', 'Suporte', { replyId: 'opt1' }).body);
    expect(i.messages[0]).toMatchObject({ type: 'interactive', text: 'Suporte', replyId: 'opt1' });
    const s = parseWebhook(statusPayload('123', 'wamid.X', 'delivered'));
    expect(s.statuses[0]).toMatchObject({ waMessageId: 'wamid.X', status: 'delivered' });
  });
  it('ignora objetos que não são do WhatsApp', () => {
    expect(parseWebhook({ object: 'page' })).toEqual({ messages: [], statuses: [] });
  });
});

describe('Cliente da Cloud API', () => {
  it('monta corpos de texto, mídia, botões e modelo', () => {
    expect(buildGraphBody('55', { type: 'text', text: 'oi' })).toMatchObject({ messaging_product: 'whatsapp', to: '55', type: 'text', text: { body: 'oi' } });
    expect(buildGraphBody('55', { type: 'image', link: 'https://x/y.png', caption: 'c' })).toMatchObject({ type: 'image', image: { link: 'https://x/y.png', caption: 'c' } });
    const b = buildGraphBody('55', { type: 'buttons', text: 't', buttons: [1, 2, 3, 4].map((n) => ({ id: `b${n}`, title: `Botão ${n}` })) }) as any;
    expect(b.interactive.action.buttons).toHaveLength(3);
    expect(buildGraphBody('55', { type: 'template', name: 'hello_world', language: 'pt_BR' })).toMatchObject({ type: 'template', template: { name: 'hello_world', language: { code: 'pt_BR' } } });
  });
  it('repete em 5xx e devolve o id da Meta', async () => {
    let n = 0;
    setFetch(async () => (++n < 3 ? new Response('{}', { status: 503 }) : new Response(JSON.stringify({ messages: [{ id: 'wamid.OK' }] }), { status: 200 })));
    const r = await sendCloudMessage({ phoneNumberId: '1', accessToken: 't' }, '55', { type: 'text', text: 'x' }, { baseDelayMs: 1 });
    expect(r).toEqual({ waMessageId: 'wamid.OK', attempts: 3 });
  });
  it('não repete em erro 4xx (exceto 429)', async () => {
    let n = 0;
    setFetch(async () => { n++; return new Response(JSON.stringify({ error: { message: 'Token inválido' } }), { status: 401 }); });
    await expect(sendCloudMessage({ phoneNumberId: '1', accessToken: 't' }, '55', { type: 'text', text: 'x' }, { baseDelayMs: 1 })).rejects.toThrow('Token inválido');
    expect(n).toBe(1);
  });
  it('desiste após o máximo de tentativas em falha de rede', async () => {
    let n = 0;
    setFetch(async () => { n++; throw new Error('ECONNRESET'); });
    await expect(sendCloudMessage({ phoneNumberId: '1', accessToken: 't' }, '55', { type: 'text', text: 'x' }, { baseDelayMs: 1, maxAttempts: 3 })).rejects.toThrow(/Falha de rede/);
    expect(n).toBe(3);
  });
});

describe('Proteção SSRF', () => {
  it('identifica endereços privados', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.0.1', '172.16.5.5', '169.254.169.254', '::1', '::ffff:127.0.0.1', 'fd00::1']) expect(isPrivateAddress(ip)).toBe(true);
    for (const ip of ['8.8.8.8', '172.32.0.1', '2001:4860::8888']) expect(isPrivateAddress(ip)).toBe(false);
  });
  it('bloqueia localhost, IP interno e protocolos não HTTP', async () => {
    await expect(assertPublicUrl('http://localhost:3000/x', false)).rejects.toThrow(/interno/);
    await expect(assertPublicUrl('http://169.254.169.254/latest', false)).rejects.toThrow(/interno/);
    await expect(assertPublicUrl('file:///etc/passwd', false)).rejects.toThrow(/http/);
    await expect(assertPublicUrl('http://93.184.216.34/', false)).resolves.toBeInstanceOf(URL);
  });
});
