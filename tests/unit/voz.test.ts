import { describe, it, expect, afterEach } from 'vitest';
import { cleanForSpeech, splitForVoice, decideReplyAsAudio, estimateSpeechSeconds, isAudioType, openAiVoiceFor } from '../../server/ai/voice/spoken.js';
import { pcmToOggOpus, oggCrc, isOggOpus, oggOpusDurationSec, decodePcm, buildOggOpus, waveform } from '../../server/ai/voice/ogg.js';
import {
  pickGeminiTtsModel, geminiTtsBody, geminiAudioOf, sttEngineOf, buildTts, buildStt, elevenTtsBody,
  ElevenLabsVoice, OpenAiVoice, openAiTranscribeModel, FakeVoice, DEFAULT_GEMINI_TTS_MODEL,
} from '../../server/ai/voice/providers.js';
import { setFetch, resetFetch } from '../../server/lib/fetcher.js';

const sine = (seconds: number, rate = 24000) => {
  const s = new Int16Array(Math.round(seconds * rate));
  for (let i = 0; i < s.length; i++) s[i] = Math.round(8000 * Math.sin((2 * Math.PI * 300 * i) / rate));
  return s;
};

/** Confere todas as páginas Ogg: assinatura, CRC, sequência e flags. */
function checkOggPages(buf: Buffer) {
  let off = 0;
  let seq = 0;
  const pages: { flags: number; granule: bigint }[] = [];
  while (off < buf.length) {
    expect(buf.toString('ascii', off, off + 4)).toBe('OggS');
    const nseg = buf[off + 26];
    let len = 27 + nseg;
    for (let i = 0; i < nseg; i++) len += buf[off + 27 + i];
    const page = Buffer.from(buf.subarray(off, off + len));
    const crc = page.readUInt32LE(22);
    page.writeUInt32LE(0, 22);
    expect(oggCrc(page)).toBe(crc);
    expect(page.readUInt32LE(18)).toBe(seq++);
    pages.push({ flags: page[5], granule: page.readBigInt64LE(6) });
    off += len;
  }
  expect(off).toBe(buf.length);
  return pages;
}

describe('Voz da IA — texto falado', () => {
  it('limpa markdown, emojis, marcadores e links para a fala', () => {
    const t = cleanForSpeech('**Olá!** 😀 Temos _3 planos_:\n- Básico\n- Pro\n# Título\nVeja `aqui` https://x.com/a');
    expect(t).not.toMatch(/[*_#`😀]/u);
    expect(t).not.toContain('https://');
    expect(t).toContain('Olá!');
    expect(t).toContain('Básico.');
    expect(t).toContain('Pro.');
  });

  it('tira marcadores internos da IA ([AGENDAR], [ETAPA]...)', () => {
    expect(cleanForSpeech('Combinado! [ETAPA:Proposta] Até logo')).toBe('Combinado! Até logo.');
  });

  it('links e listas de preços vão por escrito depois do áudio', () => {
    const a = splitForVoice('Claro! Pode pagar pelo link: https://pag.example/abc\nQualquer dúvida me chama.');
    expect(a.extra).toContain('https://pag.example/abc');
    expect(a.spoken).not.toContain('https');
    expect(a.spoken).toContain('aqui embaixo');
    const b = splitForVoice('Nossos planos:\n1. Básico R$ 22,00\n2. Pro R$ 30,00\n3. Combo R$ 45,00\nQual combina com você?');
    expect(b.extra.split('\n')).toHaveLength(3);
    expect(b.spoken).toContain('Qual combina com você?');
    expect(b.spoken).not.toContain('R$');
    // Lista curta sem preço continua falada.
    const c = splitForVoice('Temos:\n- entrega\n- retirada');
    expect(c.extra).toBe('');
    expect(c.spoken).toContain('entrega');
  });

  it('e-mail não é lido em voz alta', () => {
    const r = splitForVoice('Mande para contato@empresa.com.br que a gente responde.');
    expect(r.extra).toContain('contato@empresa.com.br');
    expect(r.spoken).not.toContain('@');
  });

  it('estima a duração da fala e reconhece áudio', () => {
    expect(estimateSpeechSeconds('a'.repeat(140))).toBe(10);
    expect(isAudioType('audio')).toBe(true);
    expect(isAudioType('ptt')).toBe(true);
    expect(isAudioType('text')).toBe(false);
    expect(openAiVoiceFor('Puck')).toBe('ash');
    expect(openAiVoiceFor('Kore')).toBe('coral');
  });
});

describe('Voz da IA — quando responder em áudio', () => {
  const s = (voiceEnabled: boolean, voiceReplyMode: string) => ({ voiceEnabled, voiceReplyMode });
  it('espelhar: áudio responde áudio, texto responde texto', () => {
    expect(decideReplyAsAudio(s(true, 'espelhar'), true)).toBe(true);
    expect(decideReplyAsAudio(s(true, 'espelhar'), false)).toBe(false);
  });
  it('sempre_audio e nunca_audio', () => {
    expect(decideReplyAsAudio(s(true, 'sempre_audio'), false)).toBe(true);
    expect(decideReplyAsAudio(s(true, 'nunca_audio'), true)).toBe(false);
  });
  it('voz desligada ou modo desconhecido', () => {
    expect(decideReplyAsAudio(s(false, 'sempre_audio'), true)).toBe(false);
    expect(decideReplyAsAudio(null, true)).toBe(false);
    expect(decideReplyAsAudio(s(true, 'xyz'), true)).toBe(true); // cai no espelhar
  });
});

describe('Voz da IA — PCM → OGG/Opus (sem ffmpeg)', () => {
  it('gera Ogg/Opus válido: OggS, OpusHead, OpusTags, CRC, EOS e duração', () => {
    const r = pcmToOggOpus({ samples: sine(1.5), rate: 24000 });
    expect(r.ogg.toString('ascii', 0, 4)).toBe('OggS');
    expect(r.ogg.toString('ascii', 28, 36)).toBe('OpusHead');
    expect(r.ogg.indexOf('OpusTags')).toBeGreaterThan(0);
    expect(isOggOpus(r.ogg)).toBe(true);
    const head = r.ogg.indexOf('OpusHead');
    expect(r.ogg[head + 9]).toBe(1); // mono
    expect(r.ogg.readUInt32LE(head + 12)).toBe(24000);
    const pages = checkOggPages(r.ogg);
    expect(pages[0].flags & 0x02).toBe(2); // início do fluxo
    expect(pages[pages.length - 1].flags & 0x04).toBe(4); // fim do fluxo
    expect(oggOpusDurationSec(r.ogg)).toBeCloseTo(1.5, 1);
    expect(r.seconds).toBeCloseTo(1.5, 2);
    expect(r.waveform).toHaveLength(64);
    expect(Math.max(...r.waveform)).toBe(100);
    // Voz de ~1,5 s a 24 kbps fica bem abaixo de 512 KB (limite do play automático no WhatsApp).
    expect(r.ogg.length).toBeLessThan(20000);
  });

  it('aceita WAV (Gemini 3.8 devolve WAV) e taxa fora do Opus (reamostra)', () => {
    const pcm = sine(0.5, 22050);
    const data = Buffer.from(pcm.buffer);
    const wav = Buffer.alloc(44 + data.length);
    wav.write('RIFF', 0); wav.writeUInt32LE(36 + data.length, 4); wav.write('WAVE', 8);
    wav.write('fmt ', 12); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(22050, 24); wav.writeUInt32LE(44100, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
    wav.write('data', 36); wav.writeUInt32LE(data.length, 40); data.copy(wav, 44);
    const d = decodePcm(wav, 'audio/wav');
    expect(d.rate).toBe(22050);
    expect(d.samples.length).toBe(pcm.length);
    const r = pcmToOggOpus(d);
    expect(isOggOpus(r.ogg)).toBe(true);
    expect(oggOpusDurationSec(r.ogg)).toBeCloseTo(0.5, 1);
    // PCM cru com a taxa no mime.
    expect(decodePcm(Buffer.alloc(100), 'audio/L16;codec=pcm;rate=16000').rate).toBe(16000);
  });

  it('Ogg sem pacotes e forma de onda de silêncio', () => {
    const empty = buildOggOpus([], { inputRate: 24000 });
    expect(empty.toString('ascii', 0, 4)).toBe('OggS');
    expect(Array.from(waveform(new Int16Array(0)))).toHaveLength(64);
    expect(isOggOpus(Buffer.from('não é áudio nenhum, só texto qualquer aqui dentro para o teste'))).toBe(false);
  });
});

describe('Voz da IA — motores', () => {
  afterEach(() => resetFetch());

  it('escolhe o modelo TTS do Gemini (3.8 Flash-Lite; nunca pro)', () => {
    expect(pickGeminiTtsModel([], {})).toBe(DEFAULT_GEMINI_TTS_MODEL);
    expect(pickGeminiTtsModel(['gemini-3.8-flash-lite-tts', 'gemini-3.8-flash-tts'], {})).toBe('gemini-3.8-flash-lite-tts');
    expect(pickGeminiTtsModel(['gemini-2.5-pro-preview-tts', 'gemini-2.5-flash-preview-tts', 'gemini-3.5-flash-lite'], {})).toBe('gemini-2.5-flash-preview-tts');
    expect(pickGeminiTtsModel(['gemini-3.8-flash-tts'], { GEMINI_TTS_MODEL: 'meu-modelo' })).toBe('meu-modelo');
  });

  it('corpo do pedido: formato 3.8 (speech_metadata) e antigo (prebuiltVoiceConfig)', () => {
    const novo: any = geminiTtsBody('gemini-3.8-flash-lite-tts', 'Oi', 'Kore', 'calorosa');
    expect(novo.contents[0].parts[0]).toEqual({ text: 'Oi', speech_metadata: { style: 'calorosa' } });
    expect(novo.generationConfig.speechConfig.voiceConfig.voice).toBe('Kore');
    const antigo: any = geminiTtsBody('gemini-2.5-flash-preview-tts', 'Oi', 'Puck', 'calorosa');
    expect(antigo.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName).toBe('Puck');
    expect(antigo.contents[0].parts[0].text).toContain('Oi');
    expect(() => geminiAudioOf({ candidates: [{ finishReason: 'STOP', content: { parts: [] } }] })).toThrow(/não devolveu áudio/);
    expect(geminiAudioOf({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/wav', data: Buffer.from('xx').toString('base64') } }] } }] }).mime).toBe('audio/wav');
  });

  it('transcrição "auto" segue a IA de texto; escolha explícita vale', () => {
    expect(sttEngineOf('auto', 'gemini')).toBe('gemini');
    expect(sttEngineOf('auto', 'openai')).toBe('openai');
    expect(sttEngineOf('auto', 'mck')).toBe('mck');
    expect(sttEngineOf('elevenlabs', 'gemini')).toBe('elevenlabs');
    expect(sttEngineOf('openai', 'fake')).toBe('fake');
    expect(openAiTranscribeModel('https://api.groq.com/openai/v1')).toBe('whisper-large-v3-turbo');
    expect(openAiTranscribeModel('https://api.openai.com/v1')).toBe('gpt-4o-mini-transcribe');
  });

  it('cada motor exige a própria chave (mensagem clara, sem chamar a rede)', () => {
    const k = { provider: 'gemini', model: 'gemini-3.5-flash-lite', apiKey: 'AIza-teste-123', baseUrl: null, voiceApiKey: null };
    expect(buildTts('gemini', k).usageProvider).toBe('gemini');
    expect(() => buildTts('elevenlabs', k)).toThrow(/ElevenLabs/);
    expect(() => buildTts('openai', k)).toThrow(/OpenAI/);
    expect(buildTts('elevenlabs', { ...k, voiceApiKey: 'sk_eleven_teste' }).usageProvider).toBe('elevenlabs');
    expect(() => buildTts('gemini', { ...k, provider: 'openai' })).toThrow(/Gemini/);
    expect(buildStt('elevenlabs', { ...k, voiceApiKey: 'sk_eleven_teste' }).usageProvider).toBe('elevenlabs');
    // Testes: o provedor fake cobre todos os motores.
    const fake = buildTts('openai', { ...k, provider: 'fake' });
    expect(fake.p).toBeInstanceOf(FakeVoice);
    expect(fake.usageProvider).toBe('openai');
  });

  it('ElevenLabs (HTTP simulado): voz em pcm_24000 vira OGG/Opus, vozes da conta e transcrição scribe_v2', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const pcm = Buffer.from(sine(0.6).buffer);
    setFetch(async (input, init) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.includes('/v1/text-to-speech/')) return new Response(new Uint8Array(pcm), { status: 200, headers: { 'content-type': 'audio/pcm' } });
      if (url.endsWith('/v1/voices')) return new Response(JSON.stringify({ voices: [{ voice_id: 'abcDEF123456', name: 'Camila', labels: { gender: 'female', accent: 'brazilian' }, preview_url: 'https://x/p.mp3' }, { voice_id: 'xyzXYZ987654', name: 'Rafael', labels: { gender: 'male' } }] }), { status: 200 });
      if (url.endsWith('/v1/speech-to-text')) return new Response(JSON.stringify({ language_code: 'por', text: ' quanto custa o plano? ' }), { status: 200 });
      return new Response('{}', { status: 404 });
    });
    const el = new ElevenLabsVoice('sk_eleven_teste');
    const t = await el.tts('Oi, tudo bem?', { voice: 'abcDEF123456', style: '', model: 'eleven_flash_v2_5' });
    expect(isOggOpus(t.ogg)).toBe(true);
    expect(t.seconds).toBeCloseTo(0.6, 1);
    expect(t.model).toBe('eleven_flash_v2_5');
    expect(calls[0].url).toBe('https://api.elevenlabs.io/v1/text-to-speech/abcDEF123456?output_format=pcm_24000');
    expect((calls[0].init?.headers as any)['xi-api-key']).toBe('sk_eleven_teste');
    expect(JSON.parse(String(calls[0].init?.body))).toMatchObject({ model_id: 'eleven_flash_v2_5', language_code: 'pt' });
    const voices = await el.voices();
    expect(voices[0]).toMatchObject({ id: 'abcDEF123456', genero: 'feminina' });
    expect(voices[0].label).toContain('Camila');
    expect(voices[1].genero).toBe('masculina');
    const tr = await el.transcribe(Buffer.from('ogg'), 'audio/ogg; codecs=opus');
    expect(tr.text).toBe('quanto custa o plano?');
    expect(tr.model).toBe('scribe_v2');
    const form = calls.find((c) => c.url.endsWith('/speech-to-text'))!.init!.body as FormData;
    expect(form.get('model_id')).toBe('scribe_v2');
    await expect(el.tts('Oi', { voice: '', style: '' })).rejects.toThrow(/Escolha uma voz/);
    expect(elevenTtsBody('x', 'qualquer').model_id).toBe('eleven_multilingual_v2');
    expect(elevenTtsBody('x', 'eleven_multilingual_v2')).not.toHaveProperty('language_code');
  });

  it('ElevenLabs: chave recusada vira erro claro', async () => {
    setFetch(async () => new Response(JSON.stringify({ detail: { message: 'Invalid API key' } }), { status: 401 }));
    await expect(new ElevenLabsVoice('sk_ruim').voices()).rejects.toThrow(/recusada/);
  });

  it('OpenAI (HTTP simulado): gpt-4o-mini-tts com voz e instruções, response_format opus; whisper na transcrição', async () => {
    const ogg = pcmToOggOpus({ samples: sine(0.8), rate: 24000 }).ogg;
    const calls: { url: string; init?: RequestInit }[] = [];
    setFetch(async (input, init) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.endsWith('/audio/speech')) return new Response(new Uint8Array(ogg), { status: 200, headers: { 'content-type': 'audio/ogg' } });
      if (url.endsWith('/audio/transcriptions')) return new Response(JSON.stringify({ text: 'bom dia' }), { status: 200 });
      return new Response('{}', { status: 404 });
    });
    const o = new OpenAiVoice('sk-openai-teste');
    const t = await o.tts('Bom dia!', { voice: 'sage', style: 'calma' });
    expect(t.model).toBe('gpt-4o-mini-tts');
    expect(t.seconds).toBeCloseTo(0.8, 1);
    const body = JSON.parse(String(calls[0].init?.body));
    expect(body).toMatchObject({ model: 'gpt-4o-mini-tts', voice: 'sage', response_format: 'opus', instructions: 'calma' });
    // Voz de outro motor (ex.: "Kore") vira uma voz equivalente da OpenAI.
    await o.tts('Oi', { voice: 'Kore', style: '' });
    expect(JSON.parse(String(calls[1].init?.body)).voice).toBe('coral');
    expect((await o.transcribe(Buffer.from('x'), 'audio/ogg')).text).toBe('bom dia');
  });

  it('OpenAI: resposta que não é Ogg/Opus é recusada', async () => {
    setFetch(async () => new Response(new Uint8Array([0xff, 0xfb, 1, 2, 3]), { status: 200 }));
    await expect(new OpenAiVoice('sk-openai-teste').tts('Oi', { voice: 'nova', style: '' })).rejects.toThrow(/OGG/);
  });
});
