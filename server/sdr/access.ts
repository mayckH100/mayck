import type { Request, Response, NextFunction } from 'express';
import { prisma } from '../db.js';
import { orgOf } from '../auth/session.js';
import { isProductActive, planoCompletoAtivo } from '../billing/service.js';
import { parseJson } from '../lib/json.js';

/**
 * Quem tem o SDR com IA (v1.18.0):
 * - Plano Completo ativo ou em teste (mesma regra do MCK ERP na 1.17.0), quando o Master deixa o plano ligado (padrão: ligado);
 * - MCKBOT ou MCK Mensagens sozinhos, só se o Master ligar o plano (padrão: desligado);
 * - sempre: a empresa da própria MCK (empresa com um superadmin na equipe, ou SDR_ORG_IDS) e o superadmin.
 */
export type SdrPlans = { COMBO: boolean; MCKBOT: boolean; MCKMENSAGEM: boolean };
export const DEFAULT_SDR_PLANS: SdrPlans = { COMBO: true, MCKBOT: false, MCKMENSAGEM: false };

export async function getSdrPlans(): Promise<SdrPlans> {
  const s = await prisma.platformSettings.findUnique({ where: { id: 'default' } });
  const j = parseJson<Partial<SdrPlans>>((s as any)?.sdrPlansJson, {});
  return { COMBO: j.COMBO ?? DEFAULT_SDR_PLANS.COMBO, MCKBOT: j.MCKBOT ?? DEFAULT_SDR_PLANS.MCKBOT, MCKMENSAGEM: j.MCKMENSAGEM ?? DEFAULT_SDR_PLANS.MCKMENSAGEM };
}

export async function setSdrPlans(p: Partial<SdrPlans>): Promise<SdrPlans> {
  const cur = await getSdrPlans();
  const next: SdrPlans = { COMBO: p.COMBO ?? cur.COMBO, MCKBOT: p.MCKBOT ?? cur.MCKBOT, MCKMENSAGEM: p.MCKMENSAGEM ?? cur.MCKMENSAGEM };
  await prisma.platformSettings.upsert({ where: { id: 'default' }, update: { sdrPlansJson: JSON.stringify(next) }, create: { id: 'default', sdrPlansJson: JSON.stringify(next) } });
  cache.clear();
  return next;
}

/** Empresa da própria MCK: tem um superadmin na equipe (ou está em SDR_ORG_IDS). */
export async function isMckOrg(orgId: string): Promise<boolean> {
  const ids = (process.env.SDR_ORG_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (ids.includes(orgId)) return true;
  const m = await prisma.membership.findFirst({ where: { orgId, user: { isSuperAdmin: true } }, select: { id: true } });
  return !!m;
}

export type SdrAccess = { liberado: boolean; motivo: 'MCK' | 'SUPERADMIN' | 'PLANO_COMPLETO' | 'MCKBOT' | 'MCKMENSAGEM' | 'SEM_PLANO' };

export async function sdrAccess(orgId: string, isSuperAdmin = false): Promise<SdrAccess> {
  if (isSuperAdmin) return { liberado: true, motivo: 'SUPERADMIN' };
  if (await isMckOrg(orgId)) return { liberado: true, motivo: 'MCK' };
  const plans = await getSdrPlans();
  if (plans.COMBO && (await planoCompletoAtivo(orgId))) return { liberado: true, motivo: 'PLANO_COMPLETO' };
  if (plans.MCKBOT && (await isProductActive(orgId, 'MCKBOT'))) return { liberado: true, motivo: 'MCKBOT' };
  if (plans.MCKMENSAGEM && (await isProductActive(orgId, 'MCKMENSAGEM'))) return { liberado: true, motivo: 'MCKMENSAGEM' };
  return { liberado: false, motivo: 'SEM_PLANO' };
}

// Cache curto para o caminho quente (mensagem recebida no WhatsApp e agendador).
const cache = new Map<string, { at: number; ok: boolean }>();
export async function sdrLiberadoCached(orgId: string): Promise<boolean> {
  const c = cache.get(orgId);
  if (c && Date.now() - c.at < 60_000) return c.ok;
  const ok = (await sdrAccess(orgId).catch(() => ({ liberado: false }))).liberado;
  if (cache.size > 5000) cache.clear();
  cache.set(orgId, { at: Date.now(), ok });
  return ok;
}
export const clearSdrAccessCache = () => cache.clear();

export const SDR_PLANO = 'SDR_PLANO';
export const SDR_PLANO_MSG = 'O SDR com IA faz parte do Plano Completo (MCK ERP + MCKBOT + MCK Mensagens). Faça o upgrade para usar.';

/** Rotas /api/sdr: sem o plano, 402 (code SDR_PLANO), exceto saber se está liberado. */
export function requireSdr(req: Request, res: Response, next: NextFunction) {
  if (req.method === 'OPTIONS' || /^\/acesso\/?$/.test(req.path)) return next();
  sdrAccess(orgOf(req), !!req.auth?.isSuperAdmin)
    .then((a) => (a.liberado ? next() : res.status(402).json({ error: SDR_PLANO_MSG, code: SDR_PLANO })))
    .catch(next);
}
