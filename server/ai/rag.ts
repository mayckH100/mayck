/** RAG simples: fragmentação + ranking BM25 por termos (sem embeddings, sem custo extra). */
const STOP = new Set('a o e de da do das dos em no na nos nas um uma uns umas para pra pro por com sem que se os as ao aos e ser sao eu voce voces vc vcs me meu minha seu sua isso esse essa este esta tem ter qual quais como quando onde mais menos muito pouco ja nao sim ou oi ola la ai entao'.split(' '));

/** Sufixos (do mais longo ao mais curto) retirados pelo radical leve em português. */
const SUFFIXES = ['amentos', 'imentos', 'amento', 'imento', 'acoes', 'icoes', 'encias', 'ancias', 'mente', 'acao', 'icao', 'coes', 'encia', 'ancia', 'entes', 'antes', 'adoras', 'adores', 'adora', 'ador', 'ados', 'adas', 'idos', 'idas', 'ando', 'endo', 'indo', 'ente', 'ante', 'cao', 'oes', 'ais', 'eis', 'ado', 'ada', 'ido', 'ida', 'ar', 'er', 'ir', 'ao', 'es', 'as', 'os', 'e', 'a', 'o', 's'];
/** Radicais que são a mesma ideia (conexão/conectar, contratação/contratar…). */
const SAME = new Map<string, string>([['conex', 'conect'], ['conet', 'conect'], ['pag', 'pagament'], ['pagament', 'pagament'], ['assinatur', 'assin'], ['cadastr', 'cadastr'], ['inscri', 'cadastr'], ['concorrenc', 'concorr'], ['valor', 'prec'], ['cust', 'prec'], ['zap', 'whatsapp'], ['wpp', 'whatsapp'], ['whats', 'whatsapp']]);

/** Radical leve (sem dicionário): conectar/conecte/conectado → "conect"; concorrência/concorrente → "concorr". */
export function stem(t: string): string {
  if (t.length <= 4 || /\d/.test(t)) return SAME.get(t) ?? t;
  let r = t;
  for (const suf of SUFFIXES) {
    if (r.endsWith(suf) && r.length - suf.length >= 4) { r = r.slice(0, -suf.length); break; }
  }
  return SAME.get(r) ?? r;
}

/** Sem acentos, minúsculo, sem palavras vazias, com radical. */
export function tokenize(s: string): string[] {
  return (s ?? '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .split(/[^a-z0-9$,]+/).map((t) => t.replace(/,$/, ''))
    .filter((t) => t.length > 1 && !STOP.has(t))
    .map(stem);
}

export function chunkText(content: string, size = 700, overlap = 120): string[] {
  const clean = content.replace(/\r/g, '').trim();
  if (!clean) return [];
  const paras = clean.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const chunks: string[] = [];
  let cur = '';
  for (const p of paras) {
    if ((cur + '\n\n' + p).length <= size) { cur = cur ? cur + '\n\n' + p : p; continue; }
    if (cur) chunks.push(cur);
    if (p.length <= size) { cur = p; continue; }
    for (let i = 0; i < p.length; i += size - overlap) chunks.push(p.slice(i, i + size));
    cur = '';
  }
  if (cur) chunks.push(cur);
  return chunks;
}

export interface Scored<T> { item: T; score: number }

/**
 * Ranking BM25. `scoreText` (opcional) é o texto usado na pontuação (ex.: título + trecho); o título conta 2x.
 * Devolve até k trechos com pontuação > 0 (qualquer termo em comum basta).
 */
export function rank<T extends { text: string; scoreText?: string }>(query: string, docs: T[], k = 3): Scored<T>[] {
  const q = [...new Set(tokenize(query))];
  if (!q.length || !docs.length) return [];
  const toks = docs.map((d) => tokenize(d.scoreText ?? d.text));
  const avg = toks.reduce((a, t) => a + t.length, 0) / toks.length || 1;
  const df = new Map<string, number>();
  for (const t of toks) for (const term of new Set(t)) df.set(term, (df.get(term) ?? 0) + 1);
  const N = docs.length, k1 = 1.2, b = 0.75;
  return docs
    .map((item, i) => {
      const tf = new Map<string, number>();
      for (const term of toks[i]) tf.set(term, (tf.get(term) ?? 0) + 1);
      let score = 0;
      for (const term of q) {
        const f = tf.get(term) ?? 0;
        if (!f) continue;
        const n = df.get(term) ?? 0;
        const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
        score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * toks[i].length) / avg)));
      }
      return { item, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b2) => b2.score - a.score)
    .slice(0, k);
}
