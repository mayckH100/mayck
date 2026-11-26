/**
 * v1.55.0 — "🖨️ Imprimir / PDF" dos cadastros do MCK ERP: lista (com a busca/filtros atuais da tela) e ficha individual
 * (dados salvos). Puro, sem DOM (testado em tests/unit/impressao-listas.test.ts). Só usa dados já carregados pela tela
 * (que o servidor já filtrou pela organização). O cabeçalho e o rodapé vêm do `imprimir`.
 */
import { htmlFicha, htmlTabela, fmt, type Coluna } from './listas';
import type { Documento } from './cabecalho';

const busca = (q?: string) => (q?.trim() ? `Busca: “${q.trim()}”` : '');
const STATUS: Record<string, string> = { ATIVO: 'Ativo', INATIVO: 'Inativo', BLOQUEADO: 'Bloqueado' };
const REGIME: Record<string, string> = { MEI: 'MEI', SIMPLES: 'Simples Nacional', NORMAL: 'Lucro Presumido/Real' };
const cidadeUf = (p: any) => [p?.municipio, p?.uf].filter(Boolean).join('/');
const endereco = (p: any) => [[p?.logradouro, p?.numero].filter(Boolean).join(', '), p?.complemento, p?.bairro, cidadeUf(p), p?.cep && `CEP ${p.cep}`].filter(Boolean).join(' · ');

/** Lista de clientes ou fornecedores com a busca atual. */
export function listaParceiros(itens: any[], papel: 'cliente' | 'fornecedor', q = '', total?: number): Documento {
  const forn = papel === 'fornecedor';
  const colunas: Coluna<any>[] = [
    { titulo: 'Nome', valor: (p) => (p.fantasia && p.fantasia !== p.nome ? `${p.fantasia} (${p.nome})` : p.fantasia || p.nome) },
    { titulo: 'CPF/CNPJ', valor: (p) => fmt.doc(p.documento) },
    { titulo: 'Cidade', valor: cidadeUf },
    { titulo: 'Telefone', valor: (p) => p.telefone },
    { titulo: 'E-mail', valor: (p) => p.email },
    { titulo: 'Situação na Receita', valor: (p) => p.situacaoCadastral },
    { titulo: 'Status', valor: (p) => STATUS[p.status] ?? p.status },
  ];
  return htmlTabela({ titulo: forn ? 'Lista de fornecedores' : 'Lista de clientes', filtros: [busca(q) || (forn ? 'Todos os fornecedores' : 'Todos os clientes'), total != null && total > itens.length ? `mostrando ${itens.length} de ${total}` : ''], colunas, linhas: itens });
}

/** Ficha do cliente/fornecedor (dados salvos + contatos + oportunidades). */
export function fichaParceiro(p: any): Documento {
  const forn = p?.ehFornecedor && !p?.ehCliente;
  return htmlFicha({
    titulo: `Ficha do ${forn ? 'fornecedor' : 'cliente'} · ${p?.fantasia || p?.nome || ''}`,
    subtitulo: fmt.doc(p?.documento),
    secoes: [
      { titulo: 'Cadastro', campos: [['Razão social / nome', p?.nome], ['Nome fantasia', p?.fantasia], ['CPF/CNPJ', fmt.doc(p?.documento)], ['Papel', [p?.ehCliente && 'Cliente', p?.ehFornecedor && 'Fornecedor'].filter(Boolean).join(' e ')],
        ['Inscrição estadual', p?.inscricaoEstadual], ['Inscrição municipal', p?.inscricaoMunicipal], ['Regime', REGIME[p?.regimeTributario] ?? p?.regimeTributario], ['CNAE', [p?.cnae, p?.cnaeDescricao].filter(Boolean).join(' · ')],
        ['Situação na Receita', p?.situacaoCadastral], ['Status', STATUS[p?.status] ?? p?.status]] },
      { titulo: 'Contato e endereço', campos: [['E-mail', p?.email], ['Telefone / WhatsApp', p?.telefone], ['Endereço', endereco(p)], ['Código IBGE do município', p?.codigoMunicipio]] },
      { titulo: 'Comercial', campos: [['Limite de crédito', p?.ehCliente ? fmt.brl(p?.limiteCreditoCents) : ''], ['Prazo de entrega', forn && p?.prazoEntregaDias ? `${p.prazoEntregaDias} dia(s)` : ''], ['Origem', p?.origem],
        ['Total comprado', p?.resumo ? fmt.brl(p.resumo.totalGanhoCents) : ''], ['Ticket médio', p?.resumo ? fmt.brl(p.resumo.ticketMedioCents) : ''], ['Em negociação', p?.resumo ? fmt.brl(p.resumo.emAbertoCents) : ''], ['Cadastrado em', fmt.dia(p?.createdAt)]] },
    ],
    tabelas: [
      ...(p?.contatos?.length ? [{ titulo: 'Contatos', colunas: [{ titulo: 'Nome', valor: (c: any) => `${c.nome}${c.principal ? ' (principal)' : ''}` }, { titulo: 'Cargo', valor: (c: any) => c.cargo }, { titulo: 'E-mail', valor: (c: any) => c.email }, { titulo: 'Telefone', valor: (c: any) => c.telefone }], linhas: p.contatos }] : []),
      ...(p?.oportunidades?.length ? [{ titulo: 'Oportunidades', colunas: [{ titulo: 'Título', valor: (o: any) => o.titulo }, { titulo: 'Status', valor: (o: any) => o.status }, { titulo: 'Valor', valor: (o: any) => fmt.brl(o.valorCents), dir: true }], linhas: p.oportunidades }] : []),
    ],
    observacoes: p?.observacoes ?? '',
  });
}

/** Painel CRM: indicadores e funil por etapa do período/filial da tela. */
export function relatorioPainelCrm(d: any, f: { de: string; ate: string; filial?: string }): Documento {
  const k = d?.kpis ?? {};
  const kpis: [string, string][] = [
    ['Clientes ativos', `${k.clientesAtivos ?? 0} (${k.clientesInativos ?? 0} inativos)`], ['Pipeline aberto', `${fmt.brl(k.pipelineCents ?? 0)} · ${k.oportunidadesAbertas ?? 0} oportunidade(s)`],
    ['Taxa de conversão', `${Number(k.taxaConversao ?? 0).toLocaleString('pt-BR')}% · ${k.ganhas ?? 0} ganhas · ${k.perdidas ?? 0} perdidas`], ['Ticket médio', `${fmt.brl(k.ticketMedioCents ?? 0)} · ciclo médio ${k.cicloMedioDias ?? 0} dias`],
    ['CAC', fmt.brl(k.cacCents ?? 0)], ['Inadimplência', k.inadimplenciaPct == null ? '—' : `${k.inadimplenciaPct}%`],
  ];
  return htmlTabela({ titulo: 'Painel CRM', filtros: [`Período: ${fmt.dia(f.de)} a ${fmt.dia(f.ate)}`, f.filial || 'Todas as filiais'],
    colunas: [{ titulo: 'Indicador', valor: (x: [string, string]) => x[0] }, { titulo: 'Valor', valor: (x: [string, string]) => x[1] }], linhas: kpis,
    extras: [{ titulo: 'Funil por etapa', colunas: [{ titulo: 'Etapa', valor: (x: any) => x.nome }, { titulo: 'Quantidade', valor: (x: any) => x.quantidade, dir: true }, { titulo: 'Valor', valor: (x: any) => fmt.brl(x.valorCents), dir: true }], linhas: d?.funil ?? [] }] });
}

const nomeParceiro = (p: any) => p?.fantasia || p?.nome || '';

/** Funil de vendas: oportunidades abertas por etapa. */
export function listaFunil(d: any): Documento {
  const etapa = new Map<string, any>((d?.etapas ?? []).map((e: any) => [e.id, e]));
  const ordem = new Map<string, number>((d?.etapas ?? []).map((e: any, i: number) => [e.id, i]));
  const linhas = [...(d?.oportunidades ?? [])].sort((a, b) => (ordem.get(a.etapaId) ?? 0) - (ordem.get(b.etapaId) ?? 0));
  const total = linhas.reduce((a, o) => a + (o.valorCents ?? 0), 0);
  return htmlTabela({ titulo: 'Funil de vendas', filtros: ['Oportunidades abertas'], linhas, total: `Total em negociação ${fmt.brl(total)}`,
    colunas: [{ titulo: 'Etapa', valor: (o) => etapa.get(o.etapaId)?.nome }, { titulo: 'Oportunidade', valor: (o) => o.titulo }, { titulo: 'Cliente', valor: (o) => nomeParceiro(o.parceiro) },
      { titulo: 'Probabilidade', valor: (o) => (o.probabilidade != null ? `${o.probabilidade}%` : ''), dir: true }, { titulo: 'Valor', valor: (o) => fmt.brl(o.valorCents), dir: true }] });
}

/** Ficha de uma oportunidade. */
export function fichaOportunidade(o: any, etapaNome = ''): Documento {
  return htmlFicha({ titulo: `Oportunidade · ${o?.titulo ?? ''}`, secoes: [{ campos: [['Título', o?.titulo], ['Cliente', nomeParceiro(o?.parceiro)], ['Etapa', etapaNome], ['Status', o?.status], ['Valor', fmt.brl(o?.valorCents)],
    ['Probabilidade', o?.probabilidade != null ? `${o.probabilidade}%` : ''], ['Previsão de fechamento', fmt.dia(o?.previsaoFechamento)], ['Origem', o?.origem], ['Criada em', fmt.dia(o?.createdAt)]] }], observacoes: o?.descricao ?? o?.observacoes ?? '' });
}

/** Pedidos de venda do filtro (aba) atual. `status` traduz o código do status. */
export function listaPedidos(itens: any[], grupo: string, status: Record<string, string> = {}): Documento {
  return htmlTabela({ titulo: 'Pedidos de venda', filtros: [`Filtro: ${grupo}`], linhas: itens, total: `Total ${fmt.brl(itens.reduce((a, p) => a + (p.totalCents ?? 0), 0))}`,
    colunas: [{ titulo: 'Nº', valor: (p) => p.numero }, { titulo: 'Cliente', valor: (p) => nomeParceiro(p.parceiro) }, { titulo: 'Status', valor: (p) => `${status[p.statusOperacional] ?? p.statusOperacional ?? ''}${p.balcao ? ' · balcão' : ''}` },
      { titulo: 'Criado em', valor: (p) => fmt.dataHora(p.createdAt) }, { titulo: 'Total', valor: (p) => fmt.brl(p.totalCents), dir: true }] });
}

/** Resultado de "Localizar pedido". */
export function listaLocalizar(d: any, q: string, status: Record<string, string> = {}): Documento {
  return htmlTabela({ titulo: 'Localizar pedido', filtros: [`Busca: “${q}”`], linhas: (d?.pedidos ?? []) as any[],
    colunas: [{ titulo: 'Nº', valor: (p) => p.numero }, { titulo: 'Cliente', valor: (p) => p.cliente }, { titulo: 'Status', valor: (p) => status[p.status] ?? p.status }, { titulo: 'Data', valor: (p) => fmt.dia(p.createdAt) },
      { titulo: 'Nota', valor: (p) => p.nf }, { titulo: 'Encontrado por', valor: (p) => (p.motivos ?? []).join('; ') }, { titulo: 'Total', valor: (p) => fmt.brl(p.totalCents), dir: true }] });
}

/** Histórico de caixas (período/situação da tela). */
export function listaCaixas(itens: any[], f: { de: string; ate: string; status: string }): Documento {
  return htmlTabela({ titulo: 'Caixas', filtros: [`Período: ${fmt.dia(f.de)} a ${fmt.dia(f.ate)}`, f.status === 'ABERTO' ? 'Abertos' : f.status === 'FECHADO' ? 'Fechados' : 'Todos'], linhas: itens,
    colunas: [{ titulo: 'Caixa', valor: (s) => `${s.contaNome ?? ''}${s.status === 'ABERTO' ? ' (aberto)' : ''}` }, { titulo: 'Abertura', valor: (s) => `${fmt.dataHora(s.abertoEm)} ${s.abertoPor?.nome ?? ''}`.trim() },
      { titulo: 'Fechamento', valor: (s) => (s.fechadoEm ? `${fmt.dataHora(s.fechadoEm)} ${s.fechadoPor?.nome ?? ''}`.trim() : '') }, { titulo: 'Na abertura', valor: (s) => fmt.brl(s.valorAberturaCents), dir: true },
      { titulo: 'Vendido', valor: (s) => fmt.brl(s.resumo?.totalVendasCents), dir: true }, { titulo: 'Esperado', valor: (s) => fmt.brl(s.resumo?.esperadoDinheiroCents), dir: true },
      { titulo: 'Contado', valor: (s) => (s.valorContadoCents == null ? '' : fmt.brl(s.valorContadoCents)), dir: true }, { titulo: 'Diferença', valor: (s) => (s.diferencaCents == null ? '' : fmt.brl(s.diferencaCents)), dir: true }] });
}

/** BI do período: indicadores e as tabelas da tela (ABC, clientes, estoque, vencimentos, fornecedores). */
export function relatorioBi(d: any, f: { de: string; ate: string }): Documento {
  const pct = (bp: unknown) => fmt.pct(bp ?? 0);
  const v = d?.vendas ?? {}; const e = d?.estoque ?? {}; const fi = d?.financeiro ?? {}; const c = d?.compras ?? {}; const pr = d?.producao ?? {}; const crm = d?.crm ?? {};
  const kpis: [string, string][] = [
    ['Receita', `${fmt.brl(v.receitaCents ?? 0)} · ${v.pedidos ?? 0} pedidos · ticket ${fmt.brl(v.ticketMedioCents ?? 0)}`], ['Margem bruta', `${pct(v.margemBrutaBp)} · ${fmt.brl(v.margemBrutaCents ?? 0)} · CMV ${fmt.brl(v.cmvCents ?? 0)}`],
    ['Estoque', `${fmt.brl(e.valorCents ?? 0)}${e.coberturaDias != null ? ` · cobertura ${e.coberturaDias} dias` : ''}`], ['Inadimplência', `${pct(fi.inadimplenciaBp)} · vencido ${fmt.brl(fi.receberVencidoCents ?? 0)} de ${fmt.brl(fi.receberAbertoCents ?? 0)}`],
    ['A pagar em 7 dias', fmt.brl(fi.pagarProximos7DiasCents ?? 0)], ['Compras', `${fmt.brl(c.totalCents ?? 0)} · ${c.pedidos ?? 0} pedidos`],
    ['Produção', `${pr.opsEncerradas ?? 0} OPs encerradas · refugo ${pct(pr.refugoBp)} · ${pr.opsAbertas ?? 0} abertas`], ['CRM', `${fmt.brl(crm.pipelineCents ?? 0)} · ${crm.abertas ?? 0} abertas · conversão ${pct(crm.conversaoBp)}`],
  ];
  const par = (x: [string, string]) => x;
  return htmlTabela({ titulo: 'BI · resumo do período', filtros: [`Período: ${fmt.dia(f.de)} a ${fmt.dia(f.ate)}`], linhas: kpis, colunas: [{ titulo: 'Indicador', valor: (x) => par(x)[0] }, { titulo: 'Valor', valor: (x) => par(x)[1] }],
    extras: [
      { titulo: 'Curva ABC (15 primeiros)', linhas: (v.curvaAbc ?? []).slice(0, 15), colunas: [{ titulo: 'Produto', valor: (x: any) => `${x.sku} · ${x.nome}` }, { titulo: 'Classe', valor: (x: any) => x.classe }, { titulo: 'Venda', valor: (x: any) => fmt.brl(x.valorCents), dir: true }, { titulo: 'Margem', valor: (x: any) => fmt.brl(x.margemCents), dir: true }, { titulo: 'Acum.', valor: (x: any) => `${Math.round((x.acumulado ?? 0) * 100)}%`, dir: true }] },
      { titulo: 'Maiores clientes', linhas: v.topClientes ?? [], colunas: [{ titulo: 'Cliente', valor: (x: any) => x.nome }, { titulo: 'Valor', valor: (x: any) => fmt.brl(x.valorCents), dir: true }, { titulo: 'Participação', valor: (x: any) => pct(x.participacaoBp), dir: true }] },
      { titulo: 'Abaixo do mínimo', linhas: e.abaixoMinimo ?? [], colunas: [{ titulo: 'Produto', valor: (x: any) => `${x.sku} · ${x.nome}` }, { titulo: 'Saldo', valor: (x: any) => fmt.qtd(x.saldoMil), dir: true }, { titulo: 'Mínimo', valor: (x: any) => fmt.qtd(x.minimoMil), dir: true }] },
      { titulo: 'Vencendo em 30 dias', linhas: e.vencendo30Dias ?? [], colunas: [{ titulo: 'Produto · lote', valor: (x: any) => `${x.sku} · lote ${x.lote}` }, { titulo: 'Validade', valor: (x: any) => (x.validade ? new Date(x.validade).toLocaleDateString('pt-BR', { timeZone: 'UTC' }) : '') }, { titulo: 'Qtd', valor: (x: any) => fmt.qtd(x.qtdMil), dir: true }] },
      { titulo: 'Maiores fornecedores', linhas: c.topFornecedores ?? [], colunas: [{ titulo: 'Fornecedor', valor: (x: any) => x.nome }, { titulo: 'Valor', valor: (x: any) => fmt.brl(x.valorCents), dir: true }] },
    ] });
}
