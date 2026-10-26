import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { registerClient, Client, createTestChannel, installGraphMock, graph, sendInbound, sentTexts, prisma } from '../helpers.js';
import { tick } from '../../server/flows/engine.js';
import { qrManager, type QrSocket } from '../../server/whatsapp/qr/manager.js';
import { handleQrMessage } from '../../server/whatsapp/inbound.js';
import { isMenuCommand, withMenuReturn, DEFAULT_MENU_SETTINGS, MENU_BUTTON_ID } from '../../server/flows/menuReturn.js';

const N = (id: string, type: string, data: any = {}) => ({ id, type, position: { x: 0, y: 0 }, data });
const E = (source: string, target: string, sourceHandle = 'next') => ({ id: `${source}-${sourceHandle}-${target}`, source, target, sourceHandle });

/** Fluxo principal: boas-vindas + menu; "Cadastro" pergunta nome e e-mail; "Aguardar" tem espera de 1 h. */
const mainGraph = {
  nodes: [
    N('s', 'start', { triggers: [{ type: 'keyword', value: 'oi', match: 'contains' }] }),
    N('w', 'send_text', { text: 'Olá! Bem-vindo à Loja Demo.' }),
    N('m', 'menu', { text: 'Escolha uma opção:', options: [{ id: 'a', label: 'Cadastro' }, { id: 'b', label: 'Aguardar' }, { id: 'c', label: 'Fim' }] }),
    N('q1', 'ask', { question: 'Qual é o seu nome?', variable: 'nome' }),
    N('q2', 'ask', { question: 'Seu e-mail?', variable: 'email', validation: 'email' }),
    N('t', 'send_text', { text: 'Vou verificar, aguarde.' }),
    N('wt', 'wait', { seconds: 3600 }),
    N('t2', 'send_text', { text: 'Pronto!' }),
    N('e', 'end', { message: 'Até logo!' }),
  ],
  edges: [E('s', 'w'), E('w', 'm'), E('m', 'q1', 'opt-a'), E('m', 't', 'opt-b'), E('m', 'e', 'opt-c'), E('q1', 'q2'), E('q2', 'e'), E('t', 'wt'), E('wt', 't2')],
};
const MENU_TEXT = 'Escolha uma opção:\n\n1. Cadastro\n2. Aguardar\n3. Fim';
const WELCOME = 'Olá! Bem-vindo à Loja Demo.';

async function setup(owner: Client) {
  const f = await owner.post('/api/flows', { name: 'Principal', graph: mainGraph });
  expect(f.status).toBe(201);
  expect((await owner.post(`/api/flows/${f.body.id}/status`, { status: 'ACTIVE' })).status).toBe(200);
  return f.body.id as string;
}

describe('Voltar ao menu — unidade', () => {
  it('reconhece as palavras padrão sem diferenciar maiúsculas e acentos, e o botão', () => {
    for (const t of ['0', 'menu', 'MENU', ' Menú ', 'voltar', 'VOLTAR']) expect(isMenuCommand(DEFAULT_MENU_SETTINGS, t)).toBe(true);
    for (const t of ['1', 'menu principal', 'quero voltar', '']) expect(isMenuCommand(DEFAULT_MENU_SETTINGS, t)).toBe(false);
    expect(isMenuCommand(DEFAULT_MENU_SETTINGS, 'Voltar ao menu', MENU_BUTTON_ID)).toBe(true);
    expect(isMenuCommand({ ...DEFAULT_MENU_SETTINGS, menuCommandEnabled: false }, '0')).toBe(false);
  });
  it('QR recebe rodapé em texto; Cloud recebe o botão (ou rodapé quando não cabe)', () => {
    expect(withMenuReturn({ type: 'text', text: 'Nome?' }, DEFAULT_MENU_SETTINGS, true)).toEqual({ type: 'text', text: 'Nome?\n\n↩️ Digite 0 para voltar ao menu' });
    expect(withMenuReturn({ type: 'text', text: 'Nome?' }, DEFAULT_MENU_SETTINGS, false)).toEqual({ type: 'buttons', text: 'Nome?', buttons: [{ id: MENU_BUTTON_ID, title: 'Voltar ao menu' }] });
    const three = { type: 'buttons' as const, text: 'X', buttons: [1, 2, 3].map((i) => ({ id: `${i}`, title: `${i}` })) };
    expect(withMenuReturn(three, DEFAULT_MENU_SETTINGS, false)).toMatchObject({ type: 'buttons', text: 'X\n\n↩️ Digite 0 para voltar ao menu' });
    expect(withMenuReturn({ type: 'text', text: 'A' }, { ...DEFAULT_MENU_SETTINGS, menuFooterEnabled: false }, true)).toEqual({ type: 'text', text: 'A' });
  });
});

describe('Voltar ao menu — Cloud API (webhook)', () => {
  let owner: Client;
  let ctx: Awaited<ReturnType<typeof createTestChannel>>;
  let flowId: string;
  let phone = 5511870000000;
  const nextPhone = () => String(++phone);
  const lastCall = () => graph.calls.filter((c) => c.body).at(-1)!.body;
  const contactOf = (p: string) => prisma.contact.findFirstOrThrow({ where: { orgId: owner.me.org.id, waId: p } });

  beforeAll(async () => {
    installGraphMock();
    owner = await registerClient();
    ctx = await createTestChannel(owner.me.org.id);
    flowId = await setup(owner);
  });
  beforeEach(() => graph.reset());

  it('configuração padrão: ligado, palavras 0/menu/voltar, rodapé e botão ligados', async () => {
    const r = await owner.get('/api/flows/menu-settings');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ menuCommandEnabled: true, menuCommandWords: '0,menu,voltar', menuFooterEnabled: true, menuFooterText: '↩️ Digite 0 para voltar ao menu', menuButtonEnabled: true, menuFlowId: null });
  });

  it('"0" no meio do cadastro cancela a pergunta e reenvia o menu inteiro desde o primeiro bloco', async () => {
    const p = nextPhone();
    await sendInbound(ctx, p, 'oi');
    expect(sentTexts()).toEqual([WELCOME, MENU_TEXT]);
    // a mensagem que espera resposta leva o botão "Voltar ao menu"
    expect(lastCall().interactive.action.buttons.map((b: any) => b.reply)).toEqual([{ id: MENU_BUTTON_ID, title: 'Voltar ao menu' }]);
    await sendInbound(ctx, p, '1');
    await sendInbound(ctx, p, 'Joana');
    expect(sentTexts().slice(2)).toEqual(['Qual é o seu nome?', 'Seu e-mail?']);
    graph.reset();
    await sendInbound(ctx, p, '0');
    expect(sentTexts()).toEqual([WELCOME, MENU_TEXT]);
    const c = await contactOf(p);
    const runs = await prisma.flowRun.findMany({ where: { contactId: c.id }, orderBy: { startedAt: 'asc' } });
    expect(runs.map((r) => r.status)).toEqual(['CANCELLED', 'WAITING']);
    expect(runs[1].currentNodeId).toBe('m');
    // segue normalmente depois de voltar
    graph.reset();
    await sendInbound(ctx, p, '3');
    expect(sentTexts()).toEqual(['Até logo!']);
  });

  it('o botão "Voltar ao menu" e as palavras com maiúsculas/acentos têm o mesmo efeito', async () => {
    const p = nextPhone();
    await sendInbound(ctx, p, 'oi');
    await sendInbound(ctx, p, '1');
    graph.reset();
    await sendInbound(ctx, p, 'Voltar ao menu', { replyId: MENU_BUTTON_ID });
    expect(sentTexts()).toEqual([WELCOME, MENU_TEXT]);
    graph.reset();
    await sendInbound(ctx, p, 'MENÚ');
    expect(sentTexts()).toEqual([WELCOME, MENU_TEXT]);
    graph.reset();
    await sendInbound(ctx, p, 'Voltar');
    expect(sentTexts()).toEqual([WELCOME, MENU_TEXT]);
  });

  it('funciona durante uma espera (bloco Aguardar) e depois que o fluxo já terminou', async () => {
    const p = nextPhone();
    await sendInbound(ctx, p, 'oi');
    await sendInbound(ctx, p, '2');
    expect(sentTexts().at(-1)).toBe('Vou verificar, aguarde.');
    graph.reset();
    await sendInbound(ctx, p, 'menu');
    expect(sentTexts()).toEqual([WELCOME, MENU_TEXT]);
    // a espera cancelada não volta a disparar
    graph.reset();
    expect(await tick(new Date(Date.now() + 2 * 3600 * 1000))).toBe(0);
    expect(sentTexts()).toEqual([]);
    // fluxo encerrado: "0" recomeça o menu
    await sendInbound(ctx, p, '3');
    graph.reset();
    await sendInbound(ctx, p, '0');
    expect(sentTexts()).toEqual([WELCOME, MENU_TEXT]);
  });

  it('não dispara durante o atendimento humano: a conversa continua com o atendente', async () => {
    const p = nextPhone();
    await sendInbound(ctx, p, 'oi');
    const c = await contactOf(p);
    const conv = await prisma.conversation.findFirstOrThrow({ where: { contactId: c.id } });
    await prisma.conversation.update({ where: { id: conv.id }, data: { mode: 'HUMAN', status: 'PENDING' } });
    graph.reset();
    await sendInbound(ctx, p, '0');
    await sendInbound(ctx, p, 'menu');
    expect(sentTexts()).toEqual([]);
    const after = await prisma.conversation.findUniqueOrThrow({ where: { id: conv.id } });
    expect(after.mode).toBe('HUMAN');
    expect(await prisma.flowRun.count({ where: { contactId: c.id } })).toBe(1);
    const inbound = await prisma.message.findMany({ where: { conversationId: conv.id, direction: 'IN' }, orderBy: { createdAt: 'asc' } });
    expect(inbound.map((m) => m.body)).toEqual(['oi', '0', 'menu']); // o atendente vê as mensagens no Inbox
  });

  it('palavras personalizadas, fluxo do menu escolhido e comando desligado', async () => {
    const bad = await owner.put('/api/flows/menu-settings', { ...DEFAULT_MENU_SETTINGS, menuCommandWords: ' , ' });
    expect(bad.status).toBe(400);
    const ok = await owner.put('/api/flows/menu-settings', { ...DEFAULT_MENU_SETTINGS, menuCommandWords: 'Início, #, Inicio', menuFlowId: flowId });
    expect(ok.status).toBe(200);
    expect(ok.body.menuCommandWords).toBe('inicio,#');
    const p = nextPhone();
    await sendInbound(ctx, p, 'oi');
    await sendInbound(ctx, p, '1');
    graph.reset();
    await sendInbound(ctx, p, 'INÍCIO');
    expect(sentTexts()).toEqual([WELCOME, MENU_TEXT]);
    // desligado: "0" vira resposta comum (opção inválida do menu)
    await owner.put('/api/flows/menu-settings', { ...DEFAULT_MENU_SETTINGS, menuCommandEnabled: false });
    graph.reset();
    await sendInbound(ctx, p, '0');
    expect(sentTexts()[0]).toMatch(/Opção inválida/);
    expect(lastCall().type).toBe('text'); // sem botão quando o comando está desligado
    await owner.put('/api/flows/menu-settings', DEFAULT_MENU_SETTINGS);
  });

  it('atendente (AGENT) vê, mas não altera a configuração', async () => {
    const agent = await registerClient();
    await prisma.membership.create({ data: { userId: agent.me.user.id, orgId: owner.me.org.id, role: 'AGENT' } });
    const sw = await agent.post('/api/auth/switch-org', { orgId: owner.me.org.id });
    expect(sw.status).toBe(200);
    if (sw.body.csrfToken) agent.csrf = sw.body.csrfToken;
    expect((await agent.get('/api/flows/menu-settings')).status).toBe(200);
    expect((await agent.put('/api/flows/menu-settings', DEFAULT_MENU_SETTINGS)).status).toBe(403);
  });
});

describe('Voltar ao menu — QR code (Baileys)', () => {
  let owner: Client;
  let channelId: string;
  const sent: string[] = [];
  let seq = 0;
  const raw = (from: string, text: string) => ({
    key: { remoteJid: `${from}@s.whatsapp.net`, fromMe: false, id: `MR${Date.now()}${seq++}` },
    pushName: 'Cliente QR', messageTimestamp: Math.floor(Date.now() / 1000), message: { conversation: text },
  }) as any;

  beforeAll(async () => {
    installGraphMock();
    owner = await registerClient();
    const r = await owner.post('/api/channels', { name: 'Celular' });
    channelId = r.body.id;
    await prisma.channel.update({ where: { id: channelId }, data: { status: 'CONNECTED' } });
    const sock: QrSocket = { user: { id: '5511900000000:1@s.whatsapp.net' }, async sendMessage(_jid, content: any) { sent.push(content.text ?? ''); return { key: { id: `QRM${++seq}` } }; } };
    qrManager.attachForTests(channelId, sock, 'CONNECTED');
    await setup(owner);
  });
  afterAll(() => qrManager.resetForTests());

  it('no QR usa a linha de rodapé em texto e "0" reenvia o menu inteiro', async () => {
    const p = '5511880000001';
    await handleQrMessage(channelId, raw(p, 'oi'));
    expect(sent).toEqual([WELCOME, `${MENU_TEXT}\n\n↩️ Digite 0 para voltar ao menu`]);
    await handleQrMessage(channelId, raw(p, '1'));
    expect(sent.at(-1)).toBe('Qual é o seu nome?\n\n↩️ Digite 0 para voltar ao menu');
    sent.length = 0;
    await handleQrMessage(channelId, raw(p, '0'));
    expect(sent).toEqual([WELCOME, `${MENU_TEXT}\n\n↩️ Digite 0 para voltar ao menu`]);
  });

  it('rodapé desligado ou com texto próprio', async () => {
    await owner.put('/api/flows/menu-settings', { ...DEFAULT_MENU_SETTINGS, menuFooterText: 'Mande MENU para recomeçar' });
    const p = '5511880000002';
    sent.length = 0;
    await handleQrMessage(channelId, raw(p, 'oi'));
    expect(sent[1]).toBe(`${MENU_TEXT}\n\nMande MENU para recomeçar`);
    await owner.put('/api/flows/menu-settings', { ...DEFAULT_MENU_SETTINGS, menuFooterEnabled: false });
    sent.length = 0;
    await handleQrMessage(channelId, raw(p, 'menu'));
    expect(sent).toEqual([WELCOME, MENU_TEXT]);
  });
});
