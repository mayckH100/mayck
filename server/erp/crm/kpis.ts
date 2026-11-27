/** KPIs do CRM (funções puras; a rota só busca os dados e chama aqui). */
import type { Inadimplencia } from './score.js';
export interface OportunidadeKpi { status: string; valorCents: number; custoAquisicaoCents: number; parceiroId: string; createdAt: Date; fechadaEm: Date | null }
export interface ParceiroKpi { id: string; status: string; ehCliente: boolean }

export interface KpisCrm {
  clientesAtivos: number; clientesInativos: number;
  oportunidadesAbertas: number; pipelineCents: number;
  ganhas: number; perdidas: number; taxaConversao: number; // % ganhas / (ganhas + perdidas)
  ticketMedioCents: number; cacCents: number; cicloMedioDias: number;
  /** v1.56.0: % do vencido em aberto sobre o total a receber do período (Financeiro). null = sem acesso ao Financeiro. */
  inadimplenciaPct: number | null;
  inadimplenciaVencidoCents: number | null;
  inadimplenciaTotalCents: number | null;
  inadimplenciaTitulos: number | null;
}

export function calcularKpis(parceiros: ParceiroKpi[], ops: OportunidadeKpi[], inad: Inadimplencia | null = null): KpisCrm {
  const clientes = parceiros.filter((p) => p.ehCliente);
  const ganhas = ops.filter((o) => o.status === 'GANHA');
  const perdidas = ops.filter((o) => o.status === 'PERDIDA');
  const abertas = ops.filter((o) => o.status === 'ABERTA');
  const fechadas = ganhas.length + perdidas.length;
  const soma = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  const novosClientes = new Set(ganhas.map((o) => o.parceiroId)).size;
  const ciclos = ganhas.filter((o) => o.fechadaEm).map((o) => (o.fechadaEm!.getTime() - o.createdAt.getTime()) / 86_400_000);
  return {
    clientesAtivos: clientes.filter((p) => p.status === 'ATIVO').length,
    clientesInativos: clientes.filter((p) => p.status !== 'ATIVO').length,
    oportunidadesAbertas: abertas.length,
    pipelineCents: soma(abertas.map((o) => o.valorCents)),
    ganhas: ganhas.length,
    perdidas: perdidas.length,
    taxaConversao: fechadas ? Math.round((ganhas.length / fechadas) * 1000) / 10 : 0,
    ticketMedioCents: ganhas.length ? Math.round(soma(ganhas.map((o) => o.valorCents)) / ganhas.length) : 0,
    cacCents: novosClientes ? Math.round(soma(ops.map((o) => o.custoAquisicaoCents)) / novosClientes) : 0,
    cicloMedioDias: ciclos.length ? Math.round((soma(ciclos) / ciclos.length) * 10) / 10 : 0,
    inadimplenciaPct: inad ? inad.pct : null,
    inadimplenciaVencidoCents: inad ? inad.vencidoCents : null,
    inadimplenciaTotalCents: inad ? inad.totalCents : null,
    inadimplenciaTitulos: inad ? inad.titulosVencidos : null,
  };
}

/** Funil: quantidade e valor por etapa. */
export function funil(etapas: { id: string; nome: string; posicao: number }[], ops: { etapaId: string; status: string; valorCents: number }[]) {
  return etapas.sort((a, b) => a.posicao - b.posicao).map((e) => {
    const xs = ops.filter((o) => o.etapaId === e.id && o.status === 'ABERTA');
    return { etapaId: e.id, nome: e.nome, quantidade: xs.length, valorCents: xs.reduce((a, o) => a + o.valorCents, 0) };
  });
}
