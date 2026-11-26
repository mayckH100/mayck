/**
 * v1.55.0 — "🖨️ Imprimir / PDF" das telas de Estoque (saldos, saldo por lote, movimentações e depósitos/endereços).
 * Puro, sem DOM. Só usa dados que a tela já carregou da própria organização.
 */
import { htmlTabela, fmt } from './listas';
import type { Documento } from './cabecalho';

const loteTxt = (n: unknown) => (n === 'UNICO' || !n ? '' : String(n));
const validadeUtc = (v: unknown) => (v ? new Date(String(v)).toLocaleDateString('pt-BR', { timeZone: 'UTC' }) : '');

export function listaSaldos(itens: any[], f: { deposito?: string; filtro?: string }): Documento {
  return htmlTabela({ titulo: 'Saldos de estoque', filtros: [f.deposito || 'Todos os depósitos', f.filtro ? `Mostrando: ${f.filtro}` : ''], linhas: itens,
    colunas: [{ titulo: 'Código', valor: (s) => s.produto?.sku }, { titulo: 'Produto', valor: (s) => s.produto?.nome },
      { titulo: 'Lote', valor: (s) => [loteTxt(s.lote?.numero), s.lote?.loteFornecedor && s.lote.loteFornecedor !== s.lote?.numero ? `fab. ${s.lote.loteFornecedor}` : '', s.lote?.status && s.lote.status !== 'LIBERADO' ? s.lote.status.toLowerCase() : ''].filter(Boolean).join(' · ') },
      { titulo: 'Validade', valor: (s) => validadeUtc(s.lote?.validade) }, { titulo: 'Endereço', valor: (s) => [s.endereco?.deposito, s.endereco?.codigo].filter(Boolean).join(' · ') },
      { titulo: 'Físico', valor: (s) => fmt.qtd(s.fisicoMil), dir: true }, { titulo: 'Reservado', valor: (s) => fmt.qtd(s.reservadoMil), dir: true }, { titulo: 'Disponível', valor: (s) => fmt.qtd(s.disponivelMil), dir: true }] });
}

export function listaLotesSaldo(itens: any[], f: { deposito?: string }): Documento {
  return htmlTabela({ titulo: 'Saldo por lote', filtros: [f.deposito || 'Todos os depósitos'], linhas: itens,
    colunas: [{ titulo: 'Lote', valor: (l) => loteTxt(l.numero) }, { titulo: 'Produto', valor: (l) => [l.produto?.sku, l.produto?.nome].filter(Boolean).join(' · ') }, { titulo: 'Lote do fornecedor', valor: (l) => l.loteFornecedor },
      { titulo: 'Fornecedor', valor: (l) => l.fornecedor?.nome }, { titulo: 'Entrada', valor: (l) => fmt.dia(l.entradaEm) }, { titulo: 'Validade', valor: (l) => validadeUtc(l.validade) },
      { titulo: 'Recebido', valor: (l) => fmt.qtd(l.recebidoMil), dir: true }, { titulo: 'Saldo', valor: (l) => fmt.qtd(l.saldoMil), dir: true }, { titulo: 'Situação', valor: (l) => (l.status ? String(l.status).toLowerCase() : '') }] });
}

export function listaMovimentos(itens: any[]): Documento {
  return htmlTabela({ titulo: 'Movimentações de estoque', filtros: ['Últimas movimentações'], linhas: itens,
    colunas: [{ titulo: 'Quando', valor: (m) => fmt.dataHora(m.createdAt) }, { titulo: 'Produto', valor: (m) => m.produto?.sku }, { titulo: 'Tipo', valor: (m) => m.tipo },
      { titulo: 'Qtd', valor: (m) => `${m.qtdMil > 0 ? '+' : ''}${fmt.qtd(m.qtdMil)}`, dir: true }, { titulo: 'Saldo após', valor: (m) => fmt.qtd(m.saldoAposMil), dir: true },
      { titulo: 'Lote · Endereço', valor: (m) => [loteTxt(m.lote), m.endereco].filter(Boolean).join(' · ') }, { titulo: 'Motivo', valor: (m) => m.motivo }] });
}

export function listaDepositos(itens: any[]): Documento {
  return htmlTabela({ titulo: 'Depósitos e endereços', linhas: itens,
    colunas: [{ titulo: 'Depósito', valor: (d) => d.nome }, { titulo: 'Endereços', valor: (d) => `${(d.enderecos ?? []).length}`, dir: true }, { titulo: 'Códigos', valor: (d) => (d.enderecos ?? []).map((e: any) => e.codigo).join(', ') }] });
}

/** Resultado da busca do Rastreio de lote: cada lote com o que ele "bateu" (produto, NF, pedido…). */
export function listaRastreioBusca(d: any, q: string): Documento {
  const linhas = (d?.grupos ?? []).flatMap((g: any) => (g.lotes ?? []).map((l: any) => ({ ...l, _grupo: [g.rotulo, g.titulo].filter(Boolean).join(': ') })));
  return htmlTabela({ titulo: 'Rastreio de lote · busca', filtros: [`Busca: “${q}”`], linhas,
    colunas: [{ titulo: 'Encontrado em', valor: (l: any) => l._grupo }, { titulo: 'Lote', valor: (l: any) => loteTxt(l.numero) }, { titulo: 'Produto', valor: (l: any) => [l.produto?.sku, l.produto?.nome].filter(Boolean).join(' · ') },
      { titulo: 'Lote do fornecedor', valor: (l: any) => l.loteFornecedor }, { titulo: 'Fornecedor', valor: (l: any) => l.fornecedor?.nome }, { titulo: 'Validade', valor: (l: any) => validadeUtc(l.validade) }, { titulo: 'Saldo', valor: (l: any) => fmt.qtd(l.saldoMil), dir: true }] });
}
