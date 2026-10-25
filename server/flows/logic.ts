/** Funções puras do motor de fluxos (sem banco) — cobertas por testes unitários. */
import { z } from 'zod';

export const NODE_TYPES = ['start', 'send_text', 'send_media', 'menu', 'ask', 'condition', 'ai', 'wait', 'http', 'handoff', 'tag', 'end'] as const;
export type NodeType = (typeof NODE_TYPES)[number];

export interface FlowNode { id: string; type: NodeType; position: { x: number; y: number }; data: Record<string, any> }
export interface FlowEdge { id: string; source: string; target: string; sourceHandle?: string | null }
export interface FlowGraph { nodes: FlowNode[]; edges: FlowEdge[] }

export const graphSchema = z.object({
  nodes: z.array(z.object({
    id: z.string().min(1).max(64),
    type: z.enum(NODE_TYPES),
    position: z.object({ x: z.number(), y: z.number() }).default({ x: 0, y: 0 }),
    data: z.record(z.any()).default({}),
  })).max(300),
  edges: z.array(z.object({
    id: z.string().min(1).max(200),
    source: z.string(), target: z.string(),
    sourceHandle: z.string().nullable().optional(),
  })).max(1000),
});

export type TriggerType = 'message' | 'keyword' | 'first_message' | 'schedule';
export interface Trigger {
  type: TriggerType;
  value?: string;
  match?: 'contains' | 'equals';
  days?: number[]; // 0=domingo … 6=sábado
  start?: string; // "08:00"
  end?: string; // "18:00"
}

export function normalize(s: string): string {
  return (s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim().replace(/\s+/g, ' ');
}

/** Hora/dia locais no fuso da organização. */
export function localTime(now: Date, timeZone: string): { day: number; minutes: number } {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '0';
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const hour = Number(get('hour')) % 24;
  return { day: days.indexOf(get('weekday')), minutes: hour * 60 + Number(get('minute')) };
}

const toMin = (hhmm = '00:00') => {
  const [h, m] = hhmm.split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
};

export function isWithinSchedule(t: Trigger, now: Date, timeZone: string): boolean {
  const { day, minutes } = localTime(now, timeZone);
  if (t.days && t.days.length && !t.days.includes(day)) return false;
  const s = toMin(t.start ?? '00:00');
  const e = toMin(t.end ?? '23:59');
  return s <= e ? minutes >= s && minutes <= e : minutes >= s || minutes <= e; // janela que cruza a meia-noite
}

/**
 * Retorna a especificidade do gatilho que casou (maior = mais específico) ou null.
 * Palavra-chave (4) > primeira mensagem (3) > horário (2) > qualquer mensagem (1).
 */
export function matchTriggers(triggers: Trigger[], ctx: { text: string; isFirst: boolean; now: Date; timeZone: string }): number | null {
  let best: number | null = null;
  const text = normalize(ctx.text);
  for (const t of triggers ?? []) {
    let score: number | null = null;
    if (t.type === 'keyword' && t.value) {
      const keys = t.value.split(',').map(normalize).filter(Boolean);
      const hit = keys.some((k) => (t.match === 'equals' ? text === k : text.includes(k)));
      if (hit) score = 4;
    } else if (t.type === 'first_message' && ctx.isFirst) score = 3;
    else if (t.type === 'schedule' && isWithinSchedule(t, ctx.now, ctx.timeZone)) score = 2;
    else if (t.type === 'message') score = 1;
    if (score !== null && (best === null || score > best)) best = score;
  }
  return best;
}

export interface ConditionRule { variable: string; operator: 'equals' | 'not_equals' | 'contains' | 'not_contains' | 'gt' | 'lt' | 'exists' | 'not_exists' | 'starts_with'; value?: string }

export function evaluateRule(rule: ConditionRule, vars: Record<string, unknown>): boolean {
  const raw = rule.variable.split('.').reduce<unknown>((a, k) => (a && typeof a === 'object' ? (a as Record<string, unknown>)[k] : undefined), vars);
  const has = raw !== undefined && raw !== null && raw !== '';
  const left = normalize(has ? String(raw) : '');
  const right = normalize(rule.value ?? '');
  switch (rule.operator) {
    case 'exists': return has;
    case 'not_exists': return !has;
    case 'equals': return left === right;
    case 'not_equals': return left !== right;
    case 'contains': return left.includes(right);
    case 'not_contains': return !left.includes(right);
    case 'starts_with': return left.startsWith(right);
    case 'gt': case 'lt': {
      const a = Number(String(raw).replace(',', '.'));
      const b = Number(String(rule.value).replace(',', '.'));
      if (Number.isNaN(a) || Number.isNaN(b)) return false;
      return rule.operator === 'gt' ? a > b : a < b;
    }
    default: return false;
  }
}

export function evaluateCondition(rules: ConditionRule[], logic: 'all' | 'any', vars: Record<string, unknown>): boolean {
  if (!rules?.length) return false;
  return logic === 'any' ? rules.some((r) => evaluateRule(r, vars)) : rules.every((r) => evaluateRule(r, vars));
}

export interface MenuOption { id: string; label: string }

/** Casa a resposta do contato com uma opção: número ("1"), id do botão ou texto do rótulo. */
export function matchMenuOption(options: MenuOption[], text: string, replyId?: string): MenuOption | null {
  if (replyId) {
    const byId = options.find((o) => o.id === replyId);
    if (byId) return byId;
  }
  const t = normalize(text);
  const n = Number(t);
  if (Number.isInteger(n) && n >= 1 && n <= options.length) return options[n - 1];
  return options.find((o) => normalize(o.label) === t) ?? null;
}

export function validateAnswer(kind: string | undefined, text: string): boolean {
  const t = (text ?? '').trim();
  if (!t) return false;
  switch (kind) {
    case 'number': return /^-?\d+([.,]\d+)?$/.test(t);
    case 'email': return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(t);
    case 'phone': return /^\+?\d{10,15}$/.test(t.replace(/[\s()-]/g, ''));
    default: return true;
  }
}

export function nextNodeId(graph: FlowGraph, nodeId: string, handle = 'next'): string | null {
  const edges = graph.edges.filter((e) => e.source === nodeId);
  const e = edges.find((x) => (x.sourceHandle ?? 'next') === handle);
  return e?.target ?? null;
}

/** Valida estrutura e campos obrigatórios. Retorna lista de problemas em português. */
export function validateGraph(graph: FlowGraph): string[] {
  const errs: string[] = [];
  const ids = new Set(graph.nodes.map((n) => n.id));
  if (ids.size !== graph.nodes.length) errs.push('Há blocos com id repetido');
  const starts = graph.nodes.filter((n) => n.type === 'start');
  if (starts.length !== 1) errs.push('O fluxo precisa de exatamente um bloco Início');
  else if (!(starts[0].data.triggers ?? []).length) errs.push('Adicione pelo menos um gatilho no bloco Início');
  for (const e of graph.edges) {
    if (!ids.has(e.source) || !ids.has(e.target)) errs.push(`Conexão ${e.id} aponta para bloco inexistente`);
  }
  for (const n of graph.nodes) {
    const d = n.data ?? {};
    if (n.type === 'send_text' && !String(d.text ?? '').trim()) errs.push(`Bloco "${d.label ?? n.id}": texto vazio`);
    if (n.type === 'send_media' && !String(d.url ?? '').trim()) errs.push(`Bloco "${d.label ?? n.id}": URL da mídia vazia`);
    if (n.type === 'menu' && !(d.options ?? []).length) errs.push(`Bloco "${d.label ?? n.id}": menu sem opções`);
    if (n.type === 'ask' && !/^[a-zA-Z_][\w]*$/.test(String(d.variable ?? ''))) errs.push(`Bloco "${d.label ?? n.id}": nome de variável inválido`);
    if (n.type === 'http' && !String(d.url ?? '').trim()) errs.push(`Bloco "${d.label ?? n.id}": URL vazia`);
    if (n.type === 'wait' && !(Number(d.seconds) > 0)) errs.push(`Bloco "${d.label ?? n.id}": tempo de espera inválido`);
  }
  return errs;
}

export function defaultGraph(): FlowGraph {
  return {
    nodes: [
      { id: 'start', type: 'start', position: { x: 40, y: 80 }, data: { triggers: [{ type: 'keyword', value: 'oi', match: 'contains' }] } },
      { id: 'n1', type: 'send_text', position: { x: 340, y: 80 }, data: { text: 'Olá, {{contact_name}}! Como podemos ajudar?' } },
    ],
    edges: [{ id: 'e1', source: 'start', target: 'n1', sourceHandle: 'next' }],
  };
}
