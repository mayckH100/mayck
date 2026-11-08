import { prisma } from '../db.js';
import { parseJson } from '../lib/json.js';
import type { SdrSettings } from '@prisma/client';
import { normalizeMetodo, normalizeObjecoes, questionsForMetodo, DEFAULT_OBJECOES, type Metodo, type Objecao } from './intel.js';
import { questionsOf } from './service.js';
import type { Question } from './core.js';
import { DEFAULT_NOSHOW_TEXT } from './meeting.js';

/**
 * Configuração da inteligência do SDR (v1.21.0) SEM migração: a versão mais recente fica no AuditLog da empresa
 * (ação `sdr.intel.config`), como a v2. Sem registro salvo, tudo fica DESLIGADO (empresas que já usam o SDR não mudam
 * nada). Ao ligar o SDR pela primeira vez, `seedIntelForNewSetup` grava os padrões de "configuração nova": só liga o
 * que não envia nada sozinho (explicações e leituras internas); o que muda mensagens fica desligado até a empresa ligar.
 */
export const SDR_INTEL_ACTION = 'sdr.intel.config';

export interface IntelConfig {
  /** Método de qualificação: PADRAO usa as perguntas da empresa (comportamento de antes). */
  metodo: Metodo;
  /** Biblioteca de objeções: a IA usa as respostas da empresa (muda as respostas aos leads: desligada por padrão). */
  objecoes: { enabled: boolean; itens: Objecao[] };
  /** Enriquecimento por CNPJ (BrasilAPI): não envia nada; ligado em configuração nova. */
  cnpj: boolean;
  /** Resumo para o vendedor (dor, orçamento, prazo, decisor, próximo passo) no aviso de lead quente e no Kanban. */
  resumo: boolean;
  /** Follow-up da cadência reescrito pela IA com o histórico (muda mensagens: desligado por padrão). */
  followupIa: boolean;
  /** Envia o passo da cadência no horário em que o lead mais responde (dentro do horário comercial; desligado por padrão). */
  melhorHorario: boolean;
  /** Reunião: IA propõe horários livres da Agenda; recuperação de quem não compareceu (os dois mudam mensagens: desligados). */
  reuniao: { ofertaHorarios: boolean; noShow: boolean; noShowTexto: string };
  /** Intenção e sentimento de cada mensagem do lead (só leitura para a equipe; ligado em configuração nova). */
  sentimento: boolean;
  /** Opt-out automático por frase ("não quero mais receber", "me tira da lista"...): para tudo, não envia nada (ligado em configuração nova). */
  optOutAuto: boolean;
  /**
   * v1.26.0 — IA conversacional avançada (contexto rico, estilo WhatsApp, planejamento, autoverificação e handoff
   * inteligente). MUDA as respostas aos leads: desligada para quem já usa; ligada só em configuração nova.
   */
  conversa: { enabled: boolean; autoverificacao: boolean; handoff: boolean };
}

export const DEFAULT_INTEL: IntelConfig = { metodo: 'PADRAO', objecoes: { enabled: false, itens: DEFAULT_OBJECOES }, cnpj: false, resumo: false, followupIa: false, melhorHorario: false, reuniao: { ofertaHorarios: false, noShow: false, noShowTexto: DEFAULT_NOSHOW_TEXT }, sentimento: false, optOutAuto: false, conversa: { enabled: false, autoverificacao: true, handoff: true } };
/** Padrões de quem liga o SDR pela primeira vez (nada aqui envia mensagem sozinho; a IA conversacional avançada só muda o jeito de responder, a pedido do Mayck em 07/11/2026). */
export const NEW_SETUP_INTEL: IntelConfig = { ...DEFAULT_INTEL, cnpj: true, resumo: true, sentimento: true, optOutAuto: true, conversa: { enabled: true, autoverificacao: true, handoff: true } };

export function normalizeIntel(raw: unknown): IntelConfig {
  const r = (raw && typeof raw === 'object' ? raw : {}) as any;
  return {
    metodo: normalizeMetodo(r.metodo),
    objecoes: { enabled: r.objecoes?.enabled === true, itens: r.objecoes?.itens === undefined ? DEFAULT_OBJECOES : normalizeObjecoes(r.objecoes.itens) },
    cnpj: r.cnpj === true,
    resumo: r.resumo === true,
    followupIa: r.followupIa === true,
    melhorHorario: r.melhorHorario === true,
    reuniao: {
      ofertaHorarios: r.reuniao?.ofertaHorarios === true,
      noShow: r.reuniao?.noShow === true,
      noShowTexto: String(r.reuniao?.noShowTexto ?? '').trim().slice(0, 600) || DEFAULT_NOSHOW_TEXT,
    },
    sentimento: r.sentimento === true,
    optOutAuto: r.optOutAuto === true,
    conversa: { enabled: r.conversa?.enabled === true, autoverificacao: r.conversa?.autoverificacao !== false, handoff: r.conversa?.handoff !== false },
  };
}

export async function getIntelConfig(orgId: string): Promise<IntelConfig & { salvo: boolean }> {
  const last = await prisma.auditLog.findFirst({ where: { orgId, action: SDR_INTEL_ACTION }, orderBy: { createdAt: 'desc' }, select: { meta: true } });
  return { ...normalizeIntel(parseJson<unknown>(last?.meta, {})), salvo: !!last };
}

export async function setIntelConfig(orgId: string, patch: Partial<IntelConfig>, ctx: { userId?: string | null; ip?: string | null } = {}): Promise<IntelConfig> {
  const { salvo: _s, ...cur } = await getIntelConfig(orgId);
  const next = normalizeIntel(mergeDeep(cur, patch));
  await prisma.auditLog.create({ data: { orgId, userId: ctx.userId ?? null, action: SDR_INTEL_ACTION, entity: 'sdr_settings', entityId: orgId, meta: JSON.stringify(next), ip: ctx.ip ?? null } });
  return next;
}

/** Primeira vez que a empresa liga o SDR e nunca salvou a inteligência: grava os padrões de configuração nova. */
export async function seedIntelForNewSetup(orgId: string, ctx: { userId?: string | null; ip?: string | null } = {}) {
  const cur = await getIntelConfig(orgId);
  if (!cur.salvo) await setIntelConfig(orgId, NEW_SETUP_INTEL, ctx);
}

function mergeDeep(a: any, b: any): any {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return b === undefined ? a : b;
  const out: any = { ...(a ?? {}) };
  for (const k of Object.keys(b)) out[k] = b[k] !== null && typeof b[k] === 'object' && !Array.isArray(b[k]) ? mergeDeep(a?.[k], b[k]) : b[k] === undefined ? a?.[k] : b[k];
  return out;
}

/** Perguntas em uso (método escolhido ou as da empresa). */
export async function questionsFor(orgId: string, s: Pick<SdrSettings, 'questionsJson'>): Promise<Question[]> {
  const c = await getIntelConfig(orgId);
  return questionsForMetodo(c.metodo, questionsOf(s));
}
