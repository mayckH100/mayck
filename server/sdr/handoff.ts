import type { SdrLead, SdrSettings } from '@prisma/client';
import { prisma } from '../db.js';
import { parseJson } from '../lib/json.js';
import type { Answers, Temperature } from './core.js';
import { buildHandoff, explainScore, handoffLines, type Handoff } from './intel.js';
import { getIntelConfig, questionsFor } from './intelConfig.js';
import { sdrLiberadoCached } from './access.js';

/** SDR fase 2 (v1.21.0) — resumo para o vendedor no handoff (lead, aviso de lead quente e Kanban). */
export function handoffOf(lead: SdrLead, s: Pick<SdrSettings, 'warmScore' | 'hotScore'>, qs: Awaited<ReturnType<typeof questionsFor>>): Handoff {
  const answers = parseJson<Answers>(lead.answersJson, {});
  const e = explainScore(qs, answers, lead.score, lead.temperature as Temperature, s.warmScore, s.hotScore);
  return buildHandoff(answers, lead, e.proximaAcao);
}

/** Linhas extras para o aviso de lead quente (vazio quando o resumo está desligado). Nunca lança. */
export async function hotAlertHandoffLines(lead: SdrLead, s: SdrSettings): Promise<string[]> {
  try {
    if (!(await getIntelConfig(lead.orgId)).resumo) return [];
    return handoffLines(handoffOf(lead, s, await questionsFor(lead.orgId, s)));
  } catch {
    return [];
  }
}

/** Cartões do Kanban: pontuação e resumo do lead do SDR por contato (só com o SDR ligado e o resumo ligado). Nunca lança. */
export async function sdrKanbanCards(orgId: string, contactIds: string[]): Promise<Map<string, { score: number; temperature: string; resumo: string[]; leadId: string }>> {
  const out = new Map<string, { score: number; temperature: string; resumo: string[]; leadId: string }>();
  try {
    if (!contactIds.length || !(await sdrLiberadoCached(orgId))) return out;
    const s = await prisma.sdrSettings.findUnique({ where: { orgId } });
    if (!s?.enabled || !(await getIntelConfig(orgId)).resumo) return out;
    const qs = await questionsFor(orgId, s);
    const leads = await prisma.sdrLead.findMany({ where: { orgId, contactId: { in: contactIds } }, orderBy: { createdAt: 'asc' } });
    for (const l of leads) if (l.contactId && !out.has(l.contactId)) out.set(l.contactId, { score: l.score, temperature: l.temperature, resumo: handoffLines(handoffOf(l, s, qs)), leadId: l.id });
  } catch (e) {
    console.warn('[sdr] resumo do Kanban ignorado', { orgId, error: (e as Error).message });
  }
  return out;
}
