/**
 * CPF/CNPJ e celular do titular da conta (dados pessoais — LGPD).
 * Guardamos só os dígitos (documento) e o celular em E.164. Nunca registre estes valores em log/auditoria;
 * na interface, use as versões mascaradas.
 */

export const onlyDigits = (s: string) => String(s ?? '').replace(/\D+/g, '');

const allSame = (d: string) => /^(\d)\1+$/.test(d);

export function isValidCpf(raw: string): boolean {
  const d = onlyDigits(raw);
  if (d.length !== 11 || allSame(d)) return false;
  const calc = (len: number) => {
    let sum = 0;
    for (let i = 0; i < len; i++) sum += Number(d[i]) * (len + 1 - i);
    const r = (sum * 10) % 11;
    return r === 10 ? 0 : r;
  };
  return calc(9) === Number(d[9]) && calc(10) === Number(d[10]);
}

export function isValidCnpj(raw: string): boolean {
  const d = onlyDigits(raw);
  if (d.length !== 14 || allSame(d)) return false;
  const calc = (len: number) => {
    const weights = len === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    let sum = 0;
    for (let i = 0; i < len; i++) sum += Number(d[i]) * weights[i];
    const r = sum % 11;
    return r < 2 ? 0 : 11 - r;
  };
  return calc(12) === Number(d[12]) && calc(13) === Number(d[13]);
}

export type TipoDocumento = 'CPF' | 'CNPJ';

/** Valida CPF (11 dígitos) ou CNPJ (14 dígitos), com ou sem máscara. Devolve só os dígitos, ou null se inválido. */
export function parseDocumento(raw: unknown): { tipo: TipoDocumento; digits: string } | null {
  if (typeof raw !== 'string' || raw.length > 30) return null;
  if (/[^\d.\-/\s]/.test(raw)) return null;
  const d = onlyDigits(raw);
  if (d.length === 11 && isValidCpf(d)) return { tipo: 'CPF', digits: d };
  if (d.length === 14 && isValidCnpj(d)) return { tipo: 'CNPJ', digits: d };
  return null;
}

/** CPF: ***.456.789-** · CNPJ: **.345.678/0001-** */
export function maskDocumento(digits: string | null | undefined): string | null {
  if (!digits) return null;
  if (digits.length === 11) return `***.${digits.slice(3, 6)}.${digits.slice(6, 9)}-**`;
  if (digits.length === 14) return `**.${digits.slice(2, 5)}.${digits.slice(5, 8)}/${digits.slice(8, 12)}-**`;
  return '***';
}

/**
 * Celular em E.164. Brasil: DDD (11–99) + 9 + 8 dígitos, com ou sem +55/0/máscara.
 * Outros países: só com "+" explícito (8 a 15 dígitos). Fixo brasileiro (sem o 9) não é aceito.
 */
export function normalizeCelular(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 30) return null;
  const s = raw.trim();
  if (!s || /[^\d+()\-.\s]/.test(s)) return null;
  const intl = s.startsWith('+') || s.startsWith('00');
  let d = onlyDigits(s);
  if (s.startsWith('00')) d = d.slice(2);
  if (intl && !d.startsWith('55')) return d.length >= 8 && d.length <= 15 && !allSame(d) ? `+${d}` : null;
  if (d.startsWith('55') && d.length === 13) d = d.slice(2);
  else if (d.startsWith('0') && d.length === 12) d = d.slice(1); // 0 + DDD + número
  if (d.length !== 11) return null;
  const ddd = Number(d.slice(0, 2));
  if (ddd < 11 || d[2] !== '9' || allSame(d.slice(3))) return null;
  return `+55${d}`;
}

/** +5511912345678 → +55 (11) 9****-5678 */
export function maskCelular(e164: string | null | undefined): string | null {
  if (!e164) return null;
  if (e164.startsWith('+55') && e164.length === 14) return `+55 (${e164.slice(3, 5)}) ${e164[5]}****-${e164.slice(-4)}`;
  return `${e164.slice(0, 3)}******${e164.slice(-3)}`;
}
