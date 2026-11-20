/** Trilha de auditoria do ERP: reaproveita o AuditLog do MCKBOT (só inserção) com antes/depois. */
import type { Request } from 'express';
import { audit } from '../../lib/audit.js';

export function auditar(req: Request, acao: string, entidade: string, id: string, antes?: unknown, depois?: unknown) {
  return audit(req, `erp.${acao}`, { entity: entidade, entityId: id, meta: { antes: antes ?? null, depois: depois ?? null } });
}

/**
 * v1.33.0: o que mudou num cadastro (antes → depois), só os campos alterados, para o AuditLog "quem mudou o quê".
 * Campos ignorados: datas internas e ids técnicos.
 */
export function diferencas(antes: Record<string, unknown>, depois: Record<string, unknown>, ignorar: string[] = ['updatedAt', 'createdAt', 'id', 'orgId']) {
  const a: Record<string, unknown> = {}; const d: Record<string, unknown> = {};
  const norm = (v: unknown) => (v instanceof Date ? v.toISOString() : v === undefined || v === '' ? null : v);
  for (const k of Object.keys(depois)) {
    if (ignorar.includes(k) || !(k in antes)) continue;
    if (JSON.stringify(norm(antes[k])) !== JSON.stringify(norm(depois[k]))) { a[k] = norm(antes[k]); d[k] = norm(depois[k]); }
  }
  return { antes: a, depois: d, campos: Object.keys(d) };
}
