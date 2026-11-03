/**
 * Regras puras de produção: estrutura (BOM) sem ciclo, explosão com perda, custo padrão e MRP.
 * Quantidades em milésimos; qtdMil do componente é por 1 unidade (1000) do pai.
 */
export interface ItemEstrutura { produtoId: string; componenteId: string; qtdMil: number; perdaBp: number }

/** Quanto do componente é preciso para produzir qtdMil do pai (com perda). */
export const necessidadeComponente = (qtdPaiMil: number, e: { qtdMil: number; perdaBp: number }) =>
  Math.ceil((qtdPaiMil * e.qtdMil * (10_000 + e.perdaBp)) / (1000 * 10_000));

/** Verdadeiro se adicionar pai → componente cria ciclo na estrutura. */
export function criaCiclo(estrutura: ItemEstrutura[], pai: string, componente: string) {
  if (pai === componente) return true;
  const filhos = new Map<string, string[]>();
  for (const e of estrutura) filhos.set(e.produtoId, [...(filhos.get(e.produtoId) ?? []), e.componenteId]);
  const pilha = [componente]; const visto = new Set<string>();
  while (pilha.length) {
    const x = pilha.pop()!;
    if (x === pai) return true;
    if (visto.has(x)) continue; visto.add(x);
    pilha.push(...(filhos.get(x) ?? []));
  }
  return false;
}

/** Custo padrão por unidade: materiais (custo médio, multinível) + operações. */
export function custoPadrao(produtoId: string, estrutura: ItemEstrutura[], custoMedio: Map<string, number>, custoOperacao: Map<string, number>, prof = 0): number {
  const comps = estrutura.filter((e) => e.produtoId === produtoId);
  if (!comps.length || prof > 20) return custoMedio.get(produtoId) ?? 0;
  const mat = comps.reduce((a, e) => a + (custoPadrao(e.componenteId, estrutura, custoMedio, custoOperacao, prof + 1) * necessidadeComponente(1000, e)) / 1000, 0);
  return Math.round(mat + (custoOperacao.get(produtoId) ?? 0));
}

export interface ProdutoMrp { id: string; sku: string; nome: string; tipo: string; leadTimeDias: number; estoqueMinimoMil: number; pontoPedidoMil: number; loteMinimoMil: number; fornecedorPadraoId?: string | null }
export interface EntradaMrp {
  produtos: ProdutoMrp[];
  estrutura: ItemEstrutura[];
  disponivelMil: Map<string, number>;   // físico − reservado − quarentena
  demandaMil: Map<string, number>;      // pedidos de venda aprovados ainda não reservados
  dependenteMil: Map<string, number>;   // componentes de OPs abertas ainda não reservados/consumidos
  programadoMil: Map<string, number>;   // pedidos de compra e OPs em aberto (a receber)
}
export interface SugestaoMrp { produtoId: string; sku: string; nome: string; acao: 'PRODUZIR' | 'COMPRAR'; qtdMil: number; necessidadeMil: number; liberarAte: string; fornecedorPadraoId: string | null; motivo: string }

/**
 * MRP de um período (sem baldes de tempo): processa pais antes dos componentes (nível mais baixo),
 * soma demanda independente + dependente + estoque alvo, abate disponível e programado, aplica lote mínimo
 * e explode a estrutura das sugestões de produção para gerar a demanda dos componentes.
 */
export function calcularMrp(e: EntradaMrp, hoje = new Date()): SugestaoMrp[] {
  const P = new Map(e.produtos.map((p) => [p.id, p]));
  const filhos = new Map<string, ItemEstrutura[]>();
  for (const x of e.estrutura) filhos.set(x.produtoId, [...(filhos.get(x.produtoId) ?? []), x]);
  // nível mais baixo de cada produto (low-level code)
  const nivel = new Map<string, number>();
  const marcar = (id: string, n: number, prof = 0) => {
    if (prof > 30) return;
    if ((nivel.get(id) ?? -1) >= n) return;
    nivel.set(id, n);
    for (const f of filhos.get(id) ?? []) marcar(f.componenteId, n + 1, prof + 1);
  };
  for (const p of e.produtos) marcar(p.id, 0);
  const ordem = [...e.produtos].sort((a, b) => (nivel.get(a.id) ?? 0) - (nivel.get(b.id) ?? 0));
  const dependente = new Map(e.dependenteMil);
  const out: SugestaoMrp[] = [];
  for (const p of ordem) {
    if (p.tipo === 'SERVICO') continue;
    const demanda = (e.demandaMil.get(p.id) ?? 0) + (dependente.get(p.id) ?? 0);
    const alvo = Math.max(p.estoqueMinimoMil, p.pontoPedidoMil);
    const liquida = demanda + alvo - (e.disponivelMil.get(p.id) ?? 0) - (e.programadoMil.get(p.id) ?? 0);
    if (liquida <= 0) continue;
    const qtd = Math.max(liquida, p.loteMinimoMil);
    const produz = p.tipo === 'PRODUZIDO' && (filhos.get(p.id)?.length ?? 0) > 0;
    const liberar = new Date(hoje.getTime()); // precisa hoje; liberar já (lead time informa a chegada)
    const chegada = new Date(hoje.getTime() + p.leadTimeDias * 86_400_000);
    out.push({
      produtoId: p.id, sku: p.sku, nome: p.nome, acao: produz ? 'PRODUZIR' : 'COMPRAR', qtdMil: qtd, necessidadeMil: liquida,
      liberarAte: liberar.toISOString().slice(0, 10), fornecedorPadraoId: produz ? null : p.fornecedorPadraoId ?? null,
      motivo: `demanda ${demanda / 1000} + alvo ${alvo / 1000} − disponível ${(e.disponivelMil.get(p.id) ?? 0) / 1000} − a receber ${(e.programadoMil.get(p.id) ?? 0) / 1000}; chega por volta de ${chegada.toISOString().slice(0, 10)}`,
    });
    if (produz) for (const f of filhos.get(p.id)!) if (P.has(f.componenteId)) dependente.set(f.componenteId, (dependente.get(f.componenteId) ?? 0) + necessidadeComponente(qtd, f));
  }
  return out;
}
