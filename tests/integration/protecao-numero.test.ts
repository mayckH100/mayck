import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { registerClient, createTestChannel, installGraphMock, prisma, uniq, type Client } from '../helpers.js';
import { qrManager, type QrSocket } from '../../server/whatsapp/qr/manager.js';
import { tick, resetDispatcherState, setRandom } from '../../server/mckmensagem/dispatcher.js';
import { verificarEnvioEmMassa, resetProtecaoState, setProtecaoRandom, registrarEventoSaude } from '../../server/whatsapp/protecao/service.js';
import { handleInboundMessage } from '../../server/whatsapp/inbound.js';
import { sendOutbound } from '../../server/whatsapp/messaging.js';
import type { AnyMessageContent } from '@whiskeysockets/baileys';

describe('v1.42.0 — proteção contra bloqueio e saúde do número (WhatsApp por QR)', () => {
  let owner: Client;
  let channelId: string;
  const sent: { jid: string; content: AnyMessageContent }[] = [];
  const presence: string[] = [];
  let k = 0;
  const sock: QrSocket = {
    user: { id: '5511993190000:7@s.whatsapp.net' },
    async sendMessage(jid, content) { sent.push({ jid, content }); return { key: { id: `PN${++k}${uniq()}` } }; },
    async sendPresenceUpdate(type) { presence.push(type); },
    signalRepository: { lidMapping: { async getPNForLID() { return null; }, async getLIDForPN() { return null; } } },
  };
  let phone = 5511766000000;

  async function campanha(n: number) {
    const orgId = owner.me.org.id;
    const c = await prisma.campaign.create({ data: { orgId, name: `Camp ${uniq()}`, message: 'Oi {nome}!', channelId, status: 'EM_ANDAMENTO', dailyLimit: 1000, minIntervalSec: 1, maxIntervalSec: 1, windowStart: '00:00', windowEnd: '23:59' } });
    for (let i = 0; i < n; i++) {
      const lead = await prisma.lead.create({ data: { orgId, phone: `+${++phone}`, name: `Lead ${i}`, consentSource: 'MANUAL', consentAt: new Date() } });
      await prisma.campaignRecipient.create({ data: { campaignId: c.id, leadId: lead.id } });
    }
    return c;
  }

  beforeAll(async () => {
    installGraphMock();
    process.env.QR_PROTECAO = 'on';
    owner = await registerClient();
    const r = await owner.post('/api/channels', { name: 'Celular proteção' });
    channelId = r.body.id;
    await prisma.channel.update({ where: { id: channelId }, data: { status: 'CONNECTED' } });
    qrManager.attachForTests(channelId, sock, 'CONNECTED');
    setRandom(() => 0);
    setProtecaoRandom(() => 0.5); // intervalo do número: 20 + 0,5 × 40 = 40 s
  });
  beforeEach(async () => {
    sent.length = 0; presence.length = 0;
    resetDispatcherState(); resetProtecaoState();
    await prisma.campaign.updateMany({ where: { status: 'EM_ANDAMENTO' }, data: { status: 'PAUSADA' } });
  });
  afterAll(() => { delete process.env.QR_PROTECAO; setRandom(null); setProtecaoRandom(null); qrManager.resetForTests(); });

  it('campanha: envio marcado como em massa e o intervalo aleatório do número segura o próximo', async () => {
    await campanha(3);
    const t0 = Date.now();
    expect((await tick(new Date(t0)))[0].action).toBe('sent');
    expect(sent).toHaveLength(1);
    const msg = await prisma.message.findFirstOrThrow({ where: { channelId, direction: 'OUT' }, orderBy: { createdAt: 'desc' } });
    expect(msg.bulk).toBe(true);
    // A campanha liberaria em 1 s, mas o número só libera em 40 s.
    expect((await tick(new Date(t0 + 5_000)))[0].action).toBe('number_protection');
    expect(sent).toHaveLength(1);
    const camp = await prisma.campaign.findFirstOrThrow({ where: { channelId, status: 'EM_ANDAMENTO' } });
    expect(await prisma.campaignRecipient.count({ where: { status: 'PENDENTE', campaignId: camp.id } })).toBe(2);
    // Passado o intervalo do número (e o adiamento da campanha), sai o próximo.
    expect((await tick(new Date(t0 + 50_000)))[0].action).toBe('sent');
    expect(sent).toHaveLength(2);
  });

  it('aquecimento: número novo tem teto de 20 por dia e 5 por hora; desligar a proteção libera', async () => {
    await prisma.message.deleteMany({ where: { channelId, bulk: true } });
    const conv = await prisma.conversation.findFirstOrThrow({ where: { channelId } });
    for (let i = 0; i < 5; i++) await prisma.message.create({ data: { orgId: owner.me.org.id, conversationId: conv.id, channelId, direction: 'OUT', sender: 'bot', type: 'text', body: 'x', status: 'SENT', bulk: true, createdAt: new Date(Date.now() - 60_000) } });
    resetProtecaoState();
    const r = await verificarEnvioEmMassa(channelId);
    expect(r).toMatchObject({ ok: false, motivo: 'hora' });
    const saude = await owner.get(`/api/channels/${channelId}/saude`);
    expect(saude.status).toBe(200);
    expect(saude.body.limites).toMatchObject({ aquecendo: true, diaAquecimento: 1, dia: 20, hora: 5 });
    expect(saude.body.numeros.emMassaHoje).toBeGreaterThanOrEqual(5);
    // Desliga a proteção: liberado.
    expect((await owner.put(`/api/channels/${channelId}/protecao`, { enabled: false })).status).toBe(200);
    expect((await verificarEnvioEmMassa(channelId)).ok).toBe(true);
    // Validação: máximo menor que o mínimo é recusado.
    expect((await owner.put(`/api/channels/${channelId}/protecao`, { minGapSec: 60, maxGapSec: 30 })).status).toBe(400);
    expect((await owner.put(`/api/channels/${channelId}/protecao`, { hourLimit: 1 })).status).toBe(400);
    // Aquecimento desligado e proteção ligada: vale o limite configurado.
    const ok = await owner.put(`/api/channels/${channelId}/protecao`, { enabled: true, warmupEnabled: false, hourLimit: 100, dayLimit: 300 });
    expect(ok.status).toBe(200);
    expect(ok.body.limites).toMatchObject({ aquecendo: false, dia: 300, hora: 100 });
    expect((await verificarEnvioEmMassa(channelId)).ok).toBe(true);
  });

  it('respostas a quem chamou não são seguradas e mostram "digitando..." antes (robô/IA), não para atendente', async () => {
    const orgId = owner.me.org.id;
    const contact = await prisma.contact.create({ data: { orgId, waId: String(++phone), phone: `+${phone}` } });
    const conv = await prisma.conversation.create({ data: { orgId, contactId: contact.id, channelId, lastInboundAt: new Date() } });
    const m = await sendOutbound({ conversation: conv, contact, payload: { type: 'text', text: 'Olá! Como posso ajudar?' }, sender: 'ai' });
    expect(m.status).toBe('SENT');
    expect(m.bulk).toBe(false);
    expect(presence).toEqual(['composing', 'paused']);
    presence.length = 0;
    await sendOutbound({ conversation: conv, contact, payload: { type: 'text', text: 'Oi, aqui é a Ana.' }, sender: 'agent' });
    expect(presence).toEqual([]);
    // Desligado na proteção do número: sem "digitando...".
    await owner.put(`/api/channels/${channelId}/protecao`, { typingEnabled: false });
    await sendOutbound({ conversation: conv, contact, payload: { type: 'text', text: 'Mais alguma coisa?' }, sender: 'bot' });
    expect(presence).toEqual([]);
    await owner.put(`/api/channels/${channelId}/protecao`, { typingEnabled: true });
  });

  it('saúde: desconexões e restrição entram no painel e o nível vira Risco; permissão e isolamento', async () => {
    await registrarEventoSaude(channelId, 'desconexao', 'Conexão perdida (código 428)');
    await registrarEventoSaude(channelId, 'desconexao', 'repetida em menos de 10 min — conta 1 vez');
    await registrarEventoSaude(channelId, 'restricao', 'Sessão inválida (código 403)');
    const r = await owner.get(`/api/channels/${channelId}/saude`);
    expect(r.status).toBe(200);
    expect(r.body.nivel).toBe('RISCO');
    expect(r.body.rotulo).toBe('Risco');
    expect(r.body.numeros.desconexoes7d).toBe(2);
    expect(r.body.eventos.map((e: any) => e.type)).toEqual(expect.arrayContaining(['desconexao', 'restricao']));
    expect(r.body.dicas.length).toBeGreaterThan(0);
    const other = await registerClient();
    expect((await other.get(`/api/channels/${channelId}/saude`)).status).toBe(404);
    expect((await other.put(`/api/channels/${channelId}/protecao`, { enabled: false })).status).toBe(404);
  });

  it('API oficial: sem trava de envio em massa (limites são os da Meta), painel funciona', async () => {
    const ctx = await createTestChannel(owner.me.org.id);
    expect((await verificarEnvioEmMassa(ctx.ch.id)).ok).toBe(true);
    const r = await owner.get(`/api/channels/${ctx.ch.id}/saude`);
    expect(r.status).toBe(200);
    expect(r.body.qr).toBe(false);
  });
});

describe('v1.42.0 — áudio: duração máxima configurável e "[áudio não transcrito]"', () => {
  let owner: Client;
  let ctx: Awaited<ReturnType<typeof createTestChannel>>;
  let phone = 5511767000000;
  const audio = (from: string, falado: string, segundos: number) => handleInboundMessage(
    ctx.ch,
    { phoneNumberId: ctx.phoneNumberId, waMessageId: `wamid.AUDP${uniq()}`, from, timestamp: new Date(), type: 'audio', text: '', mediaId: 'media-in-1' },
    async () => ({ dados: Buffer.from(falado), nome: 'audio.ogg', mime: 'audio/ogg; codecs=opus', segundos }),
  );
  const inboundOf = async (p: string) => {
    const contact = await prisma.contact.findUniqueOrThrow({ where: { orgId_waId: { orgId: owner.me.org.id, waId: p } } });
    const conv = await prisma.conversation.findFirstOrThrow({ where: { contactId: contact.id } });
    return prisma.message.findFirstOrThrow({ where: { conversationId: conv.id, direction: 'IN' } });
  };

  beforeAll(async () => {
    installGraphMock();
    owner = await registerClient();
    ctx = await createTestChannel(owner.me.org.id);
    await prisma.channel.update({ where: { id: ctx.ch.id }, data: { autoReplyMode: 'ai' } });
    expect((await owner.put('/api/ai/settings', { provider: 'fake', model: 'fake-1', enabled: true, autoReply: true })).status).toBe(200);
  });

  it('padrão 2 minutos; com 30 s configurado, áudio de 45 s não é transcrito e a IA pede um áudio menor', async () => {
    expect((await owner.get('/api/ai/settings')).body.transcribeMaxSeconds).toBe(120);
    const p1 = String(++phone);
    await audio(p1, 'FAKE:quero um orçamento', 45);
    expect((await inboundOf(p1)).transcript).toBe('quero um orçamento');
    expect((await owner.put('/api/ai/settings', { transcribeMaxSeconds: 30 })).status).toBe(200);
    expect((await owner.put('/api/ai/settings', { transcribeMaxSeconds: 5 })).status).toBe(400);
    const p2 = String(++phone);
    await audio(p2, 'FAKE:quero um orçamento', 45);
    const m = await inboundOf(p2);
    expect(m.transcript).toBeNull();
    expect(m.body).toBe('[áudio não transcrito]');
    const out = await prisma.message.findFirstOrThrow({ where: { conversationId: m.conversationId, direction: 'OUT' } });
    expect(out.body).toContain('até 30 segundos');
    await owner.put('/api/ai/settings', { transcribeMaxSeconds: 120 });
  });

  it('sem provedor capaz (falha): registra "[áudio não transcrito]" e a conversa segue sem quebrar', async () => {
    const p = String(++phone);
    expect(await audio(p, 'FALHAR', 4)).toBe('ok');
    const m = await inboundOf(p);
    expect(m.body).toBe('[áudio não transcrito]');
    expect(await prisma.message.count({ where: { conversationId: m.conversationId, direction: 'OUT' } })).toBe(1);
  });
});
