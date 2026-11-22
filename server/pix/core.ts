/**
 * v1.44.0 — Cobrança Pix na conversa (puro, testável).
 * Gera o "Pix copia e cola" (BR Code EMV estático, CRC16-CCITT) com a chave da própria empresa: sem intermediário
 * e sem taxa. Reaproveita a geração do Financeiro do ERP (server/erp/financeiro/calculo.ts).
 */
import { pixCopiaECola, crc16 } from '../erp/financeiro/calculo.js';

export { crc16, pixCopiaECola };

export const TIPOS_CHAVE = ['cpf', 'cnpj', 'email', 'telefone', 'aleatoria'] as const;
export type TipoChave = typeof TIPOS_CHAVE[number];
export const ROTULO_TIPO: Record<TipoChave, string> = { cpf: 'CPF', cnpj: 'CNPJ', email: 'E-mail', telefone: 'Telefone', aleatoria: 'Chave aleatória' };
export const VALOR_MAX_CENTS = 100_000_000; // R$ 1.000.000,00

function cpfValido(d: string): boolean {
  if (!/^\d{11}$/.test(d) || /^(\d)\1{10}$/.test(d)) return false;
  const dv = (n: number) => { let s = 0; for (let i = 0; i < n; i++) s += Number(d[i]) * (n + 1 - i); const r = (s * 10) % 11; return r === 10 ? 0 : r; };
  return dv(9) === Number(d[9]) && dv(10) === Number(d[10]);
}
// CNPJ numérico ou alfanumérico (regra oficial: valor do caractere = código ASCII − 48).
function cnpjValido(c: string): boolean {
  if (!/^[0-9A-Z]{12}\d{2}$/.test(c) || /^(\d)\1{13}$/.test(c)) return false;
  const v = (ch: string) => ch.charCodeAt(0) - 48;
  const dv = (n: number) => {
    const pesos = n === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    const s = pesos.reduce((a, p, i) => a + v(c[i]) * p, 0);
    const r = s % 11;
    return r < 2 ? 0 : 11 - r;
  };
  return dv(12) === Number(c[12]) && dv(13) === Number(c[13]);
}

/** Valida e normaliza a chave Pix conforme o tipo. Devolve a chave pronta para o BR Code ou o erro. */
export function normalizarChave(tipo: string, chave: string): { ok: true; chave: string } | { ok: false; erro: string } {
  const c = (chave || '').trim();
  switch (tipo) {
    case 'cpf': { const d = c.replace(/\D/g, ''); return cpfValido(d) ? { ok: true, chave: d } : { ok: false, erro: 'CPF inválido' }; }
    case 'cnpj': { const d = c.toUpperCase().replace(/[^0-9A-Z]/g, ''); return cnpjValido(d) ? { ok: true, chave: d } : { ok: false, erro: 'CNPJ inválido' }; }
    case 'email': { const e = c.toLowerCase(); return /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/.test(e) && e.length <= 77 ? { ok: true, chave: e } : { ok: false, erro: 'E-mail inválido' }; }
    case 'telefone': {
      let d = c.replace(/\D/g, '');
      if (d.length === 10 || d.length === 11) d = '55' + d;
      return /^55\d{10,11}$/.test(d) ? { ok: true, chave: '+' + d } : { ok: false, erro: 'Telefone inválido: use DDD + número (ex.: 11 91234-5678)' };
    }
    case 'aleatoria': {
      const k = c.toLowerCase();
      return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(k) ? { ok: true, chave: k } : { ok: false, erro: 'Chave aleatória inválida (formato 123e4567-e89b-12d3-a456-426614174000)' };
    }
    default: return { ok: false, erro: 'Tipo de chave inválido' };
  }
}

/** "150", "150,5", "1.234,56", "R$ 10,00", "10.5" → centavos. null se inválido. */
export function valorEmCentavos(v: string | number): number | null {
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? Math.round(v * 100) : null;
  let s = (v || '').replace(/R\$|\s/gi, '');
  if (!/^\d[\d.,]*$/.test(s)) return null;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  else if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) return null;
  const cents = Math.round(n * 100);
  return cents > 0 && cents <= VALOR_MAX_CENTS ? cents : null;
}

export const brl = (cents: number) => (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

/** Identificador da cobrança no BR Code (até 25 letras/números). */
export function txidDe(id: string): string {
  return ('MCK' + id.replace(/[^A-Za-z0-9]/g, '')).slice(0, 25);
}

/** Código copia e cola da cobrança. */
export function codigoCobranca(cfg: { key: string; name: string; city: string }, valorCents: number, txid: string): string {
  return pixCopiaECola({ chave: cfg.key, nome: cfg.name, cidade: cfg.city, valorCents, txid });
}

/** Texto que acompanha o QR code. */
export function textoCobranca(valorCents: number, descricao: string, recebedor: string): string {
  const d = descricao.trim();
  return [`💠 *Pix de ${brl(valorCents)}*${d ? ` — ${d}` : ''}`, `Recebedor: ${recebedor}`, 'Pague pelo QR code ou copie o código "Pix copia e cola" da próxima mensagem no app do seu banco.'].join('\n');
}

/** Confere a estrutura de um BR Code (campos TLV e CRC). Puro; usado nos testes e como proteção antes de enviar. */
export function brCodeValido(code: string): boolean {
  if (!/^000201/.test(code) || code.length < 30) return false;
  const corpo = code.slice(0, -4);
  if (!corpo.endsWith('6304')) return false;
  let i = 0;
  while (i < corpo.length - 4) {
    const len = Number(corpo.slice(i + 2, i + 4));
    if (!Number.isFinite(len)) return false;
    i += 4 + len;
  }
  if (i !== corpo.length - 4) return false;
  return crcOk(code);
}
function crcOk(code: string) { return crc16(code.slice(0, -4)) === code.slice(-4); }
