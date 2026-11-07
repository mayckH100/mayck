/**
 * Leitor de CSV da importação de leads (vírgula ou ponto e vírgula, aspas, BOM, CRLF). Cabeçalhos aceitos
 * (sem acento/maiúsculas): nome, empresa, segmento, telefone (celular/whatsapp), email (e-mail), consentimento.
 */
const ALIASES: Record<string, string> = {
  nome: 'nome', name: 'nome', contato: 'nome',
  empresa: 'empresa', company: 'empresa', razaosocial: 'empresa',
  segmento: 'segmento', segment: 'segmento', ramo: 'segmento',
  telefone: 'telefone', celular: 'telefone', whatsapp: 'telefone', fone: 'telefone', phone: 'telefone',
  email: 'email', mail: 'email',
  consentimento: 'consentimento', consent: 'consentimento', autorizou: 'consentimento',
};
const key = (h: string) => h.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z]/g, '');

export function splitCsv(text: string): string[][] {
  const src = text.replace(/^\uFEFF/, '');
  const firstLine = src.split(/\r?\n/, 1)[0] ?? '';
  const sep = (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ';' : ',';
  const rows: string[][] = [];
  let row: string[] = [], cur = '', q = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (q) {
      if (c === '"') { if (src[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c;
    } else if (c === '"') q = true;
    else if (c === sep) { row.push(cur); cur = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(cur); cur = '';
      if (row.some((x) => x.trim())) rows.push(row);
      row = [];
    } else cur += c;
  }
  row.push(cur);
  if (row.some((x) => x.trim())) rows.push(row);
  return rows;
}

export type CsvLead = { nome?: string; empresa?: string; segmento?: string; telefone?: string; email?: string; consentimento?: string };

export function parseCsv(text: string): CsvLead[] {
  const rows = splitCsv(text);
  if (rows.length < 2) return [];
  const head = rows[0].map((h) => ALIASES[key(h)] ?? null);
  return rows.slice(1).map((r) => {
    const o: Record<string, string> = {};
    head.forEach((h, i) => { if (h && r[i] !== undefined && !o[h]) o[h] = r[i].trim().slice(0, 200); });
    return o as CsvLead;
  });
}
