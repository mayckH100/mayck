/**
 * Ponto único de saída HTTP do servidor. Em testes automatizados é substituído
 * por um fetch simulado (setFetch) — em produção usa sempre o fetch real.
 */
type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
const real: FetchFn = (input, init) => fetch(input, init);
let impl: FetchFn = real;

export const httpFetch: FetchFn = (input, init) => impl(input, init);
export function setFetch(fn: FetchFn) {
  if (process.env.NODE_ENV !== 'test') throw new Error('setFetch só pode ser usado em testes');
  impl = fn;
}
export function resetFetch() {
  impl = real;
}
