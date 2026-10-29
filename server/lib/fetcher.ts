/**
 * Ponto único de saída HTTP do servidor. Em testes automatizados é substituído
 * por um fetch simulado (setFetch) — em produção usa sempre o fetch real.
 */
import { fetch as undiciFetch } from 'undici';

type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
// Com dispatcher próprio (proteção SSRF), usa o fetch do pacote undici, compatível com o Agent dele.
const real: FetchFn = (input, init) => ((init as any)?.dispatcher ? (undiciFetch(input as any, init as any) as unknown as Promise<Response>) : fetch(input, init));
let impl: FetchFn = real;

export const httpFetch: FetchFn = (input, init) => impl(input, init);
export function setFetch(fn: FetchFn) {
  if (process.env.NODE_ENV !== 'test') throw new Error('setFetch só pode ser usado em testes');
  impl = fn;
}
export function resetFetch() {
  impl = real;
}
