/**
 * Comunicação com a SEFAZ (SOAP 1.2 com certificado A1 do cliente): status do serviço, autorização síncrona e evento
 * de cancelamento. Endpoints: SP (própria) e UFs atendidas pela SVRS. As demais UFs com SEFAZ própria ficam para depois.
 * Não testado contra a SEFAZ real (precisa do certificado do cliente); os testes cobrem montagem e leitura das respostas.
 */
import https from 'node:https';
import { NS } from './nfe.js';
import { tag } from '../estoque/nfe-xml.js';

type Servico = 'autorizacao' | 'status' | 'evento';
const SP = { autorizacao: 'nfeautorizacao4.asmx', status: 'nfestatusservico4.asmx', evento: 'nferecepcaoevento4.asmx' };
const SVRS = { autorizacao: 'NfeAutorizacao/NFeAutorizacao4.asmx', status: 'NfeStatusServico/NfeStatusServico4.asmx', evento: 'recepcaoevento/recepcaoevento4.asmx' };
const UFS_SVRS = ['AC', 'AL', 'AP', 'DF', 'ES', 'PA', 'PB', 'PI', 'RJ', 'RN', 'RO', 'RR', 'SC', 'SE', 'TO'];
const WSDL: Record<Servico, string> = { autorizacao: 'NFeAutorizacao4', status: 'NFeStatusServico4', evento: 'NFeRecepcaoEvento4' };

export function urlSefaz(uf: string, ambiente: number, s: Servico) {
  if (uf === 'SP') return `https://${ambiente === 1 ? 'nfe' : 'homologacao.nfe'}.fazenda.sp.gov.br/ws/${SP[s]}`;
  if (UFS_SVRS.includes(uf)) return `https://${ambiente === 1 ? 'nfe' : 'nfe-homologacao'}.svrs.rs.gov.br/ws/${SVRS[s]}`;
  throw new Error(`A emissão para ${uf} ainda não está configurada (SEFAZ própria). Hoje: SP e UFs da SVRS.`);
}

export const envelope = (s: Servico, corpo: string) =>
  `<?xml version="1.0" encoding="utf-8"?><soap12:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap12="http://www.w3.org/2003/05/soap-envelope"><soap12:Body><nfeDadosMsg xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/${WSDL[s]}">${corpo}</nfeDadosMsg></soap12:Body></soap12:Envelope>`;

function chamar(url: string, xml: string, cert: { chavePem: string; certBase64: string }, timeoutMs = 30_000): Promise<string> {
  const certPem = `-----BEGIN CERTIFICATE-----\n${cert.certBase64.match(/.{1,64}/g)!.join('\n')}\n-----END CERTIFICATE-----\n`;
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method: 'POST', key: cert.chavePem, cert: certPem,
      // A cadeia ICP-Brasil da SEFAZ não está no repositório de CAs do Node. SEFAZ_CA_PEM permite fixá-la; sem ela, aceita.
      ca: process.env.SEFAZ_CA_PEM || undefined, rejectUnauthorized: !!process.env.SEFAZ_CA_PEM,
      headers: { 'Content-Type': 'application/soap+xml; charset=utf-8', 'Content-Length': Buffer.byteLength(xml) },
      timeout: timeoutMs,
    }, (res) => { let b = ''; res.setEncoding('utf8'); res.on('data', (c) => (b += c)); res.on('end', () => resolve(b)); });
    req.on('timeout', () => req.destroy(new Error('A SEFAZ não respondeu a tempo')));
    req.on('error', (e) => reject(new Error(`Falha ao falar com a SEFAZ: ${e.message}`)));
    req.end(xml);
  });
}

export async function statusServico(uf: string, ambiente: number, cnpjUfIbge: string, cert: { chavePem: string; certBase64: string }) {
  const corpo = `<consStatServ xmlns="${NS}" versao="4.00"><tpAmb>${ambiente}</tpAmb><cUF>${cnpjUfIbge}</cUF><xServ>STATUS</xServ></consStatServ>`;
  const r = await chamar(urlSefaz(uf, ambiente, 'status'), envelope('status', corpo), cert);
  return { cStat: tag(r, 'cStat'), motivo: tag(r, 'xMotivo') };
}

/** Lê o retorno da autorização síncrona (protNFe) ou o motivo do lote. */
export function lerRetornoAutorizacao(r: string) {
  const prot = /<protNFe[\s\S]*?<\/protNFe>/.exec(r)?.[0] ?? null;
  if (prot) return { cStat: tag(prot, 'cStat'), motivo: tag(prot, 'xMotivo'), protocolo: tag(prot, 'nProt'), protNFe: prot };
  return { cStat: tag(r, 'cStat'), motivo: tag(r, 'xMotivo'), protocolo: null, protNFe: null };
}

export async function autorizar(uf: string, ambiente: number, nfeAssinada: string, cert: { chavePem: string; certBase64: string }) {
  const corpo = `<enviNFe xmlns="${NS}" versao="4.00"><idLote>${Date.now().toString().slice(-15)}</idLote><indSinc>1</indSinc>${nfeAssinada}</enviNFe>`;
  return lerRetornoAutorizacao(await chamar(urlSefaz(uf, ambiente, 'autorizacao'), envelope('autorizacao', corpo), cert));
}

export const nfeProc = (nfe: string, protNFe: string) => `<?xml version="1.0" encoding="UTF-8"?><nfeProc xmlns="${NS}" versao="4.00">${nfe}${protNFe}</nfeProc>`;

export async function enviarEvento(uf: string, ambiente: number, eventoAssinado: string, cert: { chavePem: string; certBase64: string }) {
  const corpo = `<envEvento xmlns="${NS}" versao="1.00"><idLote>${Date.now().toString().slice(-15)}</idLote>${eventoAssinado}</envEvento>`;
  const r = await chamar(urlSefaz(uf, ambiente, 'evento'), envelope('evento', corpo), cert);
  const ret = /<retEvento[\s\S]*?<\/retEvento>/.exec(r)?.[0] ?? r;
  return { cStat: tag(ret, 'cStat'), motivo: tag(ret, 'xMotivo'), protocolo: tag(ret, 'nProt') };
}

