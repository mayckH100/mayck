import { describe, it, expect } from 'vitest';
import {
  menuHandleId, menuOutputs, normalizeMenuOptions, normalizeGraph, newOptionId, handleLayout, setOutputEdge, edgeTarget, INVALID_HANDLE,
} from '../../server/flows/handles.js';
import { matchMenuOption, nextNodeId, type FlowGraph } from '../../server/flows/logic.js';

const five = [1, 2, 3, 4, 5].map((i) => ({ id: `o${i}`, label: `Opção ${i}` }));

describe('Saídas do bloco Menu (ids dos handles)', () => {
  it('uma saída por opção, na ordem, com id opt-<id da opção>, e a inválida por último', () => {
    const outs = menuOutputs(five);
    expect(outs.map((o) => o.id)).toEqual(['opt-o1', 'opt-o2', 'opt-o3', 'opt-o4', 'opt-o5', INVALID_HANDLE]);
    expect(outs.map((o) => o.label)).toEqual(['1', '2', '3', '4', '5', '✕']);
    expect(new Set(outs.map((o) => o.id)).size).toBe(outs.length);
  });

  it('o id da saída não depende da posição: remover/reordenar opções mantém os ids das outras', () => {
    const semA = menuOutputs(five.filter((o) => o.id !== 'o2')).map((o) => o.id);
    expect(semA).toEqual(['opt-o1', 'opt-o3', 'opt-o4', 'opt-o5', INVALID_HANDLE]);
    const invert = menuOutputs([...five].reverse()).map((o) => o.id);
    expect(invert.slice(0, 5)).toEqual(['opt-o5', 'opt-o4', 'opt-o3', 'opt-o2', 'opt-o1']);
  });

  it('opções sem id ou com id repetido ganham ids únicos (nunca "opt-undefined" duplicado)', () => {
    const { options, renamed } = normalizeMenuOptions([{ label: 'A' }, { id: 'x', label: 'B' }, { id: 'x', label: 'C' }, { id: '', label: 'D' }, { id: 'o1', label: 'E' }]);
    const ids = options.map((o) => o.id);
    expect(new Set(ids).size).toBe(5);
    expect(ids[1]).toBe('x');
    expect(ids[4]).toBe('o1'); // id válido existente é preservado
    expect(ids).not.toContain('');
    expect(renamed.map((r) => r.index)).toEqual([0, 2, 3]);
    expect(menuOutputs([{ label: 'A' }, { label: 'B' }]).map((o) => o.id)).toEqual(['opt-o1', 'opt-o2', INVALID_HANDLE]);
  });

  it('newOptionId não repete um id existente', () => {
    let calls = 0;
    const rand = () => (++calls < 3 ? 'o1' : 'zz');
    expect(newOptionId(five, rand)).toBe('zz');
    expect(newOptionId(five, () => 'o1')).toBe('o6');
  });

  it('layout: rótulo e bolinha na mesma posição, 36 px entre centros e bloco largo o bastante', () => {
    const { lefts, minWidth } = handleLayout(6, 36);
    expect(lefts).toHaveLength(6);
    const px = lefts.map((l) => (l / 100) * minWidth);
    for (let i = 1; i < px.length; i++) expect(px[i] - px[i - 1]).toBeGreaterThanOrEqual(36 - 1e-9);
    // a área de toque (28 px no desktop, 32 px no celular) é menor que o espaçamento
    expect(32).toBeLessThan(px[1] - px[0]);
    expect(px[0]).toBeGreaterThan(0);
    expect(px[5]).toBeLessThan(minWidth);
  });
});

describe('Conexões por saída', () => {
  const base = [
    { id: 'e1', source: 'm', target: 'a', sourceHandle: 'opt-o1' },
    { id: 'e2', source: 'm', target: 'b', sourceHandle: 'opt-o2' },
  ];
  it('ligar a opção 1 troca só a conexão da opção 1; a da 2 continua', () => {
    const es = setOutputEdge(base, 'm', 'opt-o1', 'c', 'n1');
    expect(edgeTarget(es, 'm', 'opt-o1')).toBe('c');
    expect(edgeTarget(es, 'm', 'opt-o2')).toBe('b');
    expect(es.filter((e) => e.sourceHandle === 'opt-o1')).toHaveLength(1);
  });
  it('desligar (target vazio) remove só aquela saída; ligar no próprio bloco é ignorado', () => {
    expect(setOutputEdge(base, 'm', 'opt-o2', null, 'n')).toEqual([base[0]]);
    expect(setOutputEdge(base, 'm', 'opt-o3', 'm', 'n')).toEqual(base);
  });
});

describe('Roteamento do motor usa o mesmo id de saída do editor', () => {
  const g: FlowGraph = {
    nodes: [{ id: 'm', type: 'menu', position: { x: 0, y: 0 }, data: { options: five } }],
    edges: five.map((o, i) => ({ id: `e${i}`, source: 'm', target: `dest${i + 1}`, sourceHandle: menuOutputs(five)[i].id }))
      .concat([{ id: 'ei', source: 'm', target: 'destX', sourceHandle: INVALID_HANDLE }]),
  };
  it('escolha N (número, rótulo ou botão) vai para o bloco ligado à saída N', () => {
    for (let n = 1; n <= 5; n++) {
      const opt = matchMenuOption(five, String(n))!;
      expect(nextNodeId(g, 'm', menuHandleId(opt.id))).toBe(`dest${n}`);
      expect(nextNodeId(g, 'm', menuHandleId(matchMenuOption(five, `opção ${n}`)!.id))).toBe(`dest${n}`);
      expect(nextNodeId(g, 'm', menuHandleId(matchMenuOption(five, '', `o${n}`)!.id))).toBe(`dest${n}`);
    }
    expect(nextNodeId(g, 'm', INVALID_HANDLE)).toBe('destX');
  });

  it('normalizeGraph religa a conexão "opt-undefined" de opções antigas sem id e não mexe no resto', () => {
    const old: FlowGraph = {
      nodes: [{ id: 'm', type: 'menu', position: { x: 0, y: 0 }, data: { options: [{ label: 'A' }, { id: 'b', label: 'B' }] } }],
      edges: [{ id: 'e1', source: 'm', target: 'x', sourceHandle: 'opt-undefined' }, { id: 'e2', source: 'm', target: 'y', sourceHandle: 'opt-b' }],
    };
    const fixed = normalizeGraph(old);
    expect(fixed.nodes[0].data.options.map((o: any) => o.id)).toEqual(['o1', 'b']);
    expect(nextNodeId(fixed, 'm', 'opt-o1')).toBe('x');
    expect(nextNodeId(fixed, 'm', 'opt-b')).toBe('y');
    const ok: FlowGraph = { nodes: [{ id: 'm', type: 'menu', position: { x: 0, y: 0 }, data: { options: five } }], edges: [] };
    expect(normalizeGraph(ok)).toBe(ok);
  });
});
