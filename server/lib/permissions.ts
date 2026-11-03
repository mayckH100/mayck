import type { Request, Response, NextFunction } from 'express';
import type { Role } from '../types.js';
import { forbidden } from './http.js';

/**
 * Permissões por módulo e por canal WhatsApp dos membros da equipe.
 * - O papel (OWNER/ADMIN/AGENT) continua valendo: os módulos só RESTRINGEM, nunca dão mais do que o papel permite.
 * - Membership.modules nulo = tudo o que o papel permite (membros antigos mantêm o acesso de antes).
 * - Membership.channelIds nulo = todos os canais.
 * - O proprietário sempre tem tudo e não pode ser restringido.
 */
export const MODULES = [
  { id: 'inbox', label: 'Inbox (conversas)', app: 'MCKBOT' },
  { id: 'kanban', label: 'Kanban', app: 'MCKBOT' },
  { id: 'agenda', label: 'Agenda e pedidos', app: 'MCKBOT' },
  { id: 'contatos', label: 'Contatos', app: 'MCKBOT' },
  { id: 'fluxos', label: 'Fluxos', app: 'MCKBOT' },
  { id: 'ia', label: 'Inteligência artificial', app: 'MCKBOT' },
  { id: 'canais', label: 'Canais WhatsApp', app: 'MCKBOT' },
  { id: 'integracoes', label: 'Integrações', app: 'MCKBOT' },
  { id: 'relatorios', label: 'Relatórios', app: 'MCKBOT' },
  { id: 'equipe', label: 'Equipe', app: 'MCKBOT' },
  { id: 'plano', label: 'Plano e cobrança', app: 'MCKBOT' },
  { id: 'auditoria', label: 'Auditoria', app: 'MCKBOT' },
  { id: 'mensagens', label: 'MCK Mensagens: leads, campanhas/disparos e IA', app: 'MCKMENSAGEM' },
  { id: 'automacoes', label: 'MCK Mensagens: automações e cobranças', app: 'MCKMENSAGEM' },
  { id: 'erp_crm', label: 'MCK ERP: CRM (clientes, funil, linha do tempo)', app: 'MCKBOT' },
] as const;
export type ModuleId = (typeof MODULES)[number]['id'];
export const MODULE_IDS = MODULES.map((m) => m.id) as ModuleId[];
const MODULE_SET = new Set<string>(MODULE_IDS);
export const moduleLabel = (id: string) => MODULES.find((m) => m.id === id)?.label ?? id;

/** Módulos que fazem sentido para cada papel (o papel já bloqueia o resto no servidor). */
export const ROLE_MODULES: Record<Role, ModuleId[]> = {
  OWNER: MODULE_IDS,
  ADMIN: MODULE_IDS,
  AGENT: ['inbox', 'kanban', 'agenda', 'contatos', 'fluxos', 'ia', 'canais', 'relatorios', 'equipe', 'plano', 'automacoes', 'erp_crm'],
};
/** Pré-seleção do formulário de convite. */
export const DEFAULT_MODULES: Record<'ADMIN' | 'AGENT', ModuleId[]> = {
  AGENT: ['inbox', 'kanban', 'contatos'],
  ADMIN: MODULE_IDS.filter((m) => m !== 'plano'),
};

export interface Access { modules: ModuleId[] | null; channelIds: string[] | null }

function parseList(raw: string | null | undefined): string[] | null {
  if (raw == null) return null;
  try { const v = JSON.parse(raw); return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : null; } catch { return null; }
}

/** Acesso efetivo a partir da linha do banco (OWNER: sempre tudo). */
export function accessOf(role: Role | null, m: { modules?: string | null; channelIds?: string | null } | null): Access {
  if (!role || role === 'OWNER' || !m) return { modules: null, channelIds: null };
  const mods = parseList(m.modules);
  return {
    modules: mods ? (mods.filter((x) => MODULE_SET.has(x) && ROLE_MODULES[role].includes(x as ModuleId)) as ModuleId[]) : null,
    channelIds: parseList(m.channelIds),
  };
}

/** Lista completa de módulos que o membro tem (resolve o nulo para o que o papel permite). */
export function effectiveModules(role: Role | null, access: Access): ModuleId[] {
  if (!role) return [];
  return access.modules ?? ROLE_MODULES[role];
}

export function hasModule(req: Request, mod: ModuleId): boolean {
  const a = req.auth;
  if (!a?.role) return false;
  if (a.role === 'OWNER') return true;
  return !a.modules || a.modules.includes(mod);
}

/** Canais que o membro pode atender (null = todos). */
export const allowedChannels = (req: Request): string[] | null => (req.auth?.role === 'OWNER' ? null : req.auth?.channelIds ?? null);

/** Filtro Prisma de conversas por canal permitido (objeto vazio quando pode ver todos). */
export function channelWhere(req: Request): { channelId?: { in: string[] } } {
  const ids = allowedChannels(req);
  return ids ? { channelId: { in: ids } } : {};
}

type Exception = { method: string; path: RegExp; anyOf?: ModuleId[] };
/**
 * Bloqueia (403) as rotas do módulo para quem não o tem. `exceptions` libera leituras usadas por outras telas
 * (ex.: o Inbox lista os canais e as etapas do Kanban); `anyOf` vazio = liberado para qualquer membro.
 */
export function requireModule(mod: ModuleId, exceptions: Exception[] = []) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (hasModule(req, mod)) return next();
    const ex = exceptions.find((e) => e.method === req.method && e.path.test(req.path));
    if (ex && (!ex.anyOf || ex.anyOf.some((m) => hasModule(req, m)))) return next();
    next(forbidden(`Você não tem acesso ao módulo ${moduleLabel(mod)}. Peça ao administrador da equipe.`));
  };
}

/**
 * Valida módulos/canais pedidos para um membro ou convite: só módulos conhecidos e compatíveis com o papel,
 * e quem concede não pode dar mais do que tem (módulos e canais).
 * Devolve os valores prontos para gravar (JSON). modules nulo = tudo o que o papel permite (só quando quem concede não tem limite).
 */
export function sanitizeGrant(
  granter: { role: Role; access: Access },
  target: { role: 'ADMIN' | 'AGENT'; modules?: string[] | null; channelIds?: string[] | null },
  orgChannelIds: string[],
): { modules: string | null; channelIds: string | null } | { error: string } {
  const mine = effectiveModules(granter.role, granter.access);
  // Sem lista explícita (clientes antigos da API): tudo o que o papel permite, como antes — limitado ao que quem concede tem.
  const unrestricted = granter.role === 'OWNER' || granter.access.modules === null;
  const keepNull = target.modules == null && unrestricted;
  const requested = target.modules ?? ROLE_MODULES[target.role].filter((m) => mine.includes(m));
  const unknown = requested.filter((m) => !MODULE_SET.has(m));
  if (unknown.length) return { error: `Módulo inválido: ${unknown.join(', ')}` };
  const mods = [...new Set(requested)].filter((m) => ROLE_MODULES[target.role].includes(m as ModuleId));
  const beyond = mods.filter((m) => !mine.includes(m as ModuleId));
  if (beyond.length) return { error: `Você não pode conceder acesso que não tem: ${beyond.map(moduleLabel).join(', ')}` };
  let channels: string[] | null = null;
  if (target.channelIds != null) {
    channels = [...new Set(target.channelIds)];
    const foreign = channels.filter((c) => !orgChannelIds.includes(c));
    if (foreign.length) return { error: 'Canal WhatsApp inválido' };
  }
  const myCh = granter.role === 'OWNER' ? null : granter.access.channelIds;
  if (myCh) {
    if (channels == null) channels = [...myCh]; // "todos" de quem tem acesso limitado = os canais dele
    else if (channels.some((c) => !myCh.includes(c))) return { error: 'Você não pode liberar canais WhatsApp que você não atende' };
  }
  return { modules: keepNull ? null : JSON.stringify(mods), channelIds: channels ? JSON.stringify(channels) : null };
}
