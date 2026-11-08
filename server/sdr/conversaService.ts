import { prisma } from '../db.js';
import { parseJson } from '../lib/json.js';
import { leadPhoneOfWaId } from '../mckmensagem/contactSync.js';
import { getIntelConfig, questionsFor, type IntelConfig } from './intelConfig.js';
import { leadEmpresa } from './cnpj.js';
import { STAGE_LABEL, type Answers, type Stage } from './core.js';
import type { Metodo } from './intel.js';
import { contextoLines, empresaUsaEmoji, estiloLines, polirResposta, objetivoSugerido, planejamentoLines, guardrailLines, verificarResposta, criticaPara, ajusteMecanico, extrairPlano, GRAVES, TEXTO_ESPECIALISTA, MCK_IA_INDISPONIVEL, motivoHandoff, resumoHandoff, comPassagem, type MotivoHandoff, type LeadContexto, type Plano, type Problema } from './conversa.js';
import { mckQuotaStatus } from '../ai/mckQuota.js';
import { logEvent } from './service.js';
import { detectIntent } from './intel.js';

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
export function conversaPromptSection(c: ConversaCtx, textoLead = ''): string {
  const sugerido = objetivoSugerido(c.contexto, detectIntent(textoLead).intencao);
  return ['### IA CONVERSACIONAL AVANÇADA', ...contextoLines(c.contexto), ...estiloLines({ usaEmoji: c.usaEmoji }), ...planejamentoLines({ metodo: c.metodo, sugerido, handoff: c.cfg.handoff }), ...guardrailLines(), '### FIM DA IA CONVERSACIONAL'].join('\n');
}

/** A IA chamou o lead pelo nome nas últimas 3 respostas? (para não repetir o nome em toda mensagem) */
export function nomeUsadoRecente(nome: string | null | undefined, history: { direction: string; body: string | null }[]): boolean {
  const first = (nome ?? '').trim().split(/\s+/)[0]?.toLowerCase();
  if (!first || first.length < 2) return false;
  return history.filter((m) => m.direction === 'OUT').slice(0, 3).some((m) => (m.body ?? '').toLowerCase().includes(first));
}

/** Estilo aplicado ao texto final da IA (parte 2). */
export function estiloFinal(c: ConversaCtx, text: string, historyNewestFirst: { direction: string; body: string | null }[]): string {
  return polirResposta(text, { usaEmoji: c.usaEmoji, nome: c.contexto?.nome, nomeRecente: nomeUsadoRecente(c.contexto?.nome, historyNewestFirst) });
}

/**
 * Cabe a chamada extra da autoverificação? (no máximo 1 por resposta). Pula quando a cota está no fim: MCK IA com
 * menos de 10% (ou 5 respostas) restantes no dia, ou o limite diário da própria empresa a 1 resposta do fim.
 */
export async function cotaPermiteExtra(orgId: string, s: { provider: string; dailyLimit: number }, usadasHoje: number): Promise<boolean> {
  try {
    if (usadasHoje + 2 > s.dailyLimit) return false;
    if (s.provider === 'mck') {
      const q = await mckQuotaStatus(orgId);
      if (q.reached) return false;
      if (q.remaining !== null && (q.remaining <= 5 || (q.limit > 0 && q.remaining / q.limit < 0.1))) return false;
    }
    return true;
  } catch {
    return false;
  }
}

export interface Revisao { texto: string; plano: Plano | null; problemas: Problema[]; tentou: boolean; especialista: boolean }

/**
 * Parte 4: checagem final antes de enviar. Problema → (se ligado e houver cota) UMA nova tentativa com a crítica;
 * ainda grave (valor/prazo fora das Instruções, dado sensível, provedor) → texto do especialista; leve → ajuste local.
 * `regenerar` devolve o texto bruto da nova tentativa (ou null em falha). Nunca lança.
 */
export async function revisarResposta(c: ConversaCtx, a: { texto: string; plano: Plano | null; fontes: string; podeExtra: boolean; historyNewestFirst: { direction: string; body: string | null }[]; regenerar: (critica: string) => Promise<string | null> }): Promise<Revisao> {
  let texto = a.texto;
  let plano = a.plano;
  let v = verificarResposta(texto, { fontes: a.fontes });
  let tentou = false;
  if (v.problemas.length && c.cfg.autoverificacao && a.podeExtra) {
    tentou = true;
    const raw = await a.regenerar(criticaPara(v)).catch(() => null);
    if (raw) {
      const ex = extrairPlano(raw);
      const t2 = estiloFinal(c, ex.texto, a.historyNewestFirst);
      const v2 = verificarResposta(t2, { fontes: a.fontes });
      if (t2 && v2.problemas.length <= v.problemas.length) { texto = t2; v = v2; plano = ex.plano ?? plano; }
    }
  }
  const graves = v.problemas.filter((p) => GRAVES.includes(p));
  if (graves.length) {
    console.warn('[ia-conversa] resposta barrada na checagem final', { orgId: c.orgId, conversationId: c.conversationId || null, problemas: v.problemas, tentou });
    return { texto: TEXTO_ESPECIALISTA, plano, problemas: v.problemas, tentou, especialista: true };
  }
  return { texto: v.problemas.length ? ajusteMecanico(texto) : texto, plano, problemas: v.problemas, tentou, especialista: false };
}

/** Tarefa para a equipe quando a IA disse que confirma com o especialista (nota no Inbox + histórico do lead). */
export async function registrarTarefaEspecialista(c: ConversaCtx, textoLead: string, motivo: Problema[]): Promise<void> {
  if (!c.conversationId) return;
  const body = `Tarefa para a equipe: a IA disse ao lead que confirma com o especialista (a resposta não estava nas Instruções; ${motivo.join(', ')}). Pergunta do lead: "${textoLead.slice(0, 300)}"`;
  await prisma.message.create({ data: { orgId: c.orgId, conversationId: c.conversationId, direction: 'INTERNAL', sender: 'system', type: 'note', body, status: 'NOTE' } }).catch(() => undefined);
  if (c.sdrLeadId) await logEvent(c.orgId, c.sdrLeadId, 'TAREFA', 'WHATSAPP', `Confirmar com o especialista: ${textoLead.slice(0, 200)}`);
}

/** Erro da nova tentativa visto pela empresa: nunca o nome do provedor. */
export const erroAutoverificacao = (provider: string, e: unknown) => (provider === 'mck' ? MCK_IA_INDISPONIVEL : `Autoverificação: ${(e as Error)?.message ?? 'falha'}`.slice(0, 300));

/**
 * Parte 5: decide se a IA para e passa ao vendedor (lead quente, irritado, pedido de pessoa, dúvida fora do escopo).
 * Devolve o texto final (com a frase de passagem) e o motivo com o resumo, ou null para seguir com a IA.
 */
export async function decidirHandoff(c: ConversaCtx, a: { texto: string; textoLead: string; plano: Plano | null; especialista: boolean; agendou: boolean }): Promise<{ texto: string; reason: string; motivo: MotivoHandoff } | null> {
  if (!c.cfg.handoff || !c.conversationId) return null;
  const d = detectIntent(a.textoLead);
  const motivo = motivoHandoff({ textoLead: a.textoLead, sentimento: d.sentimento, intencao: d.intencao, plano: a.plano, temperatura: c.contexto?.temperatura, especialista: a.especialista, agendou: a.agendou });
  if (!motivo) return null;
  if (c.sdrLeadId) await logEvent(c.orgId, c.sdrLeadId, 'HANDOFF', 'WHATSAPP', `Passado ao vendedor: ${motivo}`);
  console.info('[ia-conversa] passado ao vendedor', { orgId: c.orgId, conversationId: c.conversationId, motivo });
  return { texto: comPassagem(a.texto), reason: resumoHandoff(c.contexto, motivo, a.textoLead), motivo };
}

/** Campanhas (MCK Mensagens): contexto + estilo + segurança; a resposta sai no JSON da qualificação (sem plano). */
export function conversaCampanhaSection(c: ConversaCtx): string {
  return ['### IA CONVERSACIONAL AVANÇADA (vale para o campo "resposta" do JSON)', ...contextoLines(c.contexto), ...estiloLines({ usaEmoji: c.usaEmoji }), ...guardrailLines(), '### FIM DA IA CONVERSACIONAL'].join('\n');
}
