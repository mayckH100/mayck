/**
 * Prazo de entrega da ordem de compra (v1.36.0). Funções puras (sem banco), usadas pelo servidor e pela web.
 * Datas "de calendário" (sem hora) são gravadas ao meio-dia UTC; as antigas (00:00 UTC, vindas de <input type=date>)
 * também são lidas pela data UTC, para não virar o dia anterior no fuso de Brasília.
 */
import { STATUS_AGUARDANDO_ENTREGA, type StatusCompra } from './compra.machine.js';

/** Dia (AAAA-MM-DD) de uma data no fuso da empresa (ou a data UTC, se for uma "data de calendário"). */
export function diaDe(d: Date | string, tz = 'America/Sao_Paulo'): string {
  const x = typeof d === 'string' ? new Date(d) : d;
  if (x.getUTCMinutes() === 0 && x.getUTCSeconds() === 0 && x.getUTCMilliseconds() === 0 && (x.getUTCHours() === 0 || x.getUTCHours() === 12)) return x.toISOString().slice(0, 10);
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(x).map((v) => [v.type, v.value]));
  return `${p.year}-${p.month}-${p.day}`;
}
/** Data de calendário (meio-dia UTC) a partir de AAAA-MM-DD. */
export const dataDoDia = (dia: string) => new Date(`${dia.slice(0, 10)}T12:00:00.000Z`);
/** Dias de `de` até `ate` (AAAA-MM-DD); positivo se `ate` é depois. */
export const diasEntre = (de: string, ate: string) => Math.round((Date.parse(`${ate}T12:00:00Z`) - Date.parse(`${de}T12:00:00Z`)) / 86_400_000);
export const somarDias = (dia: string, n: number) => new Date(Date.parse(`${dia}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
export const diaBr = (dia: string) => `${dia.slice(8, 10)}/${dia.slice(5, 7)}/${dia.slice(0, 4)}`;

/** Previsão de entrega = dia da emissão + prazo (dias corridos). */
export function calcularPrevisao(emissao: Date, prazoDias: number, tz = 'America/Sao_Paulo'): Date {
  return dataDoDia(somarDias(diaDe(emissao, tz), Math.max(0, Math.round(prazoDias))));
}

export type CodigoPrazo = 'SEM_DATA' | 'NO_PRAZO' | 'EM_BREVE' | 'ATRASADO' | 'ENTREGUE' | 'ENTREGUE_ATRASADO' | 'NA';
export interface SituacaoPrazo { codigo: CodigoPrazo; /** dias até a previsão (≥0) ou de atraso (>0) */ dias: number; rotulo: string; cor: 'green' | 'yellow' | 'red' | 'gray'; previsaoDia: string | null }

const pl = (n: number) => `${n} dia${n === 1 ? '' : 's'}`;

/**
 * No prazo / Chega em breve (≤ emBreveDias) / Atrasado há N dias, para as etapas em que a mercadoria ainda não chegou.
 * Depois da chegada: entregue no prazo ou com atraso (compara a data da chegada com a previsão).
 */
export function situacaoPrazo(p: { status: string; previsaoEntrega: Date | string | null; entregueEm?: Date | string | null }, hoje: string, emBreveDias = 2, tz = 'America/Sao_Paulo'): SituacaoPrazo {
  const previsaoDia = p.previsaoEntrega ? diaDe(p.previsaoEntrega, tz) : null;
  if (p.status === 'CANCELADO') return { codigo: 'NA', dias: 0, rotulo: 'Cancelada', cor: 'gray', previsaoDia };
  const aguardando = STATUS_AGUARDANDO_ENTREGA.includes(p.status as StatusCompra);
  if (!previsaoDia) return { codigo: aguardando ? 'SEM_DATA' : 'ENTREGUE', dias: 0, rotulo: aguardando ? 'Sem data prevista' : 'Entregue', cor: 'gray', previsaoDia };
  if (!aguardando) {
    const chegou = p.entregueEm ? diaDe(p.entregueEm, tz) : null;
    const atraso = chegou ? diasEntre(previsaoDia, chegou) : 0;
    return atraso > 0
      ? { codigo: 'ENTREGUE_ATRASADO', dias: atraso, rotulo: `Entregue com ${pl(atraso)} de atraso`, cor: 'gray', previsaoDia }
      : { codigo: 'ENTREGUE', dias: 0, rotulo: 'Entregue no prazo', cor: 'gray', previsaoDia };
  }
  const faltam = diasEntre(hoje, previsaoDia);
  if (faltam < 0) return { codigo: 'ATRASADO', dias: -faltam, rotulo: `Atrasado há ${pl(-faltam)}`, cor: 'red', previsaoDia };
  if (faltam <= Math.max(0, emBreveDias)) return { codigo: 'EM_BREVE', dias: faltam, rotulo: faltam === 0 ? 'Chega hoje' : faltam === 1 ? 'Chega amanhã' : `Chega em breve · em ${pl(faltam)}`, cor: 'yellow', previsaoDia };
  return { codigo: 'NO_PRAZO', dias: faltam, rotulo: `No prazo · faltam ${pl(faltam)}`, cor: 'green', previsaoDia };
}

/** Texto modelo do aviso ao fornecedor: troca {fornecedor} {empresa} {numero} {data_prevista} {dias_atraso} {itens}. */
export const TEXTO_FORN_LEMBRETE = 'Olá, {fornecedor}! Passando para lembrar do pedido de compra nº {numero}, com entrega prevista para {data_prevista}. Está tudo certo para a entrega?\nItens: {itens}\nObrigado! {empresa}';
export const TEXTO_FORN_ATRASO = 'Olá, {fornecedor}. O pedido de compra nº {numero} tinha entrega prevista para {data_prevista} e está atrasado há {dias_atraso} dia(s). Pode nos informar a nova data de entrega?\nItens: {itens}\nObrigado! {empresa}';
export function preencherTexto(modelo: string, v: Record<'fornecedor' | 'empresa' | 'numero' | 'data_prevista' | 'dias_atraso' | 'itens', string>): string {
  return modelo.replace(/\{(fornecedor|empresa|numero|data_prevista|dias_atraso|itens)\}/g, (_, k: keyof typeof v) => v[k]);
}
/** Cobrança ao fornecedor: 1º dia de atraso e depois a cada 3 dias (equipe recebe todo dia). */
export const cobrarFornecedorHoje = (diasAtraso: number) => diasAtraso >= 1 && (diasAtraso - 1) % 3 === 0;

/** Dia (AAAA-MM-DD) e hora local no fuso da empresa. */
export function agoraNoFuso(tz: string, now = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit' }).formatToParts(now).map((x) => [x.type, x.value]));
  return { dia: `${p.year}-${p.month}-${p.day}`, hora: Number(p.hour) % 24 };
}
