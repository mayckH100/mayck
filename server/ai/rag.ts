/** RAG simples: fragmentação + ranking BM25 por termos (sem embeddings, sem custo extra). */
const STOP = new Set('a o e de da do das dos em no na nos nas um uma uns umas para por com sem que se os as ao aos é ser sao são eu voce você vc me meu minha seu sua isso esse essa este esta tem ter qual quais como quando onde mais menos muito pouco ja já nao não sim ou'.split(' '));

export function tokenize(s: string): string[] {
  return (s ?? '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .split(/[^a-z0-9$,]+/).map((t) => t.replace(/,$/, ''))
    .filter((t) => t.length > 1 && !STOP.has(t));
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

export function rank<T extends { text: string }>(query: string, docs: T[], k = 3): Scored<T>[] {
  const q = [...new Set(tokenize(query))];
  if (!q.length || !docs.length) return [];
  const toks = docs.map((d) => tokenize(d.text));
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
