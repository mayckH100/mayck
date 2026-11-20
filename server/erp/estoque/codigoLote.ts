/**
 * Código do lote na etiqueta (v1.33.0) — puro, usado pelo servidor e pela web. Testado em tests/unit/erp-codigo-lote-gs1.test.ts.
 *
 * Código de barras GS1-128 (Code 128 com FNC1) com os Identificadores de Aplicação:
 *   (11) data de fabricação AAMMDD · (17) validade AAMMDD · (241) código do produto · (10) lote interno
 * Os de tamanho fixo vêm primeiro; os variáveis (241 e 10) são separados por FNC1 (o leitor manda o caractere GS).
 * QR: "MCK1;lote interno;lote do fornecedor;validade;SKU;descrição;fabricação;empresa" (campo vazio = "-").
 * A leitura aceita: GS1-128 (com GS, com "]C1", com parênteses ou sem separador), QR MCK1, número do lote,
 * código do produto ou código de barras do produto (EAN/GTIN).
 */

/** FNC1 para o jsbarcode/encoder (o leitor transmite como GS = \x1d). */
export const FNC1 = '\u00CF';
const GS = '\u001D';

const aammdd = (iso: string | null | undefined) => {
  const m = iso ? /^(\d{4})-(\d{2})-(\d{2})/.exec(iso) : null;
  return m ? `${m[1].slice(2)}${m[2]}${m[3]}` : null;
};
const isoDe = (a: string) => `20${a.slice(0, 2)}-${a.slice(2, 4)}-${a.slice(4, 6)}`;
const limpaVar = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\x21-\x7E]/g, '').slice(0, 30);

export interface DadosCodigoLote { sku: string; lote: string; fabricacaoIso?: string | null; validadeIso?: string | null }

/** Dados do GS1-128 (com FNC1 entre campos variáveis) e o texto legível que vai embaixo das barras. */
export function gs1Lote(d: DadosCodigoLote): { dados: string; legivel: string; zpl: string } {
  const fab = aammdd(d.fabricacaoIso); const val = aammdd(d.validadeIso);
  const sku = limpaVar(d.sku.toUpperCase()); const lote = limpaVar(d.lote.toUpperCase()).slice(0, 20);
  const fixos = `${fab ? `11${fab}` : ''}${val ? `17${val}` : ''}`;
  const dados = `${fixos}241${sku}${FNC1}10${lote}`;
  const legivel = `${fab ? `(11)${fab}` : ''}${val ? `(17)${val}` : ''}(241)${sku}(10)${lote}`;
  // ZPL ^BC: ">8" = FNC1 (início GS1 e separador).
  const zpl = `>8${fixos}241${sku}>810${lote}`;
  return { dados, legivel, zpl };
}

const sem = (s: string | null | undefined) => (s ? String(s).replace(/;/g, ',').trim() : '') || '-';
/** Texto do QR (mesmos dados da etiqueta). Os 6 primeiros campos são os da v1.4x (compatível com etiquetas antigas). */
export function qrLote(d: { lote: string | null; loteFornecedor?: string | null; validadeIso?: string | null; sku: string; nome: string; fabricacaoIso?: string | null; empresa?: string | null }) {
  return ['MCK1', sem(d.lote), sem(d.loteFornecedor), sem(d.validadeIso?.slice(0, 10)), sem(d.sku), sem(d.nome).slice(0, 60), sem(d.fabricacaoIso?.slice(0, 10)), sem(d.empresa).slice(0, 40)].join(';');
}

export interface CodigoLido {
  tipo: 'gs1' | 'qr' | 'simples';
  sku: string | null; lote: string | null; fabricacao: string | null; validade: string | null; loteFornecedor: string | null;
  /** GS1 lido sem separador: pares possíveis (código, lote) para o servidor conferir no cadastro. */
  candidatos: { sku: string; lote: string }[];
  bruto: string;
}

/** Interpreta o que o leitor/câmera devolveu. */
export function lerCodigo(entrada: string): CodigoLido {
  const bruto = (entrada ?? '').trim();
  const base: CodigoLido = { tipo: 'simples', sku: null, lote: null, fabricacao: null, validade: null, loteFornecedor: null, candidatos: [], bruto };
  if (!bruto) return base;
  // QR da etiqueta
  if (bruto.toUpperCase().startsWith('MCK1;')) {
    const f = bruto.split(';').map((x) => (x === '-' ? '' : x.trim()));
    return { ...base, tipo: 'qr', lote: f[1] || null, loteFornecedor: f[2] || null, validade: f[3] || null, sku: f[4] || null, fabricacao: f[6] || null };
  }
  // Só números com tamanho de EAN/UPC/GTIN: é o código de barras do produto, não GS1 de lote.
  if (/^\d+$/.test(bruto) && [8, 12, 13, 14].includes(bruto.length)) return base;
  // GS1 com parênteses: (11)261101(17)270120(241)MCK0001(10)L2611-0001
  if (/^\(\d{2,3}\)/.test(bruto)) {
    const r = { ...base, tipo: 'gs1' as const };
    for (const m of bruto.matchAll(/\((\d{2,3})\)([^(]*)/g)) aplicarAi(r, m[1], m[2].trim());
    return r.sku || r.lote ? r : base;
  }
  // GS1 transmitido pelo leitor: "]C1" opcional, GS (ou FNC1) entre campos variáveis
  let s = bruto.replace(/^\]C1/, '').replace(new RegExp(`[${FNC1}|]`, 'g'), GS);
  if (!/^(11\d{6}|17\d{6}|241)/.test(s)) return base;
  const r: CodigoLido = { ...base, tipo: 'gs1' };
  for (let guard = 0; s && guard < 10; guard++) {
    if (s[0] === GS) { s = s.slice(1); continue; }
    const fixo = /^(11|17)(\d{6})/.exec(s);
    if (fixo) { aplicarAi(r, fixo[1], fixo[2]); s = s.slice(8); continue; }
    const v = /^(241|10)/.exec(s);
    if (!v) break;
    s = s.slice(v[1].length);
    const fim = s.indexOf(GS);
    const valor = fim < 0 ? s : s.slice(0, fim);
    s = fim < 0 ? '' : s.slice(fim);
    if (v[1] === '241' && fim < 0) {
      // Sem separador (alguns leitores engolem o GS): todas as divisões "código" + "10" + "lote" possíveis.
      for (let i = 1; i < valor.length - 2; i++) if (valor.slice(i, i + 2) === '10') r.candidatos.push({ sku: valor.slice(0, i), lote: valor.slice(i + 2) });
      if (!r.candidatos.length) r.sku = valor;
      continue;
    }
    aplicarAi(r, v[1], valor);
  }
  return r.sku || r.lote || r.candidatos.length ? r : base;
}

function aplicarAi(r: CodigoLido, ai: string, valor: string) {
  if (ai === '11' && /^\d{6}$/.test(valor)) r.fabricacao = isoDe(valor);
  else if (ai === '17' && /^\d{6}$/.test(valor)) r.validade = isoDe(valor);
  else if (ai === '241') r.sku = valor.toUpperCase();
  else if (ai === '10') r.lote = valor.toUpperCase();
}

/** Variantes de um código de barras numérico (EAN-8/13, UPC-A, GTIN-14 com/sem zeros à esquerda). */
export function variantesBarras(codigo: string): string[] {
  const c = codigo.trim();
  if (!/^\d{6,14}$/.test(c)) return [c];
  const s = c.replace(/^0+/, '');
  return [...new Set([c, s, s.padStart(8, '0'), s.padStart(12, '0'), s.padStart(13, '0'), s.padStart(14, '0')])];
}

/**
 * Quantas etiquetas sugerir para uma entrada: uma por embalagem quando o produto compra em embalagem (caixa, pacote…),
 * senão uma por peça/unidade inteira. Produto a granel (kg, m, l) ganha 1. Sempre de 1 a 999 (editável na tela).
 */
export function etiquetasSugeridas(qtdMil: number, p: { unidade?: string | null; unidadeCompra?: string | null; fatorCompraMil?: number | null }): number {
  const granel = ['KG', 'G', 'M', 'L', 'ML', 'M2', 'M3', 'CM'].includes((p.unidade ?? '').toUpperCase());
  const fator = p.unidadeCompra && (p.fatorCompraMil ?? 1000) > 1000 ? p.fatorCompraMil! : null;
  const n = fator ? Math.ceil(qtdMil / fator) : granel ? 1 : Math.ceil(qtdMil / 1000);
  return Math.max(1, Math.min(999, n));
}
