/**
 * Motor genérico de estados (puro, sem banco). Cada documento do ERP (oportunidade, pedido, OP, título)
 * declara sua máquina; toda transição passa por aqui, então regra de negócio e auditoria ficam num só lugar.
 */
export interface Transicao<S extends string, E extends string, C> {
  de: S | S[] | '*';
  evento: E;
  para: S;
  /** Guarda: retorna mensagem de erro para bloquear a transição, ou null para permitir. */
  guarda?: (ctx: C) => string | null;
  /** Eventos de domínio emitidos quando a transição acontece (vão para o outbox). */
  emite?: string[];
}

export interface Maquina<S extends string, E extends string, C = unknown> {
  nome: string;
  inicial: S;
  finais: S[];
  transicoes: Transicao<S, E, C>[];
}

export type ResultadoTransicao<S extends string> =
  | { ok: true; de: S; para: S; emite: string[] }
  | { ok: false; erro: string };

export function transicionar<S extends string, E extends string, C>(m: Maquina<S, E, C>, atual: S, evento: E, ctx: C): ResultadoTransicao<S> {
  if (m.finais.includes(atual)) return { ok: false, erro: `${m.nome}: estado ${atual} é final` };
  const t = m.transicoes.find((x) => x.evento === evento && (x.de === '*' || x.de === atual || (Array.isArray(x.de) && x.de.includes(atual))));
  if (!t) return { ok: false, erro: `${m.nome}: evento ${evento} não permitido em ${atual}` };
  const bloqueio = t.guarda?.(ctx) ?? null;
  if (bloqueio) return { ok: false, erro: bloqueio };
  return { ok: true, de: atual, para: t.para, emite: t.emite ?? [] };
}

export function eventosPermitidos<S extends string, E extends string, C>(m: Maquina<S, E, C>, atual: S): E[] {
  if (m.finais.includes(atual)) return [];
  return [...new Set(m.transicoes.filter((x) => x.de === '*' || x.de === atual || (Array.isArray(x.de) && x.de.includes(atual))).map((x) => x.evento))];
}
