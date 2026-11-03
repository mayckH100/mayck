import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { registerClient, Client, createTestChannel, installGraphMock, graph, sendInbound, sentTexts, prisma } from '../helpers.js';
import { fakeAi } from '../../server/ai/providers.js';

describe('IA: site da MCK, concorrentes, base de conhecimento e Kanban automático', () => {
  let owner: Client;
  let ctx: Awaited<ReturnType<typeof createTestChannel>>;
  let phone = 5511730000000;
  const nextPhone = () => String(++phone);
  const lastSystem = () => fakeAi.calls.at(-1)!.find((m) => m.role === 'system')!.content;

  beforeAll(async () => {
    installGraphMock();
    owner = await registerClient();
    ctx = await createTestChannel(owner.me.org.id);
    expect((await owner.put('/api/ai/settings', { provider: 'fake', model: 'fake-1', enabled: true, autoReply: true })).status).toBe(200);
  });
  beforeEach(() => { graph.reset(); fakeAi.script = []; fakeAi.calls = []; });

  it('base de conhecimento acha os FAQs da produção ("concorrência", "conectar")', async () => {
    await owner.post('/api/ai/knowledge', { title: 'FAQ - Por que escolher a MCK (diferenciais)', content: 'Por que a MCK e não outra plataforma?\n- Tudo em um lugar.\n\nComo responder quando o cliente compara com um concorrente? Reconhecer com respeito e mostrar os pontos fortes.' });
    await owner.post('/api/ai/knowledge', { title: 'FAQ - Como começar e suporte', content: 'Como começar? Crie a conta grátis. Conecte o WhatsApp lendo o QR code em Canais WhatsApp.' });
    const a = await owner.post('/api/ai/test', { message: 'Vocês são melhores que a concorrência?' });
    expect(a.body.sources[0].title).toBe('FAQ - Por que escolher a MCK (diferenciais)');
    const b = await owner.post('/api/ai/test', { message: 'Não entendi como conectar' });
    expect(b.body.sources[0].title).toBe('FAQ - Como começar e suporte');
    expect(b.body.text).toContain('QR code');
  });

  it('"Usar o site da MCK" só o superadmin liga; com ele o prompt traz páginas, preços atuais e regras de concorrentes', async () => {
    expect((await owner.put('/api/ai/settings', { useMckSite: true })).status).toBe(403);
    await prisma.user.update({ where: { id: owner.me.user.id }, data: { isSuperAdmin: true } });
    expect((await owner.put('/api/ai/settings', { useMckSite: true, competitorNotes: '- Suporte no mesmo dia.' })).status).toBe(200);
    await prisma.user.update({ where: { id: owner.me.user.id }, data: { isSuperAdmin: false } });
    fakeAi.script = ['Somos a melhor escolha para você!'];
    await owner.post('/api/ai/test', { message: 'Vocês são melhores que a concorrência?' });
    const sys = lastSystem();
    expect(sys).toContain('SITE OFICIAL DA EMPRESA');
    expect(sys).toMatch(/\[Página mckbot\][\s\S]*MCKBOT/);
    expect(sys).toMatch(/\[Página mck-mensagens\]/);
    expect(sys).toMatch(/PREÇOS ATUAIS[\s\S]*MCKBOT: R\$/);
    expect(sys).toContain('QUANDO O CLIENTE COMPARAR COM CONCORRENTES');
    expect(sys).toContain('nunca invente preço');
    expect(sys).toContain('- Suporte no mesmo dia.');
    expect(sys).toContain('TRANSFERÊNCIA PARA HUMANO É PROIBIDA');
    // Outra organização (padrão): nada do site da MCK no prompt.
    const other = await registerClient();
    await other.put('/api/ai/settings', { provider: 'fake', model: 'fake-1', enabled: true });
    fakeAi.script = ['oi'];
    await other.post('/api/ai/test', { message: 'Vocês são melhores que a concorrência?' });
    expect(lastSystem()).not.toContain('SITE OFICIAL DA EMPRESA');
    expect(lastSystem()).not.toContain('QUANDO O CLIENTE COMPARAR');
  });

  it('Kanban automático DESLIGADO (padrão): marcador [ETAPA:] some do texto e o contato não é movido', async () => {
    await owner.put('/api/ai/settings', { useMckSite: false });
    const st = await owner.post('/api/kanban/stages', { name: 'Proposta enviada' });
    expect([200, 201]).toContain(st.status);
    fakeAi.script = ['Te mandei a proposta!\n[ETAPA:Proposta enviada]'];
    const p = nextPhone();
    await sendInbound(ctx, p, 'pode mandar a proposta');
    expect(sentTexts()).toEqual(['Te mandei a proposta!']);
    const c = await prisma.contact.findFirstOrThrow({ where: { orgId: owner.me.org.id, waId: p } });
    expect(c.stageId).toBeNull();
  });

  it('Kanban automático LIGADO: move para a etapa seguinte, anota na conversa, nunca volta nem vai para Ganho', async () => {
    await owner.put('/api/ai/settings', { kanbanAuto: true });
    const ganho = await owner.post('/api/kanban/stages', { name: 'Ganho' });
    expect([200, 201]).toContain(ganho.status);
    fakeAi.script = ['Proposta a caminho!\n[ETAPA:proposta enviada]'];
    const p = nextPhone();
    await sendInbound(ctx, p, 'pode mandar a proposta');
    expect(fakeAi.calls.at(-1)!.find((m) => m.role === 'system')!.content).toContain('FUNIL (KANBAN)');
    expect(sentTexts()).toEqual(['Proposta a caminho!']);
    const c = await prisma.contact.findFirstOrThrow({ where: { orgId: owner.me.org.id, waId: p } });
    const stage = await prisma.kanbanStage.findUniqueOrThrow({ where: { id: c.stageId! } });
    expect(stage.name).toBe('Proposta enviada');
    const conv = await prisma.conversation.findFirstOrThrow({ where: { contactId: c.id } });
    expect((await prisma.message.findFirst({ where: { conversationId: conv.id, direction: 'INTERNAL', body: { contains: 'IA moveu o contato' } } }))).toBeTruthy();
    // Etapa final não é aplicada pela IA.
    fakeAi.script = ['Fechado!\n[ETAPA:Ganho]'];
    await sendInbound(ctx, p, 'fechado então');
    const c2 = await prisma.contact.findFirstOrThrow({ where: { id: c.id } });
    expect(c2.stageId).toBe(stage.id);
    await owner.put('/api/ai/settings', { kanbanAuto: false });
  });
});
