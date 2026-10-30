/** Utilitários de fuso horário sem dependências (Intl). */

export interface ZonedParts { year: number; month: number; day: number; hour: number; minute: number; weekday: number }

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short' });
    fmtCache.set(tz, f);
  }
  return f;
}
const WD: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function safeTz(tz?: string | null): string {
  try { if (tz) { fmt(tz); return tz; } } catch { /* fuso inválido */ }
  return 'America/Sao_Paulo';
}

/** Data/hora local (no fuso) de um instante UTC. */
export function zonedParts(d: Date, tz: string): ZonedParts {
  const p = Object.fromEntries(fmt(tz).formatToParts(d).map((x) => [x.type, x.value]));
  return { year: +p.year, month: +p.month, day: +p.day, hour: +p.hour % 24, minute: +p.minute, weekday: WD[p.weekday] ?? 0 };
}

function offsetMs(d: Date, tz: string) {
  const p = Object.fromEntries(fmt(tz).formatToParts(d).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
  return asUtc - Math.floor(d.getTime() / 1000) * 1000;
}

/** Converte data/hora local de um fuso ("2026-11-03T14:00") para o instante UTC. */
export function zonedToUtc(y: number, mo: number, d: number, h: number, mi: number, tz: string): Date {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  let t = guess - offsetMs(new Date(guess), tz);
  t = guess - offsetMs(new Date(t), tz); // segunda passada acerta transições de horário de verão
  return new Date(t);
}

/** Aceita "2026-11-03T14:00", "2026-11-03 14:00" (hora local do fuso) ou ISO com Z/offset. */
export function parseLocal(s: string, tz: string): Date | null {
  const str = String(s ?? '').trim();
  if (/[zZ]$|[+-]\d\d:?\d\d$/.test(str)) {
    const d = new Date(str);
    return isNaN(d.getTime()) ? null : d;
  }
  const m = str.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})/);
  if (!m) return null;
  const [y, mo, d, h, mi] = m.slice(1).map(Number);
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return null;
  return zonedToUtc(y, mo, d, h, mi, tz);
}

const pad = (n: number) => String(n).padStart(2, '0');
const DIAS = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];

/** "2026-11-03T14:00" no fuso. */
export function toLocalIso(d: Date, tz: string) {
  const p = zonedParts(d, tz);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}

/** "terça, 03/11 às 14:00" no fuso. */
export function humanPt(d: Date, tz: string) {
  const p = zonedParts(d, tz);
  return `${DIAS[p.weekday]}, ${pad(p.day)}/${pad(p.month)} às ${pad(p.hour)}:${pad(p.minute)}`;
}

export const hhmmToMin = (s: string) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s ?? '');
  return m ? Math.min(24 * 60, +m[1] * 60 + +m[2]) : 0;
};
