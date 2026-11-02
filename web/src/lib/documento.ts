// Máscaras e validação (CPF/CNPJ e celular) no navegador. A validação definitiva é sempre no servidor.
export const onlyDigits = (s: string) => s.replace(/\D+/g, '');
const allSame = (d: string) => /^(\d)\1+$/.test(d);

export function isValidCpf(raw: string) {
  const d = onlyDigits(raw);
  if (d.length !== 11 || allSame(d)) return false;
  const dv = (len: number) => { let s = 0; for (let i = 0; i < len; i++) s += Number(d[i]) * (len + 1 - i); const r = (s * 10) % 11; return r === 10 ? 0 : r; };
  return dv(9) === Number(d[9]) && dv(10) === Number(d[10]);
}
export function isValidCnpj(raw: string) {
  const d = onlyDigits(raw);
  if (d.length !== 14 || allSame(d)) return false;
  const dv = (len: number) => {
    const w = len === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    let s = 0; for (let i = 0; i < len; i++) s += Number(d[i]) * w[i];
    const r = s % 11; return r < 2 ? 0 : 11 - r;
  };
  return dv(12) === Number(d[12]) && dv(13) === Number(d[13]);
}
export const isValidDocumento = (v: string) => isValidCpf(v) || isValidCnpj(v);

/** 000.000.000-00 até 11 dígitos; acima disso, 00.000.000/0000-00. */
export function maskDocumento(v: string) {
  const d = onlyDigits(v).slice(0, 14);
  if (d.length <= 11) return d.replace(/^(\d{3})(\d)/, '$1.$2').replace(/^(\d{3})\.(\d{3})(\d)/, '$1.$2.$3').replace(/\.(\d{3})(\d{1,2})$/, '.$1-$2');
  return d.replace(/^(\d{2})(\d)/, '$1.$2').replace(/^(\d{2})\.(\d{3})(\d)/, '$1.$2.$3').replace(/\.(\d{3})(\d)/, '.$1/$2').replace(/(\d{4})(\d{1,2})$/, '$1-$2');
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
