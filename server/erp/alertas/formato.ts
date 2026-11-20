/**
 * Alerta diário do MCK ERP (v1.30.0) — contas e texto, sem banco (testável). `dados.ts` junta os números;
 * aqui viram o texto do WhatsApp: cabeçalho com a empresa e a data, seções numeradas, totais, "Ações sugeridas"
 * e divisão em mais de uma mensagem quando fica longo.
 */

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
 * Quanto comprar: o que falta para o mínimo ou, com consumo, o suficiente para cobrir `coberturaDias` (+ prazo do
 * fornecedor) e ainda ficar no mínimo. Respeita o lote mínimo de compra e arredonda para unidade inteira.
 */
export function sugestaoCompra(e: EntradaSugestao): Sugestao {
  const saldo = Math.max(0, e.saldoMil);
  const faltaMil = Math.max(0, e.minimoMil - saldo);
  const consumoDiaMil = e.consumoDias > 0 ? Math.max(0, e.consumoMil) / e.consumoDias : 0;
  const duraDias = consumoDiaMil > 0 ? Math.floor(saldo / consumoDiaMil) : null;
  const alvo = e.minimoMil + Math.ceil(consumoDiaMil * (e.coberturaDias + Math.max(0, e.leadTimeDias ?? 0)));
  let sug = Math.max(faltaMil, alvo - saldo);
  if (e.loteMinimoMil && e.loteMinimoMil > 0) sug = Math.max(sug, e.loteMinimoMil);
  sug = Math.ceil(sug / 1000) * 1000; // unidade inteira
  return { faltaMil, consumoDiaMil, duraDias, sugeridaMil: Math.max(sug, 0) };
}

// ---------------- Dados do alerta ----------------
export interface ContaPagar { quem: string; descricao: string; abertoCents: number; vencimento: Date; empresa: boolean }
export interface ItemEstoqueBaixo {
  produtoId: string; sku: string; nome: string; unidade: string;
  saldoMil: number; minimoMil: number; sugestao: Sugestao; consumoDias: number; coberturaDias: number;
  fornecedorId: string | null; fornecedorNome: string | null; custoUnitCents: number; custoOrigem: 'compra' | 'entrada' | 'medio' | null;
}
export interface ItemParado { sku: string; nome: string; unidade: string; saldoMil: number; diasParado: number | null; ultimaSaida: Date | null; valorCents: number }
export interface LoteValidade { sku: string; nome: string; unidade: string; lote: string; validade: Date; dias: number; saldoMil: number; valorCents: number }
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
const dataBr = (iso: string) => iso.split('-').reverse().join('/');
const diaSemana = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('pt-BR', { timeZone: 'UTC', weekday: 'long' });
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Valor estimado de um item sugerido (quantidade × último custo). */
export const estimadoItem = (i: Pick<ItemEstoqueBaixo, 'sugestao' | 'custoUnitCents'>) => Math.round((i.sugestao.sugeridaMil * i.custoUnitCents) / 1000);

export const temConteudo = (d: DadosAlerta) =>
  !!(d.pagar?.length || d.estoqueBaixo?.length || d.parados?.itens.length || d.validade?.lotes.length || d.caixa?.length || d.alteracoes?.length);

export const qtdItens = (d: DadosAlerta) =>
  (d.pagar?.length ?? 0) + (d.estoqueBaixo?.length ?? 0) + (d.parados?.itens.length ?? 0) + (d.validade?.lotes.length ?? 0) + (d.caixa?.length ?? 0) + (d.alteracoes?.length ?? 0);

function resto(n: number) { return n > MAX_LINHAS ? [`… e mais ${n - MAX_LINHAS}`] : []; }

// ---------------- Seções ----------------
function secaoPagar(contas: ContaPagar[], hoje: Date): string[] {
  const DIA = 86_400_000;
  const situacao = (t: ContaPagar) => (t.vencimento < hoje ? `🔴 vencida em ${ddmm(t.vencimento)}` : t.vencimento.getTime() < hoje.getTime() + DIA ? '🟠 vence hoje' : `vence ${ddmm(t.vencimento)}`);
  const linha = (t: ContaPagar) => `• ${t.quem}: ${t.descricao} — *${brl(t.abertoCents)}* (${situacao(t)})`;
  const total = (l: ContaPagar[]) => brl(l.reduce((s, t) => s + t.abertoCents, 0));
  const forn = contas.filter((t) => !t.empresa);
  const emp = contas.filter((t) => t.empresa);
  const L: string[] = [];
  const vencidas = contas.filter((t) => t.vencimento < hoje);
  L.push(`Total em aberto: *${total(contas)}*${vencidas.length ? ` · ${plural(vencidas.length, 'vencida', 'vencidas')} (${total(vencidas)})` : ''}`);
  if (forn.length) L.push('', `_Fornecedores_ (${forn.length}, ${total(forn)})`, ...forn.slice(0, MAX_LINHAS).map(linha), ...resto(forn.length));
  if (emp.length) L.push('', `_Contas da empresa_ (${emp.length}, ${total(emp)})`, ...emp.slice(0, MAX_LINHAS).map(linha), ...resto(emp.length));
  return L;
}

function secaoEstoque(itens: ItemEstoqueBaixo[], codigo: string | null | undefined, previa: boolean): string[] {
  const L: string[] = [];
  const lista = itens.slice(0, MAX_LINHAS);
  const totalEst = lista.reduce((a, i) => a + estimadoItem(i), 0);
  const zerados = itens.filter((i) => i.saldoMil <= 0).length;
  L.push(`${plural(itens.length, 'produto abaixo do mínimo', 'produtos abaixo do mínimo')}${zerados ? ` · ${zerados} sem estoque` : ''}${totalEst ? ` · compra sugerida ≈ *${brl(totalEst)}*` : ''}`);
  lista.forEach((i, n) => {
    const s = i.sugestao; const u = i.unidade;
    L.push('', `*${n + 1})* ${i.sku} · ${i.nome}${i.saldoMil <= 0 ? ' ⚠️ sem estoque' : ''}`);
    L.push(`   Saldo: ${qtd(i.saldoMil)} ${u} · Mínimo: ${qtd(i.minimoMil)} ${u} · Falta: ${qtd(s.faltaMil)} ${u}`);
    L.push(s.consumoDiaMil > 0
      ? `   Consumo médio: ${qtd(Math.round(s.consumoDiaMil))} ${u}/dia (últimos ${i.consumoDias} dias)${s.duraDias !== null ? ` · o saldo dura ~${plural(s.duraDias, 'dia', 'dias')}` : ''}`
      : `   Sem saídas nos últimos ${i.consumoDias} dias`);
    const est = estimadoItem(i);
    L.push(`   ➜ Sugestão: comprar *${qtd(s.sugeridaMil)} ${u}*${s.consumoDiaMil > 0 ? ` (cobre ~${i.coberturaDias} dias)` : ''}`);
    const forn = i.fornecedorNome ? `Fornecedor: ${i.fornecedorNome}` : 'Sem fornecedor cadastrado';
    const custo = i.custoUnitCents > 0 ? ` · ${i.custoOrigem === 'compra' ? 'último custo' : i.custoOrigem === 'entrada' ? 'custo da última entrada' : 'custo médio'} ${brl(i.custoUnitCents)}${est ? ` · estimado ${brl(est)}` : ''}` : '';
    L.push(`   ${forn}${custo}`);
  });
  L.push(...resto(itens.length));
  if (codigo || previa) {
    const cod = codigo ? `*${codigo}*` : '(gerado no envio)';
    const n = lista.length;
    const ex = n >= 3 ? '1,3' : '1';
    L.push('', n === 1
      ? `👉 *Para comprar:* responda *APROVADO* para gerar o pedido de compra do item acima. Código ${cod}, vale por 48 h.`
      : `👉 *Para comprar:* responda *APROVADO* para gerar o pedido de compra dos itens acima, ou *APROVADO ${ex}* para só ${n >= 3 ? 'alguns' : 'o 1º'}. Código ${cod}, vale por 48 h.`,
      '_O pedido fica em rascunho no ERP. Nada é enviado ao fornecedor sem você._');
  }
  return L;
}

function secaoParados(p: { dias: number; itens: ItemParado[] }): string[] {
  const total = p.itens.reduce((a, i) => a + i.valorCents, 0);
  const L = [`${plural(p.itens.length, 'produto', 'produtos')} com saldo e sem venda/saída há ${p.dias} dias ou mais · *${brl(total)}* parado (a custo)`];
  for (const i of p.itens.slice(0, MAX_LINHAS)) {
    const quando = i.ultimaSaida ? `parado há ${plural(i.diasParado ?? 0, 'dia', 'dias')} (última saída ${ddmm(i.ultimaSaida)})` : 'nunca teve saída';
    L.push(`• ${i.sku} · ${i.nome}: ${qtd(i.saldoMil)} ${i.unidade} · ${brl(i.valorCents)} · ${quando}`);
  }
  L.push(...resto(p.itens.length));
  return L;
}

function secaoValidade(v: { dias: number; lotes: LoteValidade[] }): string[] {
  const vencidos = v.lotes.filter((l) => l.dias < 0);
  const vencendo = v.lotes.filter((l) => l.dias >= 0);
  const soma = (l: LoteValidade[]) => brl(l.reduce((a, x) => a + x.valorCents, 0));
  const linha = (l: LoteValidade) => `• ${l.sku} · ${l.nome} — lote ${l.lote}: ${qtd(l.saldoMil)} ${l.unidade} · ${brl(l.valorCents)} · ${l.dias < 0 ? `🔴 venceu ${ddmm(l.validade)} (há ${plural(-l.dias, 'dia', 'dias')})` : l.dias === 0 ? '🟠 vence hoje' : `vence ${ddmm(l.validade)} (em ${plural(l.dias, 'dia', 'dias')})`}`;
  const L: string[] = [];
  if (vencidos.length) L.push(`_Vencidos com saldo_ (${vencidos.length}, ${soma(vencidos)})`, ...vencidos.slice(0, MAX_LINHAS).map(linha), ...resto(vencidos.length));
  if (vencendo.length) { if (L.length) L.push(''); L.push(`_Vencem em até ${v.dias} dias_ (${vencendo.length}, ${soma(vencendo)})`, ...vencendo.slice(0, MAX_LINHAS).map(linha), ...resto(vencendo.length)); }
  return L;
}

function secaoCaixa(sessoes: SessaoCaixa[]): string[] {
  const L: string[] = [];
  sessoes.forEach((s, n) => {
    if (n) L.push('');
    L.push(`*${s.conta}* — ${s.status === 'ABERTO' ? '🟢 ainda aberto' : 'fechado'}`);
    L.push(`   Abertura: ${s.abertoEm} por ${s.abertoPor} · troco inicial ${brl(s.aberturaCents)}`);
    const formas = Object.entries(s.porForma).filter(([, v]) => v.qtd > 0 || v.valorCents > 0);
    L.push(`   Vendas: ${plural(s.qtdVendas, 'recebimento', 'recebimentos')} · *${brl(s.totalVendasCents)}*`);
    for (const [f, v] of formas) L.push(`      ${nomeForma(f)}: ${brl(v.valorCents)} (${v.qtd})`);
    if (s.sangriasCents || s.suprimentosCents) L.push(`   Retiradas (sangrias): ${brl(s.sangriasCents)} · Reforços (suprimentos): ${brl(s.suprimentosCents)}`);
    for (const m of s.movimentos.slice(0, 8)) L.push(`      ${m.tipo === 'SANGRIA' ? '↘️ Retirada' : '↗️ Reforço'} ${brl(m.valorCents)} às ${m.hora} por ${m.quem} — ${m.motivo}`);
    if (s.status !== 'ABERTO' && s.contadoCents !== null) {
      const d = s.diferencaCents ?? 0;
      const sit = d === 0 ? '✅ conferido, sem diferença' : d < 0 ? `🔴 *faltaram ${brl(-d)}* (quebra de caixa)` : `🟡 *sobraram ${brl(d)}*`;
      L.push(`   Fechamento: ${s.fechadoEm ?? ''} por ${s.fechadoPor ?? '—'} · contado ${brl(s.contadoCents)} × esperado ${brl(s.esperadoCents ?? 0)} → ${sit}`);
      if (d !== 0 && s.observacao) L.push(`   Justificativa: ${s.observacao}`);
    }
  });
  return L;
}

function secaoAlteracoes(a: Alteracao[]): string[] {
  const L = [`${plural(a.length, 'alteração manual', 'alterações manuais')}:`];
  for (const x of a.slice(0, 20)) L.push(`• ${x.hora} · ${x.quem || 'Sistema'} — ${x.acao}${x.item ? `: ${x.item}` : ''}${x.detalhe ? ` (${x.detalhe})` : ''}`);
  if (a.length > 20) L.push(`… e mais ${a.length - 20} (veja ERP › Relatórios)`);
  return L;
}

/** Ações sugeridas a partir dos números do dia (frases curtas, uma por linha). */
export function acoesSugeridas(d: DadosAlerta, codigo?: string | null): string[] {
  const A: string[] = [];
  const hoje = new Date(`${d.hojeIso}T00:00:00Z`);
  if (d.pagar?.length) {
    const venc = d.pagar.filter((t) => t.vencimento < hoje);
    const hj = d.pagar.filter((t) => t.vencimento >= hoje && t.vencimento.getTime() < hoje.getTime() + 86_400_000);
    if (venc.length) A.push(`Pagar ou renegociar ${plural(venc.length, 'conta vencida', 'contas vencidas')} (${brl(venc.reduce((a, t) => a + t.abertoCents, 0))}).`);
    if (hj.length) A.push(`Separar ${brl(hj.reduce((a, t) => a + t.abertoCents, 0))} para ${plural(hj.length, 'conta que vence', 'contas que vencem')} hoje.`);
  }
  if (d.estoqueBaixo?.length) {
    const n = Math.min(d.estoqueBaixo.length, MAX_LINHAS);
    const est = d.estoqueBaixo.slice(0, MAX_LINHAS).reduce((a, i) => a + estimadoItem(i), 0);
    const zer = d.estoqueBaixo.filter((i) => i.saldoMil <= 0).length;
    if (zer) A.push(`Prioridade: ${plural(zer, 'produto já está', 'produtos já estão')} sem estoque.`);
    A.push(codigo
      ? `Aprovar a compra de ${plural(n, 'item', 'itens')}${est ? ` (≈ ${brl(est)})` : ''}: responda *APROVADO*${n > 1 ? ` (ou só alguns: *APROVADO ${n >= 3 ? '1,3' : '1'}*)` : ''}.`
      : `Fazer o pedido de compra de ${plural(n, 'item', 'itens')}${est ? ` (≈ ${brl(est)})` : ''} em ERP › Compras.`);
  }
  if (d.validade?.lotes.length) {
    const venc = d.validade.lotes.filter((l) => l.dias < 0);
    const logo = d.validade.lotes.filter((l) => l.dias >= 0 && l.dias <= 7);
    if (venc.length) A.push(`Retirar da venda ${plural(venc.length, 'lote vencido', 'lotes vencidos')} (${brl(venc.reduce((a, l) => a + l.valorCents, 0))} a custo) e lançar a perda.`);
    if (logo.length) A.push(`Vender primeiro ou fazer promoção de ${plural(logo.length, 'lote que vence', 'lotes que vencem')} em até 7 dias.`);
  }
  if (d.parados?.itens.length) A.push(`Criar promoção, combo ou devolução para ${plural(d.parados.itens.length, 'produto parado', 'produtos parados')} (${brl(d.parados.itens.reduce((a, i) => a + i.valorCents, 0))} empatados).`);
  for (const s of d.caixa ?? []) {
    if (s.status !== 'ABERTO' && s.diferencaCents) A.push(`Conferir a ${s.diferencaCents < 0 ? 'falta' : 'sobra'} de ${brl(Math.abs(s.diferencaCents))} no ${s.conta} fechado por ${s.fechadoPor ?? '—'}.`);
    if (s.status === 'ABERTO') A.push(`Fechar e conferir o ${s.conta}, aberto desde ${s.abertoEm}.`);
  }
  const precos = (d.alteracoes ?? []).filter((a) => a.tipo === 'preco' || a.tipo === 'custo').length;
  const est = (d.alteracoes ?? []).filter((a) => a.tipo === 'estoque').length;
  if (precos) A.push(`Revisar ${plural(precos, 'mudança de preço/custo feita', 'mudanças de preço/custo feitas')} ontem.`);
  if (est) A.push(`Confirmar ${plural(est, 'ajuste manual', 'ajustes manuais')} de estoque de ontem.`);
  return A;
}

/** Junta tudo em blocos (seções) já numerados. O 1º bloco é o cabeçalho. */
export function blocosAlerta(d: DadosAlerta, opts: { codigo?: string | null; previa?: boolean } = {}): string[] {
  const hoje = new Date(`${d.hojeIso}T00:00:00Z`);
  const secoes: { titulo: string; linhas: string[] }[] = [];
  if (d.pagar?.length) secoes.push({ titulo: '💰 Contas a pagar', linhas: secaoPagar(d.pagar, hoje) });
  if (d.estoqueBaixo?.length) secoes.push({ titulo: '📦 Estoque baixo', linhas: secaoEstoque(d.estoqueBaixo, opts.codigo, !!opts.previa) });
  if (d.validade?.lotes.length) secoes.push({ titulo: '⏳ Validade', linhas: secaoValidade(d.validade) });
  if (d.parados?.itens.length) secoes.push({ titulo: '💤 Produtos parados', linhas: secaoParados(d.parados) });
  if (d.caixa?.length) secoes.push({ titulo: `🧾 Caixa de ontem (${dataBr(d.ontemIso).slice(0, 5)})`, linhas: secaoCaixa(d.caixa) });
  if (d.alteracoes?.length) secoes.push({ titulo: `✏️ Alterações de ontem (${dataBr(d.ontemIso).slice(0, 5)})`, linhas: secaoAlteracoes(d.alteracoes) });

  const resumo: string[] = [];
  if (d.pagar?.length) resumo.push(plural(d.pagar.length, 'conta a pagar', 'contas a pagar'));
  if (d.estoqueBaixo?.length) resumo.push(`${d.estoqueBaixo.length} com estoque baixo`);
  if (d.validade?.lotes.length) resumo.push(plural(d.validade.lotes.length, 'lote na validade', 'lotes na validade'));
  if (d.parados?.itens.length) resumo.push(`${d.parados.itens.length} parado${d.parados.itens.length === 1 ? '' : 's'}`);
  const quebra = (d.caixa ?? []).reduce((a, s) => a + Math.min(0, s.diferencaCents ?? 0), 0);
  if (quebra) resumo.push(`quebra de caixa ${brl(-quebra)}`);

  const cab = [
    `🏢 *${d.empresa || 'Sua empresa'}*`,
    `📋 *Alerta diário do MCK ERP*`,
    `${cap(diaSemana(d.hojeIso))}, ${dataBr(d.hojeIso)}`,
    ...(resumo.length ? ['', `Hoje: ${resumo.join(' · ')}.`] : []),
  ].join('\n');
  const blocos = [cab, ...secoes.map((s, i) => [`*${i + 1}. ${s.titulo}*`, ...s.linhas].join('\n'))];
  const acoes = acoesSugeridas(d, opts.codigo || (opts.previa ? 'previa' : null));
  if (acoes.length) blocos.push(['*✅ Ações sugeridas*', ...acoes.map((a) => `• ${a}`)].join('\n'));
  blocos.push('_MCK ERP · para mudar o que chega aqui: ERP › Alertas_');
  return blocos;
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
