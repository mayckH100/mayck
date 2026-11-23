import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { registerClient, installGraphMock, prisma, uniq, type Client } from '../helpers.js';
import { qrManager, type QrSocket } from '../../server/whatsapp/qr/manager.js';
import { tick, resetDispatcherState, setRandom, personalize, PAUSA_OFFLINE, RETOMADA_OFFLINE } from '../../server/mckmensagem/dispatcher.js';
import { openConversationFor } from '../../server/whatsapp/multiCanal.js';

/** v1.46.1: campanha não queima a lista quando o WhatsApp cai; falha de conexão volta para a fila; nunca reenvia para quem já recebeu. */
describe('v1.46.1 — campanha com WhatsApp desconectado', () => {
  let owner: Client;
  let other: Client;
  let channelId: string;
  const sent: string[] = [];
  let erro: string | null = null; // próximo envio lança este erro (simula queda/erro do WhatsApp)
  let k = 0;
  const sock: QrSocket = {
    user: { id: '5511993195555:7@s.whatsapp.net' },
    async sendMessage(jid) {
      if (erro) throw new Error(erro);
      sent.push(jid.split('@')[0]);
      return { key: { id: `OFF${++k}${uniq()}` } };
    },
    async sendPresenceUpdate() { /* digitando */ },
    signalRepository: { lidMapping: { async getPNForLID() { return null; }, async getLIDForPN() { return null; } } },
  };
  let phone = 5511765000000;
  const conectar = () => qrManager.attachForTests(channelId, sock, 'CONNECTED');
  const desconectar = () => qrManager.attachForTests(channelId, null, 'NOT_CONNECTED');
  const acao = async (id: string, t: number) => (await tick(new Date(t))).find((x) => x.campaignId === id)?.action;
  const recs = (id: string) => prisma.campaignRecipient.findMany({ where: { campaignId: id }, orderBy: { id: 'asc' } });

  async function campanha(n: number, extra: Record<string, unknown> = {}) {
    const orgId = owner.me.org.id;
    const c = await prisma.campaign.create({ data: { orgId, name: `Off ${uniq()}`, message: 'Oi {nome}! Novidade da loja.', channelId, status: 'EM_ANDAMENTO', dailyLimit: 1000, minIntervalSec: 10, maxIntervalSec: 10, windowStart: '00:00', windowEnd: '23:59', ...extra } });
    const leads = [];
    for (let i = 0; i < n; i++) {
      const lead = await prisma.lead.create({ data: { orgId, phone: `+${++phone}`, name: `Pessoa${i}`, consentSource: 'MANUAL', consentAt: new Date() } });
      await prisma.campaignRecipient.create({ data: { campaignId: c.id, leadId: lead.id } });
      leads.push(lead);
    }
    return { c, leads };
  }

  /** Grava uma mensagem da campanha que JÁ SAIU para o lead (status SENT/DELIVERED/READ). */
  async function mensagemJaEnviada(c: { id: string; message: string }, lead: { id: string; phone: string; name: string | null }, status: string) {
    const orgId = owner.me.org.id;
    const waId = lead.phone.replace(/\D/g, '');
    const contact = await prisma.contact.create({ data: { orgId, waId, phone: lead.phone, name: lead.name } });
    await prisma.lead.update({ where: { id: lead.id }, data: { contactId: contact.id } });
    const conv = await openConversationFor(orgId, contact.id, channelId);
    return prisma.message.create({ data: { orgId, conversationId: conv.id, channelId, direction: 'OUT', sender: 'bot', type: 'text', body: personalize(c.message, lead), status, bulk: true } });
  }

  beforeAll(async () => {
    installGraphMock();
    owner = await registerClient();
    other = await registerClient();
    const r = await owner.post('/api/channels', { name: 'Celular campanha' });
    channelId = r.body.id;
    await prisma.channel.update({ where: { id: channelId }, data: { status: 'CONNECTED' } });
    setRandom(() => 0);
  });
  beforeEach(async () => {
    sent.length = 0; erro = null;
    conectar();
    resetDispatcherState();
    await prisma.campaign.updateMany({ where: { status: 'EM_ANDAMENTO' }, data: { status: 'PAUSADA' } });
  });
  afterAll(() => { setRandom(null); qrManager.resetForTests(); });

  it('1) WhatsApp desconectado: não toca nos destinatários, avisa uma vez e retoma sozinha ao reconectar', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const { c } = await campanha(3);
      desconectar();
      const t0 = Date.now();
      for (let i = 0; i < 4; i++) expect(await acao(c.id, t0 + i * 60_000)).toBe('channel_offline');
      expect(sent).toHaveLength(0);
      expect((await recs(c.id)).every((r) => r.status === 'PENDENTE' && r.tentativas === 0 && !r.error)).toBe(true);
      const parada = await prisma.campaign.findUniqueOrThrow({ where: { id: c.id } });
      expect(parada.offlinePausa).toBe(PAUSA_OFFLINE);
      expect(parada.status).toBe('EM_ANDAMENTO');
      const avisos = () => warn.mock.calls.filter((a) => JSON.stringify(a).includes(c.id));
      expect(avisos().filter((a) => JSON.stringify(a).includes(PAUSA_OFFLINE))).toHaveLength(1); // aviso uma vez só
      // Tela da campanha mostra o aviso.
      expect((await owner.get(`/api/mckmensagem/campaigns/${c.id}`)).body.offlinePausa).toBe(PAUSA_OFFLINE);

      conectar();
      expect(await acao(c.id, t0 + 10 * 60_000)).toBe('sent');
      const volta = await prisma.campaign.findUniqueOrThrow({ where: { id: c.id } });
      expect(volta.offlinePausa).toBeNull();
      expect(avisos().filter((a) => JSON.stringify(a).includes(RETOMADA_OFFLINE))).toHaveLength(1);
      // Continua respeitando o intervalo da campanha e termina a lista sem repetir ninguém.
      expect(await acao(c.id, t0 + 10 * 60_000 + 1_000)).toBe('waiting_interval');
      expect(await acao(c.id, t0 + 11 * 60_000)).toBe('sent');
      expect(await acao(c.id, t0 + 12 * 60_000)).toBe('sent');
      expect(await acao(c.id, t0 + 13 * 60_000)).toBe('completed');
      expect(new Set(sent).size).toBe(3);
      expect((await recs(c.id)).every((r) => r.status === 'ENVIADA')).toBe(true);
    } finally { warn.mockRestore(); }
  });

  it('1b) respeita a janela de horário: fora dela não marca aviso de desconexão nem envia', async () => {
    const { c } = await campanha(1, { windowStart: '03:00', windowEnd: '03:01' });
    desconectar();
    const at10 = new Date(Date.UTC(2026, 10, 23, 13, 0, 0)); // 10:00 em Brasília
    expect(await acao(c.id, at10.getTime())).toBe('outside_window');
    expect((await prisma.campaign.findUniqueOrThrow({ where: { id: c.id } })).offlinePausa).toBeNull();
  });

  it('2) falha de conexão volta para PENDENTE (até 3 tentativas); erro definitivo continua FALHOU', async () => {
    const { c } = await campanha(2);
    const t0 = Date.now();
    erro = 'Connection Closed';
    expect(await acao(c.id, t0)).toBe('retry_later');
    let [a] = await recs(c.id);
    expect(a.status).toBe('PENDENTE');
    expect(a.tentativas).toBe(1);
    expect(a.error).toMatch(/tentativa 1 de 3/);
    // Espera mais que o intervalo normal antes de tentar de novo.
    expect(await acao(c.id, t0 + 60_000)).toBe('waiting_interval');
    expect(await acao(c.id, t0 + 3 * 60_000)).toBe('retry_later');
    expect(await acao(c.id, t0 + 6 * 60_000)).toBe('failed'); // 3ª falha de conexão → FALHOU
    [a] = await recs(c.id);
    expect(a.status).toBe('FALHOU');
    expect(a.tentativas).toBe(3);

    erro = 'O número não tem WhatsApp';
    expect(await acao(c.id, t0 + 9 * 60_000)).toBe('failed');
    const b = (await recs(c.id))[1];
    expect(b.status).toBe('FALHOU');
    expect(b.tentativas).toBe(0);
    expect(sent).toHaveLength(0);

    // Volta a conexão: a tentativa seguinte sai normalmente.
    const { c: c2 } = await campanha(1);
    erro = 'Timed Out';
    expect(await acao(c2.id, t0 + 20 * 60_000)).toBe('retry_later');
    erro = null;
    expect(await acao(c2.id, t0 + 23 * 60_000)).toBe('sent');
    const [r2] = await recs(c2.id);
    expect(r2.status).toBe('ENVIADA');
    expect(sent).toHaveLength(1);
  });

  it('3) "Reenviar os que falharam por desconexão": só FALHOU por conexão; nunca quem já recebeu', async () => {
    const { c, leads } = await campanha(6, { status: 'CONCLUIDA' });
    const rs = await recs(c.id);
    const byLead = (i: number) => rs.find((r) => r.leadId === leads[i].id)!;
    // 0: falhou por conexão, nunca recebeu → volta para a fila
    await prisma.campaignRecipient.update({ where: { id: byLead(0).id }, data: { status: 'FALHOU', error: 'WhatsApp (QR) não conectado: abra Canais WhatsApp e conecte pelo QR code' } });
    // 1: falhou por conexão, mas a mensagem guardada foi entregue → já recebeu, vira ENVIADA sem reenviar
    const m1 = await mensagemJaEnviada(c, leads[1], 'DELIVERED');
    await prisma.campaignRecipient.update({ where: { id: byLead(1).id }, data: { status: 'FALHOU', error: 'Connection Closed', messageId: m1.id } });
    // 2: ENVIADA (lida) → nunca mexe
    const m2 = await mensagemJaEnviada(c, leads[2], 'READ');
    await prisma.campaignRecipient.update({ where: { id: byLead(2).id }, data: { status: 'ENVIADA', sentAt: new Date(), messageId: m2.id } });
    // 3: erro definitivo → continua FALHOU
    await prisma.campaignRecipient.update({ where: { id: byLead(3).id }, data: { status: 'FALHOU', error: 'Número inválido' } });
    // 4: falhou por conexão, sem messageId, mas há mensagem em massa da campanha já lida na conversa → não reenvia
    await mensagemJaEnviada(c, leads[4], 'READ');
    await prisma.campaignRecipient.update({ where: { id: byLead(4).id }, data: { status: 'FALHOU', error: 'Timed Out' } });
    // 5: ignorado (opt-out) → nunca mexe
    await prisma.campaignRecipient.update({ where: { id: byLead(5).id }, data: { status: 'IGNORADA', error: 'Lead pediu para não receber mensagens (opt-out)' } });

    const view = await owner.get(`/api/mckmensagem/campaigns/${c.id}`);
    expect(view.body.falhasConexao).toBe(3);
    // Outra empresa não mexe na campanha.
    expect((await other.post(`/api/mckmensagem/campaigns/${c.id}/reenviar-falhas-conexao`, {})).status).toBe(404);

    const r = await owner.post(`/api/mckmensagem/campaigns/${c.id}/reenviar-falhas-conexao`, {});
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ devolvidos: 1, jaRecebidos: 2, status: 'EM_ANDAMENTO', falhasConexao: 0 });
    const depois = await recs(c.id);
    const st = (i: number) => depois.find((x) => x.leadId === leads[i].id)!;
    expect(st(0).status).toBe('PENDENTE');
    expect(st(1)).toMatchObject({ status: 'ENVIADA', messageId: m1.id });
    expect(st(2)).toMatchObject({ status: 'ENVIADA', messageId: m2.id });
    expect(st(3).status).toBe('FALHOU');
    expect(st(4).status).toBe('ENVIADA');
    expect(st(5).status).toBe('IGNORADA');

    // Rodando de novo não devolve ninguém (nada duplicado).
    expect((await owner.post(`/api/mckmensagem/campaigns/${c.id}/reenviar-falhas-conexao`, {})).body).toMatchObject({ devolvidos: 0, jaRecebidos: 0 });

    // A campanha volta a andar e envia SÓ para o 0.
    const t0 = Date.now() + 60_000; // depois do intervalo da campanha (há envios marcados agora)
    expect(await acao(c.id, t0)).toBe('sent');
    expect(await acao(c.id, t0 + 60_000)).toBe('completed');
    expect(sent).toEqual([leads[0].phone.replace(/\D/g, '')]);
  });

  it('4) proteção contra duplicidade no envio: quem já tem a mensagem da campanha não recebe de novo', async () => {
    const { c, leads } = await campanha(2);
    await mensagemJaEnviada(c, leads[0], 'DELIVERED'); // ex.: enviada antes de o servidor cair no meio do passo
    const t0 = Date.now();
    expect(await acao(c.id, t0)).toBe('sent');
    expect(sent).toEqual([leads[1].phone.replace(/\D/g, '')]);
    const [a, b] = await recs(c.id);
    expect(a.status).toBe('ENVIADA');
    expect(b.status).toBe('ENVIADA');
    expect(await acao(c.id, t0 + 60_000)).toBe('completed');
    expect(sent).toHaveLength(1);
  });

  it('4b) mensagem anterior que FALHOU não conta como recebida (reenvia normalmente)', async () => {
    const { c, leads } = await campanha(1);
    const m = await mensagemJaEnviada(c, leads[0], 'FAILED');
    await prisma.campaignRecipient.updateMany({ where: { campaignId: c.id }, data: { messageId: m.id, tentativas: 1 } });
    expect(await acao(c.id, Date.now())).toBe('sent');
    expect(sent).toEqual([leads[0].phone.replace(/\D/g, '')]);
  });
});
