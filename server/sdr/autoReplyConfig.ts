import { prisma } from '../db.js';
import { parseJson } from '../lib/json.js';

/**
 * Configuração do identificador de resposta automática (v1.22.0), SEM migração: a versão mais recente fica no AuditLog
 * da empresa (ação `sdr.autoresposta.config`), como as outras configurações do SDR.
 * Sem registro salvo = LIGADO para todas as empresas (inclusive quem já usa): só evita ações erradas e não envia nada.
 */
export const SDR_AUTORESP_ACTION = 'sdr.autoresposta.config';

export type AcaoAutoResposta = 'SEGUIR' | 'PAUSAR';
export interface AutoReplyConfig {
  /** Identificar respostas automáticas (padrão ligado). */
  enabled: boolean;
  /** Frases extras da empresa que sempre indicam resposta automática (até 30). */
  frases: string[];
  /** Ao receber resposta automática: seguir a cadência normalmente ou pausar por `pausaHoras`. */
  acao: AcaoAutoResposta;
  pausaHoras: number;
  /** Em caso de dúvida (confiança média), perguntar à MCK IA (gasta cota; padrão desligado). */
  iaDuvida: boolean;
}

export const DEFAULT_AUTORESP: AutoReplyConfig = { enabled: true, frases: [], acao: 'SEGUIR', pausaHoras: 24, iaDuvida: false };

export function normalizeFrases(v: unknown): string[] {
  const arr = Array.isArray(v) ? v : typeof v === 'string' ? v.split(/\n|;/) : [];
  const out: string[] = [];
  for (const x of arr) {
    const f = String(x ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
    if (f.length >= 4 && !out.some((o) => o.toLowerCase() === f.toLowerCase())) out.push(f);
    if (out.length >= 30) break;
  }
  return out;
}

export function normalizeAutoReply(raw: unknown): AutoReplyConfig {
  const r = (raw && typeof raw === 'object' ? raw : {}) as any;
  const horas = Math.round(Number(r.pausaHoras));
  return {
    enabled: r.enabled !== false,
    frases: normalizeFrases(r.frases),
    acao: r.acao === 'PAUSAR' ? 'PAUSAR' : 'SEGUIR',
    pausaHoras: Number.isFinite(horas) && horas >= 1 ? Math.min(168, horas) : DEFAULT_AUTORESP.pausaHoras,
    iaDuvida: r.iaDuvida === true,
  };
}

export async function getAutoReplyConfig(orgId: string): Promise<AutoReplyConfig> {
  const last = await prisma.auditLog.findFirst({ where: { orgId, action: SDR_AUTORESP_ACTION }, orderBy: { createdAt: 'desc' }, select: { meta: true } });
  return normalizeAutoReply(parseJson<unknown>(last?.meta, {}));
}

export async function setAutoReplyConfig(orgId: string, patch: Partial<AutoReplyConfig>, ctx: { userId?: string | null; ip?: string | null } = {}): Promise<AutoReplyConfig> {
  const cur = await getAutoReplyConfig(orgId);
  const next = normalizeAutoReply({ ...cur, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) });
  await prisma.auditLog.create({ data: { orgId, userId: ctx.userId ?? null, action: SDR_AUTORESP_ACTION, entity: 'sdr_settings', entityId: orgId, meta: JSON.stringify(next), ip: ctx.ip ?? null } });
  return next;
}
