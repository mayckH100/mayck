/**
 * v1.56.0 (Fase 1, item B): inadimplência do Painel CRM e score do cliente. Funções puras (sem banco):
 * as rotas buscam os títulos a receber do Financeiro e os pedidos de venda da MESMA empresa e chamam aqui.
 *
 * Datas: "vencido" segue a mesma regra do Financeiro e do BI (vencimento antes de hoje, dia em UTC).
 */

const DIA = 86_400_000;
const hojeUtc = (agora: Date) => new Date(agora.toISOString().slice(0, 10));
const diaUtc = (d: Date) => new Date(d.toISOString().slice(0, 10)).getTime();
const ABERTO = ['EM_ABERTO', 'PARCIAL'];

export interface TituloInadimplencia { valorCents: number; pagoCents: number; status: string; vencimento: Date }
export interface Inadimplencia {
  /** Total a receber do período (soma dos títulos não cancelados com vencimento no período). */
  totalCents: number;
  /** Valor vencido e ainda não pago desses títulos. */
  vencidoCents: number;
  /** % do vencido em aberto sobre o total a receber do período (1 casa). 0 quando não há nada a receber. */
  pct: number;
  /** Quantos títulos estão vencidos e em aberto. */
  titulosVencidos: number;
}

/** Inadimplência do período: os títulos já devem vir filtrados (a receber, mesma empresa, vencimento no período). */
export function calcularInadimplencia(titulos: TituloInadimplencia[], agora = new Date()): Inadimplencia {
  const hoje = hojeUtc(agora).getTime();
  const validos = titulos.filter((t) => t.status !== 'CANCELADO');
  const totalCents = validos.reduce((s, t) => s + t.valorCents, 0);
  const vencidos = validos.filter((t) => ABERTO.includes(t.status) && t.vencimento.getTime() < hoje && t.valorCents - t.pagoCents > 0);
  const vencidoCents = vencidos.reduce((s, t) => s + Math.max(0, t.valorCents - t.pagoCents), 0);
  return { totalCents, vencidoCents, pct: totalCents ? Math.round((vencidoCents / totalCents) * 1000) / 10 : 0, titulosVencidos: vencidos.length };
}

// ---------------- Score do cliente ----------------

export interface TituloScore {
  valorCents: number; pagoCents: number; status: string; vencimento: Date;
  /** Datas das baixas não estornadas (a última é a data em que o título foi quitado). */
  baixas: Date[];
}
export interface ScoreMotivo { texto: string; pontos: number }
/** BOM (verde), ATENCAO (amarelo), RISCO (vermelho) ou NOVO (sem histórico ainda: fica em 500). */
export type FaixaScore = 'BOM' | 'ATENCAO' | 'RISCO' | 'NOVO';
export interface ScoreCliente { score: number; faixa: FaixaScore; motivos: ScoreMotivo[] }

export const SCORE_BASE = 500;
/** Regras do score (pontos e limites), na ordem em que aparecem na explicação. */
export const REGRAS_SCORE = {
  pagoEmDia: 20, pagoEmDiaMax: 200,
  pagoAtrasado: -20, pagoAtrasadoMax: -200,
  vencidoAberto: -50, vencidoAbertoMax: -300,
  vencidoMais30Dias: -100,
  recencia30: 80, recencia90: 50, recencia180: 20, semComprarAno: -50,
  freq12: 100, freq6: 70, freq3: 40, freq1: 15,
} as const;

const limitar = (v: number, max: number) => (max >= 0 ? Math.min(v, max) : Math.max(v, max));
const plural = (n: number, um: string, varios: string) => `${n} ${n === 1 ? um : varios}`;

export function faixaDoScore(score: number): Exclude<FaixaScore, 'NOVO'> {
  return score >= 650 ? 'BOM' : score >= 400 ? 'ATENCAO' : 'RISCO';
}

/**
 * Score simples e explicável (0–1000). Base 500:
 *  + 20 por conta paga em dia (até +200)          − 20 por conta paga com atraso (até −200)
 *  − 50 por conta vencida em aberto (até −300)     − 100 se alguma está vencida há mais de 30 dias
 *  + recência da última compra: até 30 dias +80, até 90 +50, até 180 +20; mais de 1 ano sem comprar −50
 *  + frequência (compras nos últimos 12 meses): 12+ +100, 6+ +70, 3+ +40, 1+ +15
 * Sem nenhuma conta e nenhuma compra: 500, faixa NOVO.
 * `compras` = datas dos pedidos de venda válidos (fora de rascunho, aprovação, bloqueado, cancelado e devolvido).
 */
export function calcularScore(titulos: TituloScore[], compras: Date[], agora = new Date()): ScoreCliente {
  const R = REGRAS_SCORE;
  const hoje = hojeUtc(agora).getTime();
  const validos = titulos.filter((t) => t.status !== 'CANCELADO');
  if (!validos.length && !compras.length) return { score: SCORE_BASE, faixa: 'NOVO', motivos: [{ texto: 'Sem compras nem contas ainda: começa em 500', pontos: 0 }] };

  const motivos: ScoreMotivo[] = [];
  const pagos = validos.filter((t) => t.status === 'PAGO');
  const quitadoEm = (t: TituloScore) => (t.baixas.length ? Math.max(...t.baixas.map(diaUtc)) : diaUtc(t.vencimento));
  const emDia = pagos.filter((t) => quitadoEm(t) <= diaUtc(t.vencimento)).length;
  const atrasados = pagos.length - emDia;
  if (emDia) motivos.push({ texto: `${plural(emDia, 'conta paga', 'contas pagas')} em dia`, pontos: limitar(emDia * R.pagoEmDia, R.pagoEmDiaMax) });
  if (atrasados) motivos.push({ texto: `${plural(atrasados, 'conta paga', 'contas pagas')} com atraso`, pontos: limitar(atrasados * R.pagoAtrasado, R.pagoAtrasadoMax) });

  const vencidos = validos.filter((t) => ABERTO.includes(t.status) && t.vencimento.getTime() < hoje && t.valorCents - t.pagoCents > 0);
  if (vencidos.length) {
    motivos.push({ texto: `${plural(vencidos.length, 'conta vencida', 'contas vencidas')} sem pagar`, pontos: limitar(vencidos.length * R.vencidoAberto, R.vencidoAbertoMax) });
    const maisAntigo = Math.max(...vencidos.map((t) => Math.floor((hoje - diaUtc(t.vencimento)) / DIA)));
    if (maisAntigo > 30) motivos.push({ texto: `Conta vencida há ${maisAntigo} dias`, pontos: R.vencidoMais30Dias });
  }

  if (compras.length) {
    const ultima = Math.max(...compras.map((d) => d.getTime()));
    const dias = Math.max(0, Math.floor((agora.getTime() - ultima) / DIA));
    const rec = dias <= 30 ? R.recencia30 : dias <= 90 ? R.recencia90 : dias <= 180 ? R.recencia180 : dias > 365 ? R.semComprarAno : 0;
    if (rec) motivos.push({ texto: dias > 365 ? `Sem comprar há mais de 1 ano` : `Última compra há ${dias === 0 ? 'menos de 1 dia' : plural(dias, 'dia', 'dias')}`, pontos: rec });
    const ano = compras.filter((d) => agora.getTime() - d.getTime() <= 365 * DIA).length;
    const freq = ano >= 12 ? R.freq12 : ano >= 6 ? R.freq6 : ano >= 3 ? R.freq3 : ano >= 1 ? R.freq1 : 0;
    if (freq) motivos.push({ texto: `${plural(ano, 'compra', 'compras')} nos últimos 12 meses`, pontos: freq });
  }

  const score = Math.max(0, Math.min(1000, SCORE_BASE + motivos.reduce((s, m) => s + m.pontos, 0)));
  return { score, faixa: faixaDoScore(score), motivos };
}

/** Resumo dos scores para o painel: quantos em cada faixa, média e os que mais precisam de atenção. */
export function resumoScores(xs: { id: string; nome: string; score: ScoreCliente }[], limite = 5) {
  const com = xs.filter((x) => x.score.faixa !== 'NOVO');
  return {
    bons: com.filter((x) => x.score.faixa === 'BOM').length,
    atencao: com.filter((x) => x.score.faixa === 'ATENCAO').length,
    risco: com.filter((x) => x.score.faixa === 'RISCO').length,
    novos: xs.length - com.length,
    medio: com.length ? Math.round(com.reduce((s, x) => s + x.score.score, 0) / com.length) : null,
    piores: com.filter((x) => x.score.faixa !== 'BOM').sort((a, b) => a.score.score - b.score.score).slice(0, limite)
      .map((x) => ({ id: x.id, nome: x.nome, score: x.score.score, faixa: x.score.faixa, motivo: [...x.score.motivos].sort((a, b) => a.pontos - b.pontos)[0]?.texto ?? '' })),
  };
}

/** Status de pedido de venda que NÃO contam como compra no score (mesma regra do público pelo ERP do MCK Mensagens). */
export const PEDIDO_NAO_CONTA = ['RASCUNHO', 'EM_APROVACAO', 'BLOQUEADO', 'CANCELADO', 'DEVOLVIDO'];
