import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { registerClient, Client, createTestChannel, installGraphMock, graph, sendInbound, sentTexts, prisma } from '../helpers.js';
import { tick } from '../../server/flows/engine.js';

const N = (id: string, type: string, data: any = {}, x = 0) => ({ id, type, position: { x, y: 0 }, data });
const E = (source: string, target: string, sourceHandle = 'next') => ({ id: `${source}-${sourceHandle}-${target}`, source, target, sourceHandle });

describe('Motor de fluxos (integração com banco e webhook)', () => {
  let owner: Client;
  let ctx: Awaited<ReturnType<typeof createTestChannel>>;
  let phone = 5511800000000;
  const nextPhone = () => String(++phone);

  async function createActive(name: string, graphDef: any, priority = 0) {
    const f = await owner.post('/api/flows', { name, graph: graphDef });
    expect(f.status).toBe(201);
    if (priority) await owner.put(`/api/flows/${f.body.id}`, { priority, graph: graphDef });
    const a = await owner.post(`/api/flows/${f.body.id}/status`, { status: 'ACTIVE' });
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    return f.body.id as string;
  }

  beforeAll(async () => {
    installGraphMock();
    owner = await registerClient();
    ctx = await createTestChannel(owner.me.org.id);

    // Fluxo 1: palavra-chave "cadastro" → pergunta nome → pergunta email → condição → texto → fim
    await createActive('Cadastro', {
      nodes: [
        N('s', 'start', { triggers: [{ type: 'keyword', value: 'cadastro', match: 'contains' }] }),
        N('q1', 'ask', { question: 'Qual é o seu nome?', variable: 'nome' }),
        N('q2', 'ask', { question: 'Seu e-mail, {{nome}}?', variable: 'email', validation: 'email', errorText: 'E-mail inválido, tente de novo.' }),
        N('c', 'condition', { logic: 'all', rules: [{ variable: 'email', operator: 'contains', value: '@empresa.com' }] }),
        N('y', 'send_text', { text: 'Cliente corporativo! Obrigado, {{nome}}.' }),
        N('n', 'send_text', { text: 'Obrigado, {{nome}}!' }),
        N('t', 'tag', { tag: 'cadastrado' }),
        N('e', 'end', { message: 'Cadastro concluído.' }),
      ],
      edges: [E('s', 'q1'), E('q1', 'q2'), E('q2', 'c'), E('c', 'y', 'yes'), E('c', 'n', 'no'), E('y', 't'), E('n', 't'), E('t', 'e')],
    });
    // Fluxo 2: menu
    await createActive('Menu', {
      nodes: [
        N('s', 'start', { triggers: [{ type: 'keyword', value: 'menu', match: 'equals' }] }),
        N('m', 'menu', { text: 'Escolha:', options: [{ id: 'a', label: 'Suporte' }, { id: 'b', label: 'Vendas' }] }),
        N('a', 'send_text', { text: 'Você escolheu suporte.' }),
        N('h', 'handoff', { message: 'Chamando um vendedor...' }),
      ],
      edges: [E('s', 'm'), E('m', 'a', 'opt-a'), E('m', 'h', 'opt-b')],
    });
    // Fluxo 3: espera
    await createActive('Espera', {
      nodes: [N('s', 'start', { triggers: [{ type: 'keyword', value: 'aguarde', match: 'equals' }] }), N('a', 'send_text', { text: 'Um momento...' }), N('w', 'wait', { seconds: 60 }), N('b', 'send_text', { text: 'Pronto!' })],
      edges: [E('s', 'a'), E('a', 'w'), E('w', 'b')],
    });
    // Fluxo 4: loop infinito (condição sempre falsa volta para ela mesma via tag)
    await createActive('Loop', {
      nodes: [N('s', 'start', { triggers: [{ type: 'keyword', value: 'loop', match: 'equals' }] }), N('t1', 'tag', { tag: 'x' }), N('t2', 'tag', { tag: 'y' })],
      edges: [E('s', 't1'), E('t1', 't2'), E('t2', 't1')],
    });
    // Fluxo 5: primeira mensagem (genérico) — menor especificidade que palavra-chave
    await createActive('Boas-vindas', {
      nodes: [N('s', 'start', { triggers: [{ type: 'first_message' }] }), N('a', 'send_text', { text: 'Bem-vindo à loja!' })],
      edges: [E('s', 'a')],
    });
  });
  beforeEach(() => graph.reset());

  it('primeira mensagem dispara o fluxo de boas-vindas; a segunda não', async () => {
    const p = nextPhone();
    await sendInbound(ctx, p, 'bom dia');
    expect(sentTexts()).toEqual(['Bem-vindo à loja!']);
    graph.reset();
    await sendInbound(ctx, p, 'bom dia de novo');
    expect(sentTexts()).toEqual([]);
  });

  it('palavra-chave tem prioridade sobre primeira mensagem e coleta variáveis com validação', async () => {
    const p = nextPhone();
    await sendInbound(ctx, p, 'quero fazer cadastro');
    expect(sentTexts()).toEqual(['Qual é o seu nome?']);
    await sendInbound(ctx, p, 'Joana');
    await sendInbound(ctx, p, 'email-invalido');
    await sendInbound(ctx, p, 'joana@empresa.com');
    expect(sentTexts()).toEqual(['Qual é o seu nome?', 'Seu e-mail, Joana?', 'E-mail inválido, tente de novo.', 'Cliente corporativo! Obrigado, Joana.', 'Cadastro concluído.']);
    const contact = await prisma.contact.findFirstOrThrow({ where: { orgId: owner.me.org.id, waId: p } });
    expect(contact.name).toBe('Joana');
    expect(contact.email).toBe('joana@empresa.com');
    expect(JSON.parse(contact.tags)).toContain('cadastrado');
    expect(JSON.parse(contact.vars)).toMatchObject({ nome: 'Joana', email: 'joana@empresa.com' });
    const run = await prisma.flowRun.findFirstOrThrow({ where: { contactId: contact.id } });
    expect(run.status).toBe('COMPLETED');
    const steps = await prisma.flowRunStep.findMany({ where: { runId: run.id }, orderBy: { createdAt: 'asc' } });
    // q1 registra 2 etapas (pergunta + resposta); q2 registra 3 (pergunta, resposta inválida, resposta válida)
    expect(steps.map((s) => s.nodeId)).toEqual(['s', 'q1', 'q1', 'q2', 'q2', 'q2', 'c', 'y', 't', 'e']);
  });

  it('ramo "não" da condição', async () => {
    const p = nextPhone();
    for (const t of ['cadastro', 'Rui', 'rui@gmail.com']) await sendInbound(ctx, p, t);
    expect(sentTexts()).toContain('Obrigado, Rui!');
  });

  it('menu: opção inválida reenvia, opção válida segue o ramo; "Vendas" transfere para humano', async () => {
    const p = nextPhone();
    await sendInbound(ctx, p, 'menu');
    expect(sentTexts()[0]).toBe('Escolha:\n\n1. Suporte\n2. Vendas');
    await sendInbound(ctx, p, '9');
    expect(sentTexts()[1]).toMatch(/Opção inválida/);
    await sendInbound(ctx, p, '1');
    expect(sentTexts()[2]).toBe('Você escolheu suporte.');

    const p2 = nextPhone();
    await sendInbound(ctx, p2, 'menu');
    await sendInbound(ctx, p2, 'vendas');
    const c = await prisma.contact.findFirstOrThrow({ where: { orgId: owner.me.org.id, waId: p2 } });
    const conv = await prisma.conversation.findFirstOrThrow({ where: { contactId: c.id } });
    expect(conv.mode).toBe('HUMAN');
    expect(conv.status).toBe('PENDING');
    graph.reset();
    await sendInbound(ctx, p2, 'menu'); // em modo humano a automação não responde
    expect(sentTexts()).toEqual([]);
  });

  it('bloco Aguardar pausa e o agendador retoma depois do tempo', async () => {
    const p = nextPhone();
    await sendInbound(ctx, p, 'aguarde');
    expect(sentTexts()).toEqual(['Um momento...']);
    expect(await tick(new Date())).toBe(0);
    expect(await tick(new Date(Date.now() + 61000))).toBe(1);
    expect(sentTexts()).toEqual(['Um momento...', 'Pronto!']);
    expect(await tick(new Date(Date.now() + 120000))).toBe(0); // não executa de novo
  });

  it('proteção contra loop encerra a execução com FAILED no limite de passos', async () => {
    const p = nextPhone();
    await sendInbound(ctx, p, 'loop');
    const c = await prisma.contact.findFirstOrThrow({ where: { orgId: owner.me.org.id, waId: p } });
    const run = await prisma.flowRun.findFirstOrThrow({ where: { contactId: c.id } });
    expect(run.status).toBe('FAILED');
    expect(run.error).toMatch(/Limite de 50 passos/);
    expect(run.stepCount).toBe(50);
  });

  it('duplicidade: mesma mensagem reenviada não inicia o fluxo duas vezes', async () => {
    const p = nextPhone();
    const id = `wamid.DUP${Date.now()}`;
    await Promise.all([sendInbound(ctx, p, 'menu', { id }), sendInbound(ctx, p, 'menu', { id })]);
    const c = await prisma.contact.findFirstOrThrow({ where: { orgId: owner.me.org.id, waId: p } });
    expect(await prisma.flowRun.count({ where: { contactId: c.id } })).toBe(1);
    expect(sentTexts()).toHaveLength(1);
  });

  it('versionamento: salvar cria nova versão; execução em andamento usa a versão em que começou', async () => {
    const id = await createActive('Versões', {
      nodes: [N('s', 'start', { triggers: [{ type: 'keyword', value: 'versao', match: 'equals' }] }), N('q', 'ask', { question: 'V1?', variable: 'x' }), N('a', 'send_text', { text: 'fim v1' })],
      edges: [E('s', 'q'), E('q', 'a')],
    });
    const p = nextPhone();
    await sendInbound(ctx, p, 'versao');
    const save = await owner.put(`/api/flows/${id}`, { graph: { nodes: [N('s', 'start', { triggers: [{ type: 'keyword', value: 'versao', match: 'equals' }] }), N('q', 'ask', { question: 'V2?', variable: 'x' }), N('a', 'send_text', { text: 'fim v2' })], edges: [E('s', 'q'), E('q', 'a')] } });
    expect(save.status).toBe(200);
    expect(save.body.flow.currentVersion).toBe(2);
    await sendInbound(ctx, p, 'resposta');
    expect(sentTexts()).toEqual(['V1?', 'fim v1']);
    const versions = await owner.get(`/api/flows/${id}/versions`);
    expect(versions.body.versions.map((v: any) => v.version)).toEqual([2, 1]);
    const restore = await owner.post(`/api/flows/${id}/restore/1`);
    expect(restore.body.version).toBe(3);
  });

  it('ativar fluxo inválido é recusado; pausar cancela execuções; duplicar e excluir funcionam', async () => {
    const bad = await owner.post('/api/flows', { name: 'Inválido', graph: { nodes: [N('s', 'start', { triggers: [] })], edges: [] } });
    const act = await owner.post(`/api/flows/${bad.body.id}/status`, { status: 'ACTIVE' });
    expect(act.status).toBe(400);
    expect(act.body.details).toContain('Adicione pelo menos um gatilho no bloco Início');

    const flows = await owner.get('/api/flows');
    const menu = flows.body.find((f: any) => f.name === 'Menu');
    const p = nextPhone();
    await sendInbound(ctx, p, 'menu');
    expect((await owner.post(`/api/flows/${menu.id}/status`, { status: 'PAUSED' })).body.status).toBe('PAUSED');
    const c = await prisma.contact.findFirstOrThrow({ where: { orgId: owner.me.org.id, waId: p } });
    expect((await prisma.flowRun.findFirstOrThrow({ where: { contactId: c.id } })).status).toBe('CANCELLED');
    graph.reset();
    await sendInbound(ctx, p, 'menu');
    // pausado não dispara: nenhuma execução nova do Menu (o comando "menu" cai no fluxo de boas-vindas)
    expect(await prisma.flowRun.count({ where: { contactId: c.id, flowId: menu.id } })).toBe(1);
    expect(sentTexts()).not.toContain('Escolha:\n\n1. Suporte\n2. Vendas');
    const dup = await owner.post(`/api/flows/${menu.id}/duplicate`);
    expect(dup.body.name).toBe('Menu (cópia)');
    expect(dup.body.status).toBe('DRAFT');
    expect((await owner.del(`/api/flows/${dup.body.id}`)).status).toBe(200);
    expect((await owner.get(`/api/flows/${dup.body.id}`)).status).toBe(404);
  });

  it('estatísticas por bloco e histórico de execuções', async () => {
    const flows = await owner.get('/api/flows');
    const cad = flows.body.find((f: any) => f.name === 'Cadastro');
    expect(cad.runs.completed).toBeGreaterThanOrEqual(2);
    const detail = await owner.get(`/api/flows/${cad.id}`);
    expect(detail.body.nodeStats.q2.ok).toBeGreaterThanOrEqual(3);
    const runs = await owner.get(`/api/flows/${cad.id}/runs`);
    expect(runs.body[0].steps.length).toBeGreaterThan(3);
  });

  it('bloco HTTP: mapeia JSON para variáveis, segue ramo de erro e bloqueia rede interna (SSRF)', async () => {
    graph.other = async (url) => {
      if (url === 'https://api.parceiro.com.br/clientes/ok') return new Response(JSON.stringify({ data: { plano: 'Ouro', itens: [{ nome: 'A' }] } }), { status: 200 });
      if (url === 'https://api.parceiro.com.br/clientes/erro') return new Response(JSON.stringify({ message: 'não encontrado' }), { status: 404 });
      return null;
    };
    await createActive('HTTP', {
      nodes: [
        N('s', 'start', { triggers: [{ type: 'keyword', value: 'consulta', match: 'contains' }] }),
        N('h', 'http', { method: 'GET', url: 'https://api.parceiro.com.br/clientes/{{last_message_id}}ok', mappings: [{ variable: 'plano', path: 'data.plano' }, { variable: 'item', path: 'data.itens.0.nome' }] }),
        N('ok', 'send_text', { text: 'Seu plano: {{plano}} / {{item}}' }),
        N('err', 'send_text', { text: 'Erro {{http_status}}: {{http_error}}' }),
      ],
      edges: [E('s', 'h'), E('h', 'ok', 'success'), E('h', 'err', 'error')],
    });
    const p = nextPhone();
    await sendInbound(ctx, p, 'consulta');
    expect(sentTexts()).toEqual(['Seu plano: Ouro / A']);

    const r = await owner.post('/api/flows/http-test', { method: 'GET', url: 'https://api.parceiro.com.br/clientes/erro' });
    expect(r.body).toMatchObject({ ok: false, status: 404 });
    const ssrf = await owner.post('/api/flows/http-test', { method: 'GET', url: 'http://127.0.0.1:5432/' });
    expect(ssrf.body.error).toMatch(/interno/);
    const ssrfDns = await owner.post('/api/flows/http-test', { method: 'GET', url: 'https://api.interno.test/x' });
    expect(ssrfDns.body.error).toMatch(/interno/); // domínio que resolve para IP privado também é bloqueado
  });

  it('disparo manual pelo Inbox ("Enviar fluxo") retoma o modo robô', async () => {
    const flows = await owner.get('/api/flows');
    const wel = flows.body.find((f: any) => f.name === 'Boas-vindas');
    const p = nextPhone();
    await sendInbound(ctx, p, 'oi');
    const c = await prisma.contact.findFirstOrThrow({ where: { orgId: owner.me.org.id, waId: p } });
    const conv = await prisma.conversation.findFirstOrThrow({ where: { contactId: c.id } });
    await owner.post(`/api/conversations/${conv.id}/action`, { action: 'take' });
    graph.reset();
    const r = await owner.post(`/api/flows/${wel.id}/start`, { conversationId: conv.id });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('COMPLETED');
    expect(sentTexts()).toEqual(['Bem-vindo à loja!']);
  });

  it('falha no envio (canal desconectado) marca a execução como FAILED', async () => {
    await prisma.channel.update({ where: { id: ctx.ch.id }, data: { status: 'NOT_CONNECTED' } });
    try {
      const p = nextPhone();
      await sendInbound(ctx, p, 'oi');
      const c = await prisma.contact.findFirstOrThrow({ where: { orgId: owner.me.org.id, waId: p } });
      const run = await prisma.flowRun.findFirstOrThrow({ where: { contactId: c.id } });
      expect(run.status).toBe('FAILED');
      expect(run.error).toMatch(/não conectado/);
      expect(graph.calls).toHaveLength(0);
    } finally {
      await prisma.channel.update({ where: { id: ctx.ch.id }, data: { status: 'CONNECTED' } });
    }
  });
});

describe('Agendador econômico', () => {
  it('scheduledTick não executa nada antes do vencimento e retoma depois', async () => {
    const { scheduledTick } = await import('../../server/flows/engine.js');
    installGraphMock();
    const owner = await registerClient();
    const ctx = await createTestChannel(owner.me.org.id);
    const f = await owner.post('/api/flows', { name: 'Espera curta', graph: { nodes: [N('s', 'start', { triggers: [{ type: 'keyword', value: 'espera', match: 'equals' }] }), N('w', 'wait', { seconds: 30 }), N('b', 'send_text', { text: 'Voltei!' })], edges: [E('s', 'w'), E('w', 'b')] } });
    await owner.post(`/api/flows/${f.body.id}/status`, { status: 'ACTIVE' });
    graph.reset();
    await sendInbound(ctx, '5511955554444', 'espera');
    expect(await scheduledTick(new Date())).toBe(0);
    expect(sentTexts()).toEqual([]);
    expect(await scheduledTick(new Date(Date.now() + 31000))).toBe(1);
    expect(sentTexts()).toEqual(['Voltei!']);
  });
});
