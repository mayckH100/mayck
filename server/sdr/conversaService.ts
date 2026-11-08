import { prisma } from '../db.js';
import { parseJson } from '../lib/json.js';
import { leadPhoneOfWaId } from '../mckmensagem/contactSync.js';
import { getIntelConfig, questionsFor, type IntelConfig } from './intelConfig.js';
import { leadEmpresa } from './cnpj.js';
import { STAGE_LABEL, type Answers, type Stage } from './core.js';
import type { Metodo } from './intel.js';
import { contextoLines, empresaUsaEmoji, type LeadContexto } from './conversa.js';

/**
 * IA conversacional avançada (v1.26.0) — parte com banco. `conversaAvancadaFor` diz se a conversa usa a IA
 * conversacional avançada (interruptor ligado E conversa com um lead do SDR ou de campanha; no "Testar", sem lead)
 * e junta o contexto do lead. Nunca lança: qualquer falha = null (a IA responde como antes).
 */
export interface ConversaCtx {
  orgId: string;
  conversationId: string;
  cfg: IntelConfig['conversa'];
  metodo: Metodo;
  contexto: LeadContexto | null;
  sdrLeadId: string | null;
  usaEmoji: boolean;
}

/** Quantas mensagens do histórico vão ao prompt quando ligada (antes: 10). Respostas automáticas já ficam de fora. */
export const HISTORICO_AVANCADO = 30;

export async function conversaAvancadaFor(orgId: string, conversationId: string, ai: { instructions?: string | null; tone?: string | null }): Promise<ConversaCtx | null> {
  try {
    const intel = await getIntelConfig(orgId);
    if (!intel.conversa.enabled) return null;
    const base = { orgId, conversationId, cfg: intel.conversa, metodo: intel.metodo, usaEmoji: empresaUsaEmoji(ai.instructions, ai.tone) };
    if (!conversationId) return { ...base, contexto: null, sdrLeadId: null }; // "Testar" da tela da IA
    const conv = await prisma.conversation.findFirst({ where: { id: conversationId, orgId }, select: { contactId: true } });
    const contact = conv ? await prisma.contact.findFirst({ where: { id: conv.contactId, orgId }, select: { id: true, waId: true, name: true } }) : null;
    if (!contact) return null;
    const phone = leadPhoneOfWaId(contact.waId);
    const or = [{ contactId: contact.id }, ...(phone ? [{ phone }] : [])];
    const [sdr, camp] = await Promise.all([
      prisma.sdrLead.findFirst({ where: { orgId, OR: or }, orderBy: { createdAt: 'asc' } }),
      prisma.lead.findFirst({ where: { orgId, OR: or }, orderBy: { updatedAt: 'desc' } }),
    ]);
    // Só conversas com leads (SDR ou campanha): o atendimento comum do MCKBOT não muda.
    if (!sdr && !camp) return null;
    const contexto: LeadContexto = { nome: sdr?.name || camp?.name || contact.name || null, empresa: sdr?.company ?? null, receita: null, etapa: null, pontuacao: null, temperatura: null, respondidas: [], faltam: [], objecoes: [], campanha: null, resumo: sdr?.aiSummary || camp?.aiSummary || null };
    if (sdr) {
      const s = await prisma.sdrSettings.findUnique({ where: { orgId }, select: { questionsJson: true } });
      const qs = await questionsFor(orgId, s ?? { questionsJson: '[]' });
      const answers = parseJson<Answers>(sdr.answersJson, {});
      contexto.respondidas = qs.filter((q) => answers[q.id]?.resposta).map((q) => ({ pergunta: q.pergunta, resposta: String(answers[q.id]!.resposta) }));
      contexto.faltam = qs.filter((q) => !answers[q.id]?.resposta).map((q) => q.pergunta);
      contexto.etapa = STAGE_LABEL[sdr.stage as Stage] ?? sdr.stage;
      contexto.pontuacao = sdr.score;
      contexto.temperatura = sdr.temperature;
      const [rf, objs] = await Promise.all([
        leadEmpresa(orgId, sdr.id).catch(() => null),
        prisma.sdrEvent.findMany({ where: { orgId, leadId: sdr.id, type: 'OBJECAO' }, orderBy: { createdAt: 'desc' }, take: 10, select: { detail: true } }),
      ]);
      if (rf) contexto.receita = { razaoSocial: rf.fantasia || rf.razaoSocial, atividade: rf.atividade, cidade: rf.cidade, uf: rf.uf, situacao: rf.situacao };
      if (!contexto.empresa && rf) contexto.empresa = rf.fantasia || rf.razaoSocial;
      contexto.objecoes = [...new Set(objs.map((o) => o.detail ?? '').filter(Boolean))];
    }
    if (camp?.campaignId) {
      const c = await prisma.campaign.findFirst({ where: { id: camp.campaignId, orgId }, select: { name: true } });
      contexto.campanha = c?.name ?? null;
    }
    return { ...base, contexto, sdrLeadId: sdr?.id ?? null };
  } catch (e) {
    console.warn('[ia-conversa] contexto avançado ignorado', { orgId, conversationId: conversationId || null, error: (e as Error).message });
    return null;
  }
}

/** Trecho do prompt da IA conversacional avançada (vai junto das Instruções da empresa). */
export function conversaPromptSection(c: ConversaCtx): string {
  return ['### IA CONVERSACIONAL AVANÇADA', ...contextoLines(c.contexto), '### FIM DA IA CONVERSACIONAL'].join('\n');
}
