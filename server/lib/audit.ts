import { prisma } from '../db.js';
import type { Request } from 'express';

export async function audit(req: Request | null, action: string, opts: { orgId?: string | null; entity?: string; entityId?: string; meta?: unknown; userId?: string | null } = {}) {
  await prisma.auditLog.create({
    data: {
      orgId: opts.orgId !== undefined ? opts.orgId : req?.auth?.orgId ?? null, // null explícito = evento global
      userId: opts.userId ?? req?.auth?.userId ?? null,
      action,
      entity: opts.entity,
      entityId: opts.entityId,
      meta: JSON.stringify(opts.meta ?? {}),
      ip: req?.ip ?? null,
    },
  });
}
