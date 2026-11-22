import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { registerClient, installGraphMock, prisma, uniq, type Client } from '../helpers.js';
import { qrManager, type QrSocket } from '../../server/whatsapp/qr/manager.js';
import { tick, resetDispatcherState, setRandom } from '../../server/mckmensagem/dispatcher.js';
import { tickRepescagem, resetRepescagemState, setRepescagemRandom, gerarTextoRepescagem, PAUSA_RISCO } from '../../server/mckmensagem/repescagem.js';
import { resetProtecaoState, registrarEventoSaude } from '../../server/whatsapp/protecao/service.js';
import { handleInboundMessage } from '../../server/whatsapp/inbound.js';
import { applyStatus } from '../../server/whatsapp/messaging.js';
import { fakeAi } from '../../server/ai/providers.js';
import { resetAiCache } from '../../server/ai/core.js';
import type { AnyMessageContent } from '@whiskeysockets/baileys';
import type { Channel } from '@prisma/client';

const DAY = 86400e3;
/** Início de hora cheia (+1 min) de 2 h atrás: os passos caem longe de 23:59 (fim da janela 00:00–23:59). */
const baseT0 = () => Math.floor((Date.now() - 2 * 3600e3) / 3600e3) * 3600e3 + 60_000;
const textOf = (c: AnyMessageContent) => (c as { text?: string }).text ?? '';

describe('v1.43.0 — repescagem automática inteligente das campanhas', () => {
  let owner: Client;
  let channel: Channel;
  const sent: { jid: string; content: AnyMessageContent }[] = [];
  let k = 0;
  const sock: QrSocket = {
    user: { id: '5511993191111:7@s.whatsapp.net' },
    async sendMessage(jid, content) { sent.push({ jid, content }); return { key: { id: `RP${++k}${uniq()}` } }; },
    async sendPresenceUpdate() { /* digitando */ },
    signalRepository: { lidMapping: { async getPNForLID() { return null; }, async getLIDForPN() { return null; } } },
  };
  let phone = 5511768000000;
  const org = () => owner.me.org.id;
  const jidOf = (p: string) => `${p.replace(/\D/g, '')}@s.whatsapp.net`;
  const inbound = (from: string, text: string) => handleInboundMessage(channel, { phoneNumberId: '', waMessageId: `IN${uniq()}`, from: from.replace(/\D/g, ''), timestamp: new Date(), type: 'text', text });

  /** Campanha criada pela API (repescagem ligada por padrão) com N leads, já disparada (envio original). */
  async function campanhaDisparada(n: number, t0: number, extra: Record<string, unknown> = {}) {
    const r = await owner.post('/api/mckmensagem/campaigns', {
      name: `Camp ${uniq()}`, message: 'Olá {nome}! Temos 20% de desconto no plano anual para novos clientes. Responda SAIR para não receber mais.',
      channelId: channel.id, dailyLimit: 1000, minIntervalSec: 10, maxIntervalSec: 10, windowStart: '00:00', windowEnd: '23:59', ...extra,
    });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ repescagemAtiva: extra.repescagemAtiva ?? true, repescagemDias: 2, repescagemMax: 2 });
    const leads = [];
    for (let i = 0; i < n; i++) {
      const lead = await prisma.lead.create({ data: { orgId: org(), phone: `+${++phone}`, name: `Pessoa${i} Teste`, consentSource: 'MANUAL', consentAt: new Date() } });
      await prisma.campaignRecipient.create({ data: { campaignId: r.body.id, leadId: lead.id } });
      leads.push(lead);
    }
    await prisma.campaign.update({ where: { id: r.body.id }, data: { status: 'EM_ANDAMENTO' } });
    const acoes = [];
    for (let i = 0; i <= n; i++) acoes.push((await tick(new Date(t0 + i * 20_000))).find((x) => x.campaignId === r.body.id)?.action);
    const recs = await prisma.campaignRecipient.findMany({ where: { campaignId: r.body.id }, orderBy: { sentAt: 'asc' } });
    expect(recs.map((x) => [x.status, !!x.messageId, x.error]), String(acoes)).toEqual(recs.map(() => ['ENVIADA', true, null]));
    await prisma.campaign.update({ where: { id: r.body.id }, data: { status: 'CONCLUIDA' } });
    return { id: r.body.id as string, leads, recs };
  }
  const waIdOfRec = async (messageId: string) => (await prisma.message.findUniqueOrThrow({ where: { id: messageId } })).waMessageId!;

  beforeAll(async () => {
    installGraphMock();
    owner = await registerClient();
    const r = await owner.post('/api/channels', { name: 'Celular repescagem' });
    await prisma.channel.update({ where: { id: r.body.id }, data: { status: 'CONNECTED' } });
    channel = await prisma.channel.findUniqueOrThrow({ where: { id: r.body.id } });
    expect(channel.provider).toBe('whatsapp_qr');
    qrManager.attachForTests(channel.id, sock, 'CONNECTED');
    setRandom(() => 0);
    setRepescagemRandom(() => 0);
    await prisma.aiSettings.upsert({ where: { orgId: org() }, create: { orgId: org(), provider: 'fake', model: 'fake-1' }, update: { provider: 'fake', model: 'fake-1', enabled: false } });
  });
  beforeEach(async () => {
    resetDispatcherState(); resetRepescagemState(); resetProtecaoState(); resetAiCache();
    fakeAi.script = []; fakeAi.calls = [];
    await prisma.campaign.updateMany({ where: { orgId: org() }, data: { status: 'PAUSADA' } });
    await prisma.channelHealthEvent.deleteMany({ where: { channelId: channel.id } });
  });
  afterAll(() => { setRandom(null); setRepescagemRandom(null); qrManager.resetForTests(); });

  it('separa os grupos e repesca só quem não respondeu; nunca quem disse "sim"; limite e "Sem resposta"', async () => {
    const t0 = baseT0();
    const { id, leads, recs } = await campanhaDisparada(5, t0);
    const [A, B, C, D, E] = leads;
    const recOf = (leadId: string) => recs.find((r) => r.leadId === leadId)!;
    // A leu, B só recebeu, C respondeu "sim", D pediu SAIR, E falhou (número sem WhatsApp).
    expect(await applyStatus(channel.id, await waIdOfRec(recOf(A.id).messageId!), 'read')).toBe(true);
    expect(await applyStatus(channel.id, await waIdOfRec(recOf(B.id).messageId!), 'delivered')).toBe(true);
    await inbound(C.phone, 'sim');
    await inbound(D.phone, 'SAIR');
    await applyStatus(channel.id, await waIdOfRec(recOf(E.id).messageId!), 'failed', 'Número não tem WhatsApp');
    expect((await prisma.campaignRecipient.findUniqueOrThrow({ where: { id: recOf(C.id).id } })).respondeuAt).not.toBeNull();

    const g = await owner.get(`/api/mckmensagem/campaigns/${id}/grupos`);
    expect(g.status).toBe(200);
    expect(g.body.contagem).toMatchObject({ RESPONDEU: 1, VISUALIZOU: 1, NAO_VISUALIZOU: 1, SAIU: 1, FALHOU: 1, PENDENTE: 0 });
    const so = await owner.get(`/api/mckmensagem/campaigns/${id}/grupos?grupo=VISUALIZOU`);
    expect(so.body.itens.map((x: any) => x.leadId)).toEqual([A.id]);
    const csv = await owner.get(`/api/mckmensagem/campaigns/${id}/grupos/export`);
    expect(csv.status).toBe(200);
    expect(csv.text).toContain('telefone,nome,grupo,status_mensagem');
    expect(csv.text).toContain('Visualizou e não respondeu');
    expect(csv.text).toContain('Saiu (SAIR)');

    // Antes de 2 dias: nada.
    sent.length = 0;
    const cedo = await tickRepescagem(new Date(t0 + 1 * DAY));
    expect(cedo.find((x) => x.campaignId === id)?.action).toBe('nothing');
    expect(sent).toHaveLength(0);

    // 2 dias: a IA escreve a 1ª repescagem de A (mais antigo). C (pelo inbound), D e E param.
    fakeAi.script = ['Oi Pessoa0, tudo certo? A rotina anda corrida, né? Ficou alguma dúvida sobre o desconto do anual? Posso te explicar rapidinho.'];
    const t2 = t0 + 2 * DAY + 5 * 60_000;
    const r1 = await tickRepescagem(new Date(t2));
    expect(r1.find((x) => x.campaignId === id)).toMatchObject({ action: 'sent', stopped: 2 }); // C já foi marcado pelo inbound; D e E param aqui
    expect(sent).toHaveLength(1);
    expect(sent[0].jid).toBe(jidOf(A.phone));
    expect(textOf(sent[0].content)).toMatch(/^Oi Pessoa0, tudo certo\?/);
    expect(textOf(sent[0].content)).toMatch(/responda SAIR\.$/);
    expect(fakeAi.calls[0][0].content).toContain('Temos 20% de desconto');
    const repA = await prisma.message.findFirstOrThrow({ where: { channelId: channel.id, direction: 'OUT', body: { startsWith: 'Oi Pessoa0' } } });
    expect(repA.bulk).toBe(true);
    expect(await prisma.message.findFirst({ where: { conversationId: repA.conversationId, direction: 'INTERNAL', body: { contains: 'Repescagem automática 1/2' } } })).not.toBeNull();
    const after = await prisma.campaignRecipient.findMany({ where: { campaignId: id } });
    const st = (leadId: string) => after.find((r) => r.leadId === leadId)!;
    expect(st(C.id)).toMatchObject({ repescagemStatus: 'RESPONDEU', repescagens: 0 });
    expect(st(D.id)).toMatchObject({ repescagemStatus: 'PARADA', repescagens: 0 });
    expect(st(E.id)).toMatchObject({ repescagemStatus: 'PARADA', repescagens: 0 });

    // Intervalo da campanha (10 s) segura a próxima.
    expect((await tickRepescagem(new Date(t2 + 5_000))).find((x) => x.campaignId === id)?.action).toBe('waiting_interval');

    // B: a IA copia a mensagem original → não passa na checagem → texto modelo (com o nome e SAIR).
    fakeAi.script = ['Olá Pessoa1! Temos 20% de desconto no plano anual para novos clientes. Responda SAIR para não receber mais.'];
    expect((await tickRepescagem(new Date(t2 + 15_000))).find((x) => x.campaignId === id)?.action).toBe('sent');
    expect(sent).toHaveLength(2);
    expect(sent[1].jid).toBe(jidOf(B.phone));
    expect(textOf(sent[1].content)).toContain('Pessoa1');
    expect(textOf(sent[1].content)).not.toContain('Temos 20% de desconto');
    expect(textOf(sent[1].content)).toMatch(/SAIR/);

    // B responde depois da repescagem → fluxo normal (RESPONDEU) e nunca mais recebe repescagem.
    await inbound(B.phone, 'quanto custa?');
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: B.id } })).status).toBe('RESPONDEU');
    expect((await prisma.campaignRecipient.findFirstOrThrow({ where: { campaignId: id, leadId: B.id } })).repescagemStatus).toBe('RESPONDEU');

    // 2ª (última) repescagem de A depois de mais 2 dias; depois, "Sem resposta" e para.
    sent.length = 0;
    fakeAi.script = ['Olá Pessoa0! Passando só para lembrar do desconto no plano anual. Se quiser, te mando os detalhes por aqui.'];
    resetRepescagemState();
    expect((await tickRepescagem(new Date(t2 + 2 * DAY + 60_000))).find((x) => x.campaignId === id)?.action).toBe('sent');
    expect(sent.map((s) => s.jid)).toEqual([jidOf(A.phone)]);
    resetRepescagemState();
    const fim = await tickRepescagem(new Date(t2 + 4 * DAY + 120_000));
    expect(fim.find((x) => x.campaignId === id)?.action).toBe('finalized');
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: A.id } })).status).toBe('SEM_RESPOSTA');
    expect((await prisma.campaignRecipient.findFirstOrThrow({ where: { campaignId: id, leadId: A.id } }))).toMatchObject({ repescagens: 2, repescagemStatus: 'SEM_RESPOSTA' });
    resetRepescagemState();
    await tickRepescagem(new Date(t2 + 20 * DAY));
    expect(sent).toHaveLength(1); // nada além da 2ª de A
    // Nunca saiu nada para C (respondeu "sim"), D (SAIR) nem E (falhou).
    const finais = await prisma.campaignRecipient.findMany({ where: { campaignId: id } });
    expect(finais.reduce((a, r) => a + r.repescagens, 0)).toBe(3);
    for (const l of [C, D, E]) expect(finais.find((r) => r.leadId === l.id)!.repescagens).toBe(0);
    const g2 = await owner.get(`/api/mckmensagem/campaigns/${id}/grupos?grupo=SEM_RESPOSTA`);
    expect(g2.body.itens.map((x: any) => x.leadId)).toEqual([A.id]);
    expect(g2.body.contagem.REPESCADOS).toBe(2);

    // Responder depois do "Sem resposta" volta para o fluxo normal.
    await inbound(A.phone, 'oi, tenho interesse sim');
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: A.id } })).status).toBe('RESPONDEU');
  });

  it('claim atômico: dois passos ao mesmo tempo enviam uma vez só', async () => {
    const t0 = baseT0();
    const { id, leads } = await campanhaDisparada(1, t0);
    sent.length = 0;
    fakeAi.script = ['Oi Pessoa0, tudo bem? Ainda dá tempo de aproveitar o desconto no anual. Quer que eu te explique?', 'Oi Pessoa0, outra versão qualquer do texto para o segundo passo, sem copiar nada.'];
    const now = new Date(t0 + 2 * DAY + 60_000);
    await Promise.all([tickRepescagem(now), tickRepescagem(now)]);
    expect(sent.filter((s) => s.jid === jidOf(leads[0].phone))).toHaveLength(1);
    expect((await prisma.campaignRecipient.findFirstOrThrow({ where: { campaignId: id } })).repescagens).toBe(1);
  });

  it('destinatário antigo (antes da 1.43.0, sem a mensagem guardada): liga à mensagem enviada e separa pelo status', async () => {
    const t0 = baseT0();
    const { id, recs } = await campanhaDisparada(1, t0);
    const msgId = recs[0].messageId!;
    await applyStatus(channel.id, await waIdOfRec(msgId), 'read');
    await prisma.campaignRecipient.update({ where: { id: recs[0].id }, data: { messageId: null, sentAt: new Date() } });
    const g = await owner.get(`/api/mckmensagem/campaigns/${id}/grupos`);
    expect(g.body.contagem.VISUALIZOU).toBe(1);
    expect((await prisma.campaignRecipient.findUniqueOrThrow({ where: { id: recs[0].id } })).messageId).toBe(msgId);
  });

  it('número em nível Risco pausa a repescagem e avisa na campanha; volta sozinha', async () => {
    const t0 = baseT0();
    const { id } = await campanhaDisparada(1, t0);
    await registrarEventoSaude(channel.id, 'restricao', 'Sessão inválida (código 403)');
    sent.length = 0;
    const now = new Date(t0 + 2 * DAY + 60_000);
    expect((await tickRepescagem(now)).find((x) => x.campaignId === id)?.action).toBe('number_risk');
    expect(sent).toHaveLength(0);
    expect((await prisma.campaign.findUniqueOrThrow({ where: { id } })).repescagemPausa).toBe(PAUSA_RISCO);
    expect((await owner.get(`/api/mckmensagem/campaigns/${id}/grupos`)).body.repescagem.pausa).toBe(PAUSA_RISCO);
    await prisma.channelHealthEvent.deleteMany({ where: { channelId: channel.id } });
    expect((await tickRepescagem(new Date(now.getTime() + 60_000))).find((x) => x.campaignId === id)?.action).toBe('sent');
    expect((await prisma.campaign.findUniqueOrThrow({ where: { id } })).repescagemPausa).toBeNull();
  });

  it('desligada (ou campanha antiga sem repescagem): não envia nada; configuração validada', async () => {
    const t0 = baseT0();
    const { id } = await campanhaDisparada(1, t0, { repescagemAtiva: false });
    sent.length = 0;
    expect((await tickRepescagem(new Date(t0 + 9 * DAY))).find((x) => x.campaignId === id)).toBeUndefined();
    expect(sent).toHaveLength(0);
    const antiga = await prisma.campaign.create({ data: { orgId: org(), name: 'Antiga', message: 'oi', channelId: channel.id } });
    expect(antiga.repescagemAtiva).toBe(false);
    expect((await owner.patch(`/api/mckmensagem/campaigns/${id}`, { repescagemMax: 9 })).status).toBe(400);
    const ok = await owner.patch(`/api/mckmensagem/campaigns/${id}`, { repescagemAtiva: true, repescagemDias: 3, repescagemMax: 1, repescagemModelo: '{Oi|Olá} {nome}!' });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ repescagemAtiva: true, repescagemDias: 3, repescagemMax: 1 });
    const outro = await registerClient();
    expect((await outro.get(`/api/mckmensagem/campaigns/${id}/grupos`)).status).toBe(404);
  });

  it('sem IA configurada: texto modelo da campanha com variações e o nome', async () => {
    const sem = await registerClient();
    const r1 = await gerarTextoRepescagem({ orgId: sem.me.org.id, campanha: { message: 'Promoção X', repescagemModelo: '{Oi|Olá} {nome}! Ainda quer saber da promoção?', name: 'c' }, nome: 'Carla Dias', grupo: 'NAO_VISUALIZOU', tentativa: 1, max: 2, anteriores: ['Promoção X'] });
    expect(r1.fonte).toBe('modelo');
    expect(r1.texto).toMatch(/^(Oi|Olá) Carla! Ainda quer saber da promoção\?/);
    expect(r1.texto).toMatch(/responda SAIR/);
    // IA com erro → modelo padrão.
    fakeAi.script = ['__503__', '__503__', '__503__'];
    process.env.AI_RETRY_BACKOFF_MS = '0';
    const r2 = await gerarTextoRepescagem({ orgId: org(), campanha: { message: 'Promoção X', repescagemModelo: '', name: 'c' }, nome: null, grupo: 'VISUALIZOU', tentativa: 1, max: 2, anteriores: ['Promoção X'] });
    delete process.env.AI_RETRY_BACKOFF_MS;
    expect(r2.fonte).toBe('modelo');
    expect(r2.texto).toMatch(/SAIR/);
    const prev = await owner.post(`/api/mckmensagem/campaigns/${(await prisma.campaign.findFirstOrThrow({ where: { orgId: org() } })).id}/repescagem/previa`, { grupo: 'VISUALIZOU' });
    expect(prev.status).toBe(200);
    expect(prev.body.modelo).toMatch(/SAIR/);
    expect(await prisma.message.count({ where: { body: prev.body.modelo } })).toBe(0); // prévia não envia
  });
});
