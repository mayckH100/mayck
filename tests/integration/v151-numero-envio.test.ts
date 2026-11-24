import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { registerClient, prisma, uniq, type Client } from '../helpers.js';
import { qrManager, type QrSocket } from '../../server/whatsapp/qr/manager.js';
import { tick, resetDispatcherState, setRandom, PAUSA_RISCO_AUTO, PAUSA_OFFLINE_FIXO } from '../../server/mckmensagem/dispatcher.js';
import { registrarEventoSaude, resetProtecaoState } from '../../server/whatsapp/protecao/service.js';
import { CONFIRMAR_RISCO } from '../../server/mckmensagem/campanhaCore.js';

/**
 * v1.51.0: "Escolher número de envio" na campanha. A responsável escolhe o número (inclusive em Risco, com
 * "Enviar mesmo assim"); o disparador usa esse número sem pular nem trocar pelo rodízio. Envio só para sockets falsos.
 */
describe('v1.51.0 — campanha com número de envio escolhido (mesmo em Risco)', () => {
  let owner: Client;
  let other: Client;
  const sent: { canal: string; to: string }[] = [];
  let k = 0;
  const sockDe = (canal: string): QrSocket => ({
    user: { id: `55119941${String(Math.floor(Math.random() * 1e5)).padStart(5, '0')}:7@s.whatsapp.net` },
    async sendMessage(jid) { sent.push({ canal, to: jid.split('@')[0] }); return { key: { id: `V151${++k}${uniq()}` } }; },
    async sendPresenceUpdate() { /* digitando */ },
    signalRepository: { lidMapping: { async getPNForLID() { return null; }, async getLIDForPN() { return null; } } },
  });
  let phone = 5511766000000;
  const SEG = new Date('Mon 2026-11-23 3:00 PM (UTC-03:00)').getTime();
  const base = { message: 'Oi {nome}! Oferta. Responda SAIR para não receber mais.', dailyLimit: 100, minIntervalSec: 10, maxIntervalSec: 10, windowStart: '00:00', windowEnd: '23:59' };

  async function novoCanal(cli: Client = owner, conectar = true) {
    const r = await cli.post('/api/channels', { name: `Celular ${uniq()}` });
    const id = r.body.id as string;
    if (conectar) {
      await prisma.channel.update({ where: { id }, data: { status: 'CONNECTED' } });
      qrManager.attachForTests(id, sockDe(id), 'CONNECTED');
    }
    return id;
  }
  const emRisco = (id: string) => registrarEventoSaude(id, 'restricao', 'Sessão inválida (código 403)');
  async function filaDe(campaignId: string, n: number) {
    for (let i = 0; i < n; i++) {
      const lead = await prisma.lead.create({ data: { orgId: owner.me.org.id, phone: `+${++phone}`, name: `Pessoa${phone % 1000}`, consentSource: 'MANUAL', consentAt: new Date(), campaignId } });
      await prisma.campaignRecipient.create({ data: { campaignId, leadId: lead.id } });
    }
    await prisma.campaign.update({ where: { id: campaignId }, data: { status: 'EM_ANDAMENTO' } });
  }
  const acao = async (id: string, t: number) => (await tick(new Date(t))).find((x) => x.campaignId === id)?.action;

  beforeAll(async () => {
    owner = await registerClient();
    other = await registerClient();
    setRandom(() => 0);
  });
  beforeEach(async () => {
    sent.length = 0;
    resetDispatcherState();
    resetProtecaoState();
    await prisma.campaign.updateMany({ where: { status: { in: ['EM_ANDAMENTO', 'AGENDADA'] } }, data: { status: 'PAUSADA' } });
  });
  afterAll(() => { setRandom(null); qrManager.resetForTests(); });

  it('lista de números mostra todos da empresa, com conexão e nível (inclusive em Risco e desconectado); isolada por empresa', async () => {
    const ok = await novoCanal();
    const risco = await novoCanal();
    const fora = await novoCanal(owner, false);
    const alheio = await novoCanal(other);
    await emRisco(risco);
    const r = await owner.get('/api/mckmensagem/numeros-envio');
    expect(r.status).toBe(200);
    const por = Object.fromEntries(r.body.map((n: any) => [n.id, n]));
    expect(por[ok]).toMatchObject({ conectado: true });
    expect(por[ok].nivel).not.toBe('RISCO');
    expect(por[risco]).toMatchObject({ conectado: true, nivel: 'RISCO' });
    expect(por[risco].motivos.length).toBeGreaterThan(0);
    expect(por[fora]).toMatchObject({ conectado: false });
    expect(por[alheio]).toBeUndefined();
  });

  it('número em Risco sem confirmação é recusado (409); com "Enviar mesmo assim" grava quem e quando e o disparo sai por ele', async () => {
    const risco = await novoCanal();
    await emRisco(risco);
    const sem = await owner.post('/api/mckmensagem/campaigns', { name: `Fixo ${uniq()}`, ...base, channelId: risco, envioFixo: true });
    expect(sem.status).toBe(409);
    expect(sem.body.details.codigo).toBe(CONFIRMAR_RISCO);
    expect(sem.body.error).toMatch(/Risco/);

    const com = await owner.post('/api/mckmensagem/campaigns', { name: `Fixo ${uniq()}`, ...base, channelId: risco, envioFixo: true, confirmarRisco: true });
    expect(com.status).toBe(201);
    expect(com.body).toMatchObject({ envioFixo: true, riscoLiberado: true, riscoLiberadoCanalId: risco, riscoLiberadoPor: owner.me.user.id });
    expect(com.body.riscoLiberadoEm).toBeTruthy();
    expect(com.body.riscoLiberadoPorNome).toBeTruthy();
    expect(await prisma.auditLog.count({ where: { action: 'mckmensagem.campaign.risco_liberado', entityId: com.body.id } })).toBe(1);

    await filaDe(com.body.id, 2);
    expect(await acao(com.body.id, SEG)).toBe('sent');
    expect(sent).toHaveLength(1);
    expect(sent[0].canal).toBe(risco);
    const c = await prisma.campaign.findUniqueOrThrow({ where: { id: com.body.id } });
    expect(c.riscoPausa).toBeNull();
    // Os outros limites continuam: o intervalo da campanha segura o próximo envio.
    expect(await acao(com.body.id, SEG + 1000)).toBe('waiting_interval');

    // Editar só o nome não pede confirmação de novo; trocar para outro número em Risco pede.
    expect((await owner.patch(`/api/mckmensagem/campaigns/${com.body.id}`, { name: 'Renomeada', channelId: risco, envioFixo: true })).status).toBe(200);
    const risco2 = await novoCanal();
    await emRisco(risco2);
    const troca = await owner.patch(`/api/mckmensagem/campaigns/${com.body.id}`, { channelId: risco2 });
    expect(troca.status).toBe(409);
    // Voltar ao automático apaga a confirmação.
    const auto = await owner.patch(`/api/mckmensagem/campaigns/${com.body.id}`, { envioFixo: false });
    expect(auto.status).toBe(200);
    expect(auto.body).toMatchObject({ envioFixo: false, riscoLiberado: false, riscoLiberadoEm: null });
  });

  it('sem confirmação (automático ou número saudável que entrou em Risco depois) a trava de Risco continua igual', async () => {
    const canal = await novoCanal();
    const fixo = await owner.post('/api/mckmensagem/campaigns', { name: `Fixo ${uniq()}`, ...base, channelId: canal, envioFixo: true });
    expect(fixo.status).toBe(201);
    expect(fixo.body.riscoLiberado).toBe(false);
    const autoC = await owner.post('/api/mckmensagem/campaigns', { name: `Auto ${uniq()}`, ...base, channelId: canal });
    expect(autoC.status).toBe(201);
    expect(autoC.body.envioFixo).toBe(false);
    await emRisco(canal);
    await filaDe(fixo.body.id, 1);
    await filaDe(autoC.body.id, 1);
    const r = await tick(new Date(SEG));
    expect(r.find((x) => x.campaignId === fixo.body.id)?.action).toBe('number_risk');
    expect(r.find((x) => x.campaignId === autoC.body.id)?.action).toBe('number_risk');
    expect(sent).toHaveLength(0);
    expect((await prisma.campaign.findUniqueOrThrow({ where: { id: autoC.body.id } })).riscoPausa).toBe(PAUSA_RISCO_AUTO);
    // A responsável confirma depois pela edição: volta a enviar pelo mesmo número e o aviso de pausa sai.
    const conf = await owner.patch(`/api/mckmensagem/campaigns/${fixo.body.id}`, { confirmarRisco: true });
    expect(conf.status).toBe(200);
    expect(conf.body.riscoLiberado).toBe(true);
    expect(await acao(fixo.body.id, SEG + 60_000)).toBe('sent');
    expect(sent.map((s) => s.canal)).toEqual([canal]);
    expect((await prisma.campaign.findUniqueOrThrow({ where: { id: fixo.body.id } })).riscoPausa).toBeNull();
  });

  it('número fixo ignora o rodízio (não troca de número); automático com rodízio segue dividindo como antes', async () => {
    const a = await novoCanal();
    const b = await novoCanal();
    const fixo = await owner.post('/api/mckmensagem/campaigns', { name: `Fixo ${uniq()}`, ...base, channelId: a, envioFixo: true, rodizio: true, canaisRodizio: [b] });
    expect(fixo.status).toBe(201);
    await filaDe(fixo.body.id, 4);
    for (let i = 0; i < 4; i++) await acao(fixo.body.id, SEG + i * 20_000);
    expect(sent.map((s) => s.canal)).toEqual([a, a, a, a]);

    sent.length = 0;
    const rod = await owner.post('/api/mckmensagem/campaigns', { name: `Rod ${uniq()}`, ...base, channelId: a, rodizio: true, canaisRodizio: [b] });
    await filaDe(rod.body.id, 6);
    await prisma.campaign.update({ where: { id: fixo.body.id }, data: { status: 'PAUSADA' } });
    for (let i = 0; i < 12; i++) await acao(rod.body.id, SEG + 3_600_000 + i * 20_000);
    expect(new Set(sent.map((s) => s.canal))).toEqual(new Set([a, b]));
  });

  it('número de outra empresa é recusado; membro sem permissão no número é barrado (403)', async () => {
    const alheio = await novoCanal(other);
    await emRisco(alheio);
    const r = await owner.post('/api/mckmensagem/campaigns', { name: `X ${uniq()}`, ...base, channelId: alheio, envioFixo: true, confirmarRisco: true });
    expect(r.status).toBe(400);
    const meu = await owner.post('/api/mckmensagem/campaigns', { name: `X ${uniq()}`, ...base, channelId: await novoCanal() });
    expect((await owner.patch(`/api/mckmensagem/campaigns/${meu.body.id}`, { channelId: alheio, envioFixo: true, confirmarRisco: true })).status).toBe(400);
    expect(await prisma.campaign.count({ where: { channelId: alheio, orgId: owner.me.org.id } })).toBe(0);

    // ADMIN com acesso só a um número não pode fixar outro.
    const permitido = await novoCanal();
    const negado = await novoCanal();
    const where = { userId_orgId: { userId: owner.me.user.id, orgId: owner.me.org.id } };
    await prisma.membership.update({ where, data: { role: 'ADMIN', channelIds: JSON.stringify([permitido]) } });
    try {
      expect((await owner.post('/api/mckmensagem/campaigns', { name: `Y ${uniq()}`, ...base, channelId: negado, envioFixo: true })).status).toBe(403);
      expect((await owner.post('/api/mckmensagem/campaigns', { name: `Y ${uniq()}`, ...base, channelId: permitido, envioFixo: true })).status).toBe(201);
      const lista = await owner.get('/api/mckmensagem/numeros-envio');
      expect(lista.body.map((n: any) => n.id)).toEqual([permitido]);
      // Atendente (AGENT) não edita campanha.
      await prisma.membership.update({ where, data: { role: 'AGENT', channelIds: null } });
      expect((await owner.post('/api/mckmensagem/campaigns', { name: `Z ${uniq()}`, ...base, channelId: permitido, envioFixo: true })).status).toBe(403);
    } finally {
      await prisma.membership.update({ where, data: { role: 'OWNER', channelIds: null } });
    }
  });

  it('número escolhido desconectado: não envia, não troca de número e mostra o motivo', async () => {
    const fora = await novoCanal(owner, false);
    const outro = await novoCanal();
    const c = await owner.post('/api/mckmensagem/campaigns', { name: `Off ${uniq()}`, ...base, channelId: fora, envioFixo: true, rodizio: true, canaisRodizio: [outro] });
    expect(c.status).toBe(201);
    await filaDe(c.body.id, 2);
    expect(await acao(c.body.id, SEG)).toBe('channel_offline');
    expect(sent).toHaveLength(0);
    expect((await owner.get(`/api/mckmensagem/campaigns/${c.body.id}`)).body.offlinePausa).toBe(PAUSA_OFFLINE_FIXO);
    expect(await prisma.campaignRecipient.count({ where: { campaignId: c.body.id, status: 'PENDENTE' } })).toBe(2);
  });
});
