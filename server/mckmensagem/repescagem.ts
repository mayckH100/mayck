/**
 * v1.43.0 — Repescagem automática inteligente das campanhas do MCK Mensagens (banco, IA e agendador).
 * Regras puras em ./repescagemCore.ts.
 *
 * - gruposDaCampanha: separa os destinatários (Respondeu / Visualizou e não respondeu / Não visualizou /
 *   Não entregue / Saiu / Na fila / Não enviada) pelo Message.status (enviada/entregue/lida) e pelas respostas.
 * - tickRepescagem: no agendador das campanhas (1 por minuto). No máximo uma repescagem por campanha por passo,
 *   claim atômico no destinatário (nunca envia duas vezes), dentro da janela de horário da campanha, contando como
 *   envio em massa (bulk) e respeitando a proteção do número; número em nível Risco pausa a repescagem.
 * - Texto: a IA da empresa escreve uma mensagem curta e diferente da original; sem IA (ou falha/cota) vai o texto
 *   modelo da campanha com variações.
 */
import { prisma } from '../db.js';
import { canalConectado, erroDeConexao } from '../whatsapp/conexao.js';
import type { Campaign, CampaignRecipient, Contact, Conversation, Lead } from '@prisma/client';
import { sendOutbound } from '../whatsapp/messaging.js';
import { openConversationFor } from '../whatsapp/multiCanal.js';
import { isProductActive } from '../billing/service.js';
import { verificarEnvioEmMassa, saudeDoNumero } from '../whatsapp/protecao/service.js';
import { erroIndicaBloqueio } from '../whatsapp/protecao/core.js';
import { aiChat } from '../ai/core.js';
import { mckQuotaStatus, MCK_QUOTA_REASON } from '../ai/mckQuota.js';
import { inWindow, localClock, filtroDoCanal } from './dispatcher.js';
import {
  GRUPOS, GRUPO_ROTULO, classificarDestinatario, decidirRepescagem, melhorStatus, proximaAcaoEm, textoModelo, validarTextoIa,
  type GrupoCampanha,
} from './repescagemCore.js';

const DAY_MS = 86400e3;
const CHUNK = 400;
const AUTORESPOSTA = 'AUTORESPOSTA';
export const PAUSA_RISCO = 'Repescagem pausada: o número desta campanha está em nível Risco na Saúde do número (Canais). Ela volta sozinha quando o nível melhorar.';
export const PAUSA_API_OFICIAL = 'A repescagem automática só envia por número conectado por QR code: na API oficial da Meta, fora da janela de 24 horas, só é permitido enviar modelo aprovado.';

type Sender = typeof sendOutbound;
let sender: Sender = sendOutbound;
/** Somente testes: substitui o envio. */
export function setRepescagemSender(fn: Sender | null) { sender = fn ?? sendOutbound; }
let random: () => number = Math.random;
/** Somente testes: variações e intervalos previsíveis. */
export function setRepescagemRandom(fn: (() => number) | null) { random = fn ?? Math.random; }
/** Próxima repescagem permitida por campanha (intervalo da campanha entre repescagens). */
const nextAt = new Map<string, number>();
export function resetRepescagemState() { nextAt.clear(); }

function chunks<T>(arr: T[], n = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

async function note(orgId: string, conversationId: string, body: string) {
  await prisma.message.create({ data: { orgId, conversationId, direction: 'INTERNAL', sender: 'system', type: 'note', body, status: 'NOTE' } }).catch(() => undefined);
}

// ---------------- Separação por grupos ----------------

export interface LinhaGrupo {
  recipientId: string; leadId: string; nome: string | null; telefone: string; grupo: GrupoCampanha; grupoRotulo: string;
  statusMensagem: string | null; enviadaEm: Date | null; respondeuEm: Date | null; leadStatus: string | null;
  repescagens: number; repescagemStatus: string | null; repescagemMotivo: string | null; proximaRepescagemEm: Date | null; erro: string | null;
}

/**
 * Destinatários antigos (antes da 1.43.0) não guardavam a mensagem enviada: liga cada um à mensagem em massa
 * enviada ao contato no número da campanha perto do horário do envio (até 10 min). Grava para não procurar de novo.
 */
async function vincularMensagensAntigas(c: Campaign, recs: CampaignRecipient[], leads: Map<string, Lead>) {
  const semMsg = recs.filter((r) => r.status === 'ENVIADA' && !r.messageId && r.sentAt).slice(0, 2000);
  if (!semMsg.length) return;
  const contactIds = [...new Set(semMsg.map((r) => leads.get(r.leadId)?.contactId).filter((x): x is string => !!x))];
  if (!contactIds.length) return;
  const convs = (await Promise.all(chunks(contactIds).map((ids) => prisma.conversation.findMany({ where: { orgId: c.orgId, contactId: { in: ids } }, select: { id: true, contactId: true } })))).flat();
  const convToContact = new Map(convs.map((cv) => [cv.id, cv.contactId]));
  const minSent = Math.min(...semMsg.map((r) => r.sentAt!.getTime()));
  const msgs = (await Promise.all(chunks(convs.map((cv) => cv.id)).map((ids) => prisma.message.findMany({
    where: { conversationId: { in: ids }, channelId: c.channelId, direction: 'OUT', createdAt: { gte: new Date(minSent - 10 * 60_000) } },
    select: { id: true, conversationId: true, createdAt: true }, orderBy: { createdAt: 'asc' },
  })))).flat();
  const porContato = new Map<string, { id: string; at: number }[]>();
  for (const m of msgs) {
    const ct = convToContact.get(m.conversationId);
    if (!ct) continue;
    (porContato.get(ct) ?? porContato.set(ct, []).get(ct)!).push({ id: m.id, at: m.createdAt.getTime() });
  }
  for (const r of semMsg) {
    const ct = leads.get(r.leadId)?.contactId;
    const lista = ct ? porContato.get(ct) : undefined;
    if (!lista?.length) continue;
    const alvo = r.sentAt!.getTime();
    let melhor: { id: string; at: number } | null = null;
    for (const m of lista) if (Math.abs(m.at - alvo) <= 10 * 60_000 && (!melhor || Math.abs(m.at - alvo) < Math.abs(melhor.at - alvo))) melhor = m;
    if (!melhor) continue;
    r.messageId = melhor.id;
    await prisma.campaignRecipient.updateMany({ where: { id: r.id, messageId: null }, data: { messageId: melhor.id } }).catch(() => undefined);
  }
}

/** Primeira resposta (não automática) de cada contato a partir de `desde`, em qualquer conversa da empresa. */
async function respostasPorContato(orgId: string, contactIds: string[], desde: Date): Promise<Map<string, Date[]>> {
  const out = new Map<string, Date[]>();
  if (!contactIds.length) return out;
  const convs = (await Promise.all(chunks(contactIds).map((ids) => prisma.conversation.findMany({ where: { orgId, contactId: { in: ids } }, select: { id: true, contactId: true } })))).flat();
  const convToContact = new Map(convs.map((cv) => [cv.id, cv.contactId]));
  const ins = (await Promise.all(chunks(convs.map((cv) => cv.id)).map((ids) => prisma.message.findMany({
    where: { conversationId: { in: ids }, direction: 'IN', createdAt: { gte: desde }, OR: [{ error: null }, { NOT: { error: { startsWith: AUTORESPOSTA } } }] },
    select: { conversationId: true, createdAt: true }, orderBy: { createdAt: 'asc' }, take: 20000,
  })))).flat();
  for (const m of ins) {
    const ct = convToContact.get(m.conversationId);
    if (ct) (out.get(ct) ?? out.set(ct, []).get(ct)!).push(m.createdAt);
  }
  return out;
}

/** Separa todos os destinatários da campanha em grupos. */
export async function gruposDaCampanha(c: Campaign): Promise<LinhaGrupo[]> {
  const recs = await prisma.campaignRecipient.findMany({ where: { campaignId: c.id }, orderBy: { id: 'asc' } });
  if (!recs.length) return [];
  const leads = new Map((await Promise.all(chunks(recs.map((r) => r.leadId)).map((ids) => prisma.lead.findMany({ where: { orgId: c.orgId, id: { in: ids } } })))).flat().map((l) => [l.id, l]));
  await vincularMensagensAntigas(c, recs, leads);
  const msgIds = [...new Set(recs.flatMap((r) => [r.messageId, r.ultimaMensagemId]).filter((x): x is string => !!x))];
  const msgs = new Map((await Promise.all(chunks(msgIds).map((ids) => prisma.message.findMany({ where: { id: { in: ids } }, select: { id: true, status: true, error: true } })))).flat().map((m) => [m.id, m]));
  const contactIds = [...new Set([...leads.values()].map((l) => l.contactId).filter((x): x is string => !!x))];
  const contatos = new Map((await Promise.all(chunks(contactIds).map((ids) => prisma.contact.findMany({ where: { orgId: c.orgId, id: { in: ids } }, select: { id: true, optOut: true } })))).flat().map((ct) => [ct.id, ct]));
  const enviados = recs.filter((r) => r.sentAt);
  const desde = enviados.length ? new Date(Math.min(...enviados.map((r) => r.sentAt!.getTime()))) : new Date();
  const respostas = await respostasPorContato(c.orgId, contactIds, desde);

  return recs.map((r) => {
    const lead = leads.get(r.leadId) ?? null;
    const ct = lead?.contactId ? contatos.get(lead.contactId) : undefined;
    const lista = [r.messageId, r.ultimaMensagemId].filter((x): x is string => !!x).map((id) => msgs.get(id)).filter(Boolean) as { status: string; error: string | null }[];
    const msgStatus = melhorStatus(lista.map((m) => m.status));
    const primeiraResposta = r.sentAt && lead?.contactId ? (respostas.get(lead.contactId) ?? []).find((d) => d.getTime() > r.sentAt!.getTime()) ?? null : null;
    const respondeuEm = r.respondeuAt ?? primeiraResposta;
    const saiu = !!(lead?.optOutAt || ct?.optOut || lead?.lastIntent === 'SAIR');
    const grupo = classificarDestinatario({ recipientStatus: r.status, msgStatus, respondeu: !!respondeuEm, saiu });
    const proxima = c.repescagemAtiva && !r.repescagemStatus && r.status === 'ENVIADA' && (grupo === 'VISUALIZOU' || grupo === 'NAO_VISUALIZOU')
      ? proximaAcaoEm(r, c.repescagemDias) : null;
    return {
      recipientId: r.id, leadId: r.leadId, nome: lead?.name ?? null, telefone: lead?.phone ?? '', grupo, grupoRotulo: GRUPO_ROTULO[grupo],
      statusMensagem: msgStatus, enviadaEm: r.sentAt, respondeuEm, leadStatus: lead?.status ?? null,
      repescagens: r.repescagens, repescagemStatus: r.repescagemStatus, repescagemMotivo: r.repescagemMotivo,
      proximaRepescagemEm: proxima && r.repescagens < c.repescagemMax ? proxima : null,
      erro: r.error ?? lista.find((m) => m.error)?.error ?? null,
    };
  });
}

export function contarGrupos(linhas: LinhaGrupo[]): Record<GrupoCampanha, number> & { SEM_RESPOSTA: number; REPESCADOS: number } {
  const out = Object.fromEntries(GRUPOS.map((g) => [g, 0])) as Record<GrupoCampanha, number>;
  for (const l of linhas) out[l.grupo]++;
  return { ...out, SEM_RESPOSTA: linhas.filter((l) => l.repescagemStatus === 'SEM_RESPOSTA').length, REPESCADOS: linhas.filter((l) => l.repescagens > 0).length };
}

// ---------------- Texto da repescagem (IA ou modelo) ----------------

export interface TextoRepescagem { texto: string; fonte: 'ia' | 'modelo'; motivo?: string }

/** A IA escreve a repescagem. Qualquer problema (sem IA, cota, erro, texto ruim) → texto modelo da campanha. */
export async function gerarTextoRepescagem(args: {
  orgId: string; campanha: Pick<Campaign, 'message' | 'repescagemModelo' | 'name'>; nome: string | null; grupo: GrupoCampanha;
  tentativa: number; max: number; anteriores: string[]; conversationId?: string | null;
}): Promise<TextoRepescagem> {
  const modelo = (motivo: string): TextoRepescagem => ({ texto: textoModelo(args.campanha.repescagemModelo, args.grupo, args.nome, random), fonte: 'modelo', motivo });
  const ai = await prisma.aiSettings.findUnique({ where: { orgId: args.orgId } }).catch(() => null);
  if (!ai) return modelo('IA não configurada');
  if (ai.provider !== 'mck' && ai.provider !== 'fake' && !ai.apiKeyEnc) return modelo('IA sem chave');
  try {
    if (ai.provider === 'mck' && (await mckQuotaStatus(args.orgId)).reached) return modelo(MCK_QUOTA_REASON);
    if (ai.usageLimitEnabled !== false) {
      const hoje = await prisma.aiUsage.count({ where: { orgId: args.orgId, createdAt: { gte: localClock(new Date()).dayStart } } });
      if (hoje >= ai.dailyLimit) return modelo('Limite diário de uso da IA atingido');
    }
    const primeiro = (args.nome ?? '').trim().split(/\s+/)[0] ?? '';
    const tom = args.grupo === 'VISUALIZOU'
      ? 'O contato provavelmente viu a mensagem e não respondeu: tom leve e acolhedor, reconheça que a rotina é corrida e faça UMA pergunta simples e fácil de responder (ex.: se ficou alguma dúvida). NUNCA diga que viu que ele leu ou visualizou.'
      : 'O contato provavelmente ainda não viu a mensagem: tom de lembrete gentil, apresente a oferta de forma curta e direta, como se fosse a primeira vez, sem dizer que ele não leu.';
    const system = [
      'Você escreve UMA mensagem curta de WhatsApp para retomar contato com alguém que recebeu uma mensagem da empresa e não respondeu.',
      `Português do Brasil, tom ${ai.tone || 'cordial e objetivo'}, no máximo 3 frases curtas (até 350 caracteres), no máximo 1 emoji.`,
      tom,
      primeiro ? `Chame o contato pelo primeiro nome: ${primeiro}.` : 'Não sabemos o nome do contato: não invente nome, cumprimente sem nome.',
      'Mencione a oferta da campanha (descrita na mensagem original abaixo) com outras palavras. Não copie frases da mensagem original nem das anteriores.',
      'Sem pressão, sem urgência falsa, sem culpa ("você não respondeu"), sem prometer nada que não esteja na mensagem original. Use só valores, prazos e links que aparecem na mensagem original.',
      'Nunca cite empresas concorrentes nem outras marcas. Não diga que é uma IA ou um robô.',
      'Termine com a frase: "Se não quiser mais receber mensagens, responda SAIR."',
      `Esta é a repescagem ${args.tentativa} de ${args.max}.`,
      'Responda SOMENTE com o texto da mensagem, sem aspas e sem explicações.',
      '',
      '### MENSAGEM ORIGINAL DA CAMPANHA',
      args.campanha.message,
      ...(args.anteriores.length > 1 ? ['', '### MENSAGENS JÁ ENVIADAS (não repita)', ...args.anteriores.slice(1)] : []),
      ...(ai.instructions?.trim() ? ['', '### SOBRE A EMPRESA (contexto, não copie)', ai.instructions.slice(0, 2000)] : []),
    ].join('\n');
    const r = await aiChat({
      orgId: args.orgId, conversationId: args.conversationId ?? null, purpose: 'repescagem', settings: ai,
      messages: [{ role: 'system', content: system }, { role: 'user', content: 'Escreva a mensagem agora.' }],
      temperature: 0.8, maxTokens: 300, timeoutMs: 20000, retries: 1,
    });
    const ok = validarTextoIa(r.text, args.anteriores);
    return ok ? { texto: ok, fonte: 'ia' } : modelo('Texto da IA não passou na checagem');
  } catch (e) {
    return modelo((e as Error).message?.slice(0, 200) || 'Falha da IA');
  }
}

// ---------------- Agendador ----------------

export type RepescagemAcao = 'sent' | 'failed' | 'finalized' | 'nothing' | 'outside_window' | 'daily_limit' | 'waiting_interval'
  | 'number_protection' | 'number_risk' | 'channel_disconnected' | 'cloud_channel' | 'subscription_inactive';
export type RepescagemResult = { campaignId: string; action: RepescagemAcao; stopped: number }[];

/** Um passo: no máximo uma repescagem por campanha (com repescagem ligada) por chamada. */
export async function tickRepescagem(now = new Date()): Promise<RepescagemResult> {
  const out: RepescagemResult = [];
  const campanhas = await prisma.campaign.findMany({ where: { repescagemAtiva: true, status: { in: ['EM_ANDAMENTO', 'CONCLUIDA'] } }, orderBy: { createdAt: 'asc' } });
  for (const c of campanhas) {
    try {
      out.push({ campaignId: c.id, ...(await passoCampanha(c, now)) });
    } catch (e) {
      console.error('[repescagem] erro na campanha', c.id, (e as Error).message);
    }
  }
  return out;
}

interface Contexto {
  lead: Lead | null; contact: Contact | null; conv: Conversation | null; grupo: GrupoCampanha; respondeuEm: Date | null;
  atendimentoHumano: boolean; erroBloqueio: boolean; textosAnteriores: string[];
}

async function contexto(c: Campaign, r: CampaignRecipient): Promise<Contexto> {
  const lead = await prisma.lead.findFirst({ where: { id: r.leadId, orgId: c.orgId } });
  let contact: Contact | null = null;
  if (lead?.contactId) contact = await prisma.contact.findFirst({ where: { id: lead.contactId, orgId: c.orgId } });
  if (!contact && lead) contact = await prisma.contact.findUnique({ where: { orgId_waId: { orgId: c.orgId, waId: lead.phone.replace(/\D/g, '') } } });
  if (lead && !r.messageId) await vincularMensagensAntigas(c, [r], new Map([[lead.id, { ...lead, contactId: lead.contactId ?? contact?.id ?? null }]]));
  const ids = [r.messageId, r.ultimaMensagemId].filter((x): x is string => !!x);
  const msgs = ids.length ? await prisma.message.findMany({ where: { id: { in: ids } }, select: { id: true, status: true, error: true, body: true } }) : [];
  const convIds = contact ? (await prisma.conversation.findMany({ where: { orgId: c.orgId, contactId: contact.id }, select: { id: true } })).map((x) => x.id) : [];
  const depois = r.sentAt ?? new Date(0);
  const resposta = convIds.length ? await prisma.message.findFirst({
    where: { conversationId: { in: convIds }, direction: 'IN', createdAt: { gt: depois }, OR: [{ error: null }, { NOT: { error: { startsWith: AUTORESPOSTA } } }] },
    orderBy: { createdAt: 'asc' }, select: { createdAt: true },
  }) : null;
  const atendente = convIds.length ? await prisma.message.findFirst({ where: { conversationId: { in: convIds }, direction: 'OUT', sender: 'agent', createdAt: { gt: depois } }, select: { id: true } }) : null;
  const conv = contact ? await prisma.conversation.findFirst({ where: { orgId: c.orgId, contactId: contact.id, status: { not: 'CLOSED' }, OR: [{ channelId: r.channelId ?? c.channelId }, { channelId: null }] }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] }) : null;
  const respondeuEm = r.respondeuAt ?? resposta?.createdAt ?? null;
  const saiu = !!(lead?.optOutAt || contact?.optOut || lead?.lastIntent === 'SAIR');
  const grupo = classificarDestinatario({ recipientStatus: r.status, msgStatus: melhorStatus(msgs.map((m) => m.status)), respondeu: !!respondeuEm, saiu });
  const original = msgs.find((m) => m.id === r.messageId)?.body ?? c.message;
  const ultima = r.ultimaMensagemId ? msgs.find((m) => m.id === r.ultimaMensagemId)?.body : null;
  return {
    lead, contact, conv, grupo, respondeuEm,
    atendimentoHumano: !!atendente || conv?.mode === 'HUMAN',
    erroBloqueio: msgs.some((m) => m.status === 'FAILED' && erroIndicaBloqueio(m.error)),
    textosAnteriores: [original, ...(ultima ? [ultima] : [])].filter(Boolean) as string[],
  };
}

async function pausar(c: Campaign, motivo: string, now: Date) {
  if (c.repescagemPausa === motivo) return;
  await prisma.campaign.update({ where: { id: c.id }, data: { repescagemPausa: motivo, repescagemPausaEm: now } });
  c.repescagemPausa = motivo;
  console.warn('[repescagem] pausada', { campaignId: c.id, motivo });
}
async function despausar(c: Campaign) {
  if (!c.repescagemPausa) return;
  await prisma.campaign.update({ where: { id: c.id }, data: { repescagemPausa: null, repescagemPausaEm: null } });
  c.repescagemPausa = null;
}

/** Travas do envio (só calculadas quando há alguém para repescar agora). Devolve null = pode enviar. */
async function travaDeEnvio(c: Campaign, now: Date, canal: string = c.channelId): Promise<RepescagemAcao | null> {
  if (!inWindow(c, now)) return 'outside_window';
  // v1.49.0: no rodízio, cada contato é repescado pelo número dele; só o número principal mexe no aviso de pausa.
  const principal = canal === c.channelId;
  const channel = await prisma.channel.findFirst({ where: { id: canal, orgId: c.orgId } });
  // v1.46.1: QR confere a sessão viva (não só o status gravado); desconectado = espera, sem gastar tentativa.
  if (!channel || channel.status !== 'CONNECTED' || !canalConectado(channel)) return 'channel_disconnected';
  if (channel.provider !== 'whatsapp_qr') { if (principal) await pausar(c, PAUSA_API_OFICIAL, now); return 'cloud_channel'; }
  const saude = await saudeDoNumero(channel, now).catch(() => null);
  if (saude?.nivel === 'RISCO') { if (principal) await pausar(c, PAUSA_RISCO, now); return 'number_risk'; }
  if (principal) await despausar(c);
  const { dayStart } = localClock(now);
  const doCanal = c.rodizio ? filtroDoCanal(c, canal) : {};
  const [originaisHoje, repescagensHoje] = await Promise.all([
    prisma.campaignRecipient.count({ where: { campaignId: c.id, status: 'ENVIADA', sentAt: { gte: dayStart }, ...doCanal } }),
    prisma.campaignRecipient.count({ where: { campaignId: c.id, ultimaRepescagemAt: { gte: dayStart }, ...doCanal } }),
  ]);
  if (originaisHoje + repescagensHoje >= c.dailyLimit) return 'daily_limit';
  if (now.getTime() < (nextAt.get(c.id) ?? 0)) return 'waiting_interval';
  const prot = await verificarEnvioEmMassa(canal, now);
  if (!prot.ok) { nextAt.set(c.id, now.getTime() + Math.min(prot.tentarEmMs, 10 * 60_000)); return 'number_protection'; }
  return null;
}

async function passoCampanha(c: Campaign, now: Date): Promise<{ action: RepescagemAcao; stopped: number }> {
  if (!(await isProductActive(c.orgId, 'MCKMENSAGEM'))) return { action: 'subscription_inactive', stopped: 0 };
  const corte = new Date(now.getTime() - c.repescagemDias * DAY_MS);
  const candidatos = await prisma.campaignRecipient.findMany({
    where: {
      campaignId: c.id, status: 'ENVIADA', repescagemStatus: null, repescagens: { lte: c.repescagemMax },
      AND: [
        { OR: [{ repescagens: 0, sentAt: { lte: corte } }, { repescagens: { gt: 0 }, ultimaRepescagemAt: { lte: corte } }] },
        { OR: [{ repescagemAposAt: null }, { repescagemAposAt: { lte: now } }] },
      ],
    },
    orderBy: [{ sentAt: 'asc' }, { id: 'asc' }], take: 30,
  });
  let stopped = 0;
  const travas = new Map<string, RepescagemAcao | null>(); // por número (v1.49.0: rodízio)
  let action: RepescagemAcao = 'nothing';
  for (const r of candidatos) {
    const ctx = await contexto(c, r);
    const d = decidirRepescagem({
      cfg: { ativa: c.repescagemAtiva, dias: c.repescagemDias, max: c.repescagemMax }, campanhaStatus: c.status,
      recipient: r, grupo: ctx.grupo, lead: ctx.lead, contatoOptOut: !!ctx.contact?.optOut,
      atendimentoHumano: ctx.atendimentoHumano, erroBloqueio: ctx.erroBloqueio,
    }, now);
    if (d.acao === 'IGNORAR' || d.acao === 'AGUARDAR') continue;
    if (d.acao === 'PARAR') {
      await prisma.campaignRecipient.updateMany({
        where: { id: r.id, repescagemStatus: null },
        data: { repescagemStatus: d.status, repescagemMotivo: d.motivo, ...(d.status === 'RESPONDEU' && !r.respondeuAt && ctx.respondeuEm ? { respondeuAt: ctx.respondeuEm } : {}) },
      });
      stopped++;
      continue;
    }
    if (d.acao === 'FINALIZAR') {
      const ok = await prisma.campaignRecipient.updateMany({ where: { id: r.id, repescagemStatus: null }, data: { repescagemStatus: 'SEM_RESPOSTA', repescagemMotivo: `Sem resposta depois de ${r.repescagens} repescagem(ns)` } });
      if (ok.count === 1 && ctx.lead) {
        await prisma.lead.updateMany({ where: { id: ctx.lead.id, status: 'CONTATADO' }, data: { status: 'SEM_RESPOSTA' } });
        if (ctx.conv) await note(c.orgId, ctx.conv.id, `Campanha "${c.name}": sem resposta depois de ${r.repescagens} repescagem(ns). Contato marcado como "Sem resposta"; a repescagem automática parou.`);
        if (action === 'nothing') action = 'finalized';
      }
      continue;
    }
    // ENVIAR: só uma por passo por campanha.
    if (action === 'sent' || action === 'failed') continue;
    const canal = r.channelId ?? c.channelId;
    if (!travas.has(canal)) travas.set(canal, await travaDeEnvio(c, now, canal));
    const trava = travas.get(canal);
    if (trava) { if (action === 'nothing' || action === 'finalized') action = trava; continue; }
    const res = await enviar(c, r, ctx, d.tentativa, now);
    action = res;
    if (res === 'sent' || res === 'failed') {
      const gap = c.minIntervalSec + random() * Math.max(0, c.maxIntervalSec - c.minIntervalSec);
      nextAt.set(c.id, now.getTime() + gap * 1000);
    }
  }
  return { action, stopped };
}

async function enviar(c: Campaign, r: CampaignRecipient, ctx: Contexto, tentativa: number, now: Date): Promise<RepescagemAcao> {
  if (!ctx.lead || !ctx.contact) return 'nothing';
  // Claim atômico: só um processo/passo pega este destinatário nesta tentativa.
  const claim = await prisma.campaignRecipient.updateMany({ where: { id: r.id, repescagemStatus: null, repescagens: r.repescagens }, data: { repescagemStatus: 'ENVIANDO' } });
  if (claim.count !== 1) return 'nothing';
  const conv = await openConversationFor(c.orgId, ctx.contact.id, r.channelId ?? c.channelId);
  const t = await gerarTextoRepescagem({
    orgId: c.orgId, campanha: c, nome: ctx.lead.name, grupo: ctx.grupo, tentativa, max: c.repescagemMax, anteriores: ctx.textosAnteriores, conversationId: conv.id,
  });
  // A IA leva alguns segundos: confere de novo se o contato respondeu/saiu nesse meio tempo.
  const [lead, contact, resposta] = await Promise.all([
    prisma.lead.findUnique({ where: { id: ctx.lead.id } }),
    prisma.contact.findUnique({ where: { id: ctx.contact.id } }),
    prisma.campaignRecipient.findUnique({ where: { id: r.id }, select: { respondeuAt: true } }),
  ]);
  const convIds = (await prisma.conversation.findMany({ where: { orgId: c.orgId, contactId: ctx.contact.id }, select: { id: true } })).map((x) => x.id);
  const novaResposta = await prisma.message.findFirst({ where: { conversationId: { in: convIds }, direction: 'IN', createdAt: { gt: r.sentAt ?? new Date(0) }, OR: [{ error: null }, { NOT: { error: { startsWith: AUTORESPOSTA } } }] }, select: { createdAt: true } });
  if (resposta?.respondeuAt || novaResposta || !lead || lead.status !== 'CONTATADO' || lead.optOutAt || contact?.optOut) {
    const respondeu = !!(resposta?.respondeuAt || novaResposta);
    await prisma.campaignRecipient.update({ where: { id: r.id }, data: { repescagemStatus: respondeu ? 'RESPONDEU' : 'PARADA', repescagemMotivo: respondeu ? 'Contato respondeu' : 'Contato mudou de situação antes do envio', ...(respondeu && !resposta?.respondeuAt && novaResposta ? { respondeuAt: novaResposta.createdAt } : {}) } });
    return 'nothing';
  }
  let msg;
  try {
    msg = await sender({ conversation: conv, contact: contact!, payload: { type: 'text', text: t.texto }, sender: 'bot', product: 'MCKMENSAGEM', bulk: true });
  } catch (e) {
    msg = { status: 'FAILED', error: (e as Error).message?.slice(0, 300) || 'Erro no envio', id: null } as any;
  }
  if (msg.status === 'FAILED') {
    // v1.46.1: queda do WhatsApp/erro passageiro não conta como falha do contato: tenta de novo em 10 min.
    if (!erroIndicaBloqueio(msg.error) && erroDeConexao(msg.error)) {
      await prisma.campaignRecipient.update({ where: { id: r.id }, data: { repescagemStatus: null, repescagemAposAt: new Date(now.getTime() + 10 * 60_000) } });
      return 'failed';
    }
    const falhas = r.repescagemFalhas + 1;
    const definitiva = erroIndicaBloqueio(msg.error) || falhas >= 3;
    await prisma.campaignRecipient.update({
      where: { id: r.id },
      data: definitiva
        ? { repescagemStatus: 'PARADA', repescagemMotivo: `Falha no envio da repescagem: ${msg.error ?? 'erro'}`.slice(0, 300), repescagemFalhas: falhas }
        : { repescagemStatus: null, repescagemFalhas: falhas, repescagemAposAt: new Date(now.getTime() + 3600e3) },
    });
    if (definitiva) await note(c.orgId, conv.id, `Repescagem da campanha "${c.name}" parada: ${msg.error ?? 'falha no envio'}.`);
    return 'failed';
  }
  await prisma.campaignRecipient.update({
    where: { id: r.id },
    data: { repescagens: tentativa, ultimaRepescagemAt: now, ultimaMensagemId: msg.id, repescagemStatus: null, repescagemMotivo: null, repescagemFalhas: 0, repescagemAposAt: null },
  });
  await note(c.orgId, conv.id, `Repescagem automática ${tentativa}/${c.repescagemMax} da campanha "${c.name}" enviada (${GRUPO_ROTULO[ctx.grupo].toLowerCase()}; texto ${t.fonte === 'ia' ? 'escrito pela IA' : `modelo${t.motivo ? ` — ${t.motivo}` : ''}`}). Se o contato responder, segue para a qualificação normal.`);
  return 'sent';
}

/** Marca "respondeu" nos destinatários das campanhas destes leads (chamado pelo inbound). */
export async function marcarRespostaCampanhas(leadIds: string[], at = new Date()): Promise<void> {
  if (!leadIds.length) return;
  await prisma.campaignRecipient.updateMany({ where: { leadId: { in: leadIds }, status: 'ENVIADA', respondeuAt: null, sentAt: { lte: at } }, data: { respondeuAt: at } });
  await prisma.campaignRecipient.updateMany({ where: { leadId: { in: leadIds }, status: 'ENVIADA', repescagemStatus: null, sentAt: { lte: at } }, data: { repescagemStatus: 'RESPONDEU', repescagemMotivo: 'Contato respondeu' } });
}
