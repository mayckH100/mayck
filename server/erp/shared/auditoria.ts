/** Trilha de auditoria do ERP: reaproveita o AuditLog do MCKBOT (só inserção) com antes/depois. */
import type { Request } from 'express';
import { audit } from '../../lib/audit.js';

export function auditar(req: Request, acao: string, entidade: string, id: string, antes?: unknown, depois?: unknown) {
  return audit(req, `erp.${acao}`, { entity: entidade, entityId: id, meta: { antes: antes ?? null, depois: depois ?? null } });
}
