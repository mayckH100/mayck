/**
 * Quem conta como proxy confiável na hora de descobrir o IP real do visitante (req.ip).
 *
 * Em produção o caminho é: visitante → Cloudflare → balanceador do Render → app. Com `trust proxy = 1`
 * o Express parava no Cloudflare e o req.ip virava o IP da borda do Cloudflare (muda a cada pedido e é
 * compartilhado por muita gente). Resultado: os limites por IP (login, cadastro, redefinição de senha)
 * dividiam a contagem entre vários visitantes, um atacante podia bloquear o login de quem usa a mesma
 * borda e a auditoria/alertas mostravam o IP errado.
 *
 * Aqui confiamos só em redes internas (loopback, privadas — o balanceador do Render) e nas faixas
 * publicadas do Cloudflare (https://www.cloudflare.com/ips). O primeiro endereço "não confiável" da
 * direita para a esquerda no X-Forwarded-For é o visitante; o que o visitante escrever à esquerda dele
 * é ignorado (não dá para forjar o IP).
 *
 * TRUST_PROXY (opcional) substitui a regra: número de saltos ("1", "2"), "true"/"false" ou lista de
 * faixas separadas por vírgula. Use só em emergência.
 */
export const CLOUDFLARE_RANGES = [
  '173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22', '141.101.64.0/18', '108.162.192.0/18',
  '190.93.240.0/20', '188.114.96.0/20', '197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13',
  '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22',
  '2400:cb00::/32', '2606:4700::/32', '2803:f800::/32', '2405:b500::/32', '2405:8100::/32', '2a06:98c0::/29', '2c0f:f248::/32',
];

export const DEFAULT_TRUSTED_PROXIES = ['loopback', 'linklocal', 'uniquelocal', ...CLOUDFLARE_RANGES];

export function trustProxySetting(raw = process.env.TRUST_PROXY): boolean | number | string[] {
  const v = (raw ?? '').trim();
  if (!v) return DEFAULT_TRUSTED_PROXIES;
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^\d+$/.test(v)) return Number(v);
  return v.split(',').map((s) => s.trim()).filter(Boolean);
}
