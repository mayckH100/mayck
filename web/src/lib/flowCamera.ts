/**
 * Câmera e gatilhos do editor de fluxos (funções puras, testadas em tests/unit/flow-camera.test.ts).
 *
 * Contexto do bug (2026-11-03): com 1280 px o canvas fica com ~470 px de largura entre a paleta
 * "Blocos" e o painel de propriedades. O fitView parava no zoom mínimo padrão (0,5) e cortava o
 * bloco Início na borda esquerda. Aqui ficam: as margens (insets) que os painéis tiram do canvas,
 * o padding do fitView a partir delas, o ponto de centralização que compensa painéis assimétricos,
 * o pan pelo teclado e a normalização dos gatilhos do bloco Início.
 */

export interface Rect { left: number; right: number; top: number; bottom: number }
export interface Insets { left: number; right: number; top: number; bottom: number }
export interface Viewport { x: number; y: number; zoom: number }

/** Zoom mínimo do editor: baixo o bastante para um fluxo grande caber num canvas estreito. */
export const MIN_ZOOM = 0.1;
export const MAX_FIT_ZOOM = 1;
/** Folga (px) entre os blocos e a borda visível do canvas. */
export const FIT_MARGIN = 32;

/**
 * Quanto de cada lado do canvas está coberto por painéis (paleta à esquerda, propriedades à
 * direita). Com o layout em grade atual não há sobreposição (0), mas se um painel flutuar sobre o
 * canvas (tela estreita, CSS futuro) o fitView e a centralização passam a desviar dele.
 */
export function panelInsets(canvas: Rect, palette?: Rect | null, props?: Rect | null): Insets {
  const overlapsY = (r: Rect) => r.bottom > canvas.top && r.top < canvas.bottom;
  const left = palette && overlapsY(palette) ? Math.max(0, Math.min(palette.right, canvas.right) - canvas.left) : 0;
  const right = props && overlapsY(props) ? Math.max(0, canvas.right - Math.max(props.left, canvas.left)) : 0;
  return { left, right, top: 0, bottom: 0 };
}

/** Padding do fitView (em px, por lado) = área coberta pelo painel + folga. */
export function fitPadding(insets: Insets, margin = FIT_MARGIN) {
  const px = (n: number) => `${Math.round(n + margin)}px` as `${number}px`;
  return { left: px(insets.left), right: px(insets.right), top: px(insets.top), bottom: px(insets.bottom) };
}

/** Opções completas do fitView do editor. */
export function fitOptions(insets: Insets = { left: 0, right: 0, top: 0, bottom: 0 }, duration = 0) {
  return { padding: fitPadding(insets), minZoom: MIN_ZOOM, maxZoom: MAX_FIT_ZOOM, ...(duration ? { duration } : {}) };
}

/** Opções do fitView inicial (prop do ReactFlow). Objeto estável: não recria a cada render. */
export const INITIAL_FIT_OPTIONS = Object.freeze(fitOptions());

/**
 * Ponto (coordenadas do fluxo) para setCenter de forma que o bloco fique no centro da área
 * VISÍVEL do canvas (descontando painéis). setCenter centraliza no meio do canvas inteiro; com um
 * painel de 200 px à esquerda, o centro visível fica 100 px à direita, então deslocamos o alvo.
 */
export function centerTarget(node: { position: { x: number; y: number }; width?: number; height?: number }, insets: Insets, zoom: number) {
  const w = node.width ?? 200;
  const h = node.height ?? 60;
  const z = zoom > 0 ? zoom : 1;
  return {
    x: node.position.x + w / 2 - (insets.left - insets.right) / 2 / z,
    y: node.position.y + h / 2 - (insets.top - insets.bottom) / 2 / z,
  };
}

const PAN_KEYS: Record<string, [number, number]> = { ArrowLeft: [1, 0], ArrowRight: [-1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] };

/** Setas do teclado movem a câmera (a visão anda na direção da seta). Outra tecla: null. */
export function panByKey(key: string, vp: Viewport, step = 80): Viewport | null {
  const d = PAN_KEYS[key];
  if (!d) return null;
  return { x: vp.x + d[0] * step, y: vp.y + d[1] * step, zoom: vp.zoom };
}

/** Id do bloco Início do fluxo (o editor aceita só um), ou null. */
export function findStartId(nodes: { id: string; type?: string }[]): string | null {
  return nodes.find((n) => n.type === 'start')?.id ?? null;
}

/** Destinos possíveis do seletor "Ir para o bloco…": todos menos o próprio bloco e o Início. */
export function gotoTargets<N extends { id: string; type?: string }>(nodes: N[], nodeId: string): N[] {
  return nodes.filter((n) => n.id !== nodeId && n.type !== 'start');
}

export interface TriggerLike { type: string; value?: string; match?: string; days?: number[]; start?: string; end?: string }

/**
 * Troca o tipo de um gatilho guardando só os campos que valem para o novo tipo. Antes, ao trocar
 * "Palavra-chave: oi" por "Primeira mensagem", o "oi" ficava salvo e a legenda mostrava
 * "Primeira mensagem: oi", como se a palavra fosse exigida (o motor nunca a usou).
 */
export function changeTriggerType(t: TriggerLike, type: string): TriggerLike {
  if (type === 'keyword') return { type, value: t.type === 'keyword' ? t.value ?? '' : '', match: t.match ?? 'contains' };
  if (type === 'schedule') return { type, start: t.start ?? '08:00', end: t.end ?? '18:00', days: t.days ?? [] };
  return { type };
}

export const TRIGGER_LABEL: Record<string, string> = { message: 'Mensagem recebida', keyword: 'Palavra-chave', first_message: 'Primeira mensagem', schedule: 'Horário' };

/** Legenda de um gatilho. A palavra só aparece no tipo palavra-chave. */
export function triggerSummary(t: TriggerLike): string {
  const label = TRIGGER_LABEL[t.type] ?? t.type;
  if (t.type === 'keyword') return t.value ? `${label}: ${t.value}` : `${label} (vazia)`;
  if (t.type === 'first_message') return `${label} (qualquer texto)`;
  if (t.type === 'schedule') return `${label} ${t.start ?? ''}–${t.end ?? ''}`;
  return label;
}

export function triggersSummary(triggers: TriggerLike[] | undefined): string {
  return (triggers ?? []).map(triggerSummary).join(' · ') || 'Sem gatilho';
}
