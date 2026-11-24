import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { registerClient, installGraphMock, prisma, uniq, type Client } from '../helpers.js';
import { qrManager, type QrSocket } from '../../server/whatsapp/qr/manager.js';
import { tick, resetDispatcherState, setRandom } from '../../server/mckmensagem/dispatcher.js';
import { resetTestesCampanha, TESTE_LIMITE_HORA } from '../../server/mckmensagem/routes.js';
import { AB_ESPERA_MS } from '../../server/mckmensagem/variacoes.js';

/** v1.48.0: versões da mensagem (A/B), vencedora automática, início agendado, dias da semana, enviar teste e duplicar. */
describe('v1.48.0 — campanhas: versões, A/B, agenda, teste e duplicar', () => {
  let owner: Client;
  let other: Client;
  let channelId: string;
  const sent: { to: string; text: string }[] = [];
  let k = 0;
  const sock: QrSocket = {
    user: { id: '5511993196666:7@s.whatsapp.net' },
    async sendMessage(jid, content: any) {
      sent.push({ to: jid.split('@')[0], text: content?.text ?? '' });
      return { key: { id: `V148${++k}${uniq()}` } };
    },
    async sendPresenceUpdate() { /* digitando */ },
    signalRepository: { lidMapping: { async getPNForLID() { return null; }, async getLIDForPN() { return null; } } },
  };
  let phone = 5511766000000;
  const acao = async (id: string, t: number) => (await tick(new Date(t))).find((x) => x.campaignId === id)?.action;
  const recs = (id: string) => prisma.campaignRecipient.findMany({ where: { campaignId: id }, orderBy: { id: 'asc' } });
  // Segunda-feira 15h BRT (dia útil, dentro da janela).
  const SEG = new Date('2026-11-23T18:00:00Z').getTime();

  /** Número novo por campanha: a Saúde do número e os limites de proteção não se misturam entre os testes. */
  async function novoCanal() {
    const r = await owner.post('/api/channels', { name: `Celular ${uniq()}` });
    channelId = r.body.id;
    await prisma.channel.update({ where: { id: channelId }, data: { status: 'CONNECTED' } });
    qrManager.attachForTests(channelId, sock, 'CONNECTED');
  }
  async function campanha(n: number, extra: Record<string, unknown> = {}) {
    const orgId = owner.me.org.id;
    await novoCanal();
    const c = await prisma.campaign.create({ data: { orgId, name: `V148 ${uniq()}`, message: 'Oi {nome}! Versão A.', channelId, status: 'EM_ANDAMENTO', dailyLimit: 1000, minIntervalSec: 10, maxIntervalSec: 10, windowStart: '00:00', windowEnd: '23:59', ...extra } });
    const leads = [];
    for (let i = 0; i < n; i++) {
      const lead = await prisma.lead.create({ data: { orgId, phone: `+${++phone}`, name: `Pessoa${i} Silva`, consentSource: 'MANUAL', consentAt: new Date(), campaignId: c.id } });
      await prisma.campaignRecipient.create({ data: { campaignId: c.id, leadId: lead.id } });
      leads.push(lead);
    }
    return { c, leads };
  }
  async function enviarTodos(id: string, n: number, t0 = SEG) {
    for (let i = 0; i < n; i++) await acao(id, t0 + i * 20_000);
  }

  beforeAll(async () => {
    installGraphMock();
    owner = await registerClient();
    other = await registerClient();
    const r = await owner.post('/api/channels', { name: 'Celular v148' });
    channelId = r.body.id;
    await prisma.channel.update({ where: { id: channelId }, data: { status: 'CONNECTED' } });
    setRandom(() => 0);
  });
  beforeEach(async () => {
    sent.length = 0;
    qrManager.attachForTests(channelId, sock, 'CONNECTED');
    resetDispatcherState();
    resetTestesCampanha();
    await prisma.campaign.updateMany({ where: { status: { in: ['EM_ANDAMENTO', 'AGENDADA'] } }, data: { status: 'PAUSADA' } });
  });
  afterAll(() => { setRandom(null); qrManager.resetForTests(); });

  it('1) versões: cada contato recebe uma versão fixa (gravada no destinatário), com spintax e variáveis; resultado por versão na API', async () => {
    const { c, leads } = await campanha(12, { variacoes: JSON.stringify(['{Olá|Oi} {nome_completo}, versão B.']) });
    await enviarTodos(c.id, 13);
    const rs = await recs(c.id);
    expect(rs.every((r) => r.status === 'ENVIADA' && (r.variante === 0 || r.variante === 1))).toBe(true);
    expect(new Set(rs.map((r) => r.variante)).size).toBe(2);
    expect(sent).toHaveLength(12);
    for (const r of rs) {
      const lead = leads.find((l) => l.id === r.leadId)!;
      const msg = sent.find((s) => s.to === lead.phone.replace(/\D/g, ''))!;
      if (r.variante === 0) expect(msg.text).toBe(`Oi ${lead.name!.split(' ')[0]}! Versão A.`);
      else expect(msg.text).toMatch(new RegExp(`^(Olá|Oi) ${lead.name}, versão B\\.$`));
    }
    // Resposta de um contato da versão B aparece no resultado.
    const b = rs.find((r) => r.variante === 1)!;
    await prisma.campaignRecipient.update({ where: { id: b.id }, data: { respondeuAt: new Date() } });
    const view = (await owner.get(`/api/mckmensagem/campaigns/${c.id}`)).body;
    expect(view.variacoes).toEqual(['{Olá|Oi} {nome_completo}, versão B.']);
    expect(view.ab).toHaveLength(2);
    expect(view.ab[0].enviadas + view.ab[1].enviadas).toBe(12);
    expect(view.ab[1].respostas).toBe(1);
  });

  it('2) campanha sem versões continua igual (texto antigo, A/B nulo)', async () => {
    const { c, leads } = await campanha(2);
    await enviarTodos(c.id, 3);
    expect(sent.map((s) => s.text)).toEqual(leads.map((l) => `Oi ${l.name!.split(' ')[0]}! Versão A.`));
    expect((await owner.get(`/api/mckmensagem/campaigns/${c.id}`)).body.ab).toBeNull();
  });

  it('3) vencedora automática (ligada): depois do mínimo, o resto da fila recebe a vencedora; desligada nunca decide', async () => {
    for (const auto of [true, false]) {
      const { c } = await campanha(26, { variacoes: JSON.stringify(['Versão B {nome}']), abAutoVencedora: auto, abMinimo: 10 });
      const rs = await recs(c.id);
      const antigo = new Date(SEG - AB_ESPERA_MS - 60_000);
      // 20 já enviados há mais de 2 h: 10 de cada versão; B com 5 respostas, A com 1.
      for (let i = 0; i < 20; i++) {
        const v = i % 2;
        await prisma.campaignRecipient.update({ where: { id: rs[i].id }, data: { status: 'ENVIADA', sentAt: antigo, variante: v, respondeuAt: (v === 1 && i < 10) || i === 0 ? new Date(SEG) : null } });
      }
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      try { await enviarTodos(c.id, 7); } finally { warn.mockRestore(); }
      const depois = await prisma.campaign.findUniqueOrThrow({ where: { id: c.id } });
      const novos = (await recs(c.id)).slice(20);
      expect(novos.every((r) => r.status === 'ENVIADA')).toBe(true);
      if (auto) {
        expect(depois.abVencedora).toBe(1);
        expect(novos.every((r) => r.variante === 1)).toBe(true);
        expect(sent.every((s) => s.text.startsWith('Versão B'))).toBe(true);
      } else {
        expect(depois.abVencedora).toBeNull();
      }
      sent.length = 0; resetDispatcherState();
    }
  });

  it('4) API: salva versões (máx. 3), dias da semana e mínimo; mudar versões recomeça o A/B; 4 versões extras = 400', async () => {
    const cr = await owner.post('/api/mckmensagem/campaigns', { name: 'API v148', message: 'Oi {nome}', channelId, variacoes: ['B {nome}', '  ', 'C'], diasSemana: [5, 1, 2, 3, 4], abAutoVencedora: true, abMinimo: 20 });
    expect(cr.status).toBe(201);
    expect(cr.body.variacoes).toEqual(['B {nome}', 'C']);
    expect(cr.body.diasSemana).toBe('12345');
    expect(cr.body.abAutoVencedora).toBe(true);
    expect(cr.body.abMinimo).toBe(20);
    await prisma.campaign.update({ where: { id: cr.body.id }, data: { abVencedora: 1 } });
    const p1 = await owner.patch(`/api/mckmensagem/campaigns/${cr.body.id}`, { name: 'API v148 2' });
    expect(p1.body.abVencedora).toBe(1);
    const p2 = await owner.patch(`/api/mckmensagem/campaigns/${cr.body.id}`, { variacoes: ['B nova'] });
    expect(p2.body.variacoes).toEqual(['B nova']);
    expect(p2.body.abVencedora).toBeNull();
    expect((await owner.patch(`/api/mckmensagem/campaigns/${cr.body.id}`, { variacoes: ['1', '2', '3', '4'] })).status).toBe(400);
    expect((await owner.post('/api/mckmensagem/campaigns', { name: 'x', message: 'y', channelId, abMinimo: 2 })).status).toBe(400);
  });

  it('5) dias da semana: fora do dia não envia nada; no dia permitido envia', async () => {
    const { c } = await campanha(1, { diasSemana: '12345' });
    const DOM = new Date('2026-11-22T18:00:00Z').getTime();
    expect(await acao(c.id, DOM)).toBe('outside_day');
    expect(sent).toHaveLength(0);
    expect(await acao(c.id, SEG)).toBe('sent');
  });

  it('6) início agendado: fica AGENDADA sem enviar e começa sozinha na hora; pausar antes cancela; data passada = 400', async () => {
    const { c } = await campanha(0, { status: 'RASCUNHO' });
    const orgId = owner.me.org.id;
    const lead = await prisma.lead.create({ data: { orgId, phone: `+${++phone}`, name: 'Agendado', consentSource: 'MANUAL', consentAt: new Date(), campaignId: c.id } });
    const quando = new Date(Date.now() + 3 * 3600_000);
    expect((await owner.post(`/api/mckmensagem/campaigns/${c.id}/start`, { agendarPara: new Date(Date.now() - 3600_000).toISOString() })).status).toBe(400);
    expect((await owner.post(`/api/mckmensagem/campaigns/${c.id}/start`, { agendarPara: new Date(Date.now() + 90 * 86_400_000).toISOString() })).status).toBe(400);
    const r = await owner.post(`/api/mckmensagem/campaigns/${c.id}/start`, { agendarPara: quando.toISOString() });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('AGENDADA');
    expect(new Date(r.body.iniciarEm).getTime()).toBe(quando.getTime());
    expect(await acao(c.id, quando.getTime() - 60_000)).toBeUndefined();
    expect(sent).toHaveLength(0);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try { expect(await acao(c.id, quando.getTime() + 1000)).toBe('sent'); } finally { warn.mockRestore(); }
    expect(sent.map((s) => s.to)).toEqual([lead.phone.replace(/\D/g, '')]);
    expect((await prisma.campaign.findUniqueOrThrow({ where: { id: c.id } })).status).not.toBe('AGENDADA');

    // Pausar antes da hora: não começa.
    const { c: c2 } = await campanha(0, { status: 'RASCUNHO' });
    await prisma.lead.create({ data: { orgId, phone: `+${++phone}`, name: 'Pausado', consentSource: 'MANUAL', consentAt: new Date(), campaignId: c2.id } });
    const q2 = new Date(Date.now() + 2 * 3600_000);
    await owner.post(`/api/mckmensagem/campaigns/${c2.id}/start`, { agendarPara: q2.toISOString() });
    expect((await owner.post(`/api/mckmensagem/campaigns/${c2.id}/pause`, {})).body.status).toBe('PAUSADA');
    sent.length = 0;
    expect(await acao(c2.id, q2.getTime() + 1000)).toBeUndefined();
    expect(sent).toHaveLength(0);
  });

  it('7) duplicar: rascunho com o mesmo texto/versões/limites, sem fila; outra empresa = 404', async () => {
    const { c } = await campanha(3, { variacoes: JSON.stringify(['B']), diasSemana: '135', abVencedora: 1, dailyLimit: 77 });
    expect((await other.post(`/api/mckmensagem/campaigns/${c.id}/duplicar`, {})).status).toBe(404);
    const r = await owner.post(`/api/mckmensagem/campaigns/${c.id}/duplicar`, {});
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ name: `Cópia de ${c.name}`, message: c.message, status: 'RASCUNHO', variacoes: ['B'], diasSemana: '135', abVencedora: null, dailyLimit: 77 });
    expect(await prisma.campaignRecipient.count({ where: { campaignId: r.body.id } })).toBe(0);
  });

  it('8) enviar teste: manda a versão escolhida, não entra na fila, limite por hora, opt-out e desconectado barrados', async () => {
    const { c } = await campanha(1, { variacoes: JSON.stringify(['{saudacao}, {nome}! Teste B.']) });
    expect((await other.post(`/api/mckmensagem/campaigns/${c.id}/teste`, { phone: '11912345678' })).status).toBe(404);
    expect((await owner.post(`/api/mckmensagem/campaigns/${c.id}/teste`, { phone: '123' })).status).toBe(400);
    const r = await owner.post(`/api/mckmensagem/campaigns/${c.id}/teste`, { phone: '(11) 91234-0001', versao: 1, nome: 'Mayck Teste' });
    expect(r.status).toBe(200);
    expect(r.body.texto).toMatch(/^(Bom dia|Boa tarde|Boa noite), Mayck! Teste B\.$/);
    expect(sent).toEqual([{ to: '5511912340001', text: r.body.texto }]);
    expect((await recs(c.id)).every((x) => x.status === 'PENDENTE')).toBe(true);
    const m = await prisma.message.findFirst({ where: { orgId: owner.me.org.id, body: r.body.texto }, orderBy: { createdAt: 'desc' } });
    expect(m?.bulk).toBe(false);
    // opt-out
    await prisma.contact.create({ data: { orgId: owner.me.org.id, waId: '5511912340002', phone: '+5511912340002', optOut: true } });
    expect((await owner.post(`/api/mckmensagem/campaigns/${c.id}/teste`, { phone: '11912340002' })).status).toBe(400);
    // limite por hora
    for (let i = 1; i < TESTE_LIMITE_HORA; i++) expect((await owner.post(`/api/mckmensagem/campaigns/${c.id}/teste`, { phone: '11912340001' })).status).toBe(200);
    expect((await owner.post(`/api/mckmensagem/campaigns/${c.id}/teste`, { phone: '11912340001' })).status).toBe(429);
    // desconectado
    resetTestesCampanha();
    qrManager.attachForTests(channelId, null, 'NOT_CONNECTED');
    await prisma.channel.update({ where: { id: channelId }, data: { status: 'NOT_CONNECTED' } });
    try {
      expect((await owner.post(`/api/mckmensagem/campaigns/${c.id}/teste`, { phone: '11912340001' })).status).toBe(400);
    } finally {
      await prisma.channel.update({ where: { id: channelId }, data: { status: 'CONNECTED' } });
    }
  });
});
