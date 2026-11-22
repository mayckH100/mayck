import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { app, registerClient, Client, createTestChannel, installGraphMock, graph, sendInbound, postWebhook, inboundPayload, prisma, uniq } from '../helpers.js';
import { fakeAi } from '../../server/ai/providers.js';
import { resetAiCache } from '../../server/ai/core.js';
import { brCodeValido } from '../../server/pix/core.js';
import { aguardarSite, resetLimitesSite } from '../../server/site/routes.js';
import { qrManager, type QrSocket } from '../../server/whatsapp/qr/manager.js';
import { tick, resetDispatcherState, setRandom, PAUSA_RISCO_AUTO, PAUSA_RISCO_MANUAL } from '../../server/mckmensagem/dispatcher.js';
import { resetProtecaoState, registrarEventoSaude } from '../../server/whatsapp/protecao/service.js';
import type { AnyMessageContent } from '@whiskeysockets/baileys';

async function invite(owner: Client, role: 'AGENT' | 'ADMIN') {
  const inv = await owner.post('/api/team/invites', { email: `${uniq()}@t.dev`, role });
  const token = inv.body.link.split('/convite/')[1];
  const c = new Client();
  const r = await c.agent.post('/api/auth/accept-invite').set('x-requested-with', 'mckbot').send({ token, name: `Membro ${uniq()}`, password: 'senhaMembro123' });
  c.csrf = r.body.csrfToken;
  c.me = r.body;
  return c;
}
let phone = 5511755000000;
const nextPhone = () => String(++phone);
async function convOf(orgId: string, p: string) {
  const contact = await prisma.contact.findUniqueOrThrow({ where: { orgId_waId: { orgId, waId: p } } });
  const conv = await prisma.conversation.findFirstOrThrow({ where: { contactId: contact.id }, orderBy: { createdAt: 'desc' } });
  return { contact, conv };
}

describe('v1.44.0 — assistente do atendente (Resumo e Sugerir resposta)', () => {
  let owner: Client; let ctx: Awaited<ReturnType<typeof createTestChannel>>;
  beforeAll(async () => { installGraphMock(); owner = await registerClient(); ctx = await createTestChannel(owner.me.org.id); });
  beforeEach(() => { graph.reset(); fakeAi.script = []; fakeAi.calls = []; resetAiCache(); });

  it('sem IA configurada: indisponível com dica; com IA: resumo e rascunho, sem enviar nada ao cliente', async () => {
    const org = owner.me.org.id;
    const p = nextPhone();
    await sendInbound(ctx, p, 'Oi, vocês fazem entrega em Osasco? Quanto fica o frete?');
    const { conv } = await convOf(org, p);
    await prisma.aiSettings.deleteMany({ where: { orgId: org } });
    const st = await owner.get('/api/inbox/assistente');
    expect(st.body.disponivel).toBe(false);
    expect(st.body.motivo).toMatch(/Configure a IA/);
    expect((await owner.post(`/api/inbox/conversas/${conv.id}/resumo`, {})).status).toBe(400);

    await prisma.aiSettings.create({ data: { orgId: org, provider: 'fake', model: 'fake-1', enabled: false, instructions: 'Entregamos em Osasco com frete de R$ 10.' } });
    await prisma.knowledgeDoc.create({ data: { orgId: org, title: 'Frete', content: 'x' } }).then((d) => prisma.knowledgeChunk.create({ data: { orgId: org, docId: d.id, idx: 0, text: 'Frete para Osasco: R$ 10, entrega em 1 dia útil.' } }));
    expect((await owner.get('/api/inbox/assistente')).body).toEqual({ disponivel: true });
    const antes = await prisma.message.count({ where: { conversationId: conv.id } });

    fakeAi.script = ['• Cliente quer entrega em Osasco\n• Perguntou o frete\n• Próximo passo: informar R$ 10'];
    const r = await owner.post(`/api/inbox/conversas/${conv.id}/resumo`, {});
    expect(r.status).toBe(200);
    expect(r.body.resumo.split('\n')).toHaveLength(3);
    expect(fakeAi.calls[0][1].content).toContain('Cliente: Oi, vocês fazem entrega em Osasco?');

    fakeAi.script = ['"Olá! Entregamos sim em Osasco, o frete fica R$ 10 e chega em 1 dia útil."'];
    const s = await owner.post(`/api/inbox/conversas/${conv.id}/sugestao`, {});
    expect(s.status).toBe(200);
    expect(s.body.sugestao).toBe('Olá! Entregamos sim em Osasco, o frete fica R$ 10 e chega em 1 dia útil.');
    // Usou a base de conhecimento e as instruções da empresa no prompt.
    expect(fakeAi.calls[1][0].content).toContain('Frete para Osasco: R$ 10');
    expect(fakeAi.calls[1][0].content).toContain('Entregamos em Osasco');
    // Nada foi enviado nem gravado na conversa.
    expect(graph.calls.filter((c) => c.body?.type === 'text')).toHaveLength(0);
    expect(await prisma.message.count({ where: { conversationId: conv.id } })).toBe(antes);
    const usos = await prisma.aiUsage.findMany({ where: { orgId: org, purpose: { in: ['assistente-resumo', 'assistente-sugestao'] } } });
    expect(usos.map((u) => u.purpose).sort()).toEqual(['assistente-resumo', 'assistente-sugestao']);

    // Limite diário de uso da IA atingido → indisponível.
    await prisma.aiSettings.update({ where: { orgId: org }, data: { dailyLimit: 1 } });
    expect((await owner.get('/api/inbox/assistente')).body.disponivel).toBe(false);
    expect((await owner.post(`/api/inbox/conversas/${conv.id}/sugestao`, {})).status).toBe(400);
    // Outra empresa não acessa a conversa.
    const outra = await registerClient();
    expect((await outra.post(`/api/inbox/conversas/${conv.id}/resumo`, {})).status).toBe(404);
  });
});

describe('v1.44.0 — cobrança Pix na conversa', () => {
  let owner: Client; let agent: Client; let ctx: Awaited<ReturnType<typeof createTestChannel>>;
  beforeAll(async () => { installGraphMock(); owner = await registerClient(); agent = await invite(owner, 'AGENT'); ctx = await createTestChannel(owner.me.org.id); });
  beforeEach(() => graph.reset());

  it('chave Pix: validação, só admin altera; cobrança envia QR + copia e cola, registra e dá baixa manual', async () => {
    const org = owner.me.org.id;
    const p = nextPhone();
    await sendInbound(ctx, p, 'Pode mandar o Pix?');
    const { conv } = await convOf(org, p);
    expect((await owner.get('/api/inbox/pix/config')).body).toEqual({ configurado: false });
    expect((await owner.post(`/api/inbox/conversas/${conv.id}/pix`, { valor: '50' })).status).toBe(400);
    expect((await owner.put('/api/inbox/pix/config', { keyType: 'cpf', key: '123', name: 'Loja', city: 'São Paulo' })).status).toBe(400);
    expect((await agent.put('/api/inbox/pix/config', { keyType: 'telefone', key: '11912345678', name: 'Loja', city: 'São Paulo' })).status).toBe(403);
    const cfg = await owner.put('/api/inbox/pix/config', { keyType: 'telefone', key: '(11) 91234-5678', name: 'Loja da Ana', city: 'São Paulo' });
    expect(cfg.status).toBe(200);
    expect(cfg.body).toMatchObject({ configurado: true, key: '+5511912345678', keyTypeLabel: 'Telefone' });

    expect((await agent.post(`/api/inbox/conversas/${conv.id}/pix`, { valor: 'abc' })).status).toBe(400);
    const r = await agent.post(`/api/inbox/conversas/${conv.id}/pix`, { valor: '150,50', descricao: 'Bolo de chocolate' });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ amountCents: 15050, status: 'PENDENTE', description: 'Bolo de chocolate', envio: { imagem: 'SENT', codigo: 'SENT' } });
    expect(brCodeValido(r.body.code)).toBe(true);
    expect(r.body.code).toContain('54061' + '50.50');
    // Graph: upload do PNG do QR (media), envio da imagem e do texto com o código.
    expect(graph.calls.some((c) => c.url.endsWith('/media'))).toBe(true);
    expect(graph.calls.some((c) => c.body?.type === 'image')).toBe(true);
    expect(graph.calls.some((c) => c.body?.type === 'text' && c.body.text.body === r.body.code)).toBe(true);
    const msgs = await prisma.message.findMany({ where: { conversationId: conv.id }, orderBy: { createdAt: 'asc' } });
    expect(msgs.some((m) => m.direction === 'OUT' && m.type === 'image' && /Pix de R\$\s?150,50/.test(m.body ?? ''))).toBe(true);
    expect(msgs.some((m) => m.direction === 'INTERNAL' && /Cobrança Pix/.test(m.body ?? ''))).toBe(true);
    expect((await prisma.conversation.findUniqueOrThrow({ where: { id: conv.id } })).mode).toBe('HUMAN');

    const lista = await owner.get(`/api/inbox/conversas/${conv.id}/pix`);
    expect(lista.body.items).toHaveLength(1);
    const pago = await agent.post(`/api/inbox/pix/${r.body.id}/status`, { status: 'PAGA' });
    expect(pago.status).toBe(200);
    expect(pago.body.status).toBe('PAGA');
    expect(pago.body.paidAt).toBeTruthy();
    expect((await agent.post(`/api/inbox/pix/${r.body.id}/status`, { status: 'PENDENTE' })).body.paidAt).toBeNull();

    // Imagem pública do QR só pelo token aleatório.
    const charge = await prisma.pixCharge.findUniqueOrThrow({ where: { id: r.body.id } });
    const png = await request(app).get(`/api/public/pix/${charge.publicToken}.png`);
    expect(png.status).toBe(200);
    expect(png.headers['content-type']).toContain('image/png');
    expect((await request(app).get(`/api/public/pix/${'0'.repeat(48)}.png`)).status).toBe(404);
    expect((await request(app).get(`/api/public/pix/${charge.id}.png`)).status).toBe(404);

    // Isolamento: outra empresa não vê nem altera.
    const outra = await registerClient();
    expect((await outra.post(`/api/inbox/pix/${r.body.id}/status`, { status: 'PAGA' })).status).toBe(404);
    expect((await outra.get(`/api/inbox/conversas/${conv.id}/pix`)).status).toBe(404);
  });
});

describe('v1.44.0 — origem do lead (links wa.me e anúncio)', () => {
  let owner: Client; let ctx: Awaited<ReturnType<typeof createTestChannel>>;
  beforeAll(async () => { installGraphMock(); owner = await registerClient(); ctx = await createTestChannel(owner.me.org.id); await prisma.channel.update({ where: { id: ctx.ch.id }, data: { displayPhone: '+55 11 90000-1111' } }); });
  beforeEach(() => graph.reset());

  it('cria link, detecta o código na 1ª mensagem, limpa o texto e mostra em Relatórios', async () => {
    const org = owner.me.org.id;
    const l = await owner.post('/api/origens', { name: 'Bio do Instagram' });
    expect(l.status).toBe(201);
    expect(l.body.code).toBe('bio-do-instagram');
    expect((await owner.post('/api/origens', { name: 'Outro', code: 'bio-do-instagram' })).status).toBe(409);
    expect((await owner.post('/api/origens', { name: 'Anúncio', code: 'anuncio' })).status).toBe(400);
    const lista = await owner.get('/api/origens');
    expect(lista.body.items[0].link).toBe(`https://wa.me/5511900001111?text=${encodeURIComponent('Olá! [ref:bio-do-instagram]')}`);

    const p1 = nextPhone();
    await sendInbound(ctx, p1, 'Olá! [ref:bio-do-instagram]');
    const a = await convOf(org, p1);
    expect(a.conv.origem).toBe('bio-do-instagram');
    expect(a.contact.origem).toBe('bio-do-instagram');
    const m1 = await prisma.message.findFirstOrThrow({ where: { conversationId: a.conv.id, direction: 'IN' } });
    expect(m1.body).toBe('Olá!');
    // Código desconhecido: não grava origem e não mexe no texto.
    const p2 = nextPhone();
    await sendInbound(ctx, p2, 'Oi [ref:qualquer-coisa]');
    const b = await convOf(org, p2);
    expect(b.conv.origem).toBeNull();
    expect((await prisma.message.findFirstOrThrow({ where: { conversationId: b.conv.id, direction: 'IN' } })).body).toBe('Oi [ref:qualquer-coisa]');
    // Anúncio Click-to-WhatsApp (API oficial): referral.
    const p3 = nextPhone();
    const pl = inboundPayload(ctx.phoneNumberId, p3, 'Quero saber da promoção');
    (pl.body.entry[0].changes[0].value.messages[0] as any).referral = { source_id: '120200', source_type: 'ad', headline: 'Promo de Natal', ctwa_clid: 'ARclid' };
    expect((await postWebhook(ctx.ch.id, ctx.appSecret, pl.body)).status).toBe(200);
    const c = await convOf(org, p3);
    expect(c.conv.origem).toBe('anuncio');
    expect(JSON.parse(c.conv.origemDetalhe!)).toMatchObject({ sourceId: '120200', headline: 'Promo de Natal' });
    // Segunda mensagem com outro código não troca a origem já gravada.
    await sendInbound(ctx, p1, 'Oi de novo [ref:bio-do-instagram]');
    expect((await convOf(org, p1)).conv.origem).toBe('bio-do-instagram');

    const rep = await owner.get('/api/reports?days=7');
    expect(rep.status).toBe(200);
    const porOrigem = Object.fromEntries(rep.body.origens.map((o: any) => [o.origem ?? 'sem', o]));
    expect(porOrigem['bio-do-instagram']).toMatchObject({ rotulo: 'Bio do Instagram', conversas: 1, leads: 1 });
    expect(porOrigem.anuncio).toMatchObject({ conversas: 1, leads: 1 });
    expect(porOrigem.sem.conversas).toBeGreaterThanOrEqual(1);
  });
});

describe('v1.44.0 — chat para o site do cliente', () => {
  let owner: Client;
  beforeAll(async () => { installGraphMock(); owner = await registerClient(); });
  beforeEach(() => { graph.reset(); resetLimitesSite(); });
  const pub = () => request(app);

  it('cria o chat, visitante conversa, entra no Inbox como "Site" e a resposta do atendente volta ao widget', async () => {
    const org = owner.me.org.id;
    const s = await owner.post('/api/channels/site', { name: 'Loja', color: '#112233', welcome: 'Oi! Em que posso ajudar?' });
    expect(s.status).toBe(201);
    expect(s.body.embed).toContain(`data-org="${s.body.publicKey}"`);
    expect(s.body.embed).toContain('/widget.js');
    const key = s.body.publicKey;
    // Canais de WhatsApp não listam o chat do site; com ?site=1 aparece (Inbox).
    expect((await owner.get('/api/channels')).body.some((c: any) => c.id === s.body.id)).toBe(false);
    expect((await owner.get('/api/channels?site=1')).body.find((c: any) => c.id === s.body.id)?.label).toBe('Site · Loja');

    const js = await pub().get('/widget.js');
    expect(js.status).toBe(200);
    expect(js.headers['content-type']).toContain('javascript');
    expect(js.headers['cross-origin-resource-policy']).toBe('cross-origin');

    const cfg = await pub().get(`/api/public/chat/${key}/config`).set('Origin', 'https://www.loja.com.br');
    expect(cfg.status).toBe(200);
    expect(cfg.body).toEqual({ title: 'Fale com a gente', welcome: 'Oi! Em que posso ajudar?', color: '#112233', askName: true });
    expect(cfg.headers['access-control-allow-origin']).toBe('https://www.loja.com.br');
    expect((await pub().options(`/api/public/chat/${key}/messages`).set('Origin', 'https://www.loja.com.br')).status).toBe(204);

    const visitor = 'ab'.repeat(16);
    const env = await pub().post(`/api/public/chat/${key}/messages`).set('Content-Type', 'text/plain').send(JSON.stringify({ visitor, text: 'Vocês abrem sábado?', name: 'Carla' }));
    expect(env.status).toBe(202);
    await aguardarSite();
    const contact = await prisma.contact.findFirstOrThrow({ where: { orgId: org, name: 'Carla' } });
    expect(contact.waId).toMatch(/^site:/);
    expect(contact.origem).toBe('site');
    const conv = await prisma.conversation.findFirstOrThrow({ where: { contactId: contact.id } });
    expect(conv.channelId).toBe(s.body.id);
    expect(conv.origem).toBe('site');
    const inbox = await owner.get(`/api/conversations/${conv.id}`);
    expect(inbox.body.conversation.channel.label).toBe('Site · Loja');
    expect(inbox.body.conversation.withinWindow).toBe(true);

    // Atendente responde e cria uma nota interna (que o visitante NÃO pode ver).
    const resp = await owner.post(`/api/conversations/${conv.id}/messages`, { type: 'text', text: 'Abrimos sim, das 9h às 13h.' });
    expect(resp.status).toBe(201);
    expect(resp.body.status).toBe('SENT');
    await owner.post(`/api/conversations/${conv.id}/notes`, { text: 'cliente VIP, nota interna' });
    expect(graph.calls).toHaveLength(0); // nada vai para o WhatsApp

    const lidas = await pub().get(`/api/public/chat/${key}/messages?visitor=${visitor}`);
    expect(lidas.status).toBe(200);
    expect(lidas.body.items.map((m: any) => [m.de, m.texto])).toEqual([['visitante', 'Vocês abrem sábado?'], ['empresa', 'Abrimos sim, das 9h às 13h.']]);
    expect(JSON.stringify(lidas.body)).not.toContain('VIP');
    const depois = await pub().get(`/api/public/chat/${key}/messages?visitor=${visitor}&after=${encodeURIComponent(lidas.body.items[0].criadoEm)}`);
    expect(depois.body.items.map((m: any) => m.texto)).toEqual(['Abrimos sim, das 9h às 13h.']);
    // Outro visitante não vê a conversa.
    expect((await pub().get(`/api/public/chat/${key}/messages?visitor=${'cd'.repeat(16)}`)).body.items).toEqual([]);
    expect((await pub().get(`/api/public/chat/${key}/messages?visitor=xyz`)).status).toBe(400);
    expect((await pub().get(`/api/public/chat/${'0'.repeat(32)}/config`)).status).toBe(404);

    // Cobrança Pix no chat do site: imagem pelo link público + código.
    await owner.put('/api/inbox/pix/config', { keyType: 'email', key: 'loja@exemplo.com.br', name: 'Loja', city: 'Osasco' });
    const pix = await owner.post(`/api/inbox/conversas/${conv.id}/pix`, { valor: '20' });
    expect(pix.status).toBe(201);
    const comPix = await pub().get(`/api/public/chat/${key}/messages?visitor=${visitor}`);
    expect(comPix.body.items.some((m: any) => m.imagem && m.imagem.includes('/api/public/pix/'))).toBe(true);
    expect(comPix.body.items.some((m: any) => m.texto === pix.body.code)).toBe(true);
  });

  it('limite por IP, domínios autorizados e validação do visitante', async () => {
    const s = await owner.post('/api/channels/site', { name: 'Blog' });
    const key = s.body.publicKey;
    const visitor = 'ef'.repeat(16);
    const envia = (text: string, origin?: string) => { const r = pub().post(`/api/public/chat/${key}/messages`); if (origin) r.set('Origin', origin); return r.send({ visitor, text }); };
    expect((await envia('')).status).toBe(400);
    expect((await pub().post(`/api/public/chat/${key}/messages`).send({ visitor: 'x', text: 'oi' })).status).toBe(400);
    const codes: number[] = [];
    for (let i = 0; i < 14; i++) codes.push((await envia(`oi ${i}`)).status);
    expect(codes.slice(0, 12).every((c) => c === 202)).toBe(true);
    expect(codes[13]).toBe(429); // 12 por minuto por visitante
    await aguardarSite();
    resetLimitesSite();
    // Por IP: 20 por minuto (visitantes diferentes).
    const porIp: number[] = [];
    for (let i = 0; i < 21; i++) porIp.push((await pub().post(`/api/public/chat/${key}/messages`).send({ visitor: (i + 10).toString(16).padStart(2, '0').repeat(16), text: 'oi' })).status);
    expect(porIp.filter((c) => c === 429).length).toBeGreaterThanOrEqual(1);
    expect(porIp.slice(0, 10).every((c) => c === 202)).toBe(true);
    await aguardarSite();
    resetLimitesSite();

    expect((await owner.put(`/api/channels/site/${s.body.id}`, { allowedOrigins: 'https://www.meublog.com.br/\n' })).body.allowedOrigins).toBe('www.meublog.com.br');
    expect((await pub().get(`/api/public/chat/${key}/config`).set('Origin', 'https://evil.com')).status).toBe(403);
    expect((await pub().get(`/api/public/chat/${key}/config`)).status).toBe(403);
    expect((await pub().get(`/api/public/chat/${key}/config`).set('Origin', 'https://www.meublog.com.br')).status).toBe(200);

    // Atendente não cria nem altera; outra empresa não enxerga.
    const ag = await invite(owner, 'AGENT');
    expect((await ag.post('/api/channels/site', {})).status).toBe(403);
    const outra = await registerClient();
    expect((await outra.put(`/api/channels/site/${s.body.id}`, { title: 'x' })).status).toBe(404);
    expect((await owner.del(`/api/channels/site/${s.body.id}`)).status).toBe(200);
    expect((await pub().get(`/api/public/chat/${key}/config`).set('Origin', 'https://www.meublog.com.br')).status).toBe(404);
  });
});

describe('v1.44.0 — campanhas pausam com o número em Risco', () => {
  let owner: Client;
  let channelId: string;
  const sent: AnyMessageContent[] = [];
  let k = 0;
  const sock: QrSocket = {
    user: { id: '5511993192222:7@s.whatsapp.net' },
    async sendMessage(_jid, content) { sent.push(content); return { key: { id: `RK${++k}${uniq()}` } }; },
    async sendPresenceUpdate() { /* digitando */ },
    signalRepository: { lidMapping: { async getPNForLID() { return null; }, async getLIDForPN() { return null; } } },
  };
  let ph = 5511769000000;
  beforeAll(async () => {
    installGraphMock();
    owner = await registerClient();
    const r = await owner.post('/api/channels', { name: 'Celular risco' });
    await prisma.channel.update({ where: { id: r.body.id }, data: { status: 'CONNECTED' } });
    channelId = r.body.id;
    qrManager.attachForTests(channelId, sock, 'CONNECTED');
    setRandom(() => 0);
  });
  beforeEach(async () => { resetDispatcherState(); resetProtecaoState(); await prisma.channelHealthEvent.deleteMany({ where: { channelId } }); });
  afterAll(() => { setRandom(null); qrManager.resetForTests(); });

  async function campanha(extra: Record<string, unknown> = {}) {
    const r = await owner.post('/api/mckmensagem/campaigns', { name: `C ${uniq()}`, message: 'Olá {nome}! Novidade da loja. Responda SAIR para não receber.', channelId, dailyLimit: 1000, minIntervalSec: 10, maxIntervalSec: 10, windowStart: '00:00', windowEnd: '23:59', ...extra });
    expect(r.status).toBe(201);
    for (let i = 0; i < 3; i++) {
      const lead = await prisma.lead.create({ data: { orgId: owner.me.org.id, phone: `+${++ph}`, name: `P${i}`, consentSource: 'MANUAL', consentAt: new Date() } });
      await prisma.campaignRecipient.create({ data: { campaignId: r.body.id, leadId: lead.id } });
    }
    await prisma.campaign.update({ where: { id: r.body.id }, data: { status: 'EM_ANDAMENTO' } });
    return r.body.id as string;
  }

  it('automática: pausa em Risco com aviso e volta sozinha quando melhora', async () => {
    const id = await campanha();
    await registrarEventoSaude(channelId, 'restricao', 'Sessão inválida (código 403)');
    sent.length = 0;
    const t0 = Date.now();
    expect((await tick(new Date(t0))).find((x) => x.campaignId === id)?.action).toBe('number_risk');
    expect(sent).toHaveLength(0);
    const c = await owner.get(`/api/mckmensagem/campaigns/${id}`);
    expect(c.body.riscoPausa).toBe(PAUSA_RISCO_AUTO);
    expect(c.body.status).toBe('EM_ANDAMENTO');
    expect(await prisma.campaignRecipient.count({ where: { campaignId: id, status: 'PENDENTE' } })).toBe(3);
    await prisma.channelHealthEvent.deleteMany({ where: { channelId } });
    expect((await tick(new Date(t0 + 60_000))).find((x) => x.campaignId === id)?.action).toBe('sent');
    expect(sent).toHaveLength(1);
    expect((await prisma.campaign.findUniqueOrThrow({ where: { id } })).riscoPausa).toBeNull();
    await prisma.campaign.update({ where: { id }, data: { status: 'CONCLUIDA' } });
  });

  it('manual: fica PAUSADA até clicar em Retomar', async () => {
    const id = await campanha({ riscoRetomada: 'manual' });
    await registrarEventoSaude(channelId, 'restricao', 'Sessão inválida (código 403)');
    sent.length = 0;
    const t0 = Date.now();
    expect((await tick(new Date(t0))).find((x) => x.campaignId === id)?.action).toBe('number_risk');
    let c = await prisma.campaign.findUniqueOrThrow({ where: { id } });
    expect(c.status).toBe('PAUSADA');
    expect(c.riscoPausa).toBe(PAUSA_RISCO_MANUAL);
    await prisma.channelHealthEvent.deleteMany({ where: { channelId } });
    expect((await tick(new Date(t0 + 60_000))).find((x) => x.campaignId === id)).toBeUndefined(); // continua pausada
    expect(sent).toHaveLength(0);
    const st = await owner.post(`/api/mckmensagem/campaigns/${id}/start`, {});
    expect(st.status).toBe(200);
    c = await prisma.campaign.findUniqueOrThrow({ where: { id } });
    expect(c.status).toBe('EM_ANDAMENTO');
    expect(c.riscoPausa).toBeNull();
    expect((await tick(new Date(t0 + 120_000))).find((x) => x.campaignId === id)?.action).toBe('sent');
    await prisma.campaign.update({ where: { id }, data: { status: 'CONCLUIDA' } });
  });
});
