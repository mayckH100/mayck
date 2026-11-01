/**
 * "Mesmo cliente / outros números": um cliente pode ter mais de um telefone. Cada número é um contato próprio
 * (a duplicidade é só pelo telefone); contatos da MESMA organização com o mesmo nome normalizado (sem acento,
 * sem diferença de maiúsculas e espaços) são mostrados agrupados como o mesmo cliente. Nada é mesclado pelo nome,
 * e cobranças continuam presas ao contato/telefone em que foram criadas.
 */

/** Chave do nome: sem acentos, minúsculas, espaços simples. null quando não há nome útil. */
export function nameKey(name: string | null | undefined): string | null {
  const k = String(name ?? '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  return k.length >= 2 ? k : null;
}

export interface Numbered { id: string; name: string | null; phone: string }
export interface SiblingNumber { id: string; name: string | null; phone: string }

/** Agrupa por nome normalizado (só grupos com 2+ números distintos). */
export function groupByName<T extends Numbered>(items: T[]): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const it of items) {
    const k = nameKey(it.name);
    if (!k) continue;
    const list = m.get(k);
    if (list) list.push(it); else m.set(k, [it]);
  }
  for (const [k, list] of m) if (new Set(list.map((x) => x.phone)).size < 2) m.delete(k);
  return m;
}

/** Outros números do mesmo cliente (mesmo nome normalizado, telefone diferente), excluindo o próprio registro. */
export function siblingsOf<T extends Numbered>(self: Numbered, all: T[]): SiblingNumber[] {
  const k = nameKey(self.name);
  if (!k) return [];
  return all
    .filter((x) => x.id !== self.id && x.phone !== self.phone && nameKey(x.name) === k)
    .map((x) => ({ id: x.id, name: x.name, phone: x.phone }))
    .sort((a, b) => a.phone.localeCompare(b.phone));
}

/** Quantos outros números cada item tem (para a lista). */
export function otherNumbersCount<T extends Numbered>(page: Numbered[], all: T[]): Map<string, number> {
  const byKey = new Map<string, Set<string>>();
  for (const x of all) {
    const k = nameKey(x.name);
    if (!k) continue;
    (byKey.get(k) ?? byKey.set(k, new Set()).get(k)!).add(x.phone);
  }
  const out = new Map<string, number>();
  for (const p of page) {
    const k = nameKey(p.name);
    const set = k ? byKey.get(k) : undefined;
    out.set(p.id, set ? [...set].filter((ph) => ph !== p.phone).length : 0);
  }
  return out;
}
