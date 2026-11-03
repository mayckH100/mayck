/**
 * Leitura do XML da NF-e (modelo 55, layout 4.00) sem dependência externa.
 * Extrai emitente, identificação, itens (com custo de entrada completo) e rastro de lotes.
 */
export class NfeXmlErro extends Error {}

const ent = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&').trim();
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
  chave: string; numero: string; serie: string; dataEmissao: Date | null; autorizada: boolean; valorTotalCents: number;
  emitente: { cnpj: string; nome: string; fantasia: string | null; ie: string | null; uf: string | null; municipio: string | null; cep: string | null; logradouro: string | null; numero: string | null; bairro: string | null };
  destinatarioDoc: string | null; itens: ItemXml[];
}

export function lerNfe(xml: string): NfeXml {
  if (xml.length > 900_000) throw new NfeXmlErro('XML grande demais');
  const inf = /<(?:\w+:)?infNFe\b[^>]*\bId="NFe(\d{44})"/.exec(xml);
  if (!inf) throw new NfeXmlErro('Arquivo não é um XML de NF-e (infNFe não encontrado)');
  const mod = tag(xml, 'mod');
  if (mod && mod !== '55') throw new NfeXmlErro(`Modelo ${mod} não suportado: envie NF-e modelo 55`);
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
      nItem: Number(/nItem="(\d+)"/.exec(det)?.[1] ?? 0), codigo: tag(prod, 'cProd') ?? '', descricao: tag(prod, 'xProd') ?? '',
      ean: ean && /^\d{8,14}$/.test(ean) ? ean : null, ncm: tag(prod, 'NCM'), cfop: tag(prod, 'CFOP'), unidade: (tag(prod, 'uCom') ?? 'UN').toUpperCase(),
      qtdMil: mil(tag(prod, 'qCom')), valorUnitCents: cents(tag(prod, 'vUnCom')), custoTotalCents: Math.max(0, custo),
      lotes: blocos(prod, 'rastro').map((r) => ({ numero: (tag(r, 'nLote') ?? '').toUpperCase(), qtdMil: mil(tag(r, 'qLote')), fabricacao: tag(r, 'dFab'), validade: tag(r, 'dVal') })).filter((l) => l.numero),
    };
  });
  if (!itens.length) throw new NfeXmlErro('NF-e sem itens');
  return {
    chave: inf[1], numero: tag(blocos(xml, 'ide')[0] ?? '', 'nNF') ?? '', serie: tag(blocos(xml, 'ide')[0] ?? '', 'serie') ?? '',
    dataEmissao: data(tag(xml, 'dhEmi') ?? tag(xml, 'dEmi')), autorizada: !!prot && tag(prot, 'cStat') === '100',
    valorTotalCents: cents(tag(blocos(xml, 'ICMSTot')[0] ?? '', 'vNF')),
    emitente: { cnpj, nome: tag(emit, 'xNome') ?? '', fantasia: tag(emit, 'xFant'), ie: tag(emit, 'IE'), uf: tag(end, 'UF'), municipio: tag(end, 'xMun'), cep: tag(end, 'CEP'), logradouro: tag(end, 'xLgr'), numero: tag(end, 'nro'), bairro: tag(end, 'xBairro') },
    destinatarioDoc: tag(dest, 'CNPJ') ?? tag(dest, 'CPF'), itens,
  };
}

/** Número do lote interno a partir do formato configurado. */
export function numeroLoteInterno(formato: string, seq: number, sku: string, hoje = new Date()) {
  const p2 = (n: number) => String(n).padStart(2, '0');
  const out = (formato || '{AA}{MM}{DD}-{SEQ}')
    .replace(/\{AAAA\}/g, String(hoje.getFullYear())).replace(/\{AA\}/g, String(hoje.getFullYear()).slice(2))
    .replace(/\{MM\}/g, p2(hoje.getMonth() + 1)).replace(/\{DD\}/g, p2(hoje.getDate()))
    .replace(/\{SKU\}/g, sku).replace(/\{SEQ\}/g, String(seq).padStart(5, '0'));
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
