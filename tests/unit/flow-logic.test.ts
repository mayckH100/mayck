import { describe, it, expect } from 'vitest';
import { matchTriggers, evaluateCondition, evaluateRule, matchMenuOption, validateAnswer, nextNodeId, validateGraph, isWithinSchedule, defaultGraph, type FlowGraph } from '../../server/flows/logic.js';
import { renderTemplate, renderDeep } from '../../server/lib/template.js';

const now = new Date('2026-10-26T15:00:00Z'); // segunda-feira 12:00 em São Paulo
const ctx = (text: string, isFirst = false) => ({ text, isFirst, now, timeZone: 'America/Sao_Paulo' });

describe('Gatilhos', () => {
  it('palavra-chave "contém" ignora acentos e maiúsculas', () => {
    expect(matchTriggers([{ type: 'keyword', value: 'preço', match: 'contains' }], ctx('Qual o PRECO?'))).toBe(4);
  });
  it('palavra-chave "igual" exige mensagem inteira', () => {
    const t = [{ type: 'keyword' as const, value: 'menu', match: 'equals' as const }];
    expect(matchTriggers(t, ctx('menu'))).toBe(4);
    expect(matchTriggers(t, ctx('quero o menu'))).toBeNull();
  });
  it('aceita várias palavras separadas por vírgula', () => {
    expect(matchTriggers([{ type: 'keyword', value: 'oi, olá, bom dia' }], ctx('Olá!'))).toBe(4);
  });
  it('primeira mensagem só casa quando é a primeira', () => {
    const t = [{ type: 'first_message' as const }];
    expect(matchTriggers(t, ctx('x', true))).toBe(3);
    expect(matchTriggers(t, ctx('x', false))).toBeNull();
  });
  it('mensagem recebida casa qualquer texto e perde para palavra-chave', () => {
    expect(matchTriggers([{ type: 'message' }], ctx('qualquer'))).toBe(1);
    expect(matchTriggers([{ type: 'message' }, { type: 'keyword', value: 'pix' }], ctx('quero pagar no pix'))).toBe(4);
  });
  it('horário respeita dias e janela no fuso da organização', () => {
    expect(isWithinSchedule({ type: 'schedule', days: [1], start: '08:00', end: '18:00' }, now, 'America/Sao_Paulo')).toBe(true);
    expect(isWithinSchedule({ type: 'schedule', days: [0, 6], start: '08:00', end: '18:00' }, now, 'America/Sao_Paulo')).toBe(false);
    expect(isWithinSchedule({ type: 'schedule', start: '18:00', end: '08:00' }, now, 'America/Sao_Paulo')).toBe(false);
    expect(isWithinSchedule({ type: 'schedule', start: '18:00', end: '08:00' }, new Date('2026-10-27T02:00:00Z'), 'America/Sao_Paulo')).toBe(true);
  });
});

describe('Condições', () => {
  const vars = { cidade: 'São Paulo', idade: '30', vazio: '', contact: { name: 'Ana' } };
  it('operadores básicos', () => {
    expect(evaluateRule({ variable: 'cidade', operator: 'equals', value: 'sao paulo' }, vars)).toBe(true);
    expect(evaluateRule({ variable: 'cidade', operator: 'contains', value: 'paulo' }, vars)).toBe(true);
    expect(evaluateRule({ variable: 'cidade', operator: 'not_equals', value: 'Rio' }, vars)).toBe(true);
    expect(evaluateRule({ variable: 'idade', operator: 'gt', value: '18' }, vars)).toBe(true);
    expect(evaluateRule({ variable: 'idade', operator: 'lt', value: '18' }, vars)).toBe(false);
    expect(evaluateRule({ variable: 'vazio', operator: 'exists' }, vars)).toBe(false);
    expect(evaluateRule({ variable: 'naoexiste', operator: 'not_exists' }, vars)).toBe(true);
    expect(evaluateRule({ variable: 'contact.name', operator: 'starts_with', value: 'an' }, vars)).toBe(true);
  });
  it('gt/lt com valor não numérico retorna falso', () => {
    expect(evaluateRule({ variable: 'cidade', operator: 'gt', value: '1' }, vars)).toBe(false);
  });
  it('lógica "todas" e "qualquer"', () => {
    const rules = [{ variable: 'idade', operator: 'gt' as const, value: '18' }, { variable: 'cidade', operator: 'equals' as const, value: 'Rio' }];
    expect(evaluateCondition(rules, 'all', vars)).toBe(false);
    expect(evaluateCondition(rules, 'any', vars)).toBe(true);
    expect(evaluateCondition([], 'all', vars)).toBe(false);
  });
});

describe('Menu e validação de respostas', () => {
  const opts = [{ id: 'a', label: 'Suporte' }, { id: 'b', label: 'Financeiro' }];
  it('casa por número, rótulo e id do botão', () => {
    expect(matchMenuOption(opts, '2')?.id).toBe('b');
    expect(matchMenuOption(opts, ' suporte ')?.id).toBe('a');
    expect(matchMenuOption(opts, 'Financeiro', 'b')?.id).toBe('b');
    expect(matchMenuOption(opts, '3')).toBeNull();
    expect(matchMenuOption(opts, 'outra coisa')).toBeNull();
  });
  it('valida tipos de resposta', () => {
    expect(validateAnswer('email', 'ana@x.com')).toBe(true);
    expect(validateAnswer('email', 'ana@')).toBe(false);
    expect(validateAnswer('number', '12,5')).toBe(true);
    expect(validateAnswer('number', 'doze')).toBe(false);
    expect(validateAnswer('phone', '(11) 99999-8888')).toBe(true);
    expect(validateAnswer('text', '   ')).toBe(false);
  });
});

describe('Grafo', () => {
  const g: FlowGraph = {
    nodes: [
      { id: 's', type: 'start', position: { x: 0, y: 0 }, data: { triggers: [{ type: 'message' }] } },
      { id: 'c', type: 'condition', position: { x: 0, y: 0 }, data: { rules: [] } },
      { id: 'y', type: 'send_text', position: { x: 0, y: 0 }, data: { text: 'sim' } },
    ],
    edges: [{ id: 'e1', source: 's', target: 'c' }, { id: 'e2', source: 'c', target: 'y', sourceHandle: 'yes' }],
  };
  it('segue a saída correta', () => {
    expect(nextNodeId(g, 's')).toBe('c');
    expect(nextNodeId(g, 'c', 'yes')).toBe('y');
    expect(nextNodeId(g, 'c', 'no')).toBeNull();
  });
  it('validação aponta problemas', () => {
    expect(validateGraph(g)).toEqual([]);
    expect(validateGraph({ nodes: [], edges: [] })).toContain('O fluxo precisa de exatamente um bloco Início');
    const bad: FlowGraph = { nodes: [...g.nodes, { id: 'm', type: 'menu', position: { x: 0, y: 0 }, data: {} }], edges: [{ id: 'x', source: 's', target: 'zz' }] };
    const errs = validateGraph(bad);
    expect(errs.some((e) => e.includes('inexistente'))).toBe(true);
    expect(errs.some((e) => e.includes('menu sem opções'))).toBe(true);
    expect(validateGraph(defaultGraph())).toEqual([]);
  });
});

describe('Templates de variáveis', () => {
  it('substitui variáveis e caminhos', () => {
    expect(renderTemplate('Olá {{contact_name}}, pedido {{pedido.id}}{{nada}}!', { contact_name: 'Ana', pedido: { id: 7 } })).toBe('Olá Ana, pedido 7!');
    expect(renderDeep({ a: ['{{x}}'], b: { c: '{{x}}' }, n: 1 }, { x: 'ok' })).toEqual({ a: ['ok'], b: { c: 'ok' }, n: 1 });
  });
});
