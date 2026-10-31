/**
 * Importação de contatos por planilha (CSV). Só funções puras: decodificação, leitura do CSV,
 * saneamento (anti fórmula), validação por linha e etiquetas. O acesso ao banco fica na rota.
 */
import { z } from 'zod';

export const IMPORT_MAX_BYTES = 2 * 1024 * 1024; // 2 MB
export const IMPORT_MAX_ROWS = 5000;
export const TEMPLATE_HEADER = ['nome', 'telefone', 'email', 'empresa', 'tags', 'observacoes'] as const;
export const TEMPLATE_EXAMPLE = ['Maria Silva', '(11) 99999-8888', 'maria@email.com', 'Loja Exemplo', 'cliente, vip', 'Prefere contato à tarde'];

export const LIMITS = { name: 100, email: 200, empresa: 120, tag: 40, tags: 30, notes: 5000 } as const;

/** Modelo para download: UTF-8 com BOM (o Excel reconhece acentos), separador ';', CRLF. */
export function templateCsv(): string {
  const line = (cells: readonly string[]) => cells.map(csvCell).join(';');
  return '\uFEFF' + line(TEMPLATE_HEADER) + '\r\n' + line(TEMPLATE_EXAMPLE) + '\r\n';
}
function csvCell(v: string) {
  return /[";\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
}

/** Bytes → texto. Planilha salva pelo Excel em PT-BR costuma vir em Windows-1252; se não for UTF-8 válido, usa ela. */
export function decodeCsv(buf: Buffer): string {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    text = new TextDecoder('windows-1252').decode(buf);
  }
  return text.replace(/^\uFEFF/, '');
}

/** Separador pela primeira linha (fora de aspas): ';' ou ','. Empate/nenhum → ';'. */
export function detectDelimiter(text: string): ';' | ',' {
  let semi = 0, comma = 0, inQ = false;
  for (const ch of text) {
    if (ch === '"') inQ = !inQ;
    else if (!inQ && (ch === '\n' || ch === '\r')) break;
    else if (!inQ && ch === ';') semi++;
    else if (!inQ && ch === ',') comma++;
  }
  return comma > semi ? ',' : ';';
}

/** Leitor CSV (RFC 4180): campos entre aspas, "" como aspa literal, quebras de linha dentro de aspas. */
export function parseCsv(text: string, delim: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = '', inQ = false, i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQ = false; i++; continue;
      }
      field += ch; i++; continue;
    }
    if (ch === '"' && field === '') { inQ = true; i++; continue; }
    if (ch === delim) { row.push(field); field = ''; i++; continue; }
    if (ch === '\r' || ch === '\n') {
      row.push(field); rows.push(row); row = []; field = '';
      i += ch === '\r' && text[i + 1] === '\n' ? 2 : 1;
      continue;
    }
    field += ch; i++;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/** Remove = + - @ (e tab/CR) do início — evita que a célula vire fórmula ao reabrir no Excel/Sheets. */
export function sanitizeText(v: string | undefined, max: number): string {
  let s = (v ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim();
  while (/^[=+\-@\t\r]/.test(s)) s = s.slice(1).trimStart();
  return s.slice(0, max).trim();
}

const norm = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z]/g, '');
const HEADER_ALIASES: Record<string, keyof RawRow> = {
  nome: 'nome', name: 'nome',
  telefone: 'telefone', phone: 'telefone', celular: 'telefone', whatsapp: 'telefone', fone: 'telefone',
  email: 'email',
  empresa: 'empresa', company: 'empresa',
  tags: 'tags', tag: 'tags', etiquetas: 'tags', etiqueta: 'tags',
  observacoes: 'observacoes', observacao: 'observacoes', obs: 'observacoes', notas: 'observacoes', notes: 'observacoes',
};
type RawRow = { nome: string; telefone: string; email: string; empresa: string; tags: string; observacoes: string };

export type ParsedRow = { line: number; raw: RawRow };
export type ParseResult = { ok: true; rows: ParsedRow[] } | { ok: false; error: string };

/** Lê o CSV inteiro: cabeçalho obrigatório com nome e telefone; ignora linhas vazias e "sep=;" do Excel. */
export function readSheet(text: string): ParseResult {
  let body = text;
  const sepLine = body.match(/^sep=(.)\r?\n/i);
  const delim = sepLine ? sepLine[1] : detectDelimiter(body);
  if (sepLine) body = body.slice(sepLine[0].length);
  const all = parseCsv(body, delim);
  let start = 0;
  while (start < all.length && all[start].every((c) => !c.trim())) start++;
  if (start >= all.length) return { ok: false, error: 'A planilha está vazia.' };
  const header = all[start].map((h) => HEADER_ALIASES[norm(h)]);
  if (!header.includes('nome') || !header.includes('telefone')) {
    return { ok: false, error: 'Cabeçalho inválido: a primeira linha precisa ter as colunas nome e telefone (baixe o modelo).' };
  }
  const rows: ParsedRow[] = [];
  for (let i = start + 1; i < all.length; i++) {
    const cells = all[i];
    if (cells.every((c) => !c.trim())) continue;
    const raw: RawRow = { nome: '', telefone: '', email: '', empresa: '', tags: '', observacoes: '' };
    header.forEach((key, idx) => { if (key && !raw[key]) raw[key] = cells[idx] ?? ''; });
    rows.push({ line: i + 1 + (sepLine ? 1 : 0), raw });
    if (rows.length > IMPORT_MAX_ROWS) return { ok: false, error: `A planilha passa do limite de ${IMPORT_MAX_ROWS} linhas. Divida em arquivos menores.` };
  }
  if (!rows.length) return { ok: false, error: 'Nenhum contato encontrado abaixo do cabeçalho.' };
  return { ok: true, rows };
}

/** Etiquetas separadas por vírgula ou barra vertical; sem repetição (ignora maiúsculas). */
export function splitTags(v: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const part of v.split(/[,|]/)) {
    const t = sanitizeText(part, LIMITS.tag);
    if (!t || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    out.push(t);
    if (out.length >= LIMITS.tags) break;
  }
  return out;
}

const emailSchema = z.string().email();

export type RowStatus = 'ok' | 'error' | 'duplicate';
export type CheckedRow = {
  line: number; status: RowStatus; messages: string[];
  name: string; phone: string; waId: string | null; email: string; empresa: string; tags: string[]; notes: string;
  existingId?: string;
};

/**
 * Valida as linhas. `normalizePhone` é o mesmo normalizador do cadastro manual; `existing` mapeia waId → id
 * dos contatos que já existem na organização; `canonicalTag` devolve a grafia de uma etiqueta já usada.
 */
export function checkRows(rows: ParsedRow[], normalizePhone: (s: string) => string | null, existing: Map<string, string>, canonicalTag: (t: string) => string): CheckedRow[] {
  const seenInFile = new Map<string, number>();
  return rows.map(({ line, raw }) => {
    const name = sanitizeText(raw.nome, LIMITS.name);
    const phoneRaw = sanitizeText(raw.telefone.replace(/^\s*\+/, ''), 30);
    const email = sanitizeText(raw.email, LIMITS.email);
    const r: CheckedRow = {
      line, status: 'ok', messages: [], name, phone: phoneRaw, waId: null, email,
      empresa: sanitizeText(raw.empresa, LIMITS.empresa), tags: splitTags(raw.tags).map(canonicalTag),
      notes: sanitizeText(raw.observacoes, LIMITS.notes),
    };
    if (!name) r.messages.push('Nome é obrigatório');
    if (!phoneRaw) r.messages.push('Telefone é obrigatório');
    else {
      r.waId = normalizePhone(phoneRaw);
      if (!r.waId) r.messages.push('Telefone inválido (use DDD + número, ex.: 11999998888)');
      else r.phone = '+' + r.waId;
    }
    if (email && !emailSchema.safeParse(email).success) r.messages.push('E-mail inválido');
    if (r.messages.length) { r.status = 'error'; return r; }
    const firstLine = seenInFile.get(r.waId!);
    if (firstLine !== undefined) {
      r.status = 'duplicate';
      r.messages.push(`Telefone repetido na planilha (linha ${firstLine})`);
      return r;
    }
    seenInFile.set(r.waId!, line);
    const ex = existing.get(r.waId!);
    if (ex) { r.status = 'duplicate'; r.existingId = ex; r.messages.push('Já existe um contato com este telefone'); }
    return r;
  });
}
