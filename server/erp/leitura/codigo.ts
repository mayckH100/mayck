/**
 * Leitura unificada (v1.34.0) — regras puras, sem banco (servidor e web). Testadas em tests/unit/erp-leitura.test.ts.
 * Um código lido pelo leitor USB/Bluetooth (que "digita" + Enter), pela câmera do celular ou digitado pode ser:
 *  - pedido de venda: código impresso no pedido/romaneio/recibo ("PV-123"; também "PV123", "MCKPV:123");
 *  - chave de NF-e/NFC-e (44 dígitos): código de barras do DANFE, chave digitada com espaços, ou o QR da NFC-e
 *    (URL com "chNFe=" ou "p=<chave>|...");
 *  - etiqueta do lote (GS1-128 ou QR "MCK1;...");
 *  - outro código: código de barras do produto (EAN/GTIN), código (SKU), número do lote, número do pedido/nota ou texto.
 */
import { lerCodigo } from '../estoque/codigoLote.js';

export const PREFIXO_CODIGO_PEDIDO = 'PV-';
/** Conteúdo do QR/código de barras do pedido (Code 128): "PV-123". */
export const codigoPedido = (numero: number) => `${PREFIXO_CODIGO_PEDIDO}${numero}`;

export type Leitura =
  | { tipo: 'pedido'; numero: number; bruto: string }
  | { tipo: 'chave_nfe'; chave: string; valida: boolean; modelo: '55' | '65' | null; bruto: string }
  | { tipo: 'etiqueta'; bruto: string }
  | { tipo: 'codigo'; bruto: string };

/** Dígito verificador da chave de acesso (módulo 11, pesos 2..9 da direita para a esquerda). */
export function chaveNfeValida(chave: string): boolean {
  if (!/^\d{44}$/.test(chave)) return false;
  let soma = 0; let peso = 2;
  for (let i = 42; i >= 0; i--) { soma += Number(chave[i]) * peso; peso = peso === 9 ? 2 : peso + 1; }
  const resto = soma % 11;
  const dv = resto < 2 ? 0 : 11 - resto;
  return dv === Number(chave[43]);
}

/** Tira a chave de 44 dígitos do que foi lido (código de barras do DANFE, chave com espaços, QR da NFC-e). */
export function extrairChave(bruto: string): string | null {
  const s = bruto.trim();
  const url = /(?:chNFe=|[?&]p=)(\d{44})/i.exec(s);
  if (url) return url[1];
  const d = s.replace(/^(nfe|nfce|cfe)/i, '').replace(/[\s.\-/]/g, '');
  return /^\d{44}$/.test(d) ? d : null;
}

export function classificarLeitura(entrada: string): Leitura {
  const bruto = (entrada ?? '').replace(/[\r\n]+/g, '').trim().slice(0, 600);
  const pv = /^(?:MCK)?PV[-:\s]?0*(\d{1,9})$/i.exec(bruto);
  if (pv && Number(pv[1]) > 0) return { tipo: 'pedido', numero: Number(pv[1]), bruto };
  const chave = extrairChave(bruto);
  if (chave) { const m = chave.slice(20, 22); return { tipo: 'chave_nfe', chave, valida: chaveNfeValida(chave), modelo: m === '55' || m === '65' ? m : null, bruto }; }
  if (lerCodigo(bruto).tipo !== 'simples') return { tipo: 'etiqueta', bruto };
  return { tipo: 'codigo', bruto };
}
