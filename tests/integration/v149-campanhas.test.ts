import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { registerClient, installGraphMock, createTestChannel, graph, prisma, uniq, type Client } from '../helpers.js';
import { qrManager, type QrSocket } from '../../server/whatsapp/qr/manager.js';
import { tick, resetDispatcherState, setRandom } from '../../server/mckmensagem/dispatcher.js';
import { resetTestesCampanha, TESTE_LIMITE_HORA } from '../../server/mckmensagem/routes.js';
import { tickRecorrencia } from '../../server/mckmensagem/campanhaExtras.js';
import { escolherCanal } from '../../server/mckmensagem/campanhaCore.js';

/** v1.49.0: imagem/PDF na campanha, campanha que se repete, rodízio entre números, público pelo ERP e limite de testes no banco. */
describe('v1.49.0 — campanhas: mídia, repetição, rodízio e ERP', () => {
  let owner: Client;
  let other: Client;
  const sent: { canal: string; to: string; text: string; image?: boolean; document?: string }[] = [];
  let k = 0;
  const sockDe = (canal: string): QrSocket => ({
    user: { id: `55119931${String(Math.floor(Math.random() * 1e5)).padStart(5, '0')}:7@s.whatsapp.net` },
    async sendMessage(jid, content: any) {
      sent.push({ canal, to: jid.split('@')[0], text: content?.text ?? content?.caption ?? '', image: !!content?.image, document: content?.document ? content.fileName : undefined });
      return { key: { id: `V149${++k}${uniq()}` } };
    },
    async sendPresenceUpdate() { /* digitando */ },
    signalRepository: { lidMapping: { async getPNForLID() { return null; }, async getLIDForPN() { return null; } } },
  });
  let phone = 5511755000000;
  const SEG = new Date('Mon 2026-11-23 3:00 PM (UTC-03:00)').getTime();
  const png = () => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(`IHDR${Math.random()}`)]);
  const pdf = () => Buffer.from('%PDF-1.4\n1 0 obj << >>\nendobj\ntrailer << >>\n%%EOF\n', 'latin1');
  const recs = (id: string) => prisma.campaignRecipient.findMany({ where: { campaignId: id }, orderBy: { id: 'asc' } });
  const up = (id: string, dados: Buffer, nome: string, versao = 0, cli: Client = owner) =>
    cli.agent.post(`/api/mckmensagem/campaigns/${id}/midia?versao=${versao}`).set({ ...cli.h(), 'content-type': 'application/octet-stream', 'x-file-name': encodeURIComponent(nome) }).send(dados);

  async function novoCanal() {
    const r = await owner.post('/api/channels', { name: `Celular ${uniq()}` });
    const id = r.body.id as string;
    await prisma.channel.update({ where: { id }, data: { status: 'CONNECTED' } });
    qrManager.attachForTests(id, sockDe(id), 'CONNECTED');
    return id;
  }
  async function novoLead(campaignId: string | null, extra: Record<string, unknown> = {}) {
    return prisma.lead.create({ data: { orgId: owner.me.org.id, phone: `+${++phone}`, name: `Pessoa${phone % 1000} Silva`, consentSource: 'MANUAL', consentAt: new Date(), campaignId, ...extra } });
  }
  async function campanha(n: number, extra: Record<string, unknown> = {}, canal?: string) {
    const channelId = canal ?? await novoCanal();
    const c = await prisma.campaign.create({ data: { orgId: owner.me.org.id, name: `V149 ${uniq()}`, message: 'Oi {nome}! Oferta.', channelId, status: 'EM_ANDAMENTO', dailyLimit: 1000, minIntervalSec: 10, maxIntervalSec: 10, windowStart: '00:00', windowEnd: '23:59', ...extra } });
    const leads = [];
    for (let i = 0; i < n; i++) {
      const lead = await novoLead(c.id);
      await prisma.campaignRecipient.create({ data: { campaignId: c.id, leadId: lead.id } });
      leads.push(lead);
    }
    return { c, leads, channelId };
  }
  const acao = async (id: string, t: number) => (await tick(new Date(t))).find((x) => x.campaignId === id)?.action;

  beforeAll(async () => {
    installGraphMock();
    owner = await registerClient();
    other = await registerClient();
    setRandom(() => 0);
  });
  beforeEach(async () => {
    sent.length = 0;
    resetDispatcherState();
    resetTestesCampanha();
    await prisma.campaign.updateMany({ where: { status: { in: ['EM_ANDAMENTO', 'AGENDADA'] } }, data: { status: 'PAUSADA' } });
  });
  afterAll(() => { setRandom(null); qrManager.resetForTests(); });

  it('1) imagem/PDF: tipos e tamanho conferidos, isolamento, prévia, legenda até 1.024, sai como imagem com legenda no QR (e PDF na versão B)', async () => {
    const { c, leads } = await campanha(0, { status: 'RASCUNHO', variacoes: JSON.stringify(['Versão B {nome}.']) });
    expect((await up(c.id, Buffer.from('só texto'), 'a.txt')).status).toBe(400);
    expect((await up(c.id, Buffer.concat([Buffer.from('MZ'), Buffer.alloc(10)]), 'a.png')).status).toBe(400);
    const grande = Buffer.concat([png(), Buffer.alloc(5 * 1024 * 1024 + 10)]);
    expect((await up(c.id, grande, 'grande.png')).status).toBe(413);
    expect((await up(c.id, png(), 'x.png', 0, other)).status).toBe(404);
    expect((await up(c.id, png(), 'x.png', 3)).status).toBe(400); // versão D não existe
    const r = await up(c.id, png(), 'oferta.png');
    expect(r.status).toBe(201);
    expect(r.body.midias[0]).toMatchObject({ mime: 'image/png', nome: 'oferta.png' });
    expect((await up(c.id, pdf(), 'catalogo.pdf', 1)).status).toBe(201);
    const prev = await owner.agent.get(`/api/mckmensagem/campaigns/${c.id}/midia/0`).set(owner.h());
    expect(prev.status).toBe(200);
    expect(prev.headers['content-type']).toBe('image/png');
    expect((await other.agent.get(`/api/mckmensagem/campaigns/${c.id}/midia/0`).set(other.h())).status).toBe(404);
    // texto grande demais para legenda
    expect((await owner.patch(`/api/mckmensagem/campaigns/${c.id}`, { message: 'x'.repeat(1100) })).status).toBe(400);
    // arquivo em uso não pode ser excluído em Automações › Arquivos
    const usado = await owner.agent.delete(`/api/mckmensagem/automacoes/arquivos/${r.body.midias[0].id}`).set(owner.h());
    expect([409, 403, 404]).toContain(usado.status);
    // envio
    for (let i = 0; i < 8; i++) {
      const lead = await novoLead(c.id);
      await prisma.campaignRecipient.create({ data: { campaignId: c.id, leadId: lead.id } });
      leads.push(lead);
    }
    await prisma.campaign.update({ where: { id: c.id }, data: { status: 'EM_ANDAMENTO' } });
    for (let i = 0; i < 9; i++) await acao(c.id, SEG + i * 20_000);
    const rs = await recs(c.id);
    expect(rs.every((x) => x.status === 'ENVIADA')).toBe(true);
    expect(sent).toHaveLength(8);
    for (const x of rs) {
      const lead = leads.find((l) => l.id === x.leadId)!;
      const s = sent.find((m) => m.to === lead.phone.replace(/\D/g, ''))!;
      if (x.variante === 0) { expect(s.image).toBe(true); expect(s.text).toBe(`Oi ${lead.name!.split(' ')[0]}! Oferta.`); }
      else { expect(s.document).toBe('catalogo.pdf'); expect(s.text).toBe(`Versão B ${lead.name!.split(' ')[0]}.`); }
      const m = await prisma.message.findUnique({ where: { id: x.messageId! } });
      expect(m?.type).toBe(x.variante === 0 ? 'image' : 'document');
      expect(m?.bulk).toBe(true);
    }
    // nunca reenviar: rodar mais passos não manda nada
    sent.length = 0;
    await prisma.campaign.update({ where: { id: c.id }, data: { status: 'EM_ANDAMENTO' } });
    for (let i = 0; i < 3; i++) await acao(c.id, SEG + 600_000 + i * 20_000);
    expect(sent).toHaveLength(0);
    // tirar o arquivo da versão B: ela passa a usar o da versão A
    const d = await owner.agent.delete(`/api/mckmensagem/campaigns/${c.id}/midia?versao=1`).set(owner.h());
    expect(d.status).toBe(200);
    expect(d.body.midias).toHaveLength(1);
  });

  it('2) enviar teste com mídia e limite de testes por hora contado no banco', async () => {
    const { c } = await campanha(0, { status: 'RASCUNHO' });
    expect((await up(c.id, png(), 'promo.png')).status).toBe(201);
    const r = await owner.post(`/api/mckmensagem/campaigns/${c.id}/teste`, { phone: '(11) 91234-1001', nome: 'Mayck' });
    expect(r.status).toBe(200);
    expect(sent).toEqual([expect.objectContaining({ to: '5511912341001', image: true, text: 'Oi Mayck! Oferta.' })]);
    const n = await prisma.auditLog.count({ where: { orgId: owner.me.org.id, action: 'mckmensagem.campaign.teste' } });
    expect(n).toBeGreaterThanOrEqual(1);
    for (let i = 1; i < TESTE_LIMITE_HORA; i++) expect((await owner.post(`/api/mckmensagem/campaigns/${c.id}/teste`, { phone: '11912341001' })).status).toBe(200);
    expect((await owner.post(`/api/mckmensagem/campaigns/${c.id}/teste`, { phone: '11912341001' })).status).toBe(429);
  });

  it('3) API oficial: a imagem sobe para a Meta e sai com legenda (dentro da janela de 24 h)', async () => {
    const { ch } = await createTestChannel(owner.me.org.id);
    const { c, leads } = await campanha(1, { status: 'RASCUNHO' }, ch.id);
    expect((await up(c.id, png(), 'foto.png')).status).toBe(201);
    const lead = leads[0];
    const contact = await prisma.contact.create({ data: { orgId: owner.me.org.id, waId: lead.phone.replace(/\D/g, ''), phone: lead.phone, name: lead.name } });
    await prisma.lead.update({ where: { id: lead.id }, data: { contactId: contact.id } });
    await prisma.conversation.create({ data: { orgId: owner.me.org.id, contactId: contact.id, channelId: ch.id, lastInboundAt: new Date() } });
    await prisma.campaign.update({ where: { id: c.id }, data: { status: 'EM_ANDAMENTO' } });
    graph.calls.length = 0;
    expect(await acao(c.id, Date.now())).toBe('sent');
    expect(graph.calls.some((x) => x.url.endsWith('/media'))).toBe(true);
    const msg = graph.calls.find((x) => x.body?.type === 'image');
    expect(msg?.body.image).toMatchObject({ caption: `Oi ${lead.name!.split(' ')[0]}! Oferta.` });
  });

  it('4) campanha que se repete: execução nova para o público atual, sem duplicar, pula se a anterior ainda envia, respeita opt-out e o fim', async () => {
    const { c, leads } = await campanha(0, { status: 'RASCUNHO' });
    for (let i = 0; i < 3; i++) leads.push(await novoLead(c.id));
    // validação
    expect((await owner.patch(`/api/mckmensagem/campaigns/${c.id}`, { recorrencia: 'SEMANAL', recorrenciaFim: '2020-01-01T00:00:00Z' })).status).toBe(400);
    expect((await owner.patch(`/api/mckmensagem/campaigns/${c.id}`, { recorrencia: 'DIARIA' })).status).toBe(200);
    const st = await owner.post(`/api/mckmensagem/campaigns/${c.id}/start`, {});
    expect(st.status).toBe(200);
    expect(st.body.publico).toEqual({ modo: 'vinculados' });
    let o = await prisma.campaign.findUniqueOrThrow({ where: { id: c.id } });
    expect(o.recorrenciaProxima!.getTime()).toBeGreaterThan(Date.now() + 23 * 3600_000);
    expect(o.recorrenciaExecucao).toBe(1);
    // primeira execução termina
    await prisma.campaignRecipient.updateMany({ where: { campaignId: c.id }, data: { status: 'ENVIADA', sentAt: new Date() } });
    await prisma.campaign.update({ where: { id: c.id }, data: { status: 'CONCLUIDA' } });
    // um contato novo entra e um pede para sair
    leads.push(await novoLead(c.id));
    await prisma.lead.update({ where: { id: leads[0].id }, data: { optOutAt: new Date() } });
    const quando = new Date(o.recorrenciaProxima!.getTime() + 1000);
    const r1 = await tickRecorrencia(quando);
    expect(r1.find((x) => x.origemId === c.id)?.acao).toBe('criada');
    expect((await tickRecorrencia(quando)).find((x) => x.origemId === c.id)).toBeUndefined(); // não cria de novo
    const execs = await prisma.campaign.findMany({ where: { recorrenciaOrigemId: c.id } });
    expect(execs).toHaveLength(1);
    expect(execs[0]).toMatchObject({ status: 'EM_ANDAMENTO', recorrencia: '', recorrenciaExecucao: 2, message: o.message });
    expect(execs[0].name).toMatch(/ · \d{2}\/\d{2}$/);
    const rr = await recs(execs[0].id);
    expect(rr.map((x) => x.leadId).sort()).toEqual(leads.slice(1).map((l) => l.id).sort());
    o = await prisma.campaign.findUniqueOrThrow({ where: { id: c.id } });
    expect(o.recorrenciaProxima!.getTime()).toBeGreaterThan(quando.getTime());
    // execução anterior ainda enviando → pula
    const r2 = await tickRecorrencia(new Date(o.recorrenciaProxima!.getTime() + 1000));
    expect(r2.find((x) => x.origemId === c.id)?.acao).toBe('pulada_anterior');
    expect(await prisma.campaign.count({ where: { recorrenciaOrigemId: c.id } })).toBe(1);
    // execução não pode ganhar repetição própria
    expect((await owner.patch(`/api/mckmensagem/campaigns/${execs[0].id}`, { recorrencia: 'DIARIA' })).status).toBe(400);
    // fim: passou da data → para
    o = await prisma.campaign.findUniqueOrThrow({ where: { id: c.id } });
    await prisma.campaign.update({ where: { id: c.id }, data: { recorrenciaFim: new Date(o.recorrenciaProxima!.getTime() - 1000) } });
    const r3 = await tickRecorrencia(new Date(o.recorrenciaProxima!.getTime() + 1000));
    expect(r3.find((x) => x.origemId === c.id)?.acao).toBe('fim');
    expect((await prisma.campaign.findUniqueOrThrow({ where: { id: c.id } })).recorrenciaProxima).toBeNull();
    // pausada não repete
    const { c: p } = await campanha(0, { status: 'PAUSADA', recorrencia: 'SEMANAL', recorrenciaProxima: new Date(Date.now() - 1000) });
    expect((await tickRecorrencia(new Date())).find((x) => x.origemId === p.id)).toBeUndefined();
  });

  it('5) rodízio: divide entre os números saudáveis, contato fica sempre no mesmo número, número fora não troca o contato de número', async () => {
    const a = await novoCanal();
    const b = await novoCanal();
    const { c, leads } = await campanha(10, { rodizio: true, canaisRodizio: JSON.stringify([b]) }, a);
    // contato que já conversa pelo número B vai pelo B
    const especial = leads[0];
    const ct = await prisma.contact.create({ data: { orgId: owner.me.org.id, waId: especial.phone.replace(/\D/g, ''), phone: especial.phone, name: especial.name } });
    await prisma.lead.update({ where: { id: especial.id }, data: { contactId: ct.id } });
    await prisma.conversation.create({ data: { orgId: owner.me.org.id, contactId: ct.id, channelId: b, lastMessageAt: new Date() } });
    for (let i = 0; i < 20; i++) await acao(c.id, SEG + i * 6_000);
    const rs = await recs(c.id);
    expect(rs.every((x) => x.status === 'ENVIADA' && (x.channelId === a || x.channelId === b))).toBe(true);
    expect(new Set(rs.map((x) => x.channelId)).size).toBe(2);
    expect(rs.find((x) => x.leadId === especial.id)!.channelId).toBe(b);
    for (const x of rs) {
      const lead = leads.find((l) => l.id === x.leadId)!;
      expect(sent.find((s) => s.to === lead.phone.replace(/\D/g, ''))!.canal).toBe(x.channelId);
    }
    // limite por dia vale para cada número
    const { c: c2 } = await campanha(6, { rodizio: true, canaisRodizio: JSON.stringify([b]), dailyLimit: 2 }, a);
    sent.length = 0;
    for (let i = 0; i < 10; i++) await acao(c2.id, SEG + 3_600_000 + i * 11_000);
    const r2 = await recs(c2.id);
    const porNumero = (id: string) => r2.filter((x) => x.status === 'ENVIADA' && x.channelId === id).length;
    const esperado = (id: string) => Math.min(2, r2.filter((x) => escolherCanal({ chave: x.leadId, atribuido: null, preferido: null, todos: [a, b], saudaveis: [a, b] }) === id).length);
    expect(porNumero(a)).toBe(esperado(a));
    expect(porNumero(b)).toBe(esperado(b));
    expect(r2.filter((x) => x.status === 'ENVIADA')).toHaveLength(esperado(a) + esperado(b));
    // número B desconectado: contatos dele esperam, o A continua
    const { c: c3 } = await campanha(8, { rodizio: true, canaisRodizio: JSON.stringify([b]) }, a);
    const pre = await recs(c3.id);
    await prisma.campaignRecipient.updateMany({ where: { id: { in: pre.slice(0, 4).map((x) => x.id) } }, data: { channelId: b } });
    qrManager.attachForTests(b, null, 'NOT_CONNECTED');
    await prisma.channel.update({ where: { id: b }, data: { status: 'NOT_CONNECTED' } });
    try {
      for (let i = 0; i < 10; i++) await acao(c3.id, SEG + 7_200_000 + i * 11_000);
      const r3 = await recs(c3.id);
      expect(r3.filter((x) => x.channelId === b).every((x) => x.status === 'PENDENTE')).toBe(true);
      expect(r3.filter((x) => x.channelId !== b).every((x) => x.status === 'ENVIADA' && x.channelId === a)).toBe(true);
      // os dois fora → aguardando, sem tocar na fila
      qrManager.attachForTests(a, null, 'NOT_CONNECTED');
      await prisma.channel.update({ where: { id: a }, data: { status: 'NOT_CONNECTED' } });
      expect(await acao(c3.id, SEG + 7_200_000 + 20 * 11_000)).toBe('channel_offline');
      expect((await prisma.campaign.findUniqueOrThrow({ where: { id: c3.id } })).offlinePausa).toBeTruthy();
    } finally {
      for (const id of [a, b]) { await prisma.channel.update({ where: { id }, data: { status: 'CONNECTED' } }); qrManager.attachForTests(id, sockDe(id), 'CONNECTED'); }
    }
    // validação: número de outra empresa não entra
    const alheio = (await other.post('/api/channels', { name: 'Outro' })).body.id;
    expect((await owner.patch(`/api/mckmensagem/campaigns/${c.id}`, { rodizio: true, canaisRodizio: [alheio] })).status).toBe(400);
  });

  it('6) público pelas compras do ERP: sem vínculo explica; com vínculo filtra por valor, número de compras e última compra', async () => {
    const orgId = owner.me.org.id;
    const { c } = await campanha(0, { status: 'RASCUNHO' });
    // sem nenhum cliente do ERP ligado
    const semErp = await owner.post('/api/mckmensagem/segmento-erp/previa', { gastoMin: 100 });
    expect(semErp.status).toBe(200);
    expect(semErp.body.disponivel).toBe(false);
    expect(semErp.body.motivo).toMatch(/WhatsApp/);
    const st0 = await owner.post(`/api/mckmensagem/campaigns/${c.id}/start`, { erp: { gastoMin: 100 } });
    expect(st0.status).toBe(400);
    expect(st0.body.error).toMatch(/ERP/);
    // três clientes: VIP (3 compras, R$ 900, recente), sumido (1 compra antiga), sem compra
    const vip = await novoLead(null), sumido = await novoLead(null), nada = await novoLead(null), semVinculo = await novoLead(null);
    let doc = 10000000000 + Math.floor(Math.random() * 1e8);
    const parceiro = async (fone: string) => prisma.erpParceiro.create({ data: { orgId, tipoPessoa: 'PF', documento: String(++doc), nome: 'Cliente ' + fone.slice(-4), telefone: fone } });
    const pv = await parceiro(vip.phone), ps = await parceiro(sumido.phone);
    await parceiro(nada.phone);
    let numero = Math.floor(Math.random() * 1e6);
    const pedido = (parceiroId: string, total: number, dias: number, status = 'ENTREGUE') => prisma.erpPedidoVenda.create({ data: { orgId, numero: ++numero, parceiroId, totalCents: total, statusOperacional: status, correlationId: uniq(), createdAt: new Date(Date.now() - dias * 86_400_000) } });
    await pedido(pv.id, 30000, 3); await pedido(pv.id, 30000, 10); await pedido(pv.id, 30000, 20);
    await pedido(pv.id, 99999, 1, 'CANCELADO'); // não conta
    await pedido(ps.id, 5000, 200);
    void semVinculo;
    const p1 = await owner.post('/api/mckmensagem/segmento-erp/previa', { gastoMin: 500 });
    expect(p1.body).toMatchObject({ disponivel: true, vinculados: 3, atendem: 1 });
    expect((await owner.post('/api/mckmensagem/segmento-erp/previa', { ultimaCompraMinDias: 90 })).body.atendem).toBe(2); // sumido + nunca comprou
    expect((await owner.post('/api/mckmensagem/segmento-erp/previa', { comprasMin: 1, ultimaCompraMaxDias: 30 })).body.atendem).toBe(1);
    expect((await owner.post('/api/mckmensagem/segmento-erp/previa', { gastoMin: 10, gastoMax: 5 })).status).toBe(400);
    const st = await owner.post(`/api/mckmensagem/campaigns/${c.id}/start`, { erp: { gastoMin: 500 } });
    expect(st.status).toBe(200);
    expect(st.body.publico).toEqual({ modo: 'erp', erp: { gastoMin: 500 } });
    expect((await recs(c.id)).map((x) => x.leadId)).toEqual([vip.id]);
  });
});
