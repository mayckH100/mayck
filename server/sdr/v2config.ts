import { prisma } from '../db.js';
import { parseJson } from '../lib/json.js';

/**
 * Configurações do SDR v2 (v1.19.0) SEM migração: a versão mais recente fica no AuditLog da empresa
 * (ação `sdr.v2.config`, meta JSON). Assim a mudança também aparece na Auditoria.
 *  - kanbanSync: etapa do lead do SDR ↔ etapa do contato no Kanban do MCKBOT (padrão ligado);
 *  - rodizio: distribuição automática de leads novos sem dono entre os membros escolhidos (padrão desligado);
 *  - embedDomains: sites que podem mostrar o formulário incorporado (vazio = qualquer site com HTTPS).
 */
export const SDR_V2_ACTION = 'sdr.v2.config';

export interface SdrV2Config {
  kanbanSync: boolean;
  rodizio: { enabled: boolean; members: string[] };
  embedDomains: string[];
}

export const DEFAULT_V2: SdrV2Config = { kanbanSync: true, rodizio: { enabled: false, members: [] }, embedDomains: [] };

/** Domínio permitido no frame-ancestors: host simples (com "*." opcional no começo), sem esquema, porta ou caminho. */
const HOST_RE = /^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/;
export function normalizeDomains(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  const out: string[] = [];
  for (const raw of list.slice(0, 20)) {
    let d = String(raw ?? '').trim().toLowerCase();
    d = d.replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/:\d+$/, '');
    if (d && HOST_RE.test(d) && !out.includes(d)) out.push(d);
  }
  return out;
}

export function normalizeV2(raw: unknown): SdrV2Config {
  const r = (raw && typeof raw === 'object' ? raw : {}) as any;
  const members = Array.isArray(r.rodizio?.members) ? [...new Set(r.rodizio.members.map((m: unknown) => String(m ?? '').slice(0, 40)).filter(Boolean))].slice(0, 50) as string[] : [];
  return {
    kanbanSync: typeof r.kanbanSync === 'boolean' ? r.kanbanSync : DEFAULT_V2.kanbanSync,
    rodizio: { enabled: !!r.rodizio?.enabled && members.length > 0, members },
    embedDomains: normalizeDomains(r.embedDomains),
  };
}

export async function getV2Config(orgId: string): Promise<SdrV2Config> {
  const last = await prisma.auditLog.findFirst({ where: { orgId, action: SDR_V2_ACTION }, orderBy: { createdAt: 'desc' }, select: { meta: true } });
  return normalizeV2(parseJson<unknown>(last?.meta, {}));
}

export async function setV2Config(orgId: string, patch: Partial<SdrV2Config>, ctx: { userId?: string | null; ip?: string | null } = {}): Promise<SdrV2Config> {
  const cur = await getV2Config(orgId);
  const next = normalizeV2({ ...cur, ...patch, rodizio: { ...cur.rodizio, ...(patch.rodizio ?? {}) } });
  await prisma.auditLog.create({ data: { orgId, userId: ctx.userId ?? null, action: SDR_V2_ACTION, entity: 'sdr_settings', entityId: orgId, meta: JSON.stringify(next), ip: ctx.ip ?? null } });
  return next;
}
