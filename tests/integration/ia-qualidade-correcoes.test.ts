/**
 * v1.35.0 — IA mais inteligente: correções da equipe ("IA respondeu mal") viram base de conhecimento, busca com a
 * pergunta anterior, dados do contato no contexto, checagem de valores fora da base, Qualidade por finalidade e a
 * camada única de IA. Conversas de exemplo: loja de carros fictícia.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { registerClient, Client, createTestChannel, installGraphMock, graph, sendInbound, sentTexts, prisma } from '../helpers.js';
import { fakeAi } from '../../server/ai/providers.js';
import { generateAiReply } from '../../server/ai/service.js';
import { aiChat, resetAiCache } from '../../server/ai/core.js';
import { TEXTO_CONFIRMAR_VALOR } from '../../server/ai/valueGuard.js';

const systemOf = (msgs: { role: string; content: string }[]) => msgs.find((m) => m.role === 'system')?.content ?? '';

describe('IA · qualidade e correções (loja de carros)', () => {
  let owner: Client;
  let ctx: Awaited<ReturnType<typeof createTestChannel>>;
  let phone = 5511730000000;
  const nextPhone = () => String(++phone);
  const org = () => owner.me.org.id;
  const lastConv = async (tel: string) => {
    const c = await prisma.contact.findFirstOrThrow({ where: { orgId: org(), waId: tel } });
    return prisma.conversation.findFirstOrThrow({ where: { orgId: org(), contactId: c.id }, orderBy: { createdAt: 'desc' } });
  };

  beforeAll(async () => {
    installGraphMock();
    owner = await registerClient();
    ctx = await createTestChannel(org());
    await owner.put('/api/ai/settings', { provider: 'fake', model: 'fake-1', enabled: true, autoReply: true, instructions: 'Somos a Auto Center Fictícia, loja de carros seminovos em São Paulo.' });
    await owner.post('/api/ai/knowledge', { title: 'Estoque', content: 'Chevrolet Onix 2022 completo, 40 mil km, sai por R$ 74.900,00 à vista.' });
    await owner.post('/api/ai/knowledge', { title: 'Horário', content: 'A loja abre de segunda a sábado, das 9h às 18h.' });
  });
  beforeEach(() => { graph.reset(); fakeAi.script = []; fakeAi.calls = []; resetAiCache(); });

  it('pergunta curta ("e quanto custa?") busca junto com a anterior do cliente', async () => {
    const tel = nextPhone();
    fakeAi.script = ['Temos sim, um Onix 2022 completo.'];
    await sendInbound(ctx, tel, 'vocês têm Onix 2022?');
    fakeAi.calls = [];
    await sendInbound(ctx, tel, 'e quanto custa?');
    expect(systemOf(fakeAi.calls[0])).toContain('R$ 74.900,00');
    expect(sentTexts().at(-1)).toContain('74.900,00');
  });

  it('dados do contato entram no contexto (nome, etiquetas, etapa do Kanban)', async () => {
    const tel = nextPhone();
    fakeAi.script = ['Oi!'];
    await sendInbound(ctx, tel, 'oi');
    const conv = await lastConv(tel);
    const stage = await prisma.kanbanStage.create({ data: { orgId: org(), name: 'Test-drive marcado', position: 99 } });
    await prisma.contact.update({ where: { id: conv.contactId }, data: { name: 'Marcos Lima', tags: JSON.stringify(['financiamento']), stageId: stage.id } });
    fakeAi.calls = [];
    fakeAi.script = ['Combinado, Marcos.'];
    await generateAiReply({ orgId: org(), conversationId: conv.id, text: 'posso ir sábado?' });
    const sys = systemOf(fakeAi.calls[0]);
    expect(sys).toContain('### DADOS DO CONTATO');
    expect(sys).toContain('Nome: Marcos Lima');
    expect(sys).toContain('Etiquetas: financiamento');
    expect(sys).toContain('Etapa no funil: Test-drive marcado');
    expect(sys).toMatch(/nunca diga esse nome ao cliente/);
  });

  it('"IA respondeu mal": a correção vira item da base, passa na frente e pode ser desfeita', async () => {
    const tel = nextPhone();
    fakeAi.script = ['Não trabalhamos com financiamento.'];
    await sendInbound(ctx, tel, 'vocês fazem financiamento do carro?');
    const conv = await lastConv(tel);
    const ruim = await prisma.message.findFirstOrThrow({ where: { conversationId: conv.id, sender: 'ai', direction: 'OUT' }, orderBy: { createdAt: 'desc' } });
    const r = await owner.post('/api/ai/feedback', { messageId: ruim.id, correction: 'Fazemos financiamento pelo banco parceiro em até 60 vezes, sujeito a análise de crédito.' });
    expect(r.status).toBe(201);
    expect(r.body.question).toBe('vocês fazem financiamento do carro?');
    expect(r.body.knowledgeTitle).toMatch(/^Correção: vocês fazem financiamento/);
    const doc = await prisma.knowledgeDoc.findFirstOrThrow({ where: { id: r.body.knowledgeDocId } });
    expect(await prisma.knowledgeChunk.count({ where: { docId: doc.id } })).toBeGreaterThan(0);
    // Outra pessoa pergunta a mesma coisa: a correção vai ao prompt antes dos outros trechos.
    fakeAi.calls = [];
    await sendInbound(ctx, nextPhone(), 'tem financiamento?');
    const sys = systemOf(fakeAi.calls[0]);
    const ctxTxt = sys.split('### CONTEXTO')[1];
    expect(ctxTxt.trim().startsWith('[Correção:')).toBe(true);
    expect(sys).toContain('em até 60 vezes');
    // Lista e qualidade
    expect((await owner.get('/api/ai/feedback')).body[0].correction).toMatch(/60 vezes/);
    expect((await owner.get('/api/ai/quality')).body.correcoes30d).toBe(1);
    // Mensagem que não é da IA: 404; correção vazia: 400.
    const doCliente = await prisma.message.findFirstOrThrow({ where: { conversationId: conv.id, direction: 'IN' } });
    expect((await owner.post('/api/ai/feedback', { messageId: doCliente.id, correction: 'qualquer coisa' })).status).toBe(404);
    expect((await owner.post('/api/ai/feedback', { messageId: ruim.id, correction: '' })).status).toBe(400);
    // Outra empresa não vê nem desfaz.
    const outra = await registerClient();
    expect((await outra.del(`/api/ai/feedback/${r.body.id}`)).status).toBe(404);
    expect((await outra.get('/api/ai/feedback')).body).toEqual([]);
    // Desfazer: sai da base.
    expect((await owner.del(`/api/ai/feedback/${r.body.id}`)).status).toBe(200);
    expect(await prisma.knowledgeDoc.findFirst({ where: { id: doc.id } })).toBeNull();
    expect(await prisma.knowledgeChunk.count({ where: { docId: doc.id } })).toBe(0);
  });

  it('valor fora da base: desligado só registra em Qualidade; ligado refaz uma vez e, se insistir, confirma com a equipe', async () => {
    const tel = nextPhone();
    // Desligado (padrão): a resposta sai como antes, mas fica marcada.
    expect((await owner.get('/api/ai/settings')).body.guardValues).toBe(false);
    fakeAi.script = ['O IPVA do Onix fica R$ 2.100,00.'];
    await sendInbound(ctx, tel, 'quanto é o IPVA do Onix?');
    expect(sentTexts().at(-1)).toBe('O IPVA do Onix fica R$ 2.100,00.');
    const u = await prisma.aiUsage.findFirstOrThrow({ where: { orgId: org(), purpose: 'atendimento', success: true }, orderBy: { createdAt: 'desc' } });
    expect(u.quality).toBe('valor_fora_base');
    expect(u.promptVersion).toMatch(/^atendimento@/);
    // Valor que está na base não marca nada.
    fakeAi.script = ['O Onix sai por R$ 74.900,00 à vista.'];
    await sendInbound(ctx, tel, 'e o preço do Onix?');
    expect((await prisma.aiUsage.findFirstOrThrow({ where: { orgId: org(), purpose: 'atendimento', success: true }, orderBy: { createdAt: 'desc' } })).quality).toBeNull();
    // Ligado: nova tentativa corrige.
    expect((await owner.put('/api/ai/settings', { guardValues: true })).body.guardValues).toBe(true);
    graph.reset(); fakeAi.calls = [];
    fakeAi.script = ['A garantia é de 2 anos.', 'Temos garantia de motor e câmbio; o prazo eu confirmo com a equipe.'];
    await sendInbound(ctx, tel, 'qual a garantia?');
    expect(fakeAi.calls).toHaveLength(2);
    expect(systemOf(fakeAi.calls[1])).toContain('CORREÇÃO OBRIGATÓRIA');
    expect(sentTexts()).toEqual(['Temos garantia de motor e câmbio; o prazo eu confirmo com a equipe.']);
    // Insistiu: texto de confirmação + nota no Inbox; nunca envia o valor inventado.
    graph.reset();
    fakeAi.script = ['Dou 15% de desconto.', 'Consigo 15% de desconto.'];
    await sendInbound(ctx, tel, 'tem desconto?');
    expect(sentTexts()).toEqual([TEXTO_CONFIRMAR_VALOR]);
    const conv = await lastConv(tel);
    expect((await prisma.message.findFirstOrThrow({ where: { conversationId: conv.id, direction: 'INTERNAL' }, orderBy: { createdAt: 'desc' } })).body).toMatch(/Tarefa para a equipe: a IA ia citar 15%/);
    expect((await prisma.conversation.findUniqueOrThrow({ where: { id: conv.id } })).mode).toBe('BOT'); // não transfere
    const q = (await owner.get('/api/ai/quality')).body;
    expect(q.valoresForaDaBase).toBeGreaterThanOrEqual(3);
    expect(q.valoresBloqueados).toBeGreaterThanOrEqual(2);
    expect(q.porFinalidade.map((p: any) => p.finalidade)).toEqual(expect.arrayContaining(['atendimento', 'revisao']));
    await owner.put('/api/ai/settings', { guardValues: false });
  });

  it('regra do dono: só o pedido explícito de pessoa transfere; "não sei" ou falha seguem com a IA', async () => {
    const tel = nextPhone();
    fakeAi.script = ['__EMPTY__', '__EMPTY__', '__EMPTY__'];
    await sendInbound(ctx, tel, 'aceitam meu carro na troca?');
    const conv = await lastConv(tel);
    expect((await prisma.conversation.findUniqueOrThrow({ where: { id: conv.id } })).mode).toBe('BOT');
    expect(sentTexts().length).toBe(1);
    graph.reset();
    await sendInbound(ctx, tel, 'quero falar com um vendedor humano');
    expect((await prisma.conversation.findUniqueOrThrow({ where: { id: conv.id } })).mode).toBe('HUMAN');
  });

  it('camada única: modelo reserva em falha passageira, finalidade no registro e cache curto', async () => {
    const s = { provider: 'fake', model: 'fake-1' };
    process.env.AI_FALLBACK_MODEL = 'fake-reserva';
    process.env.AI_RETRY_BACKOFF_MS = '0';
    try {
      fakeAi.models = [];
      fakeAi.script = ['__503__', '{"ok":true}'];
      const r = await aiChat({ orgId: org(), purpose: 'sdr-extracao', settings: s, messages: [{ role: 'system', content: 'teste' }, { role: 'user', content: 'carro' }], temperature: 0, maxTokens: 50 });
      expect(r.text).toBe('{"ok":true}');
      expect(fakeAi.models).toEqual(['fake-1', 'fake-reserva']);
      const u = await prisma.aiUsage.findFirstOrThrow({ where: { orgId: org(), purpose: 'sdr-extracao' }, orderBy: { createdAt: 'desc' } });
      expect(u).toMatchObject({ success: true, model: 'fake-reserva', promptVersion: expect.stringMatching(/^sdr-extracao@/) });
      // Erro definitivo não repete.
      fakeAi.models = [];
      await expect(aiChat({ orgId: org(), purpose: 'campanha', settings: { provider: 'nao-existe', model: 'x' }, messages: [{ role: 'user', content: 'oi' }], temperature: 0, maxTokens: 10 })).rejects.toThrow(/não configurada/);
      // Cache: a mesma entrada não chama de novo.
      fakeAi.calls = [];
      fakeAi.script = ['resposta 1', 'resposta 2'];
      const args = { orgId: org(), purpose: 'sdr-extracao' as const, settings: s, messages: [{ role: 'user' as const, content: 'mesma pergunta' }], temperature: 0, maxTokens: 10, cacheTtlMs: 60_000 };
      expect((await aiChat(args)).text).toBe('resposta 1');
      const c2 = await aiChat(args);
      expect(c2).toMatchObject({ text: 'resposta 1', cached: true });
      expect(fakeAi.calls).toHaveLength(1);
    } finally {
      delete process.env.AI_FALLBACK_MODEL;
      delete process.env.AI_RETRY_BACKOFF_MS;
      fakeAi.script = [];
    }
  });
});
