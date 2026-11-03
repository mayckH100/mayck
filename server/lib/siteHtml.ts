// Raiz "/" do domínio: landing institucional da MCK DESENVOLVIMENTO para visitantes e robôs,
// app (SPA do MCKBOT) para quem já está logado ou abriu pelo PWA.
// A meta google-site-verification já vem fixa no HTML; GOOGLE_SITE_VERIFICATION (opcional) acrescenta outra.
import { readFileSync } from 'node:fs';

export const SESSION_COOKIE_NAME = 'mck_sid';

/** Aceita só o token ("abc123") ou a tag inteira (<meta name="google-site-verification" content="abc123" />). */
export function gscToken(raw: string | undefined): string | null {
  if (!raw) return null;
  const m = raw.match(/content\s*=\s*["']([^"']+)["']/i);
  const tok = (m ? m[1] : raw).trim();
  return /^[A-Za-z0-9_-]{10,100}$/.test(tok) ? tok : null;
}

/** Acrescenta a meta de verificação no <head> se o token ainda não estiver no HTML. */
export function withGsc(html: string, raw: string | undefined = process.env.GOOGLE_SITE_VERIFICATION): string {
  const tok = gscToken(raw);
  if (!tok || html.includes(tok)) return html;
  return html.replace(/<\/head>/i, `<meta name="google-site-verification" content="${tok}"></head>`);
}

/** Lê o HTML uma vez (em produção os arquivos não mudam) e já devolve com a verificação aplicada. */
export function loadHtml(file: string): string {
  return withGsc(readFileSync(file, 'utf8'));
}

/**
 * Quem recebe o app na raiz:
 * - tem cookie de sessão (usuário logado; se a sessão tiver expirado, o app mostra o login);
 * - abriu pelo atalho do PWA (start_url "/?source=pwa").
 * O resto (visitantes, Google, Bing) recebe a landing da empresa.
 */
export function rootWantsApp(cookies: Record<string, unknown> | undefined, query: Record<string, unknown> | undefined): boolean {
  if (typeof cookies?.[SESSION_COOKIE_NAME] === 'string' && (cookies[SESSION_COOKIE_NAME] as string).length > 0) return true;
  if (query && 'source' in query && query.source === 'pwa') return true;
  if (query && 'app' in query) return true; // escape manual: /?app=1 sempre abre o app
  // Retornos para a raiz (Mercado Pago ?billing=, Google Agenda ?google=): sempre o app, como antes.
  if (query && ('billing' in query || 'google' in query)) return true;
  return false;
}

const attr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Cartão de prévia (Facebook, WhatsApp, LinkedIn) de uma tela do app que é compartilhada como link, ex.: /cadastro.
 * Troca og:url, og:title e og:description no HTML do app, que já traz og:image 1200x630 e twitter:card.
 * O robô do Facebook não roda JavaScript: as metas precisam vir no HTML servido.
 */
export function withPageMeta(html: string, m: { url: string; title: string; description: string }): string {
  const set = (h: string, prop: string, v: string) =>
    h.replace(new RegExp(`(<meta property="${prop}" content=")[^"]*(")`), (_x, a: string, b: string) => `${a}${attr(v)}${b}`);
  return set(set(set(html, 'og:url', m.url), 'og:title', m.title), 'og:description', m.description);
}

export const CADASTRO_META = {
  url: 'https://mckbot.onrender.com/cadastro',
  title: 'Crie sua conta grátis | MCK DESENVOLVIMENTO',
  description: 'Teste o MCKBOT e o MCK Mensagens por 7 dias, sem cartão: atendimento, campanhas e vendas no WhatsApp com inteligência artificial.',
};
