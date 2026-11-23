import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { registerClient, createTestChannel, installGraphMock, graph, prisma, uniq, type Client } from '../helpers.js';
import { handleInboundMessage } from '../../server/whatsapp/inbound.js';
import { fakeAi } from '../../server/ai/providers.js';
import { fakeVoice } from '../../server/ai/voice/providers.js';
import { isOggOpus } from '../../server/ai/voice/ogg.js';
import { setVoiceWorkerForTests, WorkerError, type VoiceWorkerClient, type WorkerJob } from '../../server/ai/voice/clone/worker.js';
import { processProfile } from '../../server/ai/voice/clone/service.js';
import { resetLimitesVoz } from '../../server/ai/voice/clone/routes.js';
import { wav } from '../vozHelpers.js';

const binary = (res: any, cb: (e: Error | null, b: Buffer) => void) => { const chunks: Buffer[] = []; res.on('data', (c: Buffer) => chunks.push(c)); res.on('end', () => cb(null, Buffer.concat(chunks))); };

/** Servidor de voz falso (mesmo contrato do voice-worker/app.py). */
class FakeWorker implements VoiceWorkerClient {
  online = true;
  voices = new Set<string>();
  jobs = new Map<string, WorkerJob>();
  ttsTexts: string[] = [];
  removed: string[] = [];
  registered: Buffer[] = [];
  configured() { return true; }
  async health() { return { ok: this.online, ready: this.online, queue: 0 }; }
  private down() { if (!this.online) throw new WorkerError('Servidor de voz fora do ar (sem conexão)', 0, 'down'); }
  async register(id: string, audio: Buffer) { this.down(); this.registered.push(audio); this.voices.add(id); const j = 'j' + uniq(); this.jobs.set(j, { status: 'done' }); return { job_id: j }; }
  async tts(id: string, text: string) {
    this.down();
    if (!this.voices.has(id)) return { missing: true as const };
    this.ttsTexts.push(text);
    const pcm = Buffer.alloc(24000 * 2);
    for (let i = 0; i < 24000; i++) pcm.writeInt16LE(Math.round(5000 * Math.sin(i / 10)), i * 2);
    const j = 'j' + uniq(); this.jobs.set(j, { status: 'done', rate: 24000, pcm16_b64: pcm.toString('base64'), seconds: 1 });
    return { job_id: j };
  }
  convertCalls = 0;
  async convert(id: string, base: Buffer) {
    this.down();
    if (!this.voices.has(id)) return { missing: true as const };
    this.convertCalls++;
    expect(isOggOpus(base)).toBe(true);
    return this.tts(id, '[convertido]');
  }
  async job(id: string) { this.down(); const j = this.jobs.get(id); if (!j) throw new Error('não encontrado'); return j; }
  async remove(id: string) { this.down(); this.removed.push(id); this.voices.delete(id); }
}

describe('v1.47.0 — biblioteca de áudios gravados e voz clonada', () => {
  let owner: Client;
  let ctx: Awaited<ReturnType<typeof createTestChannel>>;
  let phone = 5511766000000;
  const nextPhone = () => String(++phone);
  const w = new FakeWorker();
  const texto = (from: string, t: string) => handleInboundMessage(ctx.ch, { phoneNumberId: ctx.phoneNumberId, waMessageId: `wamid.TXT${uniq()}`, from, timestamp: new Date(), type: 'text', text: t });
  const sends = () => graph.calls.filter((c) => c.url.endsWith('/messages') && c.body);
  const uploads = () => graph.calls.filter((c) => c.url.endsWith('/media'));
  const upClip = (c: Client, title: string, when: string, transcript = '', body: Buffer = wav(2)) => c.agent.post('/api/ai/voz/clips').set((c as any).h()).set('content-type', 'application/octet-stream')
    .set('x-clip-title', encodeURIComponent(title)).set('x-clip-when', encodeURIComponent(when)).set('x-clip-transcript', encodeURIComponent(transcript)).send(body);
  const upSample = (c: Client, id: string, secs: number) => c.agent.post(`/api/ai/voz/perfis/${id}/amostra`).set((c as any).h()).set('content-type', 'application/octet-stream').send(wav(secs, 8000));

  beforeAll(async () => {
    installGraphMock();
    setVoiceWorkerForTests(w);
    owner = await registerClient();
    ctx = await createTestChannel(owner.me.org.id);
    await prisma.channel.update({ where: { id: ctx.ch.id }, data: { autoReplyMode: 'ai' } });
    expect((await owner.put('/api/ai/settings', { provider: 'fake', model: 'fake-1', enabled: true, autoReply: true })).status).toBe(200);
  });
  beforeEach(() => { graph.reset(); fakeAi.script = []; fakeAi.calls = []; resetLimitesVoz(); w.online = true; fakeVoice.tts = []; });
  afterAll(() => setVoiceWorkerForTests(null));

  let clipId = '';
  it('biblioteca: grava áudio (WAV → OGG), lista, só Proprietário/Admin', async () => {
    const r = await upClip(owner, 'Formas de pagamento', 'cliente pergunta como pagar', 'A gente aceita Pix, cartão e dinheiro.');
    expect(r.status).toBe(201);
    clipId = r.body.id;
    const c = await prisma.voiceClip.findUniqueOrThrow({ where: { id: clipId } });
    expect(isOggOpus(Buffer.from(c.audio))).toBe(true);
    expect(c.seconds).toBeCloseTo(2, 0);
    const g = await owner.get('/api/ai/voz');
    expect(g.status).toBe(200);
    expect(g.body.clips.map((x: any) => x.id)).toContain(clipId);
    expect(g.body.clips[0]).not.toHaveProperty('audio');
    expect(g.body.worker).toMatchObject({ configured: true, online: true });
    expect((await upClip(owner, 'x', '')).status).toBe(400);
    expect((await upClip(owner, 'Lixo', '', '', Buffer.from('nada de áudio aqui'))).status).toBe(400);
    const a = await owner.agent.get(`/api/ai/voz/clips/${clipId}/audio`).set((owner as any).h()).buffer(true).parse(binary);
    expect(a.status).toBe(200);
    expect(isOggOpus(a.body)).toBe(true);
    const outro = await registerClient();
    expect((await outro.get(`/api/ai/voz/clips/${clipId}/audio`)).status).toBe(404);
  });

  it('biblioteca desligada: a IA nem vê os áudios e o marcador é ignorado', async () => {
    fakeAi.script = [`[AUDIO:${clipId}] Qualquer coisa me chama!`];
    await texto(nextPhone(), 'como posso pagar?');
    expect(fakeAi.calls[0][0].content).not.toContain(clipId);
    expect(uploads()).toHaveLength(0);
    expect(sends()[0].body.text.body).toBe('Qualquer coisa me chama!');
  });

  it('biblioteca ligada: a IA escolhe o áudio, ele sai como áudio gravado (PTT) e o texto vai depois; não repete na conversa', async () => {
    expect((await owner.put('/api/ai/voz/biblioteca', { enabled: true })).status).toBe(200);
    const p = nextPhone();
    fakeAi.script = [`[AUDIO:${clipId}] Qualquer coisa me chama!`];
    await texto(p, 'como posso pagar?');
    expect(fakeAi.calls[0][0].content).toContain(`[AUDIO:${clipId}]`);
    expect(uploads()).toHaveLength(1);
    expect(sends()).toHaveLength(2);
    expect(sends()[0].body).toMatchObject({ type: 'audio', audio: { voice: true } });
    expect(sends()[1].body.text.body).toBe('Qualquer coisa me chama!');
    const contact = await prisma.contact.findUniqueOrThrow({ where: { orgId_waId: { orgId: owner.me.org.id, waId: p } } });
    const conv = await prisma.conversation.findFirstOrThrow({ where: { contactId: contact.id } });
    const out = await prisma.message.findFirstOrThrow({ where: { direction: 'OUT', type: 'audio', conversationId: conv.id } });
    expect(out.body).toMatch(/^\[áudio gravado\] Formas de pagamento/);
    expect((await prisma.voiceClip.findUniqueOrThrow({ where: { id: clipId } })).useCount).toBe(1);
    // Mesmo áudio não aparece de novo para a IA nesta conversa.
    graph.reset(); fakeAi.calls = [];
    fakeAi.script = ['Mais alguma dúvida?'];
    await texto(p, 'e no cartão parcela?');
    expect(fakeAi.calls[0][0].content).not.toContain(clipId);
  });

  it('só o marcador (sem texto) manda só o áudio; marcador inventado é ignorado', async () => {
    fakeAi.script = [`[AUDIO:${clipId}]`];
    await texto(nextPhone(), 'como posso pagar?');
    expect(sends()).toHaveLength(1);
    expect(sends()[0].body.type).toBe('audio');
    graph.reset();
    fakeAi.script = ['[AUDIO:inventado123] Aceitamos Pix.'];
    await texto(nextPhone(), 'como posso pagar?');
    expect(uploads()).toHaveLength(0);
    expect(sends()[0].body.text.body).toBe('Aceitamos Pix.');
  });

  let profileId = '';
  it('voz clonada: aceite com assinatura igual ao nome, amostra de 1 a 3 min, cifrada', async () => {
    const bad = await owner.post('/api/ai/voz/perfis', { ownerName: 'João da Silva', ownerRole: 'Vendedor', assinatura: 'Outro Nome', aceite: true, souDonoOuTenhoTermo: true });
    expect(bad.status).toBe(400);
    expect((await owner.post('/api/ai/voz/perfis', { ownerName: 'João da Silva', assinatura: 'João da Silva', aceite: false, souDonoOuTenhoTermo: true })).status).toBe(400);
    const r = await owner.post('/api/ai/voz/perfis', { ownerName: 'João da Silva', ownerRole: 'Vendedor', assinatura: 'joao da silva', aceite: true, souDonoOuTenhoTermo: true });
    expect(r.status).toBe(201);
    profileId = r.body.id;
    expect(r.body.script).toMatch(/^Eu, João da Silva, autorizo/);
    const p0 = await prisma.voiceProfile.findUniqueOrThrow({ where: { id: profileId } });
    expect(p0.consentText).toContain('João da Silva');
    expect(p0.status).toBe('AGUARDANDO_AMOSTRA');
    expect(await prisma.auditLog.count({ where: { orgId: owner.me.org.id, action: 'voz.clone.aceite' } })).toBe(1);
    expect((await upSample(owner, profileId, 30)).status).toBe(400);
    expect((await upSample(owner, profileId, 200)).status).toBe(400);
    const ok = await upSample(owner, profileId, 70);
    expect(ok.status).toBe(200);
    await processProfile(profileId);
    for (let i = 0; i < 100 && (await prisma.voiceProfile.findUniqueOrThrow({ where: { id: profileId } })).status !== 'PRONTA'; i++) await new Promise((r) => setTimeout(r, 50));
    const p = await prisma.voiceProfile.findUniqueOrThrow({ where: { id: profileId } });
    expect(p.status).toBe('PRONTA');
    expect(p.sampleEnc).toBeTruthy();
    expect(Buffer.from(p.sampleEnc!).subarray(0, 4).toString()).toBe('MCK1');
    expect(isOggOpus(w.registered.at(-1)!)).toBe(true); // o servidor de voz recebe a amostra decifrada
    const prev = await owner.agent.get(`/api/ai/voz/perfis/${profileId}/previa`).set((owner as any).h()).buffer(true).parse(binary);
    expect(prev.status).toBe(200);
    expect(isOggOpus(prev.body)).toBe(true);
    const outro = await registerClient();
    expect((await outro.get(`/api/ai/voz/perfis/${profileId}/previa`)).status).toBe(404);
    expect((await outro.post(`/api/ai/voz/perfis/${profileId}/ativar`)).status).toBe(400);
  });

  it('ativa a voz: a IA responde áudio na voz clonada; mesma frase vem do cache; servidor fora → texto', async () => {
    expect((await owner.post(`/api/ai/voz/perfis/${profileId}/ativar`)).status).toBe(200);
    const s = await owner.get('/api/ai/settings');
    expect(s.body).toMatchObject({ voiceProvider: 'clone', voiceEnabled: true, voiceCloneProfileId: profileId });
    await owner.put('/api/ai/settings', { voiceReplyMode: 'sempre_audio' });
    await owner.put('/api/ai/voz/biblioteca', { enabled: false });
    fakeAi.script = ['Oi! Temos horário amanhã às dez.'];
    await texto(nextPhone(), 'tem horário?');
    expect(sends()[0].body.type).toBe('audio');
    const n = w.ttsTexts.length;
    graph.reset();
    fakeAi.script = ['Oi! Temos horário amanhã às dez.'];
    await texto(nextPhone(), 'tem horário?');
    expect(sends()[0].body.type).toBe('audio');
    expect(w.ttsTexts.length).toBe(n); // cache
    graph.reset();
    w.online = false;
    const { markWorkerDown } = await import('../../server/ai/voice/clone/worker.js');
    markWorkerDown();
    fakeAi.script = ['Outra resposta qualquer, sem cache.'];
    await texto(nextPhone(), 'oi');
    expect(sends()[0].body.type).toBe('text');
    expect(sends()[0].body.text.body).toBe('Outra resposta qualquer, sem cache.');
  });

  it('servidor de voz perdeu a voz: reaprende pela amostra cifrada e responde', async () => {
    const { setVoiceWorkerForTests: set } = await import('../../server/ai/voice/clone/worker.js');
    set(w); // limpa o cache de saúde
    w.voices.clear();
    fakeAi.script = ['Resposta nova depois de reiniciar o servidor.'];
    await texto(nextPhone(), 'oi de novo');
    expect(sends()[0].body.type).toBe('audio');
    expect(w.voices.size).toBe(1);
  });

  it('exclusão a pedido: apaga amostra, prévia, cache e a voz no servidor; IA volta ao motor padrão', async () => {
    const vid = (await prisma.voiceProfile.findUniqueOrThrow({ where: { id: profileId } })).workerVoiceId;
    const r = await owner.post(`/api/ai/voz/perfis/${profileId}/excluir`, { motivo: 'Vendedor saiu da empresa' });
    expect(r.status).toBe(200);
    const p = await prisma.voiceProfile.findUniqueOrThrow({ where: { id: profileId } });
    expect(p).toMatchObject({ status: 'EXCLUIDA', sampleEnc: null, previewOgg: null, deletedReason: 'Vendedor saiu da empresa' });
    expect(p.consentText).toContain('João da Silva'); // registro do aceite fica (sem áudio)
    expect(await prisma.voiceCloneCache.count({ where: { profileId } })).toBe(0);
    expect(w.removed).toContain(vid);
    const s = await owner.get('/api/ai/settings');
    expect(s.body.voiceProvider).toBe('gemini');
    expect(s.body.voiceCloneProfileId).toBeNull();
    expect((await owner.get('/api/ai/voz')).body.profiles).toHaveLength(0);
    expect(await prisma.auditLog.count({ where: { orgId: owner.me.org.id, action: 'voz.clone.excluir' } })).toBe(1);
  });

  it('motor "clone" sem voz pronta é recusado ao salvar', async () => {
    const r = await owner.put('/api/ai/settings', { voiceProvider: 'clone', voiceName: 'naoexiste1' });
    expect(r.status).toBe(400);
  });
});
