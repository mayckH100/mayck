/**
 * v1.49.0 — Funções puras das campanhas (sem banco), usadas no servidor e na tela:
 * imagem/PDF por versão, campanha que se repete, rodízio entre números e filtro pelas compras do ERP.
 */

// ---------------- Imagem ou PDF ----------------

/** Tipos aceitos na campanha (conferidos pelos bytes do arquivo, nunca só pela extensão). */
export const MIDIA_TIPOS = ['jpg', 'png', 'webp', 'pdf'] as const;
/** Limites de tamanho (MB): o WhatsApp aceita imagem até 5 MB; o PDF fica em 10 MB para não pesar o banco. */
export const MIDIA_MAX_MB = { imagem: 5, pdf: 10 } as const;
/** A legenda da imagem/PDF no WhatsApp tem no máximo 1.024 caracteres. */
export const LEGENDA_MAX = 1024;
export const MAX_VERSOES = 4;

export function maxMbDoTipo(tipo: string): number {
  return tipo === 'pdf' ? MIDIA_MAX_MB.pdf : MIDIA_MAX_MB.imagem;
}

/** Lê Campaign.midias (JSON) sem quebrar com lixo: até 4 posições, cada uma um id ou null. */
export function lerMidias(json: string | null | undefined): (string | null)[] {
  try {
    const v = JSON.parse(json || '[]');
    if (!Array.isArray(v)) return [];
    const out = v.slice(0, MAX_VERSOES).map((x) => (typeof x === 'string' && x.trim() && x.length <= 40 ? x : null));
    while (out.length && out[out.length - 1] == null) out.pop();
    return out;
  } catch { return []; }
}

/** Arquivo que a versão usa: o próprio ou, sem arquivo próprio, o da versão A. */
export function midiaDaVersao(midias: (string | null)[], versao: number): string | null {
  return midias[versao] ?? midias[0] ?? null;
}

/** Grava (ou tira, com id null) o arquivo de uma versão e devolve o JSON. */
export function definirMidia(midias: (string | null)[], versao: number, id: string | null): string {
  const out = [...midias];
  while (out.length <= versao) out.push(null);
  out[versao] = id;
  while (out.length && out[out.length - 1] == null) out.pop();
  return JSON.stringify(out);
}

/** Com arquivo, o texto vira legenda: confere o tamanho de cada versão. Devolve a mensagem de erro (ou null). */
export function erroLegenda(textos: string[]): string | null {
  const i = textos.findIndex((t) => t.length > LEGENDA_MAX);
  if (i < 0) return null;
  return `Com imagem ou PDF, o texto vira a legenda e pode ter até ${LEGENDA_MAX.toLocaleString('pt-BR')} caracteres (a versão ${'ABCD'[i]} tem ${t(textos[i])}). Encurte o texto ou tire o arquivo.`;
}
const t = (s: string) => s.length.toLocaleString('pt-BR');

// ---------------- Campanha que se repete ----------------

export const RECORRENCIAS = ['DIARIA', 'SEMANAL', 'MENSAL'] as const;
export type Recorrencia = (typeof RECORRENCIAS)[number];
export const RECORRENCIA_ROTULO: Record<Recorrencia, string> = { DIARIA: 'todo dia', SEMANAL: 'toda semana', MENSAL: 'todo mês' };
/** Brasília não tem horário de verão desde 2019: UTC−3 fixo. */
const BRT_MS = 3 * 3600_000;

export const ehRecorrencia = (v: unknown): v is Recorrencia => typeof v === 'string' && (RECORRENCIAS as readonly string[]).includes(v);

/**
 * Próxima repetição a partir de `base`, mantendo a hora de Brasília. Mensal: mesmo dia do mês da 1ª execução
 * (`diaDoMes`); em mês mais curto, o último dia (31 → 30/fev 28).
 */
export function proximaExecucao(base: Date, rec: Recorrencia, diaDoMes?: number): Date {
  if (rec === 'DIARIA') return new Date(base.getTime() + 86_400_000);
  if (rec === 'SEMANAL') return new Date(base.getTime() + 7 * 86_400_000);
  const l = new Date(base.getTime() - BRT_MS); // "relógio" de Brasília nos campos UTC
  const ano = l.getUTCFullYear(), mes = l.getUTCMonth() + 1;
  const dia = diaDoMes ?? l.getUTCDate();
  const ultimo = new Date(Date.UTC(ano, mes + 1, 0)).getUTCDate();
  const alvo = Date.UTC(ano, mes, Math.min(dia, ultimo), l.getUTCHours(), l.getUTCMinutes(), l.getUTCSeconds());
  return new Date(alvo + BRT_MS);
}

/** Dia do mês (Brasília) de uma data — guarda o "dia 31" das repetições mensais. */
export function diaDoMesBrt(d: Date): number { return new Date(d.getTime() - BRT_MS).getUTCDate(); }

/** Pula as repetições que ficaram para trás (servidor parado): devolve a primeira depois de `agora`. */
export function proximaDepoisDe(prox: Date, rec: Recorrencia, agora: Date, diaDoMes?: number): Date {
  let n = proximaExecucao(prox, rec, diaDoMes);
  for (let i = 0; i < 400 && n.getTime() <= agora.getTime(); i++) n = proximaExecucao(n, rec, diaDoMes);
  return n;
}

/** Fim opcional: precisa ser no futuro e até 2 anos. */
export function erroFimRecorrencia(fim: Date | null, agora: Date): string | null {
  if (!fim) return null;
  if (Number.isNaN(fim.getTime())) return 'Data de fim inválida';
  if (fim.getTime() <= agora.getTime()) return 'A data de fim da repetição precisa ser no futuro';
  if (fim.getTime() > agora.getTime() + 730 * 86_400_000) return 'A repetição pode ir no máximo até 2 anos à frente';
  return null;
}

/** Nome da execução: "Nome · 24/11". */
export function nomeExecucao(nome: string, quando: Date): string {
  const l = new Date(quando.getTime() - BRT_MS);
  const dd = String(l.getUTCDate()).padStart(2, '0'), mm = String(l.getUTCMonth() + 1).padStart(2, '0');
  return `${nome.replace(/ · \d{2}\/\d{2}$/, '')} · ${dd}/${mm}`.slice(0, 120);
}

// ---------------- Rodízio entre números ----------------

export const MAX_CANAIS_RODIZIO = 5;

export function lerCanais(json: string | null | undefined): string[] {
  try {
    const v = JSON.parse(json || '[]');
    return Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === 'string' && !!x && x.length <= 40))].slice(0, MAX_CANAIS_RODIZIO - 1) : [];
  } catch { return []; }
}

/** Números da campanha: o principal e, com o rodízio ligado, os extras (sem repetir). */
export function canaisDaCampanha(c: { channelId: string; rodizio: boolean; canaisRodizio: string }): string[] {
  return c.rodizio ? [...new Set([c.channelId, ...lerCanais(c.canaisRodizio)])] : [c.channelId];
}

function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}

/**
 * Número que envia para o contato. Regra: o mesmo contato fica sempre no mesmo número.
 * 1) já atribuído e ainda na campanha → ele (mesmo que agora esteja fora: o contato espera o número dele voltar);
 * 2) número em que o contato já conversa (entre os da campanha e saudável) → ele;
 * 3) sorteio fixo pelo contato entre os números saudáveis. Sem número saudável → null (espera).
 */
export function escolherCanal(a: { chave: string; atribuido: string | null | undefined; preferido: string | null | undefined; todos: string[]; saudaveis: string[] }): string | null {
  if (a.atribuido && a.todos.includes(a.atribuido)) return a.atribuido;
  if (a.preferido && a.saudaveis.includes(a.preferido)) return a.preferido;
  const s = [...a.saudaveis].sort();
  if (!s.length) return null;
  return s[hash32(a.chave) % s.length];
}

// ---------------- Público pelas compras do ERP ----------------

export interface FiltroErp {
  /** Valor gasto no total (R$). */
  gastoMin?: number | null; gastoMax?: number | null;
  /** Número de compras. */
  comprasMin?: number | null; comprasMax?: number | null;
  /** Última compra há no máximo X dias (clientes recentes) / há pelo menos X dias (sumidos). */
  ultimaCompraMaxDias?: number | null; ultimaCompraMinDias?: number | null;
}
export interface ResumoCompras { gastoCents: number; compras: number; ultimaCompra: Date | null }

/** Pedidos que contam como compra (fora: rascunho/orçamento, em aprovação, bloqueado, cancelado, devolvido). */
export const STATUS_NAO_COMPRA = ['RASCUNHO', 'EM_APROVACAO', 'BLOQUEADO', 'CANCELADO', 'DEVOLVIDO'];

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export function filtroErpVazio(f: FiltroErp | null | undefined): boolean {
  if (!f) return true;
  return [f.gastoMin, f.gastoMax, f.comprasMin, f.comprasMax, f.ultimaCompraMaxDias, f.ultimaCompraMinDias].every((v) => num(v) == null);
}

export function erroFiltroErp(f: FiltroErp): string | null {
  const par = (a: unknown, b: unknown, nome: string) => (num(a) != null && num(b) != null && (a as number) > (b as number) ? `${nome}: o mínimo não pode ser maior que o máximo` : null);
  return par(f.gastoMin, f.gastoMax, 'Valor gasto') ?? par(f.comprasMin, f.comprasMax, 'Número de compras')
    ?? par(f.ultimaCompraMinDias, f.ultimaCompraMaxDias, 'Última compra (dias)');
}

/** O contato (já ligado a um cliente do ERP) atende ao filtro? Sem compra nenhuma = gasto 0, 0 compras, sem data. */
export function atendeFiltroErp(r: ResumoCompras, f: FiltroErp, agora: Date): boolean {
  const gasto = r.gastoCents / 100;
  if (num(f.gastoMin) != null && gasto < f.gastoMin!) return false;
  if (num(f.gastoMax) != null && gasto > f.gastoMax!) return false;
  if (num(f.comprasMin) != null && r.compras < f.comprasMin!) return false;
  if (num(f.comprasMax) != null && r.compras > f.comprasMax!) return false;
  const dias = r.ultimaCompra ? (agora.getTime() - r.ultimaCompra.getTime()) / 86_400_000 : null;
  if (num(f.ultimaCompraMaxDias) != null && (dias == null || dias > f.ultimaCompraMaxDias!)) return false;
  if (num(f.ultimaCompraMinDias) != null && dias != null && dias < f.ultimaCompraMinDias!) return false; // nunca comprou conta como "sumido"
  return true;
}

/** Texto curto do filtro (tela e detalhe da campanha). */
export function descreverFiltroErp(f: FiltroErp): string {
  const brl = (v: number) => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const p: string[] = [];
  if (num(f.gastoMin) != null) p.push(`gastou ${brl(f.gastoMin!)} ou mais`);
  if (num(f.gastoMax) != null) p.push(`gastou até ${brl(f.gastoMax!)}`);
  if (num(f.comprasMin) != null) p.push(`${f.comprasMin} compra(s) ou mais`);
  if (num(f.comprasMax) != null) p.push(`até ${f.comprasMax} compra(s)`);
  if (num(f.ultimaCompraMaxDias) != null) p.push(`comprou nos últimos ${f.ultimaCompraMaxDias} dias`);
  if (num(f.ultimaCompraMinDias) != null) p.push(`sem comprar há ${f.ultimaCompraMinDias} dias ou mais`);
  return p.join(' · ') || 'todos os clientes ligados ao ERP';
}

// ---------------- Público gravado ----------------

export type Publico = { modo: 'vinculados' } | { modo: 'etiqueta'; tag: string } | { modo: 'erp'; erp: FiltroErp };

export function lerPublico(json: string | null | undefined): Publico {
  try {
    const v = JSON.parse(json || 'null');
    if (v?.modo === 'etiqueta' && typeof v.tag === 'string' && v.tag) return { modo: 'etiqueta', tag: v.tag.slice(0, 40) };
    if (v?.modo === 'erp' && v.erp && typeof v.erp === 'object') return { modo: 'erp', erp: v.erp as FiltroErp };
  } catch { /* padrão */ }
  return { modo: 'vinculados' };
}
