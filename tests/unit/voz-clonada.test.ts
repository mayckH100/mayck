import { describe, it, expect, vi, afterEach } from 'vitest';
import { createHash, createHmac } from 'node:crypto';
import { extractClipMarker, toVoiceNote } from '../../server/ai/voice/clips.js';
import { signRequest, HttpVoiceWorker } from '../../server/ai/voice/clone/worker.js';
import { consentText, readingScript, CONSENT_VERSION, textHash } from '../../server/ai/voice/clone/service.js';
import { encryptBytes, decryptBytes } from '../../server/lib/crypto.js';
import { isOggOpus, pcmToOggOpus } from '../../server/ai/voice/ogg.js';
import { buildTts, sttEngineOf } from '../../server/ai/voice/providers.js';
import { wav } from '../vozHelpers.js';


describe('v1.47.0 voz clonada e biblioteca — funções puras', () => {
  it('marcador [AUDIO:id]: tira do texto e devolve o primeiro id', () => {
    expect(extractClipMarker('[AUDIO:clip123abc] Qualquer dúvida me chama!')).toEqual({ text: 'Qualquer dúvida me chama!', clipId: 'clip123abc' });
    expect(extractClipMarker('Oi [audio: abc12345] e [AUDIO:zzz99999]')).toEqual({ text: 'Oi e', clipId: 'abc12345' });
    expect(extractClipMarker('sem marcador')).toEqual({ text: 'sem marcador', clipId: null });
    expect(extractClipMarker('[AUDIO:clip123abc]')).toEqual({ text: '', clipId: 'clip123abc' });
  });

  it('WAV vira OGG/Opus com duração; OGG passa direto; lixo é recusado', () => {
    const n = toVoiceNote(wav(2));
    expect(isOggOpus(n.ogg)).toBe(true);
    expect(n.seconds).toBeCloseTo(2, 1);
    expect(n.waveform?.length).toBe(64);
    const ogg = pcmToOggOpus({ samples: new Int16Array(24000), rate: 24000 }).ogg;
    expect(toVoiceNote(ogg).ogg).toBe(ogg);
    expect(() => toVoiceNote(Buffer.from('não é áudio nenhum, só texto'))).toThrow(/Formato não aceito/);
    expect(() => toVoiceNote(Buffer.alloc(0))).toThrow(/vazio/);
  });

  it('assinatura HMAC do servidor de voz: ts.nonce.MÉTODO.caminho.sha256(corpo)', () => {
    const secret = 'x'.repeat(40);
    const s = signRequest(secret, 'post', '/v1/tts', '{"a":1}', 1700000000, 'abcdef0123456789');
    const expected = createHmac('sha256', secret).update(`1700000000.abcdef0123456789.POST./v1/tts.${createHash('sha256').update('{"a":1}').digest('hex')}`).digest('hex');
    expect(s).toEqual({ ts: '1700000000', nonce: 'abcdef0123456789', sig: expected });
    expect(signRequest(secret, 'POST', '/v1/tts', '{"a":2}', 1700000000, 'abcdef0123456789').sig).not.toBe(expected);
    // Dois pedidos iguais no mesmo segundo têm assinaturas diferentes (nonce aleatório): o anti-replay não barra a consulta da fila.
    expect(signRequest(secret, 'GET', '/v1/jobs/x', '', 1700000000).sig).not.toBe(signRequest(secret, 'GET', '/v1/jobs/x', '', 1700000000).sig);
  });

  it('amostra cifrada (AES-256-GCM) só abre com a mesma chave e o mesmo contexto', () => {
    const plain = Buffer.from('amostra de voz');
    const enc = encryptBytes(plain, undefined, 'org1:p1');
    expect(enc.includes(plain)).toBe(false);
    expect(decryptBytes(enc, undefined, 'org1:p1').equals(plain)).toBe(true);
    expect(() => decryptBytes(enc, undefined, 'org2:p1')).toThrow();
  });

  it('termo LGPD e roteiro de leitura com o nome do dono e da empresa', () => {
    const t = consentText({ ownerName: 'Maria Souza', company: 'Loja X' });
    expect(t).toContain('Maria Souza');
    expect(t).toContain('Loja X');
    expect(t).toContain('art. 11');
    expect(t).toContain(CONSENT_VERSION);
    expect(t).toMatch(/revogar/);
    expect(readingScript('Maria Souza', 'Loja X').split('\n')[0]).toMatch(/^Eu, Maria Souza, autorizo a Loja X/);
    expect(textHash('p1', ' oi ')).toBe(textHash('p1', 'oi'));
    expect(textHash('p1', 'oi')).not.toBe(textHash('p2', 'oi'));
  });

  it('motor "clone" exige voz ativa; transcrição nunca usa o clone', () => {
    const k = { provider: 'gemini', model: 'm', apiKey: 'k', voiceApiKey: null };
    expect(() => buildTts('clone', k)).toThrow(/voz clonada/i);
    expect(buildTts('clone', { ...k, orgId: 'o', cloneProfileId: 'p' }).usageProvider).toBe('clone');
    expect(sttEngineOf('clone', 'gemini')).toBe('gemini');
  });
});


describe('v1.51.3 servidor de voz no Hugging Face Space privado', () => {
  afterEach(() => { vi.unstubAllGlobals(); });
  const secret = 'x'.repeat(40);
  it('com token HF manda Authorization Bearer na saúde e nos pedidos assinados; sem token, não manda', async () => {
    const seen: Array<Record<string, string>> = [];
    vi.stubGlobal('fetch', async (_url: string, init: any) => { seen.push({ ...(init?.headers ?? {}) }); return new Response(JSON.stringify({ ok: true, ready: true, queue: 0, status: 'queued' }), { status: 200 }); });
    const w = new HttpVoiceWorker('https://mck-voz.hf.space', secret, 'hf_teste123');
    expect((await w.health()).ready).toBe(true);
    await w.job('abc');
    expect(seen[0].authorization).toBe('Bearer hf_teste123');
    expect(seen[1].authorization).toBe('Bearer hf_teste123');
    expect(seen[1]['x-mck-sig']).toMatch(/^[0-9a-f]{64}$/);
    const w2 = new HttpVoiceWorker('https://mck-voz.hf.space', secret, '');
    await w2.health(); await w2.job('abc');
    expect(seen[2].authorization).toBeUndefined();
    expect(seen[3].authorization).toBeUndefined();
  });

  it('Space acordando (503) ou acesso recusado (401) vira "fora do ar" (tenta de novo); voz ausente segue voice_missing', async () => {
    const respostas = [new Response('{}', { status: 503 }), new Response(JSON.stringify({ error: 'assinatura inválida' }), { status: 401 }), new Response(JSON.stringify({ error: 'x', code: 'voice_missing' }), { status: 404 }), new Response('{}', { status: 404 })];
    vi.stubGlobal('fetch', async () => respostas.shift()!);
    const w = new HttpVoiceWorker('https://mck-voz.hf.space', secret, 'hf_teste123');
    await expect(w.job('a')).rejects.toMatchObject({ code: 'down', status: 503 });
    await expect(w.job('b')).rejects.toMatchObject({ code: 'down', status: 401 });
    expect(await w.tts('vozteste123', 'oi')).toEqual({ missing: true });
    await expect(w.job('c')).rejects.toMatchObject({ code: 'down', status: 404 });
  });
});
