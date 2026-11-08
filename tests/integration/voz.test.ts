import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { registerClient, createTestChannel, installGraphMock, graph, prisma, uniq, type Client } from '../helpers.js';
import { handleInboundMessage, handleQrMessage } from '../../server/whatsapp/inbound.js';
import { qrManager, type QrSocket } from '../../server/whatsapp/qr/manager.js';
import { fakeVoice } from '../../server/ai/voice/providers.js';
import { isOggOpus } from '../../server/ai/voice/ogg.js';
import type { AnyMessageContent } from '@whiskeysockets/baileys';

const HORARIO = 'segunda a sexta, das 9h às 18h';
const binary = (res: any, cb: (e: Error | null, b: Buffer) => void) => { const chunks: Buffer[] = []; res.on('data', (c: Buffer) => chunks.push(c)); res.on('end', () => cb(null, Buffer.concat(chunks))); };

describe('Voz da IA — ouvir e responder com áudio no WhatsApp', () => {
  let owner: Client;
  let ctx: Awaited<ReturnType<typeof createTestChannel>>;
  let phone = 5511755000000;
  const nextPhone = () => String(++phone);
  const audio = (from: string, falado: string) => handleInboundMessage(
    ctx.ch,
    { phoneNumberId: ctx.phoneNumberId, waMessageId: `wamid.AUD${uniq()}`, from, timestamp: new Date(), type: 'audio', text: '', mediaId: 'media-in-1' },
    async () => ({ dados: Buffer.from(falado), nome: 'audio.ogg', mime: 'audio/ogg; codecs=opus', segundos: 4 }),
  );
  const texto = (from: string, t: string) => handleInboundMessage(ctx.ch, { phoneNumberId: ctx.phoneNumberId, waMessageId: `wamid.TXT${uniq()}`, from, timestamp: new Date(), type: 'text', text: t });
  const sends = () => graph.calls.filter((c) => c.url.endsWith('/messages') && c.body);
  const uploads = () => graph.calls.filter((c) => c.url.endsWith('/media'));
  const convOf = async (p: string) => {
    const contact = await prisma.contact.findUniqueOrThrow({ where: { orgId_waId: { orgId: owner.me.org.id, waId: p } } });
    return prisma.conversation.findFirstOrThrow({ where: { contactId: contact.id } });
  };
  const setVoice = async (data: Record<string, unknown>) => expect((await owner.put('/api/ai/settings', data)).status).toBe(200);

  beforeAll(async () => {
    installGraphMock();
    owner = await registerClient();
    ctx = await createTestChannel(owner.me.org.id);
    await prisma.channel.update({ where: { id: ctx.ch.id }, data: { autoReplyMode: 'ai' } });
    await owner.post('/api/ai/knowledge', { title: 'Horário', content: `Nosso horário de atendimento é de ${HORARIO}.` });
    expect((await owner.put('/api/ai/settings', { provider: 'fake', model: 'fake-1', enabled: true, autoReply: true })).status).toBe(200);
  });
  beforeEach(async () => {
    graph.reset();
    fakeVoice.tts = []; fakeVoice.engines = []; fakeVoice.voices = []; fakeVoice.failTts = false;
    await setVoice({ voiceEnabled: false, voiceReplyMode: 'espelhar', voiceProvider: 'gemini', voiceName: 'Kore', transcribeAudio: true, transcribeProvider: 'auto' });
  });
  afterAll(() => qrManager.resetForTests());

  it('padrões: voz desligada, espelhar, Gemini/Kore, 45 s, transcrição ligada (auto); chave nunca volta', async () => {
    const other = await registerClient();
    const r = await other.get('/api/ai/settings');
    expect(r.body).toMatchObject({ voiceEnabled: false, voiceReplyMode: 'espelhar', voiceProvider: 'gemini', voiceName: 'Kore', voiceMaxSeconds: 45, transcribeAudio: true, transcribeProvider: 'auto', hasVoiceApiKey: false });
    expect(r.body).not.toHaveProperty('voiceApiKeyEnc');
  });

  it('áudio recebido é transcrito, aparece na mensagem e a IA responde ao que foi dito (voz desligada = texto)', async () => {
    const p = nextPhone();
    expect(await audio(p, 'FAKE:qual o horário de atendimento?')).toBe('ok');
    const conv = await convOf(p);
    const inbound = await prisma.message.findFirstOrThrow({ where: { conversationId: conv.id, direction: 'IN' } });
    expect(inbound.type).toBe('audio');
    expect(inbound.transcript).toBe('qual o horário de atendimento?');
    expect(sends()).toHaveLength(1);
    expect(sends()[0].body.type).toBe('text');
    expect(sends()[0].body.text.body).toContain(HORARIO);
    expect(await prisma.aiUsage.count({ where: { orgId: owner.me.org.id, model: 'transcricao:fake-stt', success: true } })).toBeGreaterThan(0);
    // O Inbox recebe a transcrição junto com a mensagem.
    const d = await owner.get(`/api/conversations/${conv.id}`);
    expect(d.body.messages.find((m: any) => m.direction === 'IN').transcript).toBe('qual o horário de atendimento?');
  });

  it('espelhar: áudio responde com nota de voz (upload OGG + voice:true); texto responde com texto', async () => {
    await setVoice({ voiceEnabled: true, voiceReplyMode: 'espelhar' });
    const p = nextPhone();
    await audio(p, 'FAKE:qual o horário de atendimento?');
    expect(uploads()).toHaveLength(1);
    expect(sends()).toHaveLength(1);
    expect(sends()[0].body).toMatchObject({ type: 'audio', audio: { voice: true } });
    expect(sends()[0].body.audio.id).toMatch(/^media-/);
    expect(fakeVoice.engines).toContain('tts:gemini');
    expect(fakeVoice.tts[0]).toContain(HORARIO);
    const conv = await convOf(p);
    const out = await prisma.message.findFirstOrThrow({ where: { conversationId: conv.id, direction: 'OUT' } });
    expect(out).toMatchObject({ type: 'audio', sender: 'ai', status: 'SENT' });
    expect(out.transcript).toContain(HORARIO);
    expect(await prisma.aiUsage.count({ where: { orgId: owner.me.org.id, model: 'voz:fake-tts', success: true } })).toBeGreaterThan(0);
    graph.reset();
    await texto(p, 'qual o horário de atendimento?');
    expect(uploads()).toHaveLength(0);
    expect(sends()[0].body.type).toBe('text');
  });

  it('sempre_audio responde texto com áudio; nunca_audio responde áudio com texto', async () => {
    await setVoice({ voiceEnabled: true, voiceReplyMode: 'sempre_audio' });
    const p = nextPhone();
    await texto(p, 'qual o horário de atendimento?');
    expect(sends()[0].body.type).toBe('audio');
    graph.reset();
    await setVoice({ voiceReplyMode: 'nunca_audio' });
    await audio(p, 'FAKE:qual o horário de atendimento?');
    expect(uploads()).toHaveLength(0);
    expect(sends()[0].body.type).toBe('text');
    expect(sends()[0].body.text.body).toContain(HORARIO);
  });

  it('motor escolhido por organização: OpenAI com voz "sage" e ElevenLabs só com chave', async () => {
    await setVoice({ voiceEnabled: true, voiceReplyMode: 'sempre_audio', voiceProvider: 'openai', voiceName: 'sage' });
    const p = nextPhone();
    await texto(p, 'qual o horário de atendimento?');
    expect(fakeVoice.engines).toContain('tts:openai');
    expect(fakeVoice.voices).toContain('sage');
    expect(sends()[0].body.type).toBe('audio');
    // ElevenLabs sem chave: a resposta vai por texto (nunca fica sem resposta).
    graph.reset(); fakeVoice.engines = [];
    await setVoice({ voiceProvider: 'elevenlabs', voiceName: 'voz-teste-eleven-1' });
    await texto(p, 'qual o horário de atendimento?');
    expect(sends()[0].body.type).toBe('text');
    expect(fakeVoice.engines).not.toContain('tts:elevenlabs');
    // Com a chave salva (cifrada, nunca devolvida), sai em áudio.
    graph.reset();
    const r = await owner.put('/api/ai/settings', { voiceApiKey: 'sk_eleven_teste_123' });
    expect(r.body.hasVoiceApiKey).toBe(true);
    expect(JSON.stringify(r.body)).not.toContain('sk_eleven_teste_123');
    const saved = await prisma.aiSettings.findUniqueOrThrow({ where: { orgId: owner.me.org.id } });
    expect(saved.voiceApiKeyEnc).toBeTruthy();
    expect(saved.voiceApiKeyEnc).not.toContain('sk_eleven');
    await texto(p, 'qual o horário de atendimento?');
    expect(fakeVoice.engines).toContain('tts:elevenlabs');
    expect(sends()[0].body.type).toBe('audio');
    // Transcrição escolhida separadamente.
    await setVoice({ transcribeProvider: 'elevenlabs' });
    graph.reset(); fakeVoice.engines = [];
    await audio(p, 'FAKE:oi');
    expect(fakeVoice.engines).toContain('stt:elevenlabs');
    expect((await owner.put('/api/ai/settings', { clearVoiceApiKey: true })).body.hasVoiceApiKey).toBe(false);
  });

  it('falha na voz cai para o texto; resposta com link manda o link por escrito depois do áudio', async () => {
    await setVoice({ voiceEnabled: true, voiceReplyMode: 'sempre_audio', voiceProvider: 'gemini' });
    fakeVoice.failTts = true;
    const p = nextPhone();
    await texto(p, 'qual o horário de atendimento?');
    expect(sends()).toHaveLength(1);
    expect(sends()[0].body.type).toBe('text');
    fakeVoice.failTts = false;
    graph.reset();
    await owner.post('/api/ai/knowledge', { title: 'Pagamento', content: 'Pagamento pelo link https://pag.example.com/mck sempre.' });
    await texto(p, 'qual o link de pagamento?');
    const types = sends().map((c) => c.body.type);
    expect(types).toEqual(['audio', 'text']);
    expect(sends()[1].body.text.body).toContain('https://pag.example.com/mck');
    expect(fakeVoice.tts.at(-1)).not.toContain('https://');
  });

  it('áudio que não dá para ouvir: pede para escrever, com nota interna, sem responder "[audio]"', async () => {
    const p = nextPhone();
    await audio(p, 'FALHAR');
    expect(sends()).toHaveLength(1);
    expect(sends()[0].body.text.body).toMatch(/não consegui ouvir seu áudio/);
    const conv = await convOf(p);
    expect(await prisma.message.count({ where: { conversationId: conv.id, type: 'note', body: { contains: 'Áudio não transcrito' } } })).toBe(1);
    graph.reset();
    await audio(p, 'MUDO');
    expect(sends()[0].body.text.body).toMatch(/Não consegui entender/);
  });

  it('transcrição desligada: comportamento antigo (nada é transcrito)', async () => {
    await setVoice({ transcribeAudio: false });
    const before = fakeVoice.transcribed;
    const p = nextPhone();
    await audio(p, 'FAKE:qual o horário de atendimento?');
    expect(fakeVoice.transcribed).toBe(before);
    const conv = await convOf(p);
    expect((await prisma.message.findFirstOrThrow({ where: { conversationId: conv.id, direction: 'IN' } })).transcript).toBeNull();
  });

  it('conversa com atendente humano: transcreve para o Inbox, mas a IA não responde (nem em áudio)', async () => {
    await setVoice({ voiceEnabled: true, voiceReplyMode: 'sempre_audio' });
    const p = nextPhone();
    await texto(p, 'oi');
    const conv = await convOf(p);
    await prisma.conversation.update({ where: { id: conv.id }, data: { mode: 'HUMAN' } });
    graph.reset();
    await audio(p, 'FAKE:qual o horário de atendimento?');
    expect(sends()).toHaveLength(0);
    const last = await prisma.message.findFirstOrThrow({ where: { conversationId: conv.id, direction: 'IN' }, orderBy: { createdAt: 'desc' } });
    expect(last.transcript).toBe('qual o horário de atendimento?');
  });

  it('limite diário da IA atingido: não transcreve (cota respeitada) e pede para escrever', async () => {
    const p = nextPhone();
    await setVoice({ dailyLimit: 0 });
    const before = fakeVoice.transcribed;
    await audio(p, 'FAKE:oi');
    expect(fakeVoice.transcribed).toBe(before);
    expect(sends()[0].body.text.body).toMatch(/não consegui ouvir/);
    await setVoice({ dailyLimit: 200 });
  });

  it('modo QR: "gravando áudio..." e nota de voz com ptt, ogg/opus, duração e forma de onda', async () => {
    await setVoice({ voiceEnabled: true, voiceReplyMode: 'espelhar', voiceProvider: 'gemini' });
    const qr = await owner.post('/api/channels', { name: 'Celular voz' });
    const channelId = qr.body.id;
    await prisma.channel.update({ where: { id: channelId }, data: { status: 'CONNECTED', autoReplyMode: 'ai' } });
    const sent: { jid: string; content: AnyMessageContent }[] = [];
    const presence: string[] = [];
    let k = 0;
    const sock: QrSocket = {
      user: { id: '5511993195300:7@s.whatsapp.net' },
      async sendMessage(jid, content) { sent.push({ jid, content }); return { key: { id: `MV${++k}` } }; },
      async sendPresenceUpdate(type) { presence.push(type); },
      signalRepository: { lidMapping: { async getPNForLID() { return null; }, async getLIDForPN() { return null; } } },
    };
    qrManager.attachForTests(channelId, sock, 'CONNECTED');
    const raw = { key: { fromMe: false, id: `QAUD${uniq()}`, remoteJid: '5511981330001@s.whatsapp.net' }, pushName: 'Cliente', messageTimestamp: Math.floor(Date.now() / 1000), message: { audioMessage: { mimetype: 'audio/ogg; codecs=opus', seconds: 3, ptt: true } } } as any;
    // O download real do Baileys não existe no teste: o canal QR transcreve pelo mesmo caminho com o "baixar" do Baileys,
    // então simulamos a mesma mensagem pela função comum com o áudio já baixado.
    const ch = await prisma.channel.findUniqueOrThrow({ where: { id: channelId } });
    const m = { phoneNumberId: '', waMessageId: raw.key.id, from: '5511981330001', timestamp: new Date(), type: 'audio', text: '', mediaId: raw.key.id };
    expect(await handleInboundMessage(ch, m, async () => ({ dados: Buffer.from('FAKE:qual o horário de atendimento?'), nome: 'audio.ogg', mime: 'audio/ogg; codecs=opus', segundos: 3 }))).toBe('ok');
    expect(presence).toContain('recording');
    expect(presence.at(-1)).toBe('paused');
    expect(sent).toHaveLength(1);
    const c = sent[0].content as any;
    expect(c.ptt).toBe(true);
    expect(c.mimetype).toBe('audio/ogg; codecs=opus');
    expect(isOggOpus(c.audio)).toBe(true);
    expect(c.seconds).toBeGreaterThanOrEqual(1);
    expect(c.waveform).toHaveLength(64);
    // Mensagem de áudio do Baileys é reconhecida como "audio" (o download falha aqui → pede para escrever, sem quebrar).
    expect(await handleQrMessage(channelId, { ...raw, key: { ...raw.key, id: `QAUD${uniq()}` } })).toBe('ok');
    expect(JSON.stringify(sent.at(-1)!.content)).toMatch(/não consegui ouvir/);
  });

  it('prévia ("Ouvir prévia") devolve audio/ogg para cada motor; vozes mudam com o motor', async () => {
    const g = await owner.post('/api/ai/voice/preview', { voiceProvider: 'gemini', voiceName: 'Puck', voiceStyle: 'animada' }).buffer(true).parse(binary);
    expect(g.status).toBe(200);
    expect(g.headers['content-type']).toContain('audio/ogg');
    expect(isOggOpus(g.body)).toBe(true);
    const o = await owner.post('/api/ai/voice/preview', { voiceProvider: 'openai', voiceName: 'coral' }).buffer(true).parse(binary);
    expect(o.status).toBe(200);
    expect(fakeVoice.voices.at(-1)).toBe('coral');
    // ElevenLabs sem chave: erro claro (400), sem quebrar.
    await owner.put('/api/ai/settings', { clearVoiceApiKey: true });
    const e1 = await owner.post('/api/ai/voice/preview', { voiceProvider: 'elevenlabs', voiceName: 'voz-teste-eleven-1' });
    expect(e1.status).toBe(400);
    expect(e1.body.error).toMatch(/ElevenLabs/);
    expect((await owner.get('/api/ai/voice/voices?provider=elevenlabs')).body).toMatchObject({ needsKey: true, voices: [] });
    await owner.put('/api/ai/settings', { voiceApiKey: 'sk_eleven_teste_123' });
    const vl = await owner.get('/api/ai/voice/voices?provider=elevenlabs');
    expect(vl.body.voices[0].id).toBe('voz-teste-eleven-1');
    const e2 = await owner.post('/api/ai/voice/preview', { voiceProvider: 'elevenlabs', voiceName: 'voz-teste-eleven-1' }).buffer(true).parse(binary);
    expect(e2.status).toBe(200);
    expect(isOggOpus(e2.body)).toBe(true);
    const gv = await owner.get('/api/ai/voice/voices?provider=gemini');
    expect(gv.body.voices.map((v: any) => v.id)).toEqual(expect.arrayContaining(['Kore', 'Aoede', 'Leda', 'Puck', 'Charon', 'Fenrir', 'Orus', 'Zephyr']));
    const ov = await owner.get('/api/ai/voice/voices?provider=openai');
    expect(ov.body.voices.map((v: any) => v.id)).toEqual(expect.arrayContaining(['alloy', 'ash', 'coral', 'echo', 'nova', 'sage', 'shimmer']));
    expect(ov.body.defaultVoice).toBe('coral');
  });

  it('isolamento: a configuração de voz de uma organização não vale para outra', async () => {
    await setVoice({ voiceEnabled: true, voiceReplyMode: 'sempre_audio', voiceProvider: 'openai', voiceName: 'ash' });
    const other = await registerClient();
    const o = await other.get('/api/ai/settings');
    expect(o.body).toMatchObject({ voiceEnabled: false, voiceReplyMode: 'espelhar', voiceProvider: 'gemini', hasVoiceApiKey: false });
    await other.put('/api/ai/settings', { voiceEnabled: true, voiceProvider: 'elevenlabs', voiceApiKey: 'sk_eleven_outra_org' });
    const mine = await prisma.aiSettings.findUniqueOrThrow({ where: { orgId: owner.me.org.id } });
    expect(mine.voiceProvider).toBe('openai');
    expect(mine.voiceName).toBe('ash');
    // Valores inválidos são recusados.
    expect((await owner.put('/api/ai/settings', { voiceReplyMode: 'sempre' })).status).toBe(400);
    expect((await owner.put('/api/ai/settings', { voiceProvider: 'azure' })).status).toBe(400);
    expect((await owner.put('/api/ai/settings', { voiceName: 'x"; drop' })).status).toBe(400);
  });
});
