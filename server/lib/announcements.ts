import { createHash } from 'node:crypto';

/**
 * Avisos (pop-up com imagem) do Painel Master: regras puras, sem banco.
 * Testadas em tests/unit/avisos.test.ts e tests/integration/avisos.test.ts.
 */
export const ANN_TZ = 'America/Sao_Paulo';
export const ANN_MAX_BYTES = 2 * 1024 * 1024; // 2 MB
export const ANN_APPS = ['MCKBOT', 'MCKMENSAGEM', 'AMBOS'] as const;
export const ANN_AUDIENCES = ['TODOS', 'TRIAL', 'ATIVOS', 'VENCIDOS'] as const;
export type AnnApp = (typeof ANN_APPS)[number];
export type AnnAudience = (typeof ANN_AUDIENCES)[number];
export type AnnImageMime = 'image/png' | 'image/jpeg' | 'image/webp';

/**
 * Tipo real da imagem pelos primeiros bytes ("magic bytes"). Só PNG, JPEG e WEBP.
 * SVG (texto/XML, pode carregar script), GIF, HTML ou qualquer outra coisa → null.
 */
export function detectImageMime(buf: Buffer | Uint8Array | null | undefined): AnnImageMime | null {
  if (!buf || buf.length < 12) return null;
  const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

export const sha256Hex = (b: Buffer) => createHash('sha256').update(b).digest('hex');

/** Dia (AAAA-MM-DD) no fuso de São Paulo: o aviso fechado volta no máximo uma vez por dia. */
export function dayKeySP(d = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: ANN_TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

/** Diferença (ms) entre o relógio de São Paulo e o UTC num instante (negativa: SP está atrás do UTC). */
function tzOffsetMs(at: Date): number {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: ANN_TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(at).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

/**
 * Data/hora do formulário. "AAAA-MM-DDTHH:mm" (sem fuso, do <input type="datetime-local">) é horário de São Paulo;
 * ISO com Z ou deslocamento é aceito como está. Inválida → null.
 */
export function parseSpDateTime(v: string | null | undefined): Date | null {
  if (!v) return null;
  const s = String(v).trim();
  const local = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(s);
  if (local) {
    const [, y, mo, d, h, mi, se] = local;
    const guess = Date.UTC(+y, +mo - 1, +d, +h, +mi, +(se ?? 0));
    if (Number.isNaN(guess)) return null;
    // Duas passadas cobrem eventuais mudanças de horário de verão.
    let t = guess - tzOffsetMs(new Date(guess));
    t = guess - tzOffsetMs(new Date(t));
    return new Date(t);
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(s)) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** "AAAA-MM-DDTHH:mm" em São Paulo (para preencher o <input type="datetime-local"> do formulário). */
export function toSpLocalInput(d: Date): string {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: ANN_TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${String(+p.hour % 24).padStart(2, '0')}:${p.minute}`;
}

/** Link do botão: só https:// ou caminho interno ("/plano"). Nada de javascript:, data:, // etc. */
export function safeLink(v: string | null | undefined): string | null {
  const s = (v ?? '').trim();
  if (!s) return null;
  if (/^\/(?![/\\])[^\s]*$/.test(s)) return s;
  try {
    const u = new URL(s);
    if (u.protocol !== 'https:' || !u.hostname || u.username || u.password) return null;
    return u.toString();
  } catch { return null; }
}

/** O aviso vale para quem está neste app? */
export function appMatches(annApp: string, app: 'MCKBOT' | 'MCKMENSAGEM'): boolean {
  return annApp === 'AMBOS' || annApp === app;
}

/** Público-alvo × situação da assinatura do produto do app (status efetivo: TRIAL | ATIVA | VENCIDA | BLOQUEADA). */
export function audienceMatches(audience: string, status: string | null | undefined): boolean {
  switch (audience) {
    case 'TODOS': return true;
    case 'TRIAL': return status === 'TRIAL';
    case 'ATIVOS': return status === 'ATIVA';
    case 'VENCIDOS': return status === 'VENCIDA' || status === 'BLOQUEADA';
    default: return false;
  }
}

/** Situação do aviso para a lista do Master. */
export function announcementState(a: { active: boolean; startsAt: Date; endsAt: Date; imageMime: string | null }, now = new Date()) {
  if (!a.imageMime) return 'SEM_IMAGEM' as const;
  if (!a.active) return 'INATIVO' as const;
  if (a.endsAt.getTime() <= now.getTime()) return 'ENCERRADO' as const;
  if (a.startsAt.getTime() > now.getTime()) return 'AGENDADO' as const;
  return 'NO_AR' as const;
}
