/**
 * Emissão de NF-e modelo 55, layout 4.00: chave de acesso, cálculo de tributos por regra, montagem do XML e
 * assinatura XML-DSig (RSA-SHA1, C14N) com o certificado A1 do próprio cliente. Funções puras, sem rede.
 */
import { createHash, createSign } from 'node:crypto';
import forge from 'node-forge';

export const NS = 'http://www.portalfiscal.inf.br/nfe';
export const UF_IBGE: Record<string, string> = { RO: '11', AC: '12', AM: '13', RR: '14', PA: '15', AP: '16', TO: '17', MA: '21', PI: '22', CE: '23', RN: '24', PB: '25', PE: '26', AL: '27', SE: '28', BA: '29', MG: '31', ES: '32', RJ: '33', SP: '35', PR: '41', SC: '42', RS: '43', MS: '50', MT: '51', GO: '52', DF: '53' };

/** Dígito verificador módulo 11 (pesos 2..9 da direita para a esquerda). */
export function dvModulo11(base: string) {
  let soma = 0; let peso = 2;
  for (let i = base.length - 1; i >= 0; i--) { soma += Number(base[i]) * peso; peso = peso === 9 ? 2 : peso + 1; }
  const r = soma % 11;
  return r < 2 ? 0 : 11 - r;
}

export function chaveAcesso(p: { uf: string; emissao: Date; cnpj: string; serie: number; numero: number; tpEmis?: number; cNF: number }) {
  const aamm = `${String(p.emissao.getUTCFullYear()).slice(2)}${String(p.emissao.getUTCMonth() + 1).padStart(2, '0')}`;
  const base = `${UF_IBGE[p.uf]}${aamm}${p.cnpj.padStart(14, '0')}55${String(p.serie).padStart(3, '0')}${String(p.numero).padStart(9, '0')}${p.tpEmis ?? 1}${String(p.cNF).padStart(8, '0')}`;
  if (base.length !== 43 || !/^\d+$/.test(base)) throw new Error('Dados inválidos para a chave de acesso');
  return base + dvModulo11(base);
}

export interface Regra { cfopDentro: string; cfopFora: string; csosn: string; cstIcms: string; aliqIcmsBp: number; cstIpi: string; aliqIpiBp: number; cstPis: string; aliqPisBp: number; cstCofins: string; aliqCofinsBp: number }
export const REGRA_PADRAO: Regra = { cfopDentro: '5102', cfopFora: '6102', csosn: '102', cstIcms: '00', aliqIcmsBp: 1800, cstIpi: '53', aliqIpiBp: 0, cstPis: '49', aliqPisBp: 0, cstCofins: '49', aliqCofinsBp: 0 };

/** Escolhe a regra: do produto > NCM mais longo > padrão da empresa (prioridade desempata). */
export function escolherRegra<R extends Regra & { produtoId: string | null; ncmPrefixo: string | null; prioridade: number }>(regras: R[], produtoId: string, ncm: string | null): Regra {
  const p = regras.filter((r) => r.produtoId === produtoId).sort((a, b) => b.prioridade - a.prioridade)[0];
  if (p) return p;
  const n = regras.filter((r) => !r.produtoId && r.ncmPrefixo && ncm?.startsWith(r.ncmPrefixo)).sort((a, b) => b.ncmPrefixo!.length - a.ncmPrefixo!.length || b.prioridade - a.prioridade)[0];
  if (n) return n;
  return regras.filter((r) => !r.produtoId && !r.ncmPrefixo).sort((a, b) => b.prioridade - a.prioridade)[0] ?? REGRA_PADRAO;
}

const pct = (base: number, bp: number) => Math.round((base * bp) / 10_000);
/** Tributos do item em centavos. Base = produto + frete − desconto (simplificado; sem ST e sem DIFAL). */
export function tributos(baseCents: number, r: Regra, crt: number) {
  const simples = crt !== 3;
  const icmsTrib = !simples && ['00', '20'].includes(r.cstIcms);
  const vIcms = icmsTrib ? pct(baseCents, r.aliqIcmsBp) : 0;
  const vIpi = !simples && ['00', '49', '50', '99'].includes(r.cstIpi) ? pct(baseCents, r.aliqIpiBp) : 0;
  const vPis = ['01', '02'].includes(r.cstPis) ? pct(baseCents, r.aliqPisBp) : 0;
  const vCofins = ['01', '02'].includes(r.cstCofins) ? pct(baseCents, r.aliqCofinsBp) : 0;
  return { vBC: icmsTrib ? baseCents : 0, vIcms, vIpi, vPis, vCofins };
}

/** Rateia um valor pelos pesos; o resto do arredondamento vai no último. */
export function ratear(total: number, pesos: number[]) {
  const soma = pesos.reduce((a, b) => a + b, 0);
  if (!total || !soma) return pesos.map(() => 0);
  const r = pesos.map((p) => Math.floor((total * p) / soma));
  r[r.length - 1] += total - r.reduce((a, b) => a + b, 0);
  return r;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\r?\n/g, ' ').trim();
const t = (nome: string, v: string | number | null | undefined) => (v === null || v === undefined || v === '' ? '' : `<${nome}>${typeof v === 'number' ? v : esc(v)}</${nome}>`);
const m = (c: number) => (c / 100).toFixed(2);
const so = (s: string | null | undefined) => (s ?? '').replace(/\D/g, '');

export interface Emitente { cnpj: string; razaoSocial: string; fantasia?: string | null; ie: string; crt: number; uf: string; codMunicipio: string; municipio: string; logradouro: string; numero: string; bairro: string; cep: string; fone?: string | null }
export interface Destinatario { documento: string; nome: string; ie?: string | null; email?: string | null; uf: string; codMunicipio: string; municipio: string; logradouro: string; numero: string; bairro: string; cep: string; complemento?: string | null }
export interface ItemNfe { codigo: string; descricao: string; ncm: string; ean?: string | null; unidade: string; qtdMil: number; valorUnitCents: number; descontoCents: number; freteCents: number; origem: number; regra: Regra }
export interface DadosNfe { emitente: Emitente; destinatario: Destinatario; itens: ItemNfe[]; serie: number; numero: number; cNF: number; emissao: Date; ambiente: number; natOp: string; tPag: string; infCpl?: string | null; consumidorFinal: boolean }

function dhBrasil(d: Date) {
  const l = new Date(d.getTime() - 3 * 3_600_000).toISOString().slice(0, 19);
  return `${l}-03:00`;
}

/** Monta o XML (sem assinatura). O infNFe sai já na forma canônica (C14N) para o cálculo do digest. */
export function montarNfe(d: DadosNfe) {
  if (!d.itens.length) throw new Error('NF-e sem itens');
  const e = d.emitente; const ds = d.destinatario;
  for (const [campo, v] of [['CNPJ do emitente', so(e.cnpj).length === 14], ['IE do emitente', !!e.ie], ['município do emitente (IBGE)', /^\d{7}$/.test(e.codMunicipio)], ['UF do emitente', !!UF_IBGE[e.uf]], ['documento do destinatário', [11, 14].includes(so(ds.documento).length)], ['UF do destinatário', !!UF_IBGE[ds.uf]], ['município do destinatário (IBGE)', /^\d{7}$/.test(ds.codMunicipio)]] as const) {
    if (!v) throw new Error(`Falta ${campo}`);
  }
  for (const i of d.itens) if (!/^\d{8}$/.test(i.ncm)) throw new Error(`Produto ${i.codigo} sem NCM válido`);
  const chave = chaveAcesso({ uf: e.uf, emissao: new Date(d.emissao.getTime() - 3 * 3_600_000), cnpj: so(e.cnpj), serie: d.serie, numero: d.numero, cNF: d.cNF });
  const dentro = e.uf === ds.uf;
  const homolog = d.ambiente === 2;
  const tot = { vBC: 0, vICMS: 0, vProd: 0, vFrete: 0, vDesc: 0, vIPI: 0, vPIS: 0, vCOFINS: 0 };
  const dets = d.itens.map((i, n) => {
    const vProd = Math.round((i.qtdMil * i.valorUnitCents) / 1000);
    const base = vProd + i.freteCents - i.descontoCents;
    const tr = tributos(base, i.regra, e.crt);
    tot.vProd += vProd; tot.vFrete += i.freteCents; tot.vDesc += i.descontoCents; tot.vBC += tr.vBC; tot.vICMS += tr.vIcms; tot.vIPI += tr.vIpi; tot.vPIS += tr.vPis; tot.vCOFINS += tr.vCofins;
    const q = (i.qtdMil / 1000).toFixed(4); const vu = (i.valorUnitCents / 100).toFixed(10);
    const gtin = i.ean && /^\d{8,14}$/.test(i.ean) ? i.ean : 'SEM GTIN';
    const prod = `<prod>${t('cProd', i.codigo)}${t('cEAN', gtin)}${t('xProd', homolog && n === 0 ? 'NOTA FISCAL EMITIDA EM AMBIENTE DE HOMOLOGACAO - SEM VALOR FISCAL' : i.descricao)}${t('NCM', i.ncm)}${t('CFOP', dentro ? i.regra.cfopDentro : i.regra.cfopFora)}${t('uCom', i.unidade)}${t('qCom', q)}${t('vUnCom', vu)}${t('vProd', m(vProd))}${t('cEANTrib', gtin)}${t('uTrib', i.unidade)}${t('qTrib', q)}${t('vUnTrib', vu)}${i.freteCents ? t('vFrete', m(i.freteCents)) : ''}${i.descontoCents ? t('vDesc', m(i.descontoCents)) : ''}<indTot>1</indTot></prod>`;
    const icms = e.crt === 3
      ? (['00'].includes(i.regra.cstIcms) ? `<ICMS><ICMS00><orig>${i.origem}</orig><CST>00</CST><modBC>3</modBC>${t('vBC', m(tr.vBC))}${t('pICMS', (i.regra.aliqIcmsBp / 100).toFixed(4))}${t('vICMS', m(tr.vIcms))}</ICMS00></ICMS>` : `<ICMS><ICMS40><orig>${i.origem}</orig><CST>${['40', '41', '50'].includes(i.regra.cstIcms) ? i.regra.cstIcms : '41'}</CST></ICMS40></ICMS>`)
      : `<ICMS><ICMSSN102><orig>${i.origem}</orig><CSOSN>${['102', '103', '300', '400'].includes(i.regra.csosn) ? i.regra.csosn : '102'}</CSOSN></ICMSSN102></ICMS>`;
    const ipi = e.crt === 3 ? (tr.vIpi > 0 ? `<IPI><cEnq>999</cEnq><IPITrib><CST>${i.regra.cstIpi}</CST>${t('vBC', m(base))}${t('pIPI', (i.regra.aliqIpiBp / 100).toFixed(4))}${t('vIPI', m(tr.vIpi))}</IPITrib></IPI>` : `<IPI><cEnq>999</cEnq><IPINT><CST>${['01', '02', '03', '04', '05', '51', '52', '53', '54', '55'].includes(i.regra.cstIpi) ? i.regra.cstIpi : '53'}</CST></IPINT></IPI>`) : '';
    const pc = (g: 'PIS' | 'COFINS', cst: string, bp: number, v: number) => (['01', '02'].includes(cst)
      ? `<${g}><${g}Aliq><CST>${cst}</CST>${t('vBC', m(base))}${t(`p${g}`, (bp / 100).toFixed(4))}${t(`v${g}`, m(v))}</${g}Aliq></${g}>`
      : ['04', '05', '06', '07', '08', '09'].includes(cst) ? `<${g}><${g}NT><CST>${cst}</CST></${g}NT></${g}>`
        : `<${g}><${g}Outr><CST>${cst}</CST><vBC>0.00</vBC><p${g}>0.0000</p${g}><v${g}>0.00</v${g}></${g}Outr></${g}>`);
    return `<det nItem="${n + 1}">${prod}<imposto>${icms}${ipi}${pc('PIS', i.regra.cstPis, i.regra.aliqPisBp, tr.vPis)}${pc('COFINS', i.regra.cstCofins, i.regra.aliqCofinsBp, tr.vCofins)}</imposto></det>`;
  }).join('');
  const vNF = tot.vProd + tot.vFrete - tot.vDesc + tot.vIPI;
  const docDest = so(ds.documento);
  const indIEDest = docDest.length === 14 && ds.ie && !/isento/i.test(ds.ie) ? 1 : 9;
  const ender = (x: Emitente | Destinatario, tag: string) => `<${tag}>${t('xLgr', x.logradouro)}${t('nro', x.numero || 'S/N')}${'complemento' in x ? t('xCpl', x.complemento) : ''}${t('xBairro', x.bairro)}${t('cMun', x.codMunicipio)}${t('xMun', x.municipio)}${t('UF', x.uf)}${t('CEP', so(x.cep))}<cPais>1058</cPais><xPais>Brasil</xPais>${'fone' in x ? t('fone', so(x.fone)) : ''}</${tag}>`;
  const cDV = chave.slice(-1);
  const inf = `<infNFe xmlns="${NS}" Id="NFe${chave}" versao="4.00">`
    + `<ide>${t('cUF', UF_IBGE[e.uf])}${t('cNF', String(d.cNF).padStart(8, '0'))}${t('natOp', d.natOp)}<mod>55</mod>${t('serie', String(d.serie))}${t('nNF', String(d.numero))}${t('dhEmi', dhBrasil(d.emissao))}<tpNF>1</tpNF>${t('idDest', dentro ? '1' : '2')}${t('cMunFG', e.codMunicipio)}<tpImp>1</tpImp><tpEmis>1</tpEmis>${t('cDV', cDV)}${t('tpAmb', String(d.ambiente))}<finNFe>1</finNFe>${t('indFinal', d.consumidorFinal ? '1' : '0')}<indPres>9</indPres><procEmi>0</procEmi><verProc>MCK ERP 1.0</verProc></ide>`
    + `<emit>${t('CNPJ', so(e.cnpj))}${t('xNome', e.razaoSocial)}${t('xFant', e.fantasia)}${ender(e, 'enderEmit')}${t('IE', so(e.ie))}${t('CRT', String(e.crt))}</emit>`
    + `<dest>${docDest.length === 14 ? t('CNPJ', docDest) : t('CPF', docDest)}${t('xNome', homolog ? 'NF-E EMITIDA EM AMBIENTE DE HOMOLOGACAO - SEM VALOR FISCAL' : ds.nome)}${ender(ds, 'enderDest')}${t('indIEDest', String(indIEDest))}${indIEDest === 1 ? t('IE', so(ds.ie)) : ''}${t('email', ds.email)}</dest>`
    + dets
    + `<total><ICMSTot>${t('vBC', m(tot.vBC))}${t('vICMS', m(tot.vICMS))}<vICMSDeson>0.00</vICMSDeson><vFCP>0.00</vFCP><vBCST>0.00</vBCST><vST>0.00</vST><vFCPST>0.00</vFCPST><vFCPSTRet>0.00</vFCPSTRet>${t('vProd', m(tot.vProd))}${t('vFrete', m(tot.vFrete))}<vSeg>0.00</vSeg>${t('vDesc', m(tot.vDesc))}<vII>0.00</vII>${t('vIPI', m(tot.vIPI))}<vIPIDevol>0.00</vIPIDevol>${t('vPIS', m(tot.vPIS))}${t('vCOFINS', m(tot.vCOFINS))}<vOutro>0.00</vOutro>${t('vNF', m(vNF))}</ICMSTot></total>`
    + `<transp><modFrete>${tot.vFrete ? '0' : '9'}</modFrete></transp>`
    + `<pag><detPag>${t('tPag', d.tPag)}${d.tPag === '99' ? t('xPag', 'Outros') : ''}${t('vPag', m(vNF))}</detPag></pag>`
    + (d.infCpl ? `<infAdic>${t('infCpl', d.infCpl)}</infAdic>` : '')
    + `</infNFe>`;
  return { chave, infNFe: inf, totalCents: vNF, totais: tot };
}

export interface Certificado { chavePem: string; certBase64: string; titular: string; validade: Date; cnpj: string | null }
/** Lê o PFX (A1) com a senha; devolve chave privada, certificado e titular. */
export function lerPfx(pfxBase64: string, senha: string): Certificado {
  let p12: forge.pkcs12.Pkcs12Pfx;
  try { p12 = forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(forge.util.decode64(pfxBase64)), senha); } catch { throw new Error('Certificado inválido ou senha incorreta'); }
  const keyBag = (p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag] ?? [])[0] ?? (p12.getBags({ bagType: forge.pki.oids.keyBag })[forge.pki.oids.keyBag] ?? [])[0];
  const certBag = (p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] ?? []).find((b) => b.cert && !b.cert.extensions.some((x: any) => x.name === 'basicConstraints' && x.cA));
  if (!keyBag?.key || !certBag?.cert) throw new Error('O arquivo não tem chave privada e certificado');
  const cert = certBag.cert;
  const cn = String(cert.subject.getField('CN')?.value ?? '');
  return {
    chavePem: forge.pki.privateKeyToPem(keyBag.key), certBase64: forge.util.encode64(forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes()),
    titular: cn, validade: cert.validity.notAfter, cnpj: /(\d{14})/.exec(cn)?.[1] ?? null,
  };
}

const DS = 'http://www.w3.org/2000/09/xmldsig#';
const C14N = 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315';
/** Assinatura XML-DSig envelopada (C14N, SHA-1/RSA-SHA1) de um elemento já canônico com Id. */
export function assinatura(canonico: string, id: string, cert: { chavePem: string; certBase64: string }) {
  const digest = createHash('sha1').update(canonico, 'utf8').digest('base64');
  const signedInfo = (ns: boolean) => `<SignedInfo${ns ? ` xmlns="${DS}"` : ''}><CanonicalizationMethod Algorithm="${C14N}"></CanonicalizationMethod><SignatureMethod Algorithm="${DS}rsa-sha1"></SignatureMethod><Reference URI="#${id}"><Transforms><Transform Algorithm="${DS}enveloped-signature"></Transform><Transform Algorithm="${C14N}"></Transform></Transforms><DigestMethod Algorithm="${DS}sha1"></DigestMethod><DigestValue>${digest}</DigestValue></Reference></SignedInfo>`;
  const valor = createSign('RSA-SHA1').update(signedInfo(true), 'utf8').sign(cert.chavePem, 'base64');
  return `<Signature xmlns="${DS}">${signedInfo(false)}<SignatureValue>${valor}</SignatureValue><KeyInfo><X509Data><X509Certificate>${cert.certBase64}</X509Certificate></X509Data></KeyInfo></Signature>`;
}

/** Assina o infNFe e devolve o NFe completo. */
export function assinarNfe(infNFe: string, chave: string, cert: { chavePem: string; certBase64: string }) {
  const sig = assinatura(infNFe, `NFe${chave}`, cert);
  return `<NFe xmlns="${NS}">${infNFe.replace(` xmlns="${NS}"`, '')}${sig}</NFe>`;
}

/** Remonta o canônico do infNFe a partir do NFe (para conferir a assinatura). */
export const infCanonico = (nfe: string) => /<infNFe[\s\S]*<\/infNFe>/.exec(nfe)![0].replace('<infNFe ', `<infNFe xmlns="${NS}" `);

/** Evento de cancelamento (110111) assinado, pronto para o lote de eventos. */
export function eventoCancelamento(p: { chave: string; cnpj: string; protocolo: string; justificativa: string; ambiente: number; quando: Date; seq?: number }, cert: { chavePem: string; certBase64: string }) {
  const seq = p.seq ?? 1;
  const id = `ID110111${p.chave}${String(seq).padStart(2, '0')}`;
  const inf = `<infEvento xmlns="${NS}" Id="${id}"><cOrgao>${p.chave.slice(0, 2)}</cOrgao><tpAmb>${p.ambiente}</tpAmb><CNPJ>${so(p.cnpj)}</CNPJ><chNFe>${p.chave}</chNFe><dhEvento>${dhBrasil(p.quando)}</dhEvento><tpEvento>110111</tpEvento><nSeqEvento>${seq}</nSeqEvento><verEvento>1.00</verEvento><detEvento versao="1.00"><descEvento>Cancelamento</descEvento><nProt>${p.protocolo}</nProt><xJust>${esc(p.justificativa)}</xJust></detEvento></infEvento>`;
  return `<evento xmlns="${NS}" versao="1.00">${inf.replace(` xmlns="${NS}"`, '')}${assinatura(inf, id, cert)}</evento>`;
}
