/**
 * Alerta diário do MCK ERP (v1.30.0) — contas e texto, sem banco (testável). `dados.ts` junta os números;
 * aqui viram o texto do WhatsApp: cabeçalho com a empresa e a data, seções numeradas, totais, "Ações sugeridas"
 * e divisão em mais de uma mensagem quando fica longo.
 */
import { qtdUn, nomeUnidade } from '../shared/unidade.js';
import { calcularCompra, saidaMediaTexto } from '../compras/sugestao.js';
import { linhaCompra, qtdComEmbalagem, temEmbalagem, fatorDe, precoPorEmbalagem, unidadeCompraDe } from '../shared/embalagem.js';
export { qtdUn, nomeUnidade, unidadeLegivel } from '../shared/unidade.js';

export const brl = (c: number) => (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }).replace(/\u00a0/g, ' ');
export const qtd = (mil: number) => (mil / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 3 });
export const ddmm = (d: Date) => d.toLocaleDateString('pt-BR', { timeZone: 'UTC', day: '2-digit', month: '2-digit' });
const plural = (n: number, um: string, varios: string) => `${n} ${n === 1 ? um : varios}`;

/** Máximo de itens listados por seção (o resto vira "… e mais N"). */
export const MAX_LINHAS = 15;
/** Tamanho máximo de cada mensagem (o WhatsApp aceita 4096; folga para o cabeçalho de "parte 2/3"). */
export const LIMITE_MENSAGEM = 3500;

// ---------------- Sugestão de compra ----------------
export interface EntradaSugestao {
  saldoMil: number; minimoMil: number; consumoMil: number; consumoDias: number; coberturaDias: number;
  leadTimeDias?: number; loteMinimoMil?: number;
}
export interface Sugestao { faltaMil: number; consumoDiaMil: number; duraDias: number | null; sugeridaMil: number }

/**
 * Quanto comprar (v1.32.0: mesma regra da tela Compras › O que comprar, em compras/sugestao.ts): saída média por dia ×
 * dias de cobertura (+ prazo do fornecedor) − o que tem hoje; nunca menos que o necessário para voltar ao mínimo;
 * respeita o lote mínimo e arredonda para cima. Mantida com a assinatura antiga para quem já usava.
 */
export function sugestaoCompra(e: EntradaSugestao): Sugestao {
  const r = calcularCompra({ saldoMil: e.saldoMil, minimoMil: e.minimoMil, consumoMil: e.consumoMil, janelaDias: e.consumoDias, coberturaDias: e.coberturaDias, leadTimeDias: e.leadTimeDias, loteMinimoMil: e.loteMinimoMil });
  return { faltaMil: r.faltaMinimoMil, consumoDiaMil: r.consumoDiaMil, duraDias: r.duraDias, sugeridaMil: r.sugeridaMil };
}

// ---------------- Dados do alerta ----------------
export interface ContaPagar { quem: string; descricao: string; abertoCents: number; vencimento: Date; empresa: boolean }
export interface ItemEstoqueBaixo {
  produtoId: string; sku: string; nome: string; unidade: string;
  saldoMil: number; minimoMil: number; sugestao: Sugestao; consumoDias: number; coberturaDias: number;
  fornecedorId: string | null; fornecedorNome: string | null; custoUnitCents: number; custoOrigem: 'compra' | 'entrada' | 'medio' | null;
  leadTimeDias?: number; loteMinimoMil?: number;
  /** v1.32.0: embalagem de compra (pacote com 10 peças...), o porquê da sugestão e o que já foi pedido. */
  unidadeCompra?: string | null; fatorCompraMil?: number | null; motivo?: string; aCaminhoMil?: number; base?: '30d' | '90d' | 'minimo';
}
export interface ItemParado { sku: string; nome: string; unidade: string; saldoMil: number; diasParado: number | null; ultimaSaida: Date | null; valorCents: number }
export interface LoteValidade { sku: string; nome: string; unidade: string; lote: string; loteFabricante?: string | null; validade: Date; dias: number; saldoMil: number; valorCents: number }
export interface MovCaixa { tipo: string; valorCents: number; motivo: string; quem: string; hora: string }
export interface SessaoCaixa {
  conta: string; status: string; abertoPor: string; abertoEm: string; aberturaCents: number;
  porForma: Record<string, { qtd: number; valorCents: number }>; totalVendasCents: number; qtdVendas: number;
  sangriasCents: number; suprimentosCents: number; movimentos: MovCaixa[];
  fechadoPor: string | null; fechadoEm: string | null; contadoCents: number | null; esperadoCents: number | null; diferencaCents: number | null; observacao: string | null;
}
export interface Alteracao { hora: string; dia: string; quem: string; acao: string; item: string; detalhe: string; tipo: 'preco' | 'custo' | 'estoque' | 'outro' }

export interface DadosAlerta {
  empresa: string; hojeIso: string; ontemIso: string;
  pagar: ContaPagar[] | null;
  estoqueBaixo: ItemEstoqueBaixo[] | null;
  parados: { dias: number; itens: ItemParado[] } | null;
  validade: { dias: number; lotes: LoteValidade[] } | null;
  caixa: SessaoCaixa[] | null;
  alteracoes: Alteracao[] | null;
}

const FORMA: Record<string, string> = { DINHEIRO: 'Dinheiro', PIX: 'Pix', CARTAO: 'Cartão', CARTAO_CREDITO: 'Cartão de crédito', CARTAO_DEBITO: 'Cartão de débito', BOLETO: 'Boleto', TRANSFERENCIA: 'Transferência' };
const nomeForma = (f: string) => FORMA[f] ?? (f.charAt(0) + f.slice(1).toLowerCase()).replace(/_/g, ' ');
const diaSemana = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('pt-BR', { timeZone: 'UTC', weekday: 'long' });
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
/** "20 de novembro" (sem números lado a lado). */
const dataExtenso = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('pt-BR', { timeZone: 'UTC', day: 'numeric', month: 'long' });

/** Valor estimado de um item sugerido (quantidade × último custo; com embalagem, embalagens × preço da embalagem). */
export const estimadoItem = (i: Pick<ItemEstoqueBaixo, 'sugestao' | 'custoUnitCents'> & { unidade?: string; unidadeCompra?: string | null; fatorCompraMil?: number | null }) =>
  linhaCompra(i.sugestao.sugeridaMil, i.custoUnitCents, { unidade: i.unidade, unidadeCompra: i.unidadeCompra, fatorCompraMil: i.fatorCompraMil }).totalCents;

export const temConteudo = (d: DadosAlerta) =>
  !!(d.pagar?.length || d.estoqueBaixo?.length || d.parados?.itens.length || d.validade?.lotes.length || d.caixa?.length || d.alteracoes?.length);

export const qtdItens = (d: DadosAlerta) =>
  (d.pagar?.length ?? 0) + (d.estoqueBaixo?.length ?? 0) + (d.parados?.itens.length ?? 0) + (d.validade?.lotes.length ?? 0) + (d.caixa?.length ?? 0) + (d.alteracoes?.length ?? 0);

function resto(n: number) { return n > MAX_LINHAS ? [`… e mais ${n - MAX_LINHAS}`] : []; }

// ---------------- Seções ----------------
// v1.31.0: uma informação por linha, rótulos claros, unidade sempre por extenso junto do número ("15 unidades") e
// valores em negrito. Nada de dois números separados só por espaço ("5 30"): o WhatsApp sublinha como telefone.

const DIA_MS = 86_400_000;
const linhaCodigo = (nome: string, sku: string) => `*${nome}*${sku ? ` (cód. ${sku})` : ''}`;
const ORIGEM_CUSTO: Record<string, string> = { compra: 'último pedido de compra', entrada: 'última entrada no estoque', medio: 'custo do cadastro' };

function secaoPagar(contas: ContaPagar[], hoje: Date): string[] {
  const situacao = (t: ContaPagar) => (t.vencimento < hoje ? `🔴 venceu em ${ddmm(t.vencimento)}` : t.vencimento.getTime() < hoje.getTime() + DIA_MS ? '🟠 vence hoje' : `vence em ${ddmm(t.vencimento)}`);
  const linha = (t: ContaPagar) => `• *${t.quem}* — ${t.descricao}\n   Valor: *${brl(t.abertoCents)}* · ${situacao(t)}`;
  const total = (l: ContaPagar[]) => brl(l.reduce((s, t) => s + t.abertoCents, 0));
  const forn = contas.filter((t) => !t.empresa);
  const emp = contas.filter((t) => t.empresa);
  const L: string[] = [];
  const vencidas = contas.filter((t) => t.vencimento < hoje);
  L.push(`Total a pagar: *${total(contas)}*`);
  if (vencidas.length) L.push(`Já vencidas: ${plural(vencidas.length, 'conta', 'contas')}, *${total(vencidas)}*`);
  if (forn.length) L.push('', `_Fornecedores: ${plural(forn.length, 'conta', 'contas')}, ${total(forn)}_`, ...forn.slice(0, MAX_LINHAS).map(linha), ...resto(forn.length));
  if (emp.length) L.push('', `_Contas da empresa (água, luz...): ${plural(emp.length, 'conta', 'contas')}, ${total(emp)}_`, ...emp.slice(0, MAX_LINHAS).map(linha), ...resto(emp.length));
  return L;
}

/** Por que comprar essa quantidade, em uma frase simples. */
export function motivoQuantidade(i: Pick<ItemEstoqueBaixo, 'sugestao' | 'coberturaDias' | 'minimoMil' | 'saldoMil'> & { loteMinimoMil?: number; leadTimeDias?: number }): string {
  const s = i.sugestao;
  const falta = Math.ceil(s.faltaMil / 1000) * 1000;
  if (s.consumoDiaMil > 0) {
    const dias = i.coberturaDias + Math.max(0, i.leadTimeDias ?? 0);
    if (Math.ceil(s.consumoDiaMil * dias) >= s.faltaMil) return `para ficar com estoque para ${plural(dias, 'dia', 'dias')} de vendas`;
  }
  if (s.sugeridaMil > falta && (i.loteMinimoMil ?? 0) > 0) return 'é o lote mínimo de compra deste produto';
  if (s.sugeridaMil > falta && s.consumoDiaMil <= 0) return 'é o lote mínimo de compra deste produto';
  return 'para voltar ao estoque mínimo';
}

function secaoEstoque(itens: ItemEstoqueBaixo[], codigo: string | null | undefined, previa: boolean): string[] {
  const L: string[] = [];
  const lista = itens.slice(0, MAX_LINHAS);
  const totalEst = lista.reduce((a, i) => a + estimadoItem(i), 0);
  const zerados = itens.filter((i) => i.saldoMil <= 0).length;
  L.push(`${plural(itens.length, 'produto para comprar', 'produtos para comprar')} (abaixo do estoque mínimo${zerados ? `; ${zerados} sem nenhuma unidade` : ''}).`);
  if (totalEst) L.push(`Total da compra sugerida: *${brl(totalEst)}*`);
  lista.forEach((i, n) => {
    const s = i.sugestao; const u = i.unidade;
    const emb = { unidade: u, unidadeCompra: i.unidadeCompra, fatorCompraMil: i.fatorCompraMil };
    L.push('', `*${n + 1}) ${i.nome}*${i.sku ? ` (cód. ${i.sku})` : ''}${i.saldoMil <= 0 ? ' ⚠️ acabou' : ''}`);
    L.push(`📦 Tem hoje: ${qtdUn(Math.max(0, i.saldoMil), u)}`);
    L.push(`🎯 Estoque mínimo: ${qtdUn(i.minimoMil, u)}`);
    if (s.consumoDiaMil > 0) {
      L.push(`📉 Vende em média ${saidaMediaTexto(s.consumoDiaMil, u).replace(/^~/, '')}${s.duraDias !== null ? ` · ${i.saldoMil <= 0 ? 'já acabou' : s.duraDias <= 0 ? 'acaba hoje' : `dura uns ${plural(s.duraDias, 'dia', 'dias')}`}` : ''}`);
    } else L.push(`📉 Nenhuma venda nos últimos ${i.base ? 90 : i.consumoDias} dias`);
    L.push(`🛒 *Comprar: ${qtdComEmbalagem(s.sugeridaMil, emb)}*`);
    L.push(`   _(${i.motivo ?? motivoQuantidade(i)})_`);
    if (i.aCaminhoMil && i.aCaminhoMil > 0) L.push(`🚚 Já pedido e ainda não chegou: ${qtdUn(i.aCaminhoMil, u)}`);
    const est = estimadoItem(i);
    if (i.custoUnitCents > 0) {
      if (temEmbalagem(emb)) L.push(`💲 Preço: *${brl(precoPorEmbalagem(i.custoUnitCents, fatorDe(emb)))}* por ${nomeUnidade(unidadeCompraDe(emb), 1)} · ${brl(i.custoUnitCents)} por ${nomeUnidade(u, 1)}${i.custoOrigem ? ` (${ORIGEM_CUSTO[i.custoOrigem]})` : ''}`);
      else L.push(`💲 Preço por ${nomeUnidade(u, 1)}: *${brl(i.custoUnitCents)}*${i.custoOrigem ? ` (${ORIGEM_CUSTO[i.custoOrigem]})` : ''}`);
      if (est) L.push(`💰 *Total da compra: ${brl(est)}*`);
    } else L.push('💲 Preço: sem custo cadastrado (informe no pedido de compra)');
    L.push(`🏭 Fornecedor: ${i.fornecedorNome ?? 'não cadastrado'}`);
  });
  L.push(...resto(itens.length));
  if (codigo || previa) {
    const cod = codigo ? `*${codigo}*` : '(gerado no envio)';
    const n = lista.length;
    const ex = n >= 3 ? '1,3' : '1';
    L.push('', n === 1
      ? `👉 *Quer comprar?* Responda *APROVADO* e eu monto o pedido de compra do item acima.`
      : `👉 *Quer comprar?* Responda *APROVADO* para todos os itens acima, ou *APROVADO ${ex}* para só ${n >= 3 ? 'os itens 1 e 3' : 'o item 1'}.`,
      `Código da aprovação: ${cod} (vale por 48 horas).`,
      '_O pedido fica como rascunho no ERP. Nada é enviado ao fornecedor sem você._');
  }
  return L;
}

function secaoParados(p: { dias: number; itens: ItemParado[] }): string[] {
  const total = p.itens.reduce((a, i) => a + i.valorCents, 0);
  const L = [
    `${plural(p.itens.length, 'produto tem', 'produtos têm')} estoque e não vende${p.itens.length === 1 ? '' : 'm'} há ${p.dias} dias ou mais.`,
  ];
  if (p.itens.length > 1) L.push(`Dinheiro parado no estoque (preço de custo): *${brl(total)}*`);
  for (const i of p.itens.slice(0, MAX_LINHAS)) {
    const quando = i.ultimaSaida ? `Última venda/saída em ${ddmm(i.ultimaSaida)} (há ${plural(i.diasParado ?? 0, 'dia', 'dias')})` : 'Nunca teve venda/saída';
    L.push('', `• ${linhaCodigo(i.nome, i.sku)}`, `   Tem ${qtdUn(i.saldoMil, i.unidade)} · parado: *${brl(i.valorCents)}*`, `   ${quando}`);
  }
  L.push(...resto(p.itens.length));
  return L;
}

/** "Lote interno L2611-0001 · Lote fabricante ABC123" (só o que existir). */
export function textoLotes(l: { lote: string; loteFabricante?: string | null }): string {
  const partes = [l.lote ? `Lote interno ${l.lote}` : '', l.loteFabricante && l.loteFabricante !== l.lote ? `Lote fabricante ${l.loteFabricante}` : ''].filter(Boolean);
  return partes.join(' · ');
}

function secaoValidade(v: { dias: number; lotes: LoteValidade[] }): string[] {
  const vencidos = v.lotes.filter((l) => l.dias < 0);
  const vencendo = v.lotes.filter((l) => l.dias >= 0);
  const soma = (l: LoteValidade[]) => brl(l.reduce((a, x) => a + x.valorCents, 0));
  const linha = (l: LoteValidade) => {
    const quando = l.dias < 0 ? `🔴 Venceu em ${ddmm(l.validade)} (há ${plural(-l.dias, 'dia', 'dias')})` : l.dias === 0 ? '🟠 Vence hoje' : `🟡 Vence em ${ddmm(l.validade)} (daqui a ${plural(l.dias, 'dia', 'dias')})`;
    const lotes = textoLotes(l);
    return [`• ${linhaCodigo(l.nome, l.sku)}`, ...(lotes ? [`   ${lotes}`] : []), `   ${quando}`, `   Tem ${qtdUn(l.saldoMil, l.unidade)} · custo *${brl(l.valorCents)}*`].join('\n');
  };
  const L: string[] = [];
  if (vencidos.length) L.push(`_Já vencidos e ainda no estoque: ${plural(vencidos.length, 'lote', 'lotes')}, ${soma(vencidos)} a preço de custo_`, ...vencidos.slice(0, MAX_LINHAS).map(linha), ...resto(vencidos.length));
  if (vencendo.length) { if (L.length) L.push(''); L.push(`_Vencem nos próximos ${v.dias} dias: ${plural(vencendo.length, 'lote', 'lotes')}, ${soma(vencendo)} a preço de custo_`, ...vencendo.slice(0, MAX_LINHAS).map(linha), ...resto(vencendo.length)); }
  return L;
}

function secaoCaixa(sessoes: SessaoCaixa[]): string[] {
  const L: string[] = [];
  sessoes.forEach((s, n) => {
    if (n) L.push('');
    L.push(`*${s.conta}* — ${s.status === 'ABERTO' ? '🟢 ainda está aberto' : 'fechado'}`);
    L.push(`   Aberto em ${s.abertoEm} por ${s.abertoPor}`);
    L.push(`   Troco inicial: ${brl(s.aberturaCents)}`);
    const formas = Object.entries(s.porForma).filter(([, v]) => v.qtd > 0 || v.valorCents > 0);
    L.push(`   Vendas: *${brl(s.totalVendasCents)}* em ${plural(s.qtdVendas, 'recebimento', 'recebimentos')}`);
    for (const [f, v] of formas) L.push(`      ${nomeForma(f)}: ${brl(v.valorCents)} (${plural(v.qtd, 'venda', 'vendas')})`);
    if (s.sangriasCents) L.push(`   Dinheiro retirado do caixa (sangria): ${brl(s.sangriasCents)}`);
    if (s.suprimentosCents) L.push(`   Dinheiro colocado no caixa (reforço): ${brl(s.suprimentosCents)}`);
    for (const m of s.movimentos.slice(0, 8)) L.push(`      ${m.tipo === 'SANGRIA' ? '↘️ Retirada' : '↗️ Reforço'} de ${brl(m.valorCents)} em ${m.hora} por ${m.quem} — ${m.motivo}`);
    if (s.status !== 'ABERTO' && s.contadoCents !== null) {
      const d = s.diferencaCents ?? 0;
      L.push(`   Fechado em ${s.fechadoEm ?? '—'} por ${s.fechadoPor ?? '—'}`);
      L.push(`   Dinheiro contado: ${brl(s.contadoCents)} · deveria ter: ${brl(s.esperadoCents ?? 0)}`);
      L.push(`   ${d === 0 ? '✅ Conferido, sem diferença' : d < 0 ? `🔴 *Faltaram ${brl(-d)}* (quebra de caixa)` : `🟡 *Sobraram ${brl(d)}*`}`);
      if (d !== 0 && s.observacao) L.push(`   Justificativa: ${s.observacao}`);
    }
  });
  return L;
}

function secaoAlteracoes(a: Alteracao[]): string[] {
  const L = [`${plural(a.length, 'alteração feita', 'alterações feitas')} à mão:`];
  for (const x of a.slice(0, 20)) L.push(`• Às ${x.hora}, ${x.quem || 'o sistema'}: ${x.acao.charAt(0).toLowerCase()}${x.acao.slice(1)}${x.item ? ` — ${x.item}` : ''}${x.detalhe ? `\n   ${x.detalhe}` : ''}`);
  if (a.length > 20) L.push(`… e mais ${a.length - 20} (veja ERP › Relatórios)`);
  return L;
}

/** Ações sugeridas a partir dos números do dia (frases curtas, uma por linha). */
export function acoesSugeridas(d: DadosAlerta, codigo?: string | null): string[] {
  const A: string[] = [];
  const hoje = new Date(`${d.hojeIso}T00:00:00Z`);
  if (d.pagar?.length) {
    const venc = d.pagar.filter((t) => t.vencimento < hoje);
    const hj = d.pagar.filter((t) => t.vencimento >= hoje && t.vencimento.getTime() < hoje.getTime() + DIA_MS);
    if (venc.length) A.push(`Pagar ou renegociar ${plural(venc.length, 'conta vencida', 'contas vencidas')}: *${brl(venc.reduce((a, t) => a + t.abertoCents, 0))}*.`);
    if (hj.length) A.push(`Separar *${brl(hj.reduce((a, t) => a + t.abertoCents, 0))}* para ${plural(hj.length, 'conta que vence', 'contas que vencem')} hoje.`);
  }
  if (d.estoqueBaixo?.length) {
    const n = Math.min(d.estoqueBaixo.length, MAX_LINHAS);
    const est = d.estoqueBaixo.slice(0, MAX_LINHAS).reduce((a, i) => a + estimadoItem(i), 0);
    const zer = d.estoqueBaixo.filter((i) => i.saldoMil <= 0).length;
    if (zer) A.push(`Urgente: ${plural(zer, 'produto já acabou', 'produtos já acabaram')}.`);
    A.push(codigo
      ? `Comprar ${plural(n, 'item', 'itens')}: responda *APROVADO*.`
      : `Fazer o pedido de compra de ${plural(n, 'item', 'itens')}${est ? ` (total *${brl(est)}*)` : ''} em ERP › Compras.`);
  }
  if (d.validade?.lotes.length) {
    const venc = d.validade.lotes.filter((l) => l.dias < 0);
    const logo = d.validade.lotes.filter((l) => l.dias >= 0 && l.dias <= 7);
    if (venc.length) A.push(`Tirar da venda ${plural(venc.length, 'lote vencido', 'lotes vencidos')} (custo *${brl(venc.reduce((a, l) => a + l.valorCents, 0))}*) e lançar a perda.`);
    if (logo.length) A.push(`Vender primeiro ou fazer promoção de ${plural(logo.length, 'lote que vence', 'lotes que vencem')} em até 7 dias.`);
  }
  if (d.parados?.itens.length) A.push(`Fazer promoção, combo ou devolução ${d.parados.itens.length === 1 ? 'do produto parado' : 'dos produtos parados'}.`);
  for (const s of d.caixa ?? []) {
    if (s.status !== 'ABERTO' && s.diferencaCents) A.push(`Conferir a ${s.diferencaCents < 0 ? 'falta' : 'sobra'} de *${brl(Math.abs(s.diferencaCents))}* no ${s.conta} (fechado por ${s.fechadoPor ?? '—'}).`);
    if (s.status === 'ABERTO') A.push(`Fechar e conferir o ${s.conta}, aberto desde ${s.abertoEm}.`);
  }
  const precos = (d.alteracoes ?? []).filter((a) => a.tipo === 'preco' || a.tipo === 'custo').length;
  const est = (d.alteracoes ?? []).filter((a) => a.tipo === 'estoque').length;
  if (precos) A.push(`Revisar ${plural(precos, 'mudança de preço ou custo feita', 'mudanças de preço ou custo feitas')} ontem.`);
  if (est) A.push(`Confirmar ${plural(est, 'ajuste manual', 'ajustes manuais')} de estoque de ontem.`);
  return A;
}

/** Junta tudo em blocos (seções) já numerados. O 1º bloco é o cabeçalho. */
export function blocosAlerta(d0: DadosAlerta, opts: { codigo?: string | null; previa?: boolean } = {}): string[] {
  // Produto que já está em "o que comprar" não se repete em "parados" (evita o mesmo item duas vezes no alerta).
  const comprar = new Set((d0.estoqueBaixo ?? []).map((i) => i.sku || i.nome));
  const paradosItens = d0.parados?.itens.filter((i) => !comprar.has(i.sku || i.nome)) ?? [];
  const d: DadosAlerta = { ...d0, parados: d0.parados && paradosItens.length ? { ...d0.parados, itens: paradosItens } : null };
  const hoje = new Date(`${d.hojeIso}T00:00:00Z`);
  const ontem = dataExtenso(d.ontemIso);
  const secoes: { titulo: string; linhas: string[] }[] = [];
  if (d.pagar?.length) secoes.push({ titulo: '💰 Contas a pagar', linhas: secaoPagar(d.pagar, hoje) });
  if (d.estoqueBaixo?.length) secoes.push({ titulo: '📦 Estoque baixo: o que comprar', linhas: secaoEstoque(d.estoqueBaixo, opts.codigo, !!opts.previa) });
  if (d.validade?.lotes.length) secoes.push({ titulo: '⏳ Validade dos lotes', linhas: secaoValidade(d.validade) });
  if (d.parados?.itens.length) secoes.push({ titulo: '💤 Produtos parados', linhas: secaoParados(d.parados) });
  if (d.caixa?.length) secoes.push({ titulo: `🧾 Caixa de ontem (${ontem})`, linhas: secaoCaixa(d.caixa) });
  if (d.alteracoes?.length) secoes.push({ titulo: `✏️ Alterações de ontem (${ontem})`, linhas: secaoAlteracoes(d.alteracoes) });

  const quebra = (d.caixa ?? []).reduce((a, s) => a + Math.min(0, s.diferencaCents ?? 0), 0);

  const cab = [
    `🏢 *${d.empresa || 'Sua empresa'}*`,
    `📋 *Alerta diário do MCK ERP*`,
    `${cap(diaSemana(d.hojeIso))}, ${dataExtenso(d.hojeIso)}`,
    ...(quebra ? ['', `🔴 Falta no caixa de ${brl(-quebra)}.`] : []),
  ].join('\n');
  const blocos = [cab, ...secoes.map((s, i) => [`*${i + 1}. ${s.titulo}*`, ...s.linhas].join('\n'))];
  const acoes = acoesSugeridas(d, opts.codigo || (opts.previa ? 'previa' : null));
  if (acoes.length) blocos.push(['*✅ O que fazer hoje*', ...acoes.map((a) => `• ${a}`)].join('\n'));
  blocos.push('_MCK ERP · para mudar o que chega aqui: ERP › Configurações › Alertas por WhatsApp_');
  return blocos;
}

/**
 * Trechos que o WhatsApp costuma sublinhar como telefone (número longo ou números separados só por espaço/traço,
 * fora de valores em R$ e de códigos que começam por letra). Usado nos testes para o texto do alerta não confundir.
 */
export function trechosParecemTelefone(texto: string): string[] {
  const out: string[] = [];
  const re = /(?<![\w$,.])\d+(?:[ \-]+\d+)+(?![\w,])/g;
  for (const linha of texto.split('\n')) {
    const limpa = linha.replace(/R\$ ?[\d.]+,\d{2}/g, 'R$');
    for (const m of limpa.matchAll(re)) {
      const digitos = m[0].replace(/\D/g, '');
      if (/\d[ \-]+\d/.test(m[0]) || digitos.length >= 7) out.push(m[0]);
    }
  }
  return out;
}

/**
 * Divide os blocos em mensagens de até `limite` caracteres, sem cortar no meio de uma seção quando possível.
 * Da 2ª mensagem em diante entra "(parte 2/3)" para a leitura não se perder.
 */
export function dividirMensagens(blocos: string[], limite = LIMITE_MENSAGEM): string[] {
  const pedacos: string[] = [];
  for (const b of blocos) {
    if (b.length <= limite) { pedacos.push(b); continue; }
    let atual = '';
    for (const l of b.split('\n')) {
      const linha = l.length > limite ? l.slice(0, limite - 1) + '…' : l;
      if (atual && atual.length + 1 + linha.length > limite) { pedacos.push(atual); atual = linha; } else atual = atual ? `${atual}\n${linha}` : linha;
    }
    if (atual) pedacos.push(atual);
  }
  const msgs: string[] = [];
  let atual = '';
  for (const p of pedacos) {
    if (atual && atual.length + 2 + p.length > limite) { msgs.push(atual); atual = p; } else atual = atual ? `${atual}\n\n${p}` : p;
  }
  if (atual) msgs.push(atual);
  if (msgs.length <= 1) return msgs;
  return msgs.map((m, i) => (i === 0 ? m : `_(parte ${i + 1}/${msgs.length})_\n${m}`));
}

export function formatarAlerta(d: DadosAlerta, opts: { codigo?: string | null; previa?: boolean; limite?: number } = {}): string[] {
  return dividirMensagens(blocosAlerta(d, opts), opts.limite);
}
