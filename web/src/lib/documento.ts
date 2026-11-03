// Máscaras e validação (CPF/CNPJ e celular) no navegador. A validação definitiva é sempre no servidor.
export const onlyDigits = (s: string) => s.replace(/\D+/g, '');
const allSame = (d: string) => /^(\d)\1+$/.test(d);

export function isValidCpf(raw: string) {
  const d = onlyDigits(raw);
  if (d.length !== 11 || allSame(d)) return false;
  const dv = (len: number) => { let s = 0; for (let i = 0; i < len; i++) s += Number(d[i]) * (len + 1 - i); const r = (s * 10) % 11; return r === 10 ? 0 : r; };
  return dv(9) === Number(d[9]) && dv(10) === Number(d[10]);
}
/** Tira a máscara e põe em maiúsculas (o CNPJ alfanumérico tem letras). */
export const normalizeDocumento = (s: string) => s.replace(/[^0-9A-Za-z]+/g, '').toUpperCase();

/** CNPJ numérico ou alfanumérico: 12 caracteres A-Z/0-9 + 2 dígitos; valor = ASCII − 48 (Receita Federal). */
export function isValidCnpj(raw: string) {
  const d = normalizeDocumento(raw);
  if (!/^[A-Z0-9]{12}\d{2}$/.test(d) || /^(.)\1+$/.test(d)) return false;
  const dv = (len: number) => {
    const w = len === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    let s = 0; for (let i = 0; i < len; i++) s += (d.charCodeAt(i) - 48) * w[i];
    const r = s % 11; return r < 2 ? 0 : 11 - r;
  };
  return dv(12) === Number(d[12]) && dv(13) === Number(d[13]);
}
export const isValidDocumento = (v: string) => (/[A-Za-z]/.test(v) ? false : isValidCpf(v)) || isValidCnpj(v);

/**
 * Só dígitos: 000.000.000-00 até 11; acima disso, 00.000.000/0000-00.
 * Com letra (CNPJ alfanumérico): AA.AAA.AAA/AAAA-00 em maiúsculas; os 2 últimos são sempre dígitos.
 */
export function maskDocumento(v: string) {
  let d = normalizeDocumento(v).slice(0, 14);
  if (!/[A-Z]/.test(d) && d.length <= 11) return d.replace(/^(\d{3})(\d)/, '$1.$2').replace(/^(\d{3})\.(\d{3})(\d)/, '$1.$2.$3').replace(/\.(\d{3})(\d{1,2})$/, '.$1-$2');
  if (d.length > 12) d = d.slice(0, 12) + d.slice(12).replace(/\D/g, '');
  const p = [d.slice(0, 2), d.slice(2, 5), d.slice(5, 8), d.slice(8, 12), d.slice(12, 14)];
  let out = p[0];
  if (p[1]) out += '.' + p[1];
  if (p[2]) out += '.' + p[2];
  if (p[3]) out += '/' + p[3];
  if (p[4]) out += '-' + p[4];
  return out;
}

/** (11) 91234-5678 */
export function maskCelular(v: string) {
  if (v.trim().startsWith('+') && !v.trim().startsWith('+55')) return v.replace(/[^\d+\s]/g, '').slice(0, 20);
  let d = onlyDigits(v);
  if (d.startsWith('55') && d.length > 11) d = d.slice(2);
  d = d.slice(0, 11);
  if (d.length <= 2) return d.length ? `(${d}` : '';
  if (d.length <= 7) return `(${d.slice(0, 2)}) ${d.slice(2)}`;
  return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
}
export function isValidCelular(v: string) {
  const s = v.trim();
  if (s.startsWith('+') && !s.startsWith('+55')) return onlyDigits(s).length >= 8;
  let d = onlyDigits(s);
  if (d.startsWith('55') && d.length === 13) d = d.slice(2);
  return d.length === 11 && Number(d.slice(0, 2)) >= 11 && d[2] === '9';
}
