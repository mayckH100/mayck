/**
 * Ids das saídas (handles) dos blocos de fluxo — fonte única para o editor (web) e o motor (servidor).
 * Sem dependências: o editor importa este arquivo direto.
 *
 * Regra do bloco Menu: cada opção tem um `id` próprio e estável (não muda ao reordenar, renomear
 * ou remover outra opção) e a saída dela se chama `opt-<id>`. A saída de resposta inválida é `invalid`.
 */

export const INVALID_HANDLE = 'invalid';
export const DEFAULT_HANDLE = 'next';

export interface MenuOptionLike { id?: unknown; label?: unknown }
export interface MenuOption { id: string; label: string }
export interface EdgeLike { id: string; source: string; target: string; sourceHandle?: string | null }

/** Id da saída de uma opção do menu (o motor roteia a escolha por este mesmo id). */
export function menuHandleId(optionId: string): string {
  return `opt-${optionId}`;
}

const cleanId = (v: unknown) => (typeof v === 'string' || typeof v === 'number' ? String(v).trim().slice(0, 40) : '');

/**
 * Garante ids únicos e não vazios nas opções, preservando os que já são válidos.
 * Opções sem id (ou com id repetido) ganham `o1`, `o2`… (o primeiro livre).
 * `renamed` diz, por posição, qual id antigo virou qual novo (para religar conexões).
 */
export function normalizeMenuOptions(options: unknown): { options: MenuOption[]; renamed: { index: number; from: string; to: string }[] } {
  const list = Array.isArray(options) ? options : [];
  const used = new Set<string>();
  const out: MenuOption[] = [];
  const renamed: { index: number; from: string; to: string }[] = [];
  // Primeiro passa reserva os ids válidos que aparecem pela primeira vez.
  const firstSeen = new Map<string, number>();
  list.forEach((o: MenuOptionLike, i) => {
    const id = cleanId(o?.id);
    if (id && !firstSeen.has(id)) firstSeen.set(id, i);
  });
  for (const id of firstSeen.keys()) used.add(id);
  let k = 1;
  list.forEach((o: MenuOptionLike, i) => {
    const raw = cleanId(o?.id);
    let id = raw;
    if (!raw || firstSeen.get(raw) !== i) {
      while (used.has(`o${k}`)) k++;
      id = `o${k}`;
      used.add(id);
      renamed.push({ index: i, from: raw, to: id });
    }
    out.push({ ...(o && typeof o === 'object' ? (o as object) : {}), id, label: typeof o?.label === 'string' ? o.label : String(o?.label ?? '') });
  });
  return { options: out, renamed };
}

/** Novo id de opção que não colide com os existentes. */
export function newOptionId(existing: { id?: unknown }[], rand: () => string = () => Math.random().toString(36).slice(2, 8)): string {
  const used = new Set(existing.map((o) => cleanId(o?.id)));
  for (let i = 0; i < 20; i++) {
    const id = rand();
    if (id && !used.has(id)) return id;
  }
  let k = existing.length + 1;
  while (used.has(`o${k}`)) k++;
  return `o${k}`;
}

/** Saídas de um bloco Menu, na ordem exibida: opções 1..n e, por último, a inválida (✕). */
export function menuOutputs(options: unknown): { id: string; label: string; optionId?: string }[] {
  const { options: opts } = normalizeMenuOptions(options);
  return [
    ...opts.map((o, i) => ({ id: menuHandleId(o.id), label: String(i + 1), optionId: o.id })),
    { id: INVALID_HANDLE, label: '✕' },
  ];
}

/**
 * Posição (em % da largura) de cada saída na base do bloco e a largura mínima do bloco para que
 * as saídas fiquem a `spacing` px uma da outra (centro a centro). A mesma conta posiciona o
 * rótulo (1, 2, …, ✕) e a bolinha, então o número fica exatamente em cima da sua saída.
 */
export function handleLayout(count: number, spacing = 36, padding = 12): { lefts: number[]; minWidth: number } {
  const n = Math.max(0, Math.floor(count));
  const lefts = Array.from({ length: n }, (_, i) => ((i + 0.5) / n) * 100);
  return { lefts, minWidth: n * spacing + padding * 2 };
}

/** Destino ligado a uma saída (ou null). Com conexões repetidas, vale a primeira — igual ao motor. */
export function edgeTarget(edges: EdgeLike[], source: string, handle: string): string | null {
  return edges.find((e) => e.source === source && (e.sourceHandle ?? DEFAULT_HANDLE) === handle)?.target ?? null;
}

/**
 * Liga (ou desliga, com target null) uma saída a um bloco. Cada saída tem no máximo uma conexão:
 * as anteriores daquela mesma saída saem; as das outras saídas ficam intactas.
 */
export function setOutputEdge<E extends EdgeLike>(edges: E[], source: string, handle: string, target: string | null, newId: string): E[] {
  const rest = edges.filter((e) => !(e.source === source && (e.sourceHandle ?? DEFAULT_HANDLE) === handle));
  if (!target || target === source) return rest;
  return [...rest, { id: newId, source, target, sourceHandle: handle } as E];
}

/**
 * Corrige um grafo salvo: opções de menu sem id ou com id repetido ganham ids únicos, e as conexões
 * que saíam do id antigo passam para a opção que o recebeu primeiro (o mesmo que o motor fazia).
 * Não apaga blocos nem conexões. Retorna o mesmo objeto quando não há nada a corrigir.
 */
export function normalizeGraph<G extends { nodes: { id: string; type: string; data: any }[]; edges: EdgeLike[] }>(graph: G): G {
  let changed = false;
  const nodes = graph.nodes.map((n) => {
    if (n.type !== 'menu') return n;
    const { options, renamed } = normalizeMenuOptions(n.data?.options);
    if (!renamed.length) return n;
    changed = true;
    return { ...n, data: { ...n.data, options }, __renamed: renamed } as typeof n & { __renamed: typeof renamed };
  });
  if (!changed) return graph;
  let edges = graph.edges;
  for (const n of nodes as any[]) {
    if (!n.__renamed) continue;
    for (const r of n.__renamed as { from: string; to: string }[]) {
      // Só a conexão de um id que não existe mais em nenhuma opção é religada (ex.: "opt-undefined").
      const stillExists = (n.data.options as MenuOption[]).some((o) => o.id === r.from);
      if (stillExists) continue;
      const fromHandles = r.from ? [menuHandleId(r.from)] : [menuHandleId('undefined'), menuHandleId('null'), menuHandleId('')];
      let moved = false;
      edges = edges.map((e) => {
        if (moved || e.source !== n.id || !fromHandles.includes(e.sourceHandle ?? '')) return e;
        moved = true;
        return { ...e, sourceHandle: menuHandleId(r.to) };
      });
    }
    delete n.__renamed;
  }
  return { ...graph, nodes, edges };
}
