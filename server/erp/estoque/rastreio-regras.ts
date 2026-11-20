/**
 * Rastreabilidade de lote (v1.33.0) — regras puras, sem banco (testadas em tests/unit/erp-rastreio.test.ts).
 *  - identificarBusca: um único campo aceita código/nome/código de barras do produto, lote interno, lote do
 *    fornecedor, número ou chave de NF-e (entrada ou saída) e número de pedido (venda ou compra).
 *  - textoEvento: frase em português simples para cada movimento do lote (linha do tempo).
 *  - csvRastreio: exportação do rastreio (planilha abre no Excel/Google Planilhas).
 */

export const LOTE_INICIAL = 'L-INICIAL';
/** Lote "sem número" de antes da v1.31.0. A rotina/migração 0060 renomeia para L-INICIAL (mesmo id, histórico intacto). */
export const LOTE_SEM_NUMERO = 'UNICO';

export type TipoBusca = 'chave_nfe' | 'numero' | 'codigo_barras' | 'texto';

/** O que a busca parece ser. Pode ser mais de uma coisa (ex.: "123" pode ser pedido 123 ou NF 123). */
export function identificarBusca(qBruto: string): { q: string; digitos: string; tipos: TipoBusca[]; numero: number | null } {
  const q = (qBruto ?? '').trim().replace(/\s+/g, ' ').slice(0, 80);
  // Pedido "nº 12", "#12", "PV 12", "NF 000.123" → só os dígitos contam como número.
  const semPrefixo = q.replace(/^(n[º°o.]?\s*|#|pv\s*|pc\s*|pedido\s*|nf-?e?\s*|nota\s*)/i, '').trim();
  const digitos = semPrefixo.replace(/[.\-/\s]/g, '');
  const tipos: TipoBusca[] = [];
  const soDigitos = /^\d+$/.test(digitos);
  if (soDigitos && digitos.length === 44) tipos.push('chave_nfe');
  else if (soDigitos && [8, 12, 13, 14].includes(digitos.length)) tipos.push('codigo_barras', 'numero');
  else if (soDigitos && digitos.length <= 9) tipos.push('numero');
  if (!tipos.includes('chave_nfe') && q.length >= 2) tipos.push('texto');
  const numero = soDigitos && digitos.length <= 9 ? Number(digitos) : null;
  return { q, digitos: soDigitos ? digitos : '', tipos, numero };
}

/** "13/11/2026" (data de Brasília). */
export function dataBR(d: Date | string | null | undefined): string {
  if (!d) return '';
  const x = typeof d === 'string' ? new Date(d) : d;
  return x.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
}
/** "13/11/2026 às 14:05" (Brasília). */
export function dataHoraBR(d: Date | string | null | undefined): string {
  if (!d) return '';
  const x = typeof d === 'string' ? new Date(d) : d;
  const h = x.toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });
  return `${dataBR(x)} às ${h}`;
}

/** Número do lote para mostrar (o antigo "UNICO" aparece como lote inicial). */
export const numeroLoteLegivel = (n: string | null | undefined) => (!n ? '—' : n === LOTE_SEM_NUMERO ? LOTE_INICIAL : n);

export interface MovimentoEvento {
  tipo: string; qtdMil: number; docTipo: string | null; motivo: string | null;
  doc?: { rotulo: string; cliente?: string | null; fornecedor?: string | null; nf?: string | null } | null;
  endereco?: string | null;
}

/** Categoria do evento (para cor/ícone e filtros da tela). */
export type CategoriaEvento = 'entrada' | 'saida' | 'producao' | 'consumo' | 'transferencia' | 'reserva' | 'separacao' | 'baixa' | 'inventario' | 'devolucao' | 'qualidade';

export function categoriaMovimento(m: Pick<MovimentoEvento, 'tipo' | 'qtdMil' | 'docTipo'>): CategoriaEvento {
  switch (m.tipo) {
    case 'ENTRADA': return 'entrada';
    case 'PRODUCAO': return 'producao';
    case 'SAIDA': return 'saida';
    case 'CONSUMO': return 'consumo';
    case 'TRANSFERENCIA_SAIDA': case 'TRANSFERENCIA_ENTRADA': return 'transferencia';
    case 'INVENTARIO': return 'inventario';
    case 'SEPARACAO': return 'separacao';
    case 'DEVOLUCAO': return 'devolucao';
    case 'QUARENTENA': case 'LIBERACAO': return 'qualidade';
    case 'AJUSTE': return m.qtdMil > 0 ? 'entrada' : 'baixa';
    default: return m.qtdMil >= 0 ? 'entrada' : 'baixa';
  }
}

const ICONE: Record<CategoriaEvento, string> = { entrada: '📥', saida: '🚚', producao: '🏭', consumo: '⚙️', transferencia: '🔀', reserva: '📌', separacao: '✅', baixa: '📉', inventario: '📋', devolucao: '↩️', qualidade: '🔬' };
export const iconeEvento = (c: CategoriaEvento) => ICONE[c];

/** Frase do evento, em português simples (sem a quantidade, que vai em coluna própria). */
export function textoEvento(m: MovimentoEvento): string {
  const d = m.doc; const onde = m.endereco ? ` (${m.endereco})` : '';
  switch (m.tipo) {
    case 'ENTRADA':
      if (m.docTipo === 'nfe_entrada') return `Entrada pela ${d?.rotulo ?? 'NF-e'}${d?.fornecedor ? ` de ${d.fornecedor}` : ''}${onde}`;
      if (m.docTipo === 'inicial') return `Saldo inicial${onde}`;
      return `Entrada manual${m.motivo && m.motivo !== 'Entrada manual' ? `: ${m.motivo}` : ''}${onde}`;
    case 'AJUSTE':
      if (m.qtdMil > 0) return m.docTipo === 'inicial' ? `Saldo inicial${onde}` : `Entrada por ajuste${m.motivo ? `: ${m.motivo}` : ''}${onde}`;
      return `Baixa manual${m.motivo ? `: ${m.motivo}` : ''}${onde}`;
    case 'PRODUCAO': return `Produzido na ${d?.rotulo ?? 'ordem de produção'}${onde}`;
    case 'SAIDA': return `Saída: ${d?.rotulo ?? 'venda'}${d?.cliente ? ` para ${d.cliente}` : ''}${d?.nf ? ` · ${d.nf}` : ''}${onde}`;
    case 'CONSUMO': return `Usado na produção: ${d?.rotulo ?? 'ordem de produção'}${onde}`;
    case 'TRANSFERENCIA_SAIDA': return `Saiu do endereço ${m.endereco ?? ''} (mudança de lugar)`.trim();
    case 'TRANSFERENCIA_ENTRADA': return `Chegou no endereço ${m.endereco ?? ''} (mudança de lugar)`.trim();
    case 'INVENTARIO': return `Acerto do inventário${m.qtdMil >= 0 ? ' (sobrou)' : ' (faltou)'}${onde}`;
    case 'SEPARACAO': return `Separado e conferido: ${d?.rotulo ?? 'pedido'}${d?.cliente ? ` de ${d.cliente}` : ''}${onde}`;
    case 'DEVOLUCAO': return `Devolvido pelo cliente: ${d?.rotulo ?? 'pedido'}${d?.cliente ? ` (${d.cliente})` : ''}${onde}`;
    case 'QUARENTENA': return `Lote colocado em quarentena${onde}`;
    case 'LIBERACAO': return `Lote liberado para uso${onde}`;
    default: return `${m.tipo}${m.motivo ? `: ${m.motivo}` : ''}${onde}`;
  }
}

/** Tipos que contam como "quantidade recebida" do lote (a chegada de verdade, sem mudanças de lugar). */
export function contaComoRecebido(m: Pick<MovimentoEvento, 'tipo' | 'qtdMil' | 'docTipo'>): boolean {
  if (m.qtdMil <= 0) return false;
  if (m.tipo === 'ENTRADA' || m.tipo === 'PRODUCAO') return true;
  return m.tipo === 'AJUSTE' && m.docTipo === 'inicial';
}

const celula = (v: unknown) => {
  const s = v == null ? '' : String(v);
  // Evita fórmula em planilha (=, +, -, @) e escapa aspas.
  const seguro = /^[=+\-@]/.test(s) && !/^-?\d/.test(s) ? `'${s}` : s;
  return /[;"\n\r]/.test(seguro) ? `"${seguro.replace(/"/g, '""')}"` : seguro;
};
export const linhaCsv = (cols: unknown[]) => cols.map(celula).join(';');

export interface RastreioCsv {
  lote: { numero: string; loteFornecedor: string | null; produto: string; fornecedor: string | null; entradaEm: string; documentoEntrada: string; validade: string; recebida: string; saldo: string; unidade: string };
  locais: { local: string; fisico: string; reservado: string; disponivel: string }[];
  eventos: { quando: string; evento: string; quantidade: string; saldoApos: string; quem: string; documento: string }[];
  destinos: { tipo: string; para: string; documento: string; quantidade: string; quando: string }[];
  origens: { tipo: string; de: string; documento: string; quantidade: string }[];
}

/** CSV com ";" (padrão do Excel em português) e BOM para acentos. */
export function csvRastreio(r: RastreioCsv): string {
  const L: string[] = [];
  L.push(linhaCsv(['Rastreio do lote', r.lote.numero]));
  L.push(linhaCsv(['Produto', r.lote.produto]));
  L.push(linhaCsv(['Lote do fornecedor', r.lote.loteFornecedor ?? '']));
  L.push(linhaCsv(['Fornecedor', r.lote.fornecedor ?? '']));
  L.push(linhaCsv(['Data de entrada', r.lote.entradaEm]));
  L.push(linhaCsv(['Documento de entrada', r.lote.documentoEntrada]));
  L.push(linhaCsv(['Validade', r.lote.validade || 'não controla']));
  L.push(linhaCsv(['Quantidade recebida', `${r.lote.recebida} ${r.lote.unidade}`]));
  L.push(linhaCsv(['Saldo hoje', `${r.lote.saldo} ${r.lote.unidade}`]));
  L.push('');
  L.push(linhaCsv(['Onde está hoje', 'Físico', 'Reservado', 'Disponível']));
  for (const x of r.locais) L.push(linhaCsv([x.local, x.fisico, x.reservado, x.disponivel]));
  if (r.origens.length) {
    L.push('');
    L.push(linhaCsv(['De onde veio', 'Origem', 'Documento', 'Quantidade']));
    for (const o of r.origens) L.push(linhaCsv([o.tipo, o.de, o.documento, o.quantidade]));
  }
  L.push('');
  L.push(linhaCsv(['Para onde foi', 'Para', 'Documento', 'Quantidade', 'Quando']));
  for (const d of r.destinos) L.push(linhaCsv([d.tipo, d.para, d.documento, d.quantidade, d.quando]));
  L.push('');
  L.push(linhaCsv(['Quando', 'O que aconteceu', 'Quantidade', 'Saldo do lote depois', 'Quem', 'Documento']));
  for (const e of r.eventos) L.push(linhaCsv([e.quando, e.evento, e.quantidade, e.saldoApos, e.quem, e.documento]));
  return '\uFEFF' + L.join('\r\n') + '\r\n';
}
