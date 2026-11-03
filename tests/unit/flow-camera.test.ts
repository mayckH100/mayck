import { describe, it, expect } from 'vitest';
import {
  panelInsets, fitPadding, fitOptions, INITIAL_FIT_OPTIONS, centerTarget, panByKey, findStartId, gotoTargets,
  changeTriggerType, triggerSummary, triggersSummary, MIN_ZOOM,
} from '../../web/src/lib/flowCamera.js';
import { setOutputEdge, edgeTarget } from '../../server/flows/handles.js';
import { matchTriggers } from '../../server/flows/logic.js';

const rect = (left: number, right: number, top = 0, bottom = 600) => ({ left, right, top, bottom });

describe('Editor de fluxos — câmera (fitView / centralização)', () => {
  it('layout em grade (1280 px): painéis ao lado do canvas não tiram área', () => {
    // sidebar 240 + padding 24 + paleta 170 → canvas começa em 434; props começa em 1256-290
    expect(panelInsets(rect(434, 966), rect(264, 434), rect(966, 1256))).toEqual({ left: 0, right: 0, top: 0, bottom: 0 });
  });
  it('painel flutuando sobre o canvas vira margem do fitView', () => {
    const ins = panelInsets(rect(264, 1256), rect(264, 464), rect(936, 1256));
    expect(ins).toEqual({ left: 200, right: 320, top: 0, bottom: 0 });
    expect(fitPadding(ins)).toEqual({ left: '232px', right: '352px', top: '32px', bottom: '32px' });
  });
  it('painel fora da faixa vertical do canvas é ignorado', () => {
    expect(panelInsets(rect(0, 800, 0, 400), rect(0, 160, 500, 900), null).left).toBe(0);
  });
  it('fitView pode reduzir abaixo de 0,5 (antes cortava o Início) e não passa de 100%', () => {
    const o = fitOptions();
    expect(o.minZoom).toBe(MIN_ZOOM);
    expect(MIN_ZOOM).toBeLessThan(0.5);
    expect(o.maxZoom).toBe(1);
    expect(o).not.toHaveProperty('duration');
    expect(fitOptions(undefined, 200).duration).toBe(200);
  });
  it('opções do fitView inicial são um objeto estável (não reenfileira a cada render)', () => {
    expect(Object.isFrozen(INITIAL_FIT_OPTIONS)).toBe(true);
    expect(INITIAL_FIT_OPTIONS.minZoom).toBe(MIN_ZOOM);
  });
  it('centralização compensa painel à esquerda (bloco fica no centro da área visível)', () => {
    const node = { position: { x: 100, y: 50 }, width: 200, height: 60 };
    expect(centerTarget(node, { left: 0, right: 0, top: 0, bottom: 0 }, 1)).toEqual({ x: 200, y: 80 });
    // 200 px de paleta por cima: o alvo anda 100 px (em zoom 1) para a esquerda no fluxo
    expect(centerTarget(node, { left: 200, right: 0, top: 0, bottom: 0 }, 1)).toEqual({ x: 100, y: 80 });
    expect(centerTarget(node, { left: 200, right: 0, top: 0, bottom: 0 }, 0.5)).toEqual({ x: 0, y: 80 });
  });
  it('setas do teclado movem a câmera; outras teclas não', () => {
    const vp = { x: 10, y: 20, zoom: 0.7 };
    expect(panByKey('ArrowLeft', vp)).toEqual({ x: 90, y: 20, zoom: 0.7 });
    expect(panByKey('ArrowRight', vp)).toEqual({ x: -70, y: 20, zoom: 0.7 });
    expect(panByKey('ArrowUp', vp, 40)).toEqual({ x: 10, y: 60, zoom: 0.7 });
    expect(panByKey('ArrowDown', vp, 40)).toEqual({ x: 10, y: -20, zoom: 0.7 });
    expect(panByKey('a', vp)).toBeNull();
  });
});

describe('Editor de fluxos — bloco Início', () => {
  const nodes = [
    { id: 's', type: 'start' }, { id: 'm', type: 'menu' }, { id: 't', type: 'send_text' },
  ];
  it('paleta/botão "Início / Gatilho" encontram o Início existente em vez de criar outro', () => {
    expect(findStartId(nodes)).toBe('s');
    expect(findStartId([{ id: 'x', type: 'menu' }])).toBeNull();
  });
  it('seletor "Ir para o bloco…" do Início lista os outros blocos (nunca o próprio Início)', () => {
    expect(gotoTargets(nodes, 's').map((n) => n.id)).toEqual(['m', 't']);
    expect(gotoTargets(nodes, 'm').map((n) => n.id)).toEqual(['t']);
  });
  it('seletor do Início cria, substitui e remove a aresta de saída', () => {
    let edges: any[] = [{ id: 'e0', source: 'm', target: 't', sourceHandle: 'opt-o1' }];
    edges = setOutputEdge(edges, 's', 'next', 'm', 'e1');
    expect(edgeTarget(edges, 's', 'next')).toBe('m');
    edges = setOutputEdge(edges, 's', 'next', 't', 'e2');
    expect(edges.filter((e) => e.source === 's')).toEqual([{ id: 'e2', source: 's', target: 't', sourceHandle: 'next' }]);
    expect(edges.find((e) => e.id === 'e0')).toBeTruthy(); // saídas de outros blocos ficam intactas
    edges = setOutputEdge(edges, 's', 'next', null, 'e3');
    expect(edgeTarget(edges, 's', 'next')).toBeNull();
  });
});

describe('Gatilho "Primeira mensagem" não exige palavra-chave', () => {
  const now = new Date('2026-11-03T15:00:00Z');
  const ctx = (text: string, isFirst: boolean) => ({ text, isFirst, now, timeZone: 'America/Sao_Paulo' });
  it('motor: first_message com "oi" salvo por engano dispara com qualquer texto na primeira mensagem', () => {
    const t = [{ type: 'first_message' as const, value: 'oi', match: 'equals' as const }];
    expect(matchTriggers(t, ctx('bom dia, quero saber o preço', true))).toBe(3);
    expect(matchTriggers(t, ctx('', true))).toBe(3);
    expect(matchTriggers(t, ctx('oi', false))).toBeNull();
  });
  it('trocar o tipo para "Primeira mensagem" apaga a palavra; voltar para palavra-chave começa vazio', () => {
    const fm = changeTriggerType({ type: 'keyword', value: 'oi', match: 'contains' }, 'first_message');
    expect(fm).toEqual({ type: 'first_message' });
    expect(changeTriggerType(fm, 'keyword')).toEqual({ type: 'keyword', value: '', match: 'contains' });
    expect(changeTriggerType({ type: 'keyword', value: 'pix', match: 'equals' }, 'keyword')).toEqual({ type: 'keyword', value: 'pix', match: 'equals' });
    expect(changeTriggerType({ type: 'first_message', value: 'oi' }, 'schedule')).toEqual({ type: 'schedule', start: '08:00', end: '18:00', days: [] });
  });
  it('legenda: "Primeira mensagem" não mostra palavra; palavra-chave mostra', () => {
    expect(triggerSummary({ type: 'first_message', value: 'oi' })).toBe('Primeira mensagem (qualquer texto)');
    expect(triggerSummary({ type: 'keyword', value: 'oi' })).toBe('Palavra-chave: oi');
    expect(triggerSummary({ type: 'keyword', value: '' })).toBe('Palavra-chave (vazia)');
    expect(triggersSummary([{ type: 'message' }, { type: 'schedule', start: '08:00', end: '18:00' }])).toBe('Mensagem recebida · Horário 08:00–18:00');
    expect(triggersSummary([])).toBe('Sem gatilho');
  });
});
