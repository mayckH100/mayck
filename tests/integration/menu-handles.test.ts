import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { registerClient, Client, createTestChannel, installGraphMock, graph, sendInbound, sentTexts } from '../helpers.js';
import { menuOutputs } from '../../server/flows/handles.js';

const N = (id: string, type: string, data: any = {}) => ({ id, type, position: { x: 0, y: 0 }, data });
const E = (source: string, target: string, sourceHandle = 'next') => ({ id: `${source}-${sourceHandle}-${target}`, source, target, sourceHandle });

/** Menu numerado com 5 opções; cada saída (pelo mesmo id que o editor gera) vai para um texto diferente. */
const options = [1, 2, 3, 4, 5].map((i) => ({ id: `k${i}`, label: `Item ${i}` }));
const outs = menuOutputs(options);
const flowGraph = {
  nodes: [
    N('s', 'start', { triggers: [{ type: 'keyword', value: 'cardapio', match: 'equals' }] }),
    N('m', 'menu', { text: 'Escolha:', options, style: 'text' }),
    ...options.map((_, i) => N(`t${i + 1}`, 'send_text', { text: `Destino ${i + 1}` })),
    N('tx', 'send_text', { text: 'Destino inválido' }),
  ],
  edges: [E('s', 'm'), ...outs.slice(0, 5).map((o, i) => E('m', `t${i + 1}`, o.id)), E('m', 'tx', outs[5].id)],
};

describe('Menu com 5 opções: cada escolha segue a sua saída', () => {
  let owner: Client;
  let ctx: Awaited<ReturnType<typeof createTestChannel>>;
  let phone = 5511890000000;
  const nextPhone = () => String(++phone);

  beforeAll(async () => {
    installGraphMock();
    owner = await registerClient();
    ctx = await createTestChannel(owner.me.org.id);
    const f = await owner.post('/api/flows', { name: 'Cinco opções', graph: flowGraph });
    expect(f.status).toBe(201);
    const a = await owner.post(`/api/flows/${f.body.id}/status`, { status: 'ACTIVE' });
    expect(a.status, JSON.stringify(a.body)).toBe(200);
  });
  beforeEach(() => graph.reset());

  for (const n of [1, 2, 3, 4, 5]) {
    it(`resposta "${n}" vai para o bloco ligado à saída ${n}`, async () => {
      const p = nextPhone();
      await sendInbound(ctx, p, 'cardapio');
      expect(sentTexts()[0]).toBe(`Escolha:\n\n${options.map((o, i) => `${i + 1}. ${o.label}`).join('\n')}`);
      await sendInbound(ctx, p, String(n));
      expect(sentTexts().at(-1)).toBe(`Destino ${n}`);
    });
  }

  it('resposta inválida segue a saída ✕', async () => {
    const p = nextPhone();
    await sendInbound(ctx, p, 'cardapio');
    await sendInbound(ctx, p, '9');
    expect(sentTexts().at(-1)).toBe('Destino inválido');
  });

  it('salvar fluxo antigo com opções sem id corrige os ids e mantém a conexão', async () => {
    const legacy = {
      nodes: [N('s', 'start', { triggers: [{ type: 'keyword', value: 'legado', match: 'equals' }] }), N('m', 'menu', { text: 'X', options: [{ label: 'A' }, { id: 'b', label: 'B' }] }), N('a', 'send_text', { text: 'foi A' }), N('b', 'send_text', { text: 'foi B' })],
      edges: [E('s', 'm'), E('m', 'a', 'opt-undefined'), E('m', 'b', 'opt-b')],
    };
    const f = await owner.post('/api/flows', { name: 'Legado', graph: legacy });
    const g = await owner.get(`/api/flows/${f.body.id}`);
    expect(g.body.graph.nodes[1].data.options.map((o: any) => o.id)).toEqual(['o1', 'b']);
    expect(g.body.graph.edges.find((e: any) => e.target === 'a').sourceHandle).toBe('opt-o1');
    await owner.post(`/api/flows/${f.body.id}/status`, { status: 'ACTIVE' });
    const p = nextPhone();
    await sendInbound(ctx, p, 'legado');
    await sendInbound(ctx, p, '1');
    expect(sentTexts().at(-1)).toBe('foi A');
  });
});
