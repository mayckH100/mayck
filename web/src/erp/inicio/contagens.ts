/**
 * Contas das telas-resumo do MCK ERP (v1.37.0). Puro (sem React), a partir das listas que a API já devolve:
 * nenhuma regra de negócio nova, só contagem do que já existe (testado em tests/unit/erp-areas.test.ts).
 */

export interface ContagemVendas { orcamentos: number; aprovacao: number; aguardandoEstoque: number; separacao: number; aFaturar: number; emTransporte: number }
export function contarVendas(pedidos: { statusOperacional: string }[]): ContagemVendas {
  const n = (...s: string[]) => pedidos.filter((p) => s.includes(p.statusOperacional)).length;
  return {
    orcamentos: n('RASCUNHO'), aprovacao: n('EM_APROVACAO', 'BLOQUEADO'), aguardandoEstoque: n('AGUARDANDO_SUPRIMENTO'),
    separacao: n('APROVADO', 'RESERVADO', 'EM_SEPARACAO'), aFaturar: n('SEPARADO'), emTransporte: n('FATURADO', 'EM_TRANSPORTE', 'ENTREGA_PARCIAL'),
  };
}

export interface ContagemCompras { atrasadas: number; emBreve: number; aprovacaoOc: number; aguardandoEntrega: number; recebimento: number; emAndamento: number; valorAbertoCents: number }
const FECHADAS = ['RECEBIDO', 'CANCELADO'];
export function contarCompras(ocs: { status: string; totalCents?: number; prazo?: { codigo?: string } | null }[]): ContagemCompras {
  const abertas = ocs.filter((o) => !FECHADAS.includes(o.status));
  return {
    atrasadas: ocs.filter((o) => o.prazo?.codigo === 'ATRASADO').length,
    emBreve: ocs.filter((o) => o.prazo?.codigo === 'EM_BREVE').length,
    aprovacaoOc: ocs.filter((o) => o.status === 'EM_APROVACAO').length,
    aguardandoEntrega: ocs.filter((o) => ['APROVADO', 'ENVIADO', 'RECEBIDO_PARCIAL'].includes(o.status)).length,
    recebimento: ocs.filter((o) => ['AGUARDANDO_NF', 'AGUARDANDO_QUALIDADE', 'EM_CONFERENCIA', 'LIBERADA_ESTOQUE'].includes(o.status)).length,
    emAndamento: abertas.length,
    valorAbertoCents: abertas.reduce((a, o) => a + (o.totalCents ?? 0), 0),
  };
}
export const solicitacoesEmAprovacao = (s: { status: string }[]) => s.filter((x) => x.status === 'EM_APROVACAO').length;

export interface ContagemReposicao { zerados: number; abaixoMinimo: number; itens: number; totalCents: number }
export function contarReposicao(d: { itens: { saldoMil: number; minimoMil: number }[]; totalCents: number } | null | undefined): ContagemReposicao {
  const itens = d?.itens ?? [];
  const zerados = itens.filter((i) => i.saldoMil <= 0).length;
  return { zerados, abaixoMinimo: itens.length - zerados, itens: itens.length, totalCents: d?.totalCents ?? 0 };
}

/** Lotes com saldo: vencidos, vencendo em `dias` dias e em quarentena/bloqueados. */
export function contarLotes(lotes: { validade?: string | Date | null; vencido?: boolean; status?: string; saldoMil?: number }[], dias = 30, agora = Date.now()) {
  const lim = agora + dias * 86_400_000;
  const venc = (l: { validade?: string | Date | null }) => (l.validade ? new Date(l.validade).getTime() : null);
  return {
    vencidos: lotes.filter((l) => l.vencido || ((venc(l) ?? Infinity) < agora)).length,
    vencendo: lotes.filter((l) => { const v = venc(l); return v !== null && v >= agora && v <= lim && !l.vencido; }).length,
    bloqueados: lotes.filter((l) => l.status && l.status !== 'LIBERADO').length,
    total: lotes.length,
  };
}

/** Financeiro: vencido = tudo que passou do vencimento (todas as faixas de atraso). */
export const vencido = (a?: { ate30: number; ate60: number; ate90: number; mais90: number } | null) => (a ? a.ate30 + a.ate60 + a.ate90 + a.mais90 : 0);
/** A pagar/receber nos próximos `dias` dias pelo fluxo projetado (sem contar o que já venceu, que entra "hoje"). */
export function proximosDias(fluxo: { data: string; entradasCents: number; saidasCents: number }[] | undefined, dias = 7) {
  const f = (fluxo ?? []).slice(1, dias + 1);
  return { entradasCents: f.reduce((a, x) => a + x.entradasCents, 0), saidasCents: f.reduce((a, x) => a + x.saidasCents, 0) };
}
export const menorSaldo = (fluxo: { saldoCents: number }[] | undefined) => (fluxo?.length ? Math.min(...fluxo.map((f) => f.saldoCents)) : 0);

export function contarProducao(ops: { status: string; fimPrevisto?: string | Date | null }[], agora = Date.now()) {
  const abertas = ops.filter((o) => ['PLANEJADA', 'LIBERADA', 'EM_PRODUCAO'].includes(o.status));
  return {
    planejadas: ops.filter((o) => o.status === 'PLANEJADA').length,
    liberadas: ops.filter((o) => o.status === 'LIBERADA').length,
    emProducao: ops.filter((o) => o.status === 'EM_PRODUCAO').length,
    atrasadas: abertas.filter((o) => o.fimPrevisto && new Date(o.fimPrevisto).getTime() < agora).length,
  };
}

/** NF-e: do mês corrente (autorizadas e valor), rejeitadas e assinadas sem transmitir. */
export function contarFiscal(nfes: { status: string; totalCents: number; createdAt: string | Date; autorizadaEm?: string | Date | null }[], agora = new Date()) {
  const mes = (d: string | Date | null | undefined) => { if (!d) return false; const x = new Date(d); return x.getFullYear() === agora.getFullYear() && x.getMonth() === agora.getMonth(); };
  const aut = nfes.filter((n) => n.status === 'AUTORIZADA' && mes(n.autorizadaEm ?? n.createdAt));
  return {
    autorizadasMes: aut.length, valorMesCents: aut.reduce((a, n) => a + n.totalCents, 0),
    rejeitadas: nfes.filter((n) => n.status === 'REJEITADA').length,
    semTransmitir: nfes.filter((n) => n.status === 'ASSINADA').length,
  };
}
/** Dias até o certificado A1 vencer (negativo = vencido; null = sem certificado). */
export const diasCertificado = (validade?: string | Date | null, agora = Date.now()) => (validade ? Math.floor((new Date(validade).getTime() - agora) / 86_400_000) : null);
