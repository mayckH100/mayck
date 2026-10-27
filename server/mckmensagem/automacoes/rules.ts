import { z } from 'zod';

/**
 * Regras de recorrência das automações (funções puras, sem banco).
 * Todos os horários são "de parede" no fuso da automação e convertidos para UTC aqui.
 */

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use o formato HH:MM');
const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use o formato AAAA-MM-DD');
const horarios = z.array(hhmm).min(1, 'Informe ao menos um horário').max(48, 'Máximo de 48 horários por dia');

export const regraSchema = z.discriminatedUnion('tipo', [
  z.object({ tipo: z.literal('UNICO'), data: ymd, horario: hhmm }),
  z.object({ tipo: z.literal('DIARIO'), horarios }),
  z.object({ tipo: z.literal('SEMANAL'), diasSemana: z.array(z.number().int().min(0).max(6)).min(1, 'Escolha ao menos um dia da semana'), horarios }),
  z.object({
    tipo: z.literal('MENSAL'), diasMes: z.array(z.number().int().min(1).max(31)).min(1, 'Escolha ao menos um dia do mês').max(31),
    horarios, meses: z.array(z.number().int().min(1).max(12)).max(12).optional(),
  }),
  z.object({ tipo: z.literal('DATAS'), datas: z.array(z.object({ data: ymd, horario: hhmm })).min(1, 'Informe ao menos uma data').max(1000) }),
  z.object({ tipo: z.literal('ANUAL'), datas: z.array(z.string().regex(/^\d{2}-\d{2}$/, 'Use MM-DD')).min(1).max(366), horarios }),
  z.object({
    tipo: z.literal('INTERVALO'), a_cada: z.number().int().min(1).max(10000),
    unidade: z.enum(['MINUTOS', 'HORAS', 'DIAS', 'SEMANAS', 'MESES']), horario: hhmm.optional(),
  }),
]).superRefine((r, ctx) => {
  if (r.tipo === 'INTERVALO' && r.unidade === 'MINUTOS' && r.a_cada < 5) ctx.addIssue({ code: 'custom', message: 'O intervalo mínimo é de 5 minutos', path: ['a_cada'] });
});
export type Regra = z.infer<typeof regraSchema>;

// ---------------- Fuso horário ----------------

export function isValidTimeZone(tz: string): boolean {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

/** Partes da data/hora local em um fuso. */
export function localParts(d: Date, tz: string) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(d);
  const g = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return { y: g('year'), m: g('month'), d: g('day'), h: g('hour'), min: g('minute'), s: g('second') };
}

function offsetMs(d: Date, tz: string): number {
  const p = localParts(d, tz);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, p.s) - Math.floor(d.getTime() / 1000) * 1000;
}

/** Converte data local (AAAA-MM-DD) + HH:MM no fuso informado para o instante UTC. */
export function zonedToUtc(date: string, time: string, tz: string): Date {
  const [y, m, d] = date.split('-').map(Number);
  const [h, mi] = time.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, h, mi, 0);
  let t = guess - offsetMs(new Date(guess), tz);
  t = guess - offsetMs(new Date(t), tz); // segunda passada cobre mudança de horário de verão
  return new Date(t);
}

export const localDate = (d: Date, tz: string) => {
  const p = localParts(d, tz);
  return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
};
export const localTime = (d: Date, tz: string) => {
  const p = localParts(d, tz);
  return `${String(p.h).padStart(2, '0')}:${String(p.min).padStart(2, '0')}`;
};
export const hhmmToMin = (v: string) => { const [h, m] = v.split(':').map(Number); return h * 60 + m; };

/** Dias corridos (calendário) a partir de AAAA-MM-DD. */
function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

// ---------------- Geração ----------------

export interface GerarOpts {
  regra: Regra;
  tz: string;
  inicio: Date; // limite inferior (inclusive)
  fim?: Date | null; // limite superior (inclusive)
  de: Date; // gerar a partir deste instante (inclusive)
  ate: Date; // até este instante (exclusive): horizonte
  max?: number; // máximo de horários (no total, contando desde o início)
  limite?: number; // proteção contra regras gigantes por chamada
}

/**
 * Horários (UTC) das ocorrências da regra entre [de, ate), respeitando início, fim e máximo de envios.
 * "max" conta todos os horários desde o início (não só a janela), para que o máximo seja estável entre gerações.
 */
export function gerarHorarios(o: GerarOpts): Date[] {
  const limite = o.limite ?? 5000;
  const lo = Math.max(o.inicio.getTime(), o.de.getTime());
  const hiFim = o.fim ? o.fim.getTime() : Infinity;
  const out: Date[] = [];
  let contados = 0; // horários válidos desde o início (para o máximo)
  const aceitar = (t: Date): 'stop' | 'ok' => {
    const ms = t.getTime();
    if (ms < o.inicio.getTime() || ms > hiFim) return ms > hiFim ? 'stop' : 'ok';
    contados++;
    if (o.max && contados > o.max) return 'stop';
    if (ms >= lo && ms < o.ate.getTime()) out.push(t);
    return out.length >= limite ? 'stop' : 'ok';
  };
  const fimScan = Math.min(o.ate.getTime(), hiFim);
  const r = o.regra;

  if (r.tipo === 'UNICO') {
    aceitar(zonedToUtc(r.data, r.horario, o.tz));
    return out;
  }
  if (r.tipo === 'DATAS') {
    const ts = r.datas.map((x) => zonedToUtc(x.data, x.horario, o.tz)).sort((a, b) => a.getTime() - b.getTime());
    const seen = new Set<number>();
    for (const t of ts) {
      if (seen.has(t.getTime())) continue;
      seen.add(t.getTime());
      if (aceitar(t) === 'stop') break;
    }
    return out;
  }
  if (r.tipo === 'INTERVALO') {
    const startDate = localDate(o.inicio, o.tz);
    const startTime = r.horario ?? localTime(o.inicio, o.tz);
    let t = zonedToUtc(startDate, startTime, o.tz);
    if (t.getTime() < o.inicio.getTime() && r.unidade !== 'MINUTOS' && r.unidade !== 'HORAS') t = zonedToUtc(addDays(startDate, 1), startTime, o.tz);
    const [sy, sm, sd] = startDate.split('-').map(Number);
    for (let i = 0; i < 1_000_000 && t.getTime() <= fimScan; i++) {
      if (aceitar(t) === 'stop') break;
      const k = (i + 1) * r.a_cada;
      if (r.unidade === 'MINUTOS') t = new Date(t.getTime() + r.a_cada * 60_000);
      else if (r.unidade === 'HORAS') t = new Date(t.getTime() + r.a_cada * 3_600_000);
      else if (r.unidade === 'DIAS') t = zonedToUtc(addDays(startDate, k), startTime, o.tz);
      else if (r.unidade === 'SEMANAS') t = zonedToUtc(addDays(startDate, k * 7), startTime, o.tz);
      else {
        const total = sm - 1 + k;
        const y = sy + Math.floor(total / 12), m = (total % 12) + 1;
        const d = Math.min(sd, daysInMonth(y, m));
        t = zonedToUtc(`${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`, startTime, o.tz);
      }
    }
    return out;
  }

  // Regras por dia de calendário: percorre dia a dia, do início até o horizonte.
  const hs = [...new Set(r.horarios)].sort();
  let day = localDate(o.inicio, o.tz);
  const lastDay = localDate(new Date(fimScan === Infinity ? o.ate.getTime() : fimScan), o.tz);
  for (let i = 0; i < 40000 && day <= lastDay; i++, day = addDays(day, 1)) {
    const [y, m, d] = day.split('-').map(Number);
    const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
    let match = false;
    if (r.tipo === 'DIARIO') match = true;
    else if (r.tipo === 'SEMANAL') match = r.diasSemana.includes(wd);
    else if (r.tipo === 'MENSAL') {
      const dim = daysInMonth(y, m);
      // Dia 29/30/31 em mês mais curto vira o último dia do mês.
      match = (!r.meses?.length || r.meses.includes(m)) && r.diasMes.some((x) => Math.min(x, dim) === d);
    } else if (r.tipo === 'ANUAL') match = r.datas.includes(day.slice(5));
    if (!match) continue;
    for (const h of hs) {
      if (aceitar(zonedToUtc(day, h, o.tz)) === 'stop') return out;
    }
  }
  return out;
}

/** Descrição curta em português da regra (para listas e calendário). */
export function descreverRegra(r: Regra): string {
  // eslint-disable-next-line default-case
  const dias = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
  switch (r.tipo) {
    case 'UNICO': return `Envio único em ${r.data.split('-').reverse().join('/')} às ${r.horario}`;
    case 'DIARIO': return `${r.horarios.length}x por dia (${r.horarios.join(', ')})`;
    case 'SEMANAL': return `Semanal: ${r.diasSemana.map((d) => dias[d]).join(', ')} às ${r.horarios.join(', ')}`;
    case 'MENSAL': return `Mensal: dias ${r.diasMes.join(', ')} às ${r.horarios.join(', ')}`;
    case 'DATAS': return `${r.datas.length} data(s) específica(s)`;
    case 'ANUAL': return `Anual: ${r.datas.map((d) => d.split('-').reverse().join('/')).join(', ')}`;
    case 'INTERVALO': return `A cada ${r.a_cada} ${r.unidade.toLowerCase()}`;
  }
  return '';
}
