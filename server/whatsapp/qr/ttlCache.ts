/**
 * Cache em memória com validade (TTL) e limite de tamanho, compatível com o CacheStore do Baileys
 * (get/set/del/flushAll + mget/mset/mdel). Usado para a lista de aparelhos dos contatos, o contador
 * de reenvios e os metadados de grupo — sem dependência extra.
 */
export class TtlCache {
  private map = new Map<string, { v: unknown; exp: number }>();
  constructor(private ttlMs: number, private max = 5000) {}

  get<T>(key: string): T | undefined {
    const e = this.map.get(key);
    if (!e) return undefined;
    if (e.exp <= Date.now()) { this.map.delete(key); return undefined; }
    return e.v as T;
  }
  set<T>(key: string, value: T): boolean {
    this.map.delete(key);
    this.map.set(key, { v: value, exp: Date.now() + this.ttlMs });
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value as string);
    return true;
  }
  del(key: string): boolean { return this.map.delete(key); }
  flushAll(): void { this.map.clear(); }
  async mget<T>(keys: string[]): Promise<Record<string, T | undefined>> {
    const out: Record<string, T | undefined> = {};
    for (const k of keys) out[k] = this.get<T>(k);
    return out;
  }
  mset<T>(entries: { key: string; value: T }[]): boolean { for (const e of entries) this.set(e.key, e.value); return true; }
  mdel(keys: string[]): boolean { for (const k of keys) this.map.delete(k); return true; }
  close(): void { this.map.clear(); }
  get size() { return this.map.size; }
}
