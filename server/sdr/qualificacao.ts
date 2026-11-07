import type { LeadAiSettings } from '@prisma/client';
import { prisma } from '../db.js';
import { parseJson } from '../lib/json.js';

/**
 * Etapa de qualificação do SDR com IA (v1.20.0) — antiga "IA de qualificação" do MCK Mensagens.
 *
 * Um só produto para o cliente ("SDR com IA"). Esta é a ÚNICA fonte de verdade da configuração da qualificação
 * daqui pra frente: a tela do SDR (MCKBOT e MCK Mensagens) lê e grava aqui, e o motor antigo das respostas de
 * campanha (server/mckmensagem/qualificacao.ts) lê daqui por `getLeadAiSettings`.
 *
 * Sem migração de Prisma:
 *  - a configuração própria do SDR fica no AuditLog da empresa (ação `sdr.qualificacao.config`, a mais recente vale),
 *    no mesmo padrão do `sdr.v2.config`;
 *  - empresa que ainda não salvou pelo SDR: a linha antiga de LeadAiSettings é lida e convertida em código (lazy),
 *    sem gravar nada no banco; sem linha antiga, valem os padrões;
 *  - ao salvar pelo SDR, a linha de LeadAiSettings daquela empresa também é atualizada (espelho), para que uma volta
 *    à versão anterior continue com a mesma configuração. Os campos e a tabela antigos não são apagados.
 */
export const SDR_QUALI_ACTION = 'sdr.qualificacao.config';

export type PositiveAction = 'HANDOFF' | 'FLOW' | 'BOT';
export type NegativeAction = 'RETRY' | 'FLOW' | 'HANDOFF' | 'DISCARD';
export type DoubtAction = 'AI' | 'FLOW' | 'HANDOFF';

/** Formato do SDR (como a configuração é guardada e usada pelo SDR). */
export interface SdrQualificacao {
  /** Qualificar as respostas das campanhas do MCK Mensagens (antigo "Ativar IA de qualificação"). */
  campanhas: boolean;
  /** Como abordar e qualificar (o que a empresa vende, para quem, o que perguntar). */
  abordagem: string;
  /** Próximo passo oferecido a quem tem interesse. */
  proximoPasso: string;
  /** Persona/prompt editável (vazio = padrão do sistema). */
  persona: string | null;
  positivo: { acao: PositiveAction; fluxoId: string | null; mensagem: string };
  negativo: { acao: NegativeAction; fluxoId: string | null };
  duvida: { acao: DoubtAction; fluxoId: string | null };
  tentativas: { dias: number; max: number; mensagem: string };
  etiquetas: { positivo: string; aguardando: string; descartado: string };
}

/** Formato antigo (LeadAiSettings), usado pelo motor das respostas de campanha e pela API antiga. */
export interface LegacyLeadAi {
  enabled: boolean; instructions: string; offer: string;
  positiveAction: string; positiveFlowId: string | null; retryDays: number; maxAttempts: number; promptTemplate: string | null;
  positiveMessage: string; negativeAction: string; negativeFlowId: string | null; doubtAction: string; doubtFlowId: string | null;
  tagPositive: string; tagWaiting: string; tagDiscarded: string; retryMessage: string;
}

export const DEFAULT_LEAD_AI: LegacyLeadAi = {
  enabled: false,
  instructions: '',
  offer: '',
  positiveAction: 'HANDOFF',
  positiveFlowId: null,
  retryDays: 3,
  maxAttempts: 3,
  promptTemplate: null,
  positiveMessage: '',
  negativeAction: 'RETRY', // RETRY (aguardar e tentar de novo) | FLOW | HANDOFF | DISCARD
  negativeFlowId: null,
  doubtAction: 'AI', // AI (IA responde) | FLOW | HANDOFF
  doubtFlowId: null,
  tagPositive: 'lead-qualificado',
  tagWaiting: 'lead-aguardando',
  tagDiscarded: 'lead-descartado',
  retryMessage: 'Oi {nome}! Passando de novo por aqui 😊 Ainda posso te ajudar? Se quiser, te mando mais detalhes, sem compromisso.',
};

const POS: PositiveAction[] = ['HANDOFF', 'FLOW', 'BOT'];
const NEG: NegativeAction[] = ['RETRY', 'FLOW', 'HANDOFF', 'DISCARD'];
const DUV: DoubtAction[] = ['AI', 'FLOW', 'HANDOFF'];
const pick = <T extends string>(v: unknown, list: T[], d: T): T => (list.includes(v as T) ? (v as T) : d);
const str = (v: unknown, max: number, d = '') => (typeof v === 'string' ? v.slice(0, max) : d);
const idOrNull = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 40) : null);
const int = (v: unknown, min: number, max: number, d: number) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d; };

/** LeadAiSettings (linha antiga ou parcial) → formato do SDR. Campo ausente/inválido = padrão. Puro. */
export function fromLegacy(row: Partial<LegacyLeadAi> | null | undefined): SdrQualificacao {
  const given = Object.fromEntries(Object.entries(row ?? {}).filter(([, v]) => v !== undefined));
  const r = { ...DEFAULT_LEAD_AI, ...given } as LegacyLeadAi;
  const d = DEFAULT_LEAD_AI;
  return {
    campanhas: !!r.enabled,
    abordagem: str(r.instructions, 4000),
    proximoPasso: str(r.offer, 1000),
    persona: typeof r.promptTemplate === 'string' && r.promptTemplate.trim() ? r.promptTemplate.slice(0, 8000) : null,
    positivo: { acao: pick(r.positiveAction, POS, 'HANDOFF'), fluxoId: idOrNull(r.positiveFlowId), mensagem: str(r.positiveMessage, 1000) },
    negativo: { acao: pick(r.negativeAction, NEG, 'RETRY'), fluxoId: idOrNull(r.negativeFlowId) },
    duvida: { acao: pick(r.doubtAction, DUV, 'AI'), fluxoId: idOrNull(r.doubtFlowId) },
    tentativas: { dias: int(r.retryDays, 1, 60, d.retryDays), max: int(r.maxAttempts, 1, 10, d.maxAttempts), mensagem: str(r.retryMessage, 1000).trim() || d.retryMessage },
    etiquetas: { positivo: str(r.tagPositive, 40), aguardando: str(r.tagWaiting, 40), descartado: str(r.tagDiscarded, 40) },
  };
}

/** Formato do SDR → formato antigo (o que o motor das campanhas e a tela leem). Puro. */
export function toLegacy(q: SdrQualificacao): LegacyLeadAi {
  return {
    enabled: q.campanhas, instructions: q.abordagem, offer: q.proximoPasso, promptTemplate: q.persona,
    positiveAction: q.positivo.acao, positiveFlowId: q.positivo.fluxoId, positiveMessage: q.positivo.mensagem,
    negativeAction: q.negativo.acao, negativeFlowId: q.negativo.fluxoId,
    doubtAction: q.duvida.acao, doubtFlowId: q.duvida.fluxoId,
    retryDays: q.tentativas.dias, maxAttempts: q.tentativas.max, retryMessage: q.tentativas.mensagem,
    tagPositive: q.etiquetas.positivo, tagWaiting: q.etiquetas.aguardando, tagDiscarded: q.etiquetas.descartado,
  };
}

/** Normaliza o que veio do AuditLog (formato do SDR) passando pelo formato antigo, com os mesmos limites. */
export function normalizeQualificacao(raw: unknown): SdrQualificacao {
  const r = (raw && typeof raw === 'object' ? raw : {}) as any;
  return fromLegacy({
    enabled: r.campanhas, instructions: r.abordagem, offer: r.proximoPasso, promptTemplate: r.persona,
    positiveAction: r.positivo?.acao, positiveFlowId: r.positivo?.fluxoId, positiveMessage: r.positivo?.mensagem,
    negativeAction: r.negativo?.acao, negativeFlowId: r.negativo?.fluxoId,
    doubtAction: r.duvida?.acao, doubtFlowId: r.duvida?.fluxoId,
    retryDays: r.tentativas?.dias, maxAttempts: r.tentativas?.max, retryMessage: r.tentativas?.mensagem,
    tagPositive: r.etiquetas?.positivo, tagWaiting: r.etiquetas?.aguardando, tagDiscarded: r.etiquetas?.descartado,
  });
}

export type QualiOrigem = 'SDR' | 'LEGADO' | 'PADRAO';

/**
 * Configuração da qualificação da empresa: a do SDR (AuditLog) quando existir; senão a antiga (LeadAiSettings),
 * convertida em código; senão o padrão. Só lê: nunca grava.
 */
export async function getQualificacao(orgId: string): Promise<{ config: SdrQualificacao; origem: QualiOrigem }> {
  const own = await prisma.auditLog.findFirst({ where: { orgId, action: SDR_QUALI_ACTION }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { meta: true } });
  if (own) return { config: normalizeQualificacao(parseJson<unknown>(own.meta, {})), origem: 'SDR' };
  const row = await prisma.leadAiSettings.findUnique({ where: { orgId } });
  if (row) {
    const { orgId: _o, updatedAt: _u, ...rest } = row as LeadAiSettings;
    return { config: fromLegacy(rest), origem: 'LEGADO' };
  }
  return { config: fromLegacy(null), origem: 'PADRAO' };
}

/** Formato antigo da configuração atual (o motor das respostas de campanha usa este). */
export async function getLegacyView(orgId: string): Promise<LegacyLeadAi> {
  return toLegacy((await getQualificacao(orgId)).config);
}

/**
 * Salva pela tela do SDR (ou pela API antiga): grava a configuração do SDR (fonte de verdade) e espelha na linha de
 * LeadAiSettings desta empresa (só desta, só quando ela salva). `patch` vem no formato antigo (campos da tela).
 */
export async function saveQualificacao(orgId: string, patch: Partial<LegacyLeadAi>, ctx: { userId?: string | null; ip?: string | null } = {}): Promise<SdrQualificacao> {
  const cur = toLegacy((await getQualificacao(orgId)).config);
  const clean = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) as Partial<LegacyLeadAi>;
  const next = fromLegacy({ ...cur, ...clean });
  await prisma.auditLog.create({ data: { orgId, userId: ctx.userId ?? null, action: SDR_QUALI_ACTION, entity: 'sdr_settings', entityId: orgId, meta: JSON.stringify(next), ip: ctx.ip ?? null } });
  const legacy = toLegacy(next);
  await prisma.leadAiSettings.upsert({ where: { orgId }, create: { orgId, ...legacy }, update: legacy })
    .catch((e) => console.error('[sdr] falha ao espelhar a qualificação na tabela antiga', { orgId, error: (e as Error).message }));
  return next;
}

/** Trecho do prompt do SDR (conversa da IA do MCKBOT) com a abordagem e o próximo passo configurados. Vazio se não houver. */
export function qualiPromptLines(q: Pick<SdrQualificacao, 'abordagem' | 'proximoPasso'>): string[] {
  const out: string[] = [];
  const a = q.abordagem.trim(), p = q.proximoPasso.trim();
  if (a) out.push('Como abordar e qualificar (orientação da empresa):', a.slice(0, 1500));
  if (p) out.push(`Próximo passo para quem tem interesse: ${p.slice(0, 300)}. Use exatamente estas condições; não invente.`);
  return out;
}
