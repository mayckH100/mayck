/**
 * Banner de atualização ("Novidade: <título> → Ver"): mostra a novidade mais recente publicada no site
 * (/api/novidades?limit=1) por até 14 dias, até o usuário fechar (localStorage por id da novidade).
 * A mesma regra existe em web/public/empresa/assets/site.js para o site /empresa (sem React).
 */
export interface NovidadeResumo { id: string; title: string; publishedAt: string | null }

export const NOVIDADE_BANNER_DIAS = 14;
const DIA_MS = 24 * 60 * 60 * 1000;

export const novidadeDismissKey = (id: string) => `mck:novidade:fechada:${id}`;
export const novidadeHref = (id: string, base = '') => `${base.replace(/\/+$/, '')}/empresa/novidades#novidade-${encodeURIComponent(id)}`;

/** A novidade a exibir, ou null (sem itens, sem data, mais de 14 dias, data no futuro distante ou já fechada). */
export function novidadeParaBanner(
  items: NovidadeResumo[] | null | undefined, now: number, isDismissed: (id: string) => boolean,
): NovidadeResumo | null {
  const n = items?.[0];
  if (!n?.id || !n.title || !n.publishedAt) return null;
  const t = Date.parse(n.publishedAt);
  if (!Number.isFinite(t)) return null;
  const idade = now - t;
  if (idade > NOVIDADE_BANNER_DIAS * DIA_MS || idade < -DIA_MS) return null;
  if (isDismissed(n.id)) return null;
  return n;
}

export function lerFechada(id: string): boolean {
  try { return localStorage.getItem(novidadeDismissKey(id)) === '1'; } catch { return false; }
}
export function gravarFechada(id: string) {
  try { localStorage.setItem(novidadeDismissKey(id), '1'); } catch { /* modo privado: some só nesta sessão */ }
}
