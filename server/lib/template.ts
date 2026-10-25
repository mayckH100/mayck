/** Substitui {{variavel}} pelos valores do contexto. Variáveis desconhecidas viram texto vazio. */
export function renderTemplate(tpl: string, vars: Record<string, unknown>): string {
  return (tpl ?? '').replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, key: string) => {
    const v = key.split('.').reduce<unknown>((acc, k) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[k] : undefined), vars);
    if (v === undefined || v === null) return '';
    return typeof v === 'object' ? JSON.stringify(v) : String(v);
  });
}

/** Renderiza recursivamente strings dentro de um objeto (corpo/cabeçalhos HTTP). */
export function renderDeep(value: unknown, vars: Record<string, unknown>): unknown {
  if (typeof value === 'string') return renderTemplate(value, vars);
  if (Array.isArray(value)) return value.map((v) => renderDeep(v, vars));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, renderDeep(v, vars)]));
  }
  return value;
}
