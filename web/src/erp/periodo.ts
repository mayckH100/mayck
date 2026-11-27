/**
 * v1.56.0 (Fase 1, item A4): períodos padrão do MCK ERP (Hoje / 7 dias / 30 dias / Mês / Personalizado), iguais em
 * todas as telas. Funções puras: datas no formato AAAA-MM-DD no horário de Brasília (UTC−3, sem horário de verão).
 */
export type PresetPeriodo = 'hoje' | '7d' | '30d' | '90d' | 'mes' | 'todos' | 'personalizado';
export interface Periodo { preset: PresetPeriodo; de: string; ate: string }

export const ROTULO_PERIODO: Record<PresetPeriodo, string> = {
  hoje: 'Hoje', '7d': '7 dias', '30d': '30 dias', '90d': '90 dias', mes: 'Mês', todos: 'Todos', personalizado: 'Personalizado',
};
/** O conjunto padrão. Telas podem acrescentar "90 dias" ou "Todos" quando já usavam isso antes. */
export const PERIODOS_PADRAO: PresetPeriodo[] = ['hoje', '7d', '30d', 'mes', 'personalizado'];

const DIA = 86_400_000;
/** Data de hoje (ou de `d`) em Brasília, AAAA-MM-DD. */
export const isoBrasilia = (d: Date) => new Date(d.getTime() - 3 * 3_600_000).toISOString().slice(0, 10);

/** Intervalo de um período pronto, contando hoje: "7 dias" = hoje e os 6 dias antes; "Mês" = dia 1 do mês até hoje. */
export function intervaloDoPreset(preset: PresetPeriodo, agora = new Date()): { de: string; ate: string } {
  const ate = isoBrasilia(agora);
  const antes = (n: number) => isoBrasilia(new Date(agora.getTime() - n * DIA));
  switch (preset) {
    case 'hoje': return { de: ate, ate };
    case '7d': return { de: antes(6), ate };
    case '30d': return { de: antes(29), ate };
    case '90d': return { de: antes(89), ate };
    case 'mes': return { de: `${ate.slice(0, 8)}01`, ate };
    case 'todos': return { de: '', ate: '' };
    default: return { de: antes(29), ate };
  }
}

/** Período inicial de uma tela. */
export function periodoInicial(preset: PresetPeriodo, agora = new Date()): Periodo {
  return { preset, ...intervaloDoPreset(preset, agora) };
}

/** Troca o período: um pronto recalcula as datas; "Personalizado" mantém as datas atuais para a pessoa ajustar. */
export function escolherPreset(atual: Periodo, preset: PresetPeriodo, agora = new Date()): Periodo {
  if (preset === 'personalizado') {
    const base = atual.de || atual.ate ? atual : periodoInicial('30d', agora);
    return { preset, de: base.de, ate: base.ate };
  }
  return periodoInicial(preset, agora);
}

/** Datas digitadas no Personalizado: se "de" passar de "até", as duas ficam iguais (evita período invertido). */
export function ajustarDatas(atual: Periodo, campo: 'de' | 'ate', valor: string): Periodo {
  const p = { ...atual, preset: 'personalizado' as const, [campo]: valor };
  if (p.de && p.ate && p.de > p.ate) { if (campo === 'de') p.ate = p.de; else p.de = p.ate; }
  return p;
}

/** Texto curto do período para cabeçalhos e impressões: "Hoje", "Últimos 7 dias", "01/11/2026 a 26/11/2026". */
export function descreverPeriodo(p: Periodo): string {
  const br = (d: string) => d.split('-').reverse().join('/');
  if (p.preset === 'hoje') return 'Hoje';
  if (p.preset === '7d' || p.preset === '30d' || p.preset === '90d') return `Últimos ${ROTULO_PERIODO[p.preset]}`;
  if (p.preset === 'mes') return 'Este mês';
  if (!p.de && !p.ate) return 'Todos';
  if (!p.de) return `Até ${br(p.ate)}`;
  if (!p.ate) return `A partir de ${br(p.de)}`;
  return p.de === p.ate ? br(p.de) : `${br(p.de)} a ${br(p.ate)}`;
}
