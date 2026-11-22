import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { registerClient, prisma, uniq, type Client } from '../helpers.js';
import { qrManager, type QrSocket } from '../../server/whatsapp/qr/manager.js';
import { handleQrMessage } from '../../server/whatsapp/inbound.js';
import { tickAquecimento, enviarAquecimento, setAquecimentoRandom } from '../../server/whatsapp/aquecimento/service.js';
import { fakeAi } from '../../server/ai/providers.js';
import type { AnyMessageContent, WAMessage } from '@whiskeysockets/baileys';

type Envio = { jid: string; content: AnyMessageContent; messageId?: string };

function mockSock(id: string) {
  const enviados: Envio[] = [], presencas: string[] = [], lidas: unknown[] = [];
  let k = 0;
  const sock: QrSocket = {
    user: { id: `${id}:3@s.whatsapp.net` },
    async sendMessage(jid, content, options) { enviados.push({ jid, content, messageId: options?.messageId }); return { key: { id: options?.messageId ?? `AQ${++k}${uniq()}` } }; },
    async sendPresenceUpdate(type) { presencas.push(type); },
    async readMessages(keys) { lidas.push(...keys); },
    signalRepository: { lidMapping: { async getPNForLID() { return null; }, async getLIDForPN() { return null; } } },
  };
  return { sock, enviados, presencas, lidas, reset() { enviados.length = 0; presencas.length = 0; lidas.length = 0; } };
}

const textos = (e: Envio[]) => e.filter((x) => 'text' in (x.content as object)).map((x) => (x.content as { text: string }).text);
// Amanhã às 11h de Brasília (dentro da janela 8h–21h).
const amanha = (h: number, m = 0) => { const d = new Date(); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, h + 3, m)); };

function rawDe(fromPhone: string, id: string, text: string): WAMessage {
  return { key: { remoteJid: `${fromPhone}@s.whatsapp.net`, fromMe: false, id }, message: { conversation: text }, messageTimestamp: Math.floor(Date.now() / 1000), pushName: 'Teste' } as unknown as WAMessage;
}

describe('v1.45.0 — aquecimento ativo entre os números da própria empresa', () => {
  let owner: Client;
  let A: string, B: string;
  const telA = '5511955510001', telB = '5511955510002';
  const sa = mockSock(telA), sb = mockSock(telB);
  const org = () => owner.me.org.id;

  beforeAll(async () => {
    owner = await registerClient();
    A = (await owner.post('/api/channels', { name: 'Número A' })).body.id;
    B = (await owner.post('/api/channels', { name: 'Número B' })).body.id;
    await prisma.channel.update({ where: { id: A }, data: { status: 'CONNECTED', displayPhone: `+${telA}`, waJid: `${telA}:3@s.whatsapp.net` } });
    await prisma.channel.update({ where: { id: B }, data: { status: 'CONNECTED', displayPhone: `+${telB}`, waJid: `${telB}:3@s.whatsapp.net` } });
    qrManager.attachForTests(A, sa.sock, 'CONNECTED');
    qrManager.attachForTests(B, sb.sock, 'CONNECTED');
    // IA ligada e respondendo sozinha: mensagens de aquecimento NÃO podem acioná-la.
    await prisma.aiSettings.upsert({ where: { orgId: org() }, create: { orgId: org(), enabled: true, autoReply: true, provider: 'fake', model: 'fake-1' }, update: { enabled: true, autoReply: true, provider: 'fake', model: 'fake-1' } });
    setAquecimentoRandom(() => 0.5);
  });
  beforeEach(() => { sa.reset(); sb.reset(); delete process.env.AQUECIMENTO; });
  afterAll(() => { setAquecimentoRandom(null); qrManager.resetForTests(); delete process.env.AQUECIMENTO; });

  it('tela: status desligado com aviso de número novo; ligar mostra dia 1 de 14; validação', async () => {
    const s0 = await owner.get(`/api/channels/${A}/aquecimento`);
    expect(s0.status).toBe(200);
    expect(s0.body).toMatchObject({ qr: true, rodando: false, avisoNumeroNovo: true, config: { enabled: false, days: 14, startHour: 8, endHour: 21 } });
    expect(s0.body.pares.map((p: any) => p.id)).toEqual([B]);
    expect((await owner.put(`/api/channels/${A}/aquecimento`, { enabled: true, startHour: 20, endHour: 19 })).status).toBe(400);
    expect((await owner.put(`/api/channels/${A}/aquecimento`, { enabled: true, peerChannelIds: ['outro-canal'] })).status).toBe(400);
    const r = await owner.put(`/api/channels/${A}/aquecimento`, { enabled: true });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ dia: 1, dias: 14, avisoNumeroNovo: false, config: { enabled: true } });
    expect(r.body.faixaHoje).toEqual({ min: 10, max: 15 });
    const audit = await prisma.auditLog.findFirst({ where: { orgId: org(), action: 'channel.aquecimento' } });
    expect(audit).toBeTruthy();
  });

  it('outra empresa não vê nem altera o aquecimento', async () => {
    const outro = await registerClient();
    expect((await outro.get(`/api/channels/${A}/aquecimento`)).status).toBe(404);
    expect((await outro.put(`/api/channels/${A}/aquecimento`, { enabled: false })).status).toBe(404);
  });

  it('conversa de ida e volta: A inicia com "digitando…", B recebe fora do Inbox (sem IA/fluxos) e responde depois', async () => {
    await prisma.warmupConfig.update({ where: { channelId: A }, data: { nextAt: null } });
    fakeAi.script.push('["Bom dia! Já tomou café?", "Já sim, e você? ☕", "Ainda não, indo agora", "Aproveita!"]');
    const now = amanha(11);
    const r = await tickAquecimento(now);
    expect(r.find((x) => x.channelId === A)?.acao).toBe('iniciada');
    expect(textos(sa.enviados)).toEqual(['Bom dia! Já tomou café?']);
    expect(sa.enviados[0].jid).toBe(`${telB}@s.whatsapp.net`);
    expect(sa.enviados[0].messageId).toBeTruthy();
    expect(sa.presencas).toEqual(['composing', 'paused']);
    const ex = await prisma.warmupExchange.findFirstOrThrow({ where: { initiatorChannelId: A } });
    expect(ex).toMatchObject({ status: 'PENDENTE', nextIndex: 1, source: 'ia' });
    expect(ex.dueAt.getTime()).toBeGreaterThan(now.getTime() + 30_000);
    // Nada em Message/Conversation/Contact.
    expect(await prisma.message.count({ where: { orgId: org() } })).toBe(0);

    // B recebe (mesmo id da mensagem enviada por A).
    const chamadasIa = fakeAi.calls.length;
    const res = await handleQrMessage(B, rawDe(telA, sa.enviados[0].messageId!, 'Bom dia! Já tomou café?'));
    expect(res).toBe('aquecimento');
    expect(await prisma.message.count({ where: { orgId: org() } })).toBe(0);
    expect(await prisma.conversation.count({ where: { orgId: org() } })).toBe(0);
    expect(await prisma.contact.count({ where: { orgId: org() } })).toBe(0);
    expect(await prisma.lead.count({ where: { orgId: org() } })).toBe(0);
    expect(fakeAi.calls.length).toBe(chamadasIa); // IA não foi chamada
    expect(textos(sb.enviados)).toEqual([]); // nenhuma resposta automática de robô/IA/fluxo
    expect(sb.lidas).toHaveLength(1); // marcada como lida
    expect(await prisma.warmupMessage.count({ where: { channelId: B, direction: 'IN' } })).toBe(1);
    // Repetida: não duplica.
    expect(await handleQrMessage(B, rawDe(telA, sa.enviados[0].messageId!, 'Bom dia! Já tomou café?'))).toBe('aquecimento');
    expect(await prisma.warmupMessage.count({ where: { channelId: B, direction: 'IN' } })).toBe(1);

    // Antes do atraso: B não responde. Depois: responde.
    await tickAquecimento(new Date(now.getTime() + 10_000));
    expect(textos(sb.enviados)).toEqual([]);
    await tickAquecimento(new Date(ex.dueAt.getTime() + 1000));
    expect(textos(sb.enviados)).toEqual(['Já sim, e você? ☕']);
    expect(sb.enviados.find((e) => 'text' in (e.content as object))!.jid).toBe(`${telA}@s.whatsapp.net`);
    const ex2 = await prisma.warmupExchange.findUniqueOrThrow({ where: { id: ex.id } });
    expect(ex2).toMatchObject({ status: 'PENDENTE', nextIndex: 2 });

    // Saúde do número: aquecimento contado à parte.
    const saude = await owner.get(`/api/channels/${A}/saude`);
    expect(saude.body.numeros).toHaveProperty('aquecimento7d');
    expect(saude.body.numeros.enviadosHoje).toBe(0);
  });

  it('mensagem de outro número próprio sem aquecimento recente segue o caminho normal; contato real também', async () => {
    const tel = '5511955519999';
    const r = await handleQrMessage(B, rawDe(tel, `REAL${uniq()}`, 'Olá, quero um orçamento'));
    expect(r).toBe('ok');
    expect(await prisma.message.count({ where: { orgId: org(), direction: 'IN' } })).toBe(1);
  });

  it('nunca envia para contato que não é número próprio', async () => {
    const ch = await prisma.channel.findUniqueOrThrow({ where: { id: A } });
    expect(await enviarAquecimento({ from: ch, para: '5511955519999', texto: 'Oi' })).toBe(false);
    expect(await enviarAquecimento({ from: ch, para: telA, texto: 'Oi' })).toBe(false); // nem para si mesmo
    expect(sa.enviados).toHaveLength(0);
    expect(await enviarAquecimento({ from: ch, para: telB, texto: 'Oi' })).toBe(true);
    expect(sa.enviados).toHaveLength(1);
  });

  it('números extras: exigem confirmação, no máximo 5, e só eles recebem avulsas', async () => {
    expect((await owner.post('/api/channels/aquecimento/extras', { phone: '11 95551-7777' })).status).toBe(400);
    expect((await owner.post('/api/channels/aquecimento/extras', { phone: '11 95551-7777', confirm: false })).status).toBe(400);
    const ok = await owner.post('/api/channels/aquecimento/extras', { phone: '11 95551-7777', label: 'Meu celular', confirm: true });
    expect(ok.status).toBe(201);
    expect(ok.body.phone).toBe('5511955517777');
    expect((await owner.post('/api/channels/aquecimento/extras', { phone: '5511955517777', confirm: true })).status).toBe(400); // repetido
    for (let i = 0; i < 4; i++) expect((await owner.post('/api/channels/aquecimento/extras', { phone: `1195552000${i}`, confirm: true })).status).toBe(201);
    expect((await owner.post('/api/channels/aquecimento/extras', { phone: '11955529999', confirm: true })).status).toBe(400); // 6º
    const ch = await prisma.channel.findUniqueOrThrow({ where: { id: A } });
    expect(await enviarAquecimento({ from: ch, para: '5511955517777', texto: 'Oi, tudo bem?' })).toBe(true);
    // Resposta do celular pessoal logo depois: também fica fora do Inbox.
    const antes = await prisma.message.count({ where: { orgId: org() } });
    expect(await handleQrMessage(A, rawDe('5511955517777', `EXT${uniq()}`, 'Tudo ótimo!'))).toBe('aquecimento');
    expect(await prisma.message.count({ where: { orgId: org() } })).toBe(antes);
    const list = await owner.get('/api/channels/aquecimento/extras');
    for (const e of list.body) expect((await owner.del(`/api/channels/aquecimento/extras/${e.id}`)).status).toBe(200);
  });

  it('fora do horário (21h–8h) não envia', async () => {
    await prisma.warmupExchange.updateMany({ where: { orgId: org() }, data: { status: 'CONCLUIDA' } });
    await prisma.warmupConfig.update({ where: { channelId: A }, data: { nextAt: null } });
    const r = await tickAquecimento(amanha(22, 30));
    expect(r.find((x) => x.channelId === A)?.acao).toBe('fora_horario');
    expect(sa.enviados).toHaveLength(0);
    const cfg = await prisma.warmupConfig.findUniqueOrThrow({ where: { channelId: A } });
    expect(cfg.nextAt!.getTime()).toBeGreaterThanOrEqual(amanha(32).getTime()); // dia seguinte, a partir das 8h
  });

  it('número em Risco: pausa o aquecimento (não inicia nem responde) e mostra o motivo', async () => {
    await prisma.warmupConfig.update({ where: { channelId: A }, data: { nextAt: null } });
    const ev = await prisma.channelHealthEvent.create({ data: { channelId: A, orgId: org(), type: 'restricao', detail: 'teste' } });
    // Conversa pendente em que A deveria responder também é cancelada.
    const pend = await prisma.warmupExchange.create({ data: { orgId: org(), initiatorChannelId: B, peerChannelId: A, lines: JSON.stringify(['Oi', 'Oi!']), nextIndex: 1, dueAt: new Date(Date.now() - 1000), status: 'PENDENTE' } });
    const r = await tickAquecimento(amanha(11));
    expect(r.find((x) => x.channelId === A && x.acao === 'risco')).toBeTruthy();
    expect(sa.enviados).toHaveLength(0);
    expect((await prisma.warmupExchange.findUniqueOrThrow({ where: { id: pend.id } })).status).toBe('CANCELADA');
    expect((await prisma.warmupConfig.findUniqueOrThrow({ where: { channelId: A } })).pausedReason).toBe('risco');
    const s = await owner.get(`/api/channels/${A}/aquecimento`);
    expect(s.body).toMatchObject({ rodando: false, motivo: 'risco' });
    await prisma.channelHealthEvent.delete({ where: { id: ev.id } });
  });

  it('desconectado pausa; AQUECIMENTO=off para tudo; desligar cancela conversas pendentes', async () => {
    await prisma.warmupConfig.update({ where: { channelId: A }, data: { nextAt: null } });
    qrManager.attachForTests(A, null, 'NOT_CONNECTED');
    const r = await tickAquecimento(amanha(11));
    expect(r.find((x) => x.channelId === A)?.acao).toBe('desconectado');
    qrManager.attachForTests(A, sa.sock, 'CONNECTED');

    process.env.AQUECIMENTO = 'off';
    await prisma.warmupConfig.update({ where: { channelId: A }, data: { nextAt: null } });
    expect(await tickAquecimento(amanha(11))).toEqual([]);
    expect(sa.enviados).toHaveLength(0);
    expect((await owner.get(`/api/channels/${A}/aquecimento`)).body.motivo).toBe('ambiente');
    delete process.env.AQUECIMENTO;

    const pend = await prisma.warmupExchange.create({ data: { orgId: org(), initiatorChannelId: A, peerChannelId: B, lines: JSON.stringify(['Oi', 'Oi!']), nextIndex: 1, dueAt: amanha(12), status: 'PENDENTE' } });
    const off = await owner.put(`/api/channels/${A}/aquecimento`, { enabled: false });
    expect(off.status).toBe(200);
    expect((await prisma.warmupExchange.findUniqueOrThrow({ where: { id: pend.id } })).status).toBe('CANCELADA');
    expect(await tickAquecimento(amanha(11))).toEqual([]);
  });

  it('claim atômico: dois passos ao mesmo tempo enviam a resposta uma vez só', async () => {
    await owner.put(`/api/channels/${A}/aquecimento`, { enabled: false });
    const ex = await prisma.warmupExchange.create({ data: { orgId: org(), initiatorChannelId: A, peerChannelId: B, lines: JSON.stringify(['Oi', 'Tudo bem?']), nextIndex: 1, dueAt: new Date(amanha(11).getTime() - 1000), status: 'PENDENTE' } });
    await Promise.all([tickAquecimento(amanha(11)), tickAquecimento(amanha(11))]);
    expect(textos(sb.enviados)).toEqual(['Tudo bem?']);
    expect((await prisma.warmupExchange.findUniqueOrThrow({ where: { id: ex.id } })).status).toBe('CONCLUIDA');
  });

  it('API oficial não tem aquecimento ativo', async () => {
    const c = await owner.post('/api/channels', { name: 'Oficial', provider: 'whatsapp_cloud' });
    expect((await owner.put(`/api/channels/${c.body.id}/aquecimento`, { enabled: true })).status).toBe(400);
  });
});
