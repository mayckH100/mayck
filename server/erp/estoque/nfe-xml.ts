/**
 * Leitura do XML da NF-e (modelo 55, layout 4.00) sem dependência externa.
 * Extrai emitente, identificação, itens (com custo de entrada completo) e rastro de lotes.
 */
export class NfeXmlErro extends Error {}

/** Texto da tag: tira CDATA e decodifica entidades (inclusive numéricas &#233; / &#xE9;, v1.50.0). */
const ent = (s: string) => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&').trim();
/** Conteúdo da primeira tag (ignora prefixo de namespace). */
export function tag(xml: string, nome: string): string | null {
  const m = new RegExp(`<(?:\\w+:)?${nome}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:\\w+:)?${nome}>`).exec(xml);
  return m ? ent(m[1]) : null;
}
export function blocos(xml: string, nome: string): string[] {
  const re = new RegExp(`<(?:\\w+:)?${nome}(?:\\s[^>]*)?>[\\s\\S]*?</(?:\\w+:)?${nome}>`, 'g');
  return xml.match(re) ?? [];
}
const mil = (v: string | null) => (v ? Math.round(parseFloat(v) * 1000) : 0);
const cents = (v: string | null) => (v ? Math.round(parseFloat(v) * 100) : 0);
const data = (v: string | null) => (v && !Number.isNaN(Date.parse(v)) ? new Date(v.length === 10 ? `${v}T12:00:00Z` : v) : null);

export interface LoteXml { numero: string; qtdMil: number; fabricacao: string | null; validade: string | null }
export interface ItemXml { nItem: number; codigo: string; descricao: string; ean: string | null; ncm: string | null; cfop: string | null; unidade: string; qtdMil: number; valorUnitCents: number; custoTotalCents: number; lotes: LoteXml[] }
export interface NfeXml {
  /** '55' = NF-e; '65' = NFC-e (v1.50.0). */
  modelo: '55' | '65';
  chave: string; numero: string; serie: string; dataEmissao: Date | null; autorizada: boolean; valorTotalCents: number;
  duplicatas: { numero: string; vencimento: Date | null; valorCents: number }[];
  emitente: { cnpj: string; nome: string; fantasia: string | null; ie: string | null; uf: string | null; municipio: string | null; cep: string | null; logradouro: string | null; numero: string | null; bairro: string | null };
  destinatarioDoc: string | null; itens: ItemXml[];
}

/**
 * Por que o XML não é uma NF-e completa (v1.50.0): mensagem clara para o cliente em vez de "infNFe não encontrado".
 * Resumo (resNFe) e evento (procEventoNFe) vêm da consulta de notas recebidas; CT-e/NFS-e são outros documentos.
 */
export function motivoNaoNfe(xml: string): string {
  if (/<(?:\w+:)?resNFe\b/.test(xml)) return 'Este XML é só o RESUMO da nota (resNFe), sem os itens. Baixe o XML completo da NF-e (o fornecedor manda por e-mail, ou baixe no portal da SEFAZ depois de manifestar "Ciência da operação")';
  if (/<(?:\w+:)?(procEventoNFe|evento|resEvento)\b/.test(xml)) return 'Este XML é um EVENTO da nota (cancelamento, carta de correção ou manifestação), não a NF-e. Envie o XML da própria nota';
  if (/<(?:\w+:)?(cteProc|CTe)\b/.test(xml)) return 'Este XML é um CT-e (conhecimento de transporte), não uma NF-e de produtos';
  if (/<(?:\w+:)?(CompNfse|Nfse|NFSe|nfse)\b/i.test(xml)) return 'Este XML é uma NFS-e (nota de serviço): ela não tem produtos para dar entrada no estoque';
  if (/<(?:\w+:)?(MDFe|mdfeProc)\b/.test(xml)) return 'Este XML é um MDF-e (manifesto de transporte), não uma NF-e';
  if (/<(?:\w+:)?(CFe|CFeCanc)\b/.test(xml)) return 'Este XML é um cupom SAT (CF-e), não uma NF-e';
  if (!/^\s*</.test(xml)) return 'O arquivo não é um XML. Envie o arquivo .xml da NF-e (não o PDF nem a foto do DANFE)';
  return 'Arquivo não é um XML de NF-e (infNFe não encontrado). Confira se escolheu o .xml da nota';
}

/** v1.50.0: BOM, bytes nulos (arquivo UTF-16 lido errado; o Postgres recusa \u0000) e lixo antes do primeiro "<" saem. */
export function limparNfe(xml0: string): string {
  let xml = xml0.replace(/^\uFEFF/, '').replace(/\u0000/g, '');
  const ini = xml.indexOf('<'); if (ini > 0) xml = xml.slice(ini);
  return xml.trim();
}

export function lerNfe(xml0: string): NfeXml {
  const xml = limparNfe(xml0);
  if (xml.length > 900_000) throw new NfeXmlErro('XML grande demais');
  // Id com aspas simples ou duplas, e antes ou depois de "versao" (alguns emissores/conversores gravam assim).
  const inf = /<(?:\w+:)?infNFe\b[^>]*\bId\s*=\s*["']NFe(\d{44})["']/.exec(xml);
  if (!inf) throw new NfeXmlErro(motivoNaoNfe(xml));
  const mod = tag(blocos(xml, 'ide')[0] ?? xml, 'mod');
  // v1.50.0: NFC-e (modelo 65, cupom de compra em loja) também dá entrada no estoque, com aviso.
  if (mod && mod !== '55' && mod !== '65') throw new NfeXmlErro(`Modelo ${mod} não suportado: envie NF-e (modelo 55) ou NFC-e (modelo 65)`);
  const emit = blocos(xml, 'emit')[0] ?? '';
  const end = blocos(emit, 'enderEmit')[0] ?? '';
  const cnpj = tag(emit, 'CNPJ') ?? tag(emit, 'CPF');
  if (!cnpj) throw new NfeXmlErro('Emitente sem CNPJ/CPF');
  const dest = blocos(xml, 'dest')[0] ?? '';
  const prot = blocos(xml, 'protNFe')[0];
  const itens = blocos(xml, 'det').map((det): ItemXml => {
    const prod = blocos(det, 'prod')[0] ?? '';
    const imp = blocos(det, 'imposto')[0] ?? '';
    const ipi = blocos(imp, 'IPI')[0] ?? '';
    const icms = blocos(imp, 'ICMS')[0] ?? '';
    const custo = cents(tag(prod, 'vProd')) + cents(tag(prod, 'vFrete')) + cents(tag(prod, 'vSeg')) + cents(tag(prod, 'vOutro')) - cents(tag(prod, 'vDesc')) + cents(tag(ipi, 'vIPI')) + cents(tag(icms, 'vICMSST'));
    const ean = tag(prod, 'cEAN');
    return {
      nItem: Number(/nItem\s*=\s*["'](\d+)["']/.exec(det)?.[1] ?? 0), codigo: tag(prod, 'cProd') ?? '', descricao: tag(prod, 'xProd') ?? '',
      ean: ean && /^\d{8,14}$/.test(ean) ? ean : null, ncm: tag(prod, 'NCM'), cfop: tag(prod, 'CFOP'), unidade: (tag(prod, 'uCom') ?? 'UN').toUpperCase(),
      qtdMil: mil(tag(prod, 'qCom')), valorUnitCents: cents(tag(prod, 'vUnCom')), custoTotalCents: Math.max(0, custo),
      lotes: blocos(prod, 'rastro').map((r) => ({ numero: (tag(r, 'nLote') ?? '').toUpperCase(), qtdMil: mil(tag(r, 'qLote')), fabricacao: tag(r, 'dFab'), validade: tag(r, 'dVal') })).filter((l) => l.numero),
    };
  });
  if (!itens.length) throw new NfeXmlErro('NF-e sem itens');
  // Item sem nItem (XML convertido) recebe a posição na nota; números repetidos também (a chave do item é única).
  const vistos = new Set<number>();
  itens.forEach((it, i) => { if (!it.nItem || vistos.has(it.nItem)) it.nItem = i + 1; vistos.add(it.nItem); });
  return {
    modelo: mod === '65' ? '65' : '55',
    chave: inf[1], numero: tag(blocos(xml, 'ide')[0] ?? '', 'nNF') ?? '', serie: tag(blocos(xml, 'ide')[0] ?? '', 'serie') ?? '',
    dataEmissao: data(tag(xml, 'dhEmi') ?? tag(xml, 'dEmi')), autorizada: !!prot && tag(prot, 'cStat') === '100',
    valorTotalCents: cents(tag(blocos(xml, 'ICMSTot')[0] ?? '', 'vNF')),
    duplicatas: blocos(blocos(xml, 'cobr')[0] ?? '', 'dup').map((d) => ({ numero: tag(d, 'nDup') ?? '', vencimento: data(tag(d, 'dVenc')), valorCents: cents(tag(d, 'vDup')) })).filter((d) => d.valorCents > 0),
    emitente: { cnpj, nome: tag(emit, 'xNome') ?? '', fantasia: tag(emit, 'xFant'), ie: tag(emit, 'IE'), uf: tag(end, 'UF'), municipio: tag(end, 'xMun'), cep: tag(end, 'CEP'), logradouro: tag(end, 'xLgr'), numero: tag(end, 'nro'), bairro: tag(end, 'xBairro') },
    destinatarioDoc: tag(dest, 'CNPJ') ?? tag(dest, 'CPF'), itens,
  };
}

/** Formato padrão antigo (nunca personalizado) passa a usar o novo, mais legível: L + ano/mês + sequência (v1.31.0). */
export const FORMATO_LOTE_ANTIGO = '{AA}{MM}{DD}-{SEQ}';
export const FORMATO_LOTE_PADRAO = 'L{AA}{MM}-{SEQ4}';
export const formatoLoteEfetivo = (f: string | null | undefined) => (!f || f === FORMATO_LOTE_ANTIGO ? FORMATO_LOTE_PADRAO : f);

/** Número do lote interno a partir do formato configurado. */
export function numeroLoteInterno(formato: string, seq: number, sku: string, hoje = new Date()) {
  const p2 = (n: number) => String(n).padStart(2, '0');
  const out = (formato || '{AA}{MM}{DD}-{SEQ}')
    .replace(/\{AAAA\}/g, String(hoje.getFullYear())).replace(/\{AA\}/g, String(hoje.getFullYear()).slice(2))
    .replace(/\{MM\}/g, p2(hoje.getMonth() + 1)).replace(/\{DD\}/g, p2(hoje.getDate()))
    .replace(/\{SKU\}/g, sku).replace(/\{SEQ4\}/g, String(seq).padStart(4, '0')).replace(/\{SEQ\}/g, String(seq).padStart(5, '0'));
  return out.toUpperCase().replace(/[^A-Z0-9\-_./]/g, '').slice(0, 40);
}

/** Divide a quantidade do item pelos lotes do rastro; o que sobrar sem lote vai num lote só. */
export function repartirLotes(qtdMil: number, lotes: LoteXml[]) {
  const out: (LoteXml | { numero: null; qtdMil: number; fabricacao: null; validade: null })[] = [];
  let resta = qtdMil;
  for (const l of lotes) {
    const q = Math.min(resta, l.qtdMil || resta);
    if (q <= 0) break;
    out.push({ ...l, qtdMil: q }); resta -= q;
  }
  if (resta > 0) out.push({ numero: null, qtdMil: resta, fabricacao: null, validade: null });
  return out;
}
