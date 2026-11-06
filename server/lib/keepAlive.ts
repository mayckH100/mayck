/**
 * App acordado: o Render Free hiberna após ~15 min sem tráfego de entrada (o primeiro acesso depois
 * demora cerca de 1 minuto e o WhatsApp por QR cai). Um ping no próprio endereço público a cada 10 min
 * mantém a instância acordada. Roda em produção sempre que houver URL pública (PUBLIC_URL ou
 * RENDER_EXTERNAL_URL), com ou sem WhatsApp por QR. KEEP_ALIVE=false desliga.
 */
type Env = Record<string, string | undefined>;

export const KEEP_ALIVE_INTERVAL_MS = 10 * 60 * 1000;

/** URL do ping, ou null quando não deve rodar. */
export function keepAliveUrl(env: Env = process.env): string | null {
  if (env.NODE_ENV !== 'production') return null;
  if ((env.KEEP_ALIVE ?? 'true').trim().toLowerCase() === 'false') return null;
  const base = (env.PUBLIC_URL || env.RENDER_EXTERNAL_URL || '').trim().replace(/\/+$/, '');
  return base ? `${base}/api/health` : null;
}

export function startKeepAlive(env: Env = process.env, fetcher: typeof fetch = fetch): NodeJS.Timeout | null {
  const url = keepAliveUrl(env);
  if (!url) return null;
  const t = setInterval(() => { fetcher(url).catch(() => undefined); }, KEEP_ALIVE_INTERVAL_MS);
  t.unref?.();
  console.log('[keep-alive] ping a cada 10 min ligado');
  return t;
}
