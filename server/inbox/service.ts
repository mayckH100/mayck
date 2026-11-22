/**
 * v1.41.0 — Atendimento do Inbox: distribuição automática, horário de atendimento, pesquisa de satisfação
 * e mensagens agendadas. Nada aqui lança para quem chama no caminho da mensagem recebida (falha vira log).
 *
 * Regra com a IA/fluxos: estas automações só agem quando a conversa vai para (ou já está com) um humano:
 * conversa em modo humano, transferência (pedido do cliente ou bloco do fluxo) ou mensagem que nenhuma
 * automação respondeu. Com a IA respondendo no canal, a IA continua respondendo e nada daqui interfere.
 */
import { prisma } from '../db.js';
import type { Contact, Conversation, InboxSettings } from '@prisma/client';
import { accessOf } from '../lib/permissions.js';
import type { Role } from '../types.js';
import { parseJson } from '../lib/json.js';
import {
  escolherAtendente, dentroDoHorario, textoForaDoHorario, podeAvisarForaDoHorario, validarFaixas, lerNotaCsat, csatAberta,
  CSAT_PERGUNTA_PADRAO, CSAT_OBRIGADO_PADRAO, CSAT_JANELA_MS, type Estrategia, type Faixa,
} from './core.js';

/** Sessão vista há até 15 min = atendente "online" (o Inbox aberto renova a sessão sozinho). */
export const ONLINE_MS = 15 * 60_000;

export type InboxConfig = Omit<InboxSettings, 'updatedAt'> & { updatedAt: Date | null };

export function defaultInboxSettings(orgId: string): InboxConfig {
  return {
    orgId, autoAssign: false, assignStrategy: 'rodizio', assignOnlineOnly: true, assignUserIds: '[]', lastAssignedUserId: null,
    hoursEnabled: false, hours: '[]', awayMessage: '', awayEveryHours: 12, csatEnabled: false, csatQuestion: '', csatThanks: '', updatedAt: null,
  };
}

export async function getInboxSettings(orgId: string): Promise<InboxConfig> {
  return (await prisma.inboxSettings.findUnique({ where: { orgId } })) ?? defaultInboxSettings(orgId);
}

export function faixasDe(s: Pick<InboxSettings, 'hours'>): Faixa[] {
  const v = validarFaixas(parseJson<unknown>(s.hours, []));
  return 'faixas' in v ? v.faixas : [];
}

async function tzDe(orgId: string): Promise<string> {
  const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { timezone: true } });
  const tz = org?.timezone || 'America/Sao_Paulo';
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return tz; } catch { return 'America/Sao_Paulo'; }
}

const nota = (conv: Pick<Conversation, 'orgId' | 'id'>, body: string) =>
  prisma.message.create({ data: { orgId: conv.orgId, conversationId: conv.id, direction: 'INTERNAL', sender: 'system', type: 'note', body, status: 'NOTE' } });

// ---------------- Distribuição automática ----------------

/** Quem pode receber esta conversa: membro ativo, com acesso ao Inbox e ao canal (e online, se configurado). */
export async function candidatosDistribuicao(orgId: string, channelId: string | null, s: Pick<InboxSettings, 'assignOnlineOnly' | 'assignUserIds'>, agora = new Date()) {
  const membros = await prisma.membership.findMany({ where: { orgId }, include: { user: { select: { id: true, name: true, disabledAt: true } } }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
  const escolhidos = parseJson<string[]>(s.assignUserIds, []);
  const ordem = membros.map((m) => m.userId);
  let elegiveis = membros.filter((m) => {
    if (m.user.disabledAt) return false;
    if (escolhidos.length && !escolhidos.includes(m.userId)) return false;
    const a = accessOf(m.role as Role, m);
    if (a.modules && !a.modules.includes('inbox')) return false;
    // Membro com canais limitados só recebe conversas desses canais (conversa sem canal: só quem atende todos).
    if (a.channelIds && (!channelId || !a.channelIds.includes(channelId))) return false;
    return true;
  });
  if (s.assignOnlineOnly && elegiveis.length) {
    const online = await prisma.session.findMany({
      where: { userId: { in: elegiveis.map((m) => m.userId) }, expiresAt: { gt: agora }, OR: [{ lastSeenAt: { gte: new Date(agora.getTime() - ONLINE_MS) } }, { lastSeenAt: null, createdAt: { gte: new Date(agora.getTime() - ONLINE_MS) } }] },
      select: { userId: true },
    });
    const on = new Set(online.map((o) => o.userId));
    elegiveis = elegiveis.filter((m) => on.has(m.userId));
  }
  return { elegiveis: elegiveis.map((m) => ({ userId: m.userId, nome: m.user.name })), ordem };
}

/**
 * Distribui a conversa (sem responsável) para um atendente, se a empresa ligou a distribuição.
 * Devolve o userId escolhido ou null (desligado, já tem responsável, ninguém disponível).
 */
export async function distribuirConversa(conv: Conversation, agora = new Date()): Promise<string | null> {
  if (conv.assignedUserId) return null;
  const s = await getInboxSettings(conv.orgId);
  if (!s.autoAssign) return null;
  const { elegiveis, ordem } = await candidatosDistribuicao(conv.orgId, conv.channelId, s, agora);
  if (!elegiveis.length) return null;
  const abertas = await prisma.conversation.groupBy({ by: ['assignedUserId'], where: { orgId: conv.orgId, status: { not: 'CLOSED' }, assignedUserId: { in: elegiveis.map((e) => e.userId) } }, _count: { _all: true } });
  const cand = elegiveis.map((e) => ({ userId: e.userId, abertas: abertas.find((a) => a.assignedUserId === e.userId)?._count._all ?? 0 }));
  const escolhido = escolherAtendente(cand, ordem, s.lastAssignedUserId, (s.assignStrategy === 'menos_ocupado' ? 'menos_ocupado' : 'rodizio') as Estrategia);
  if (!escolhido) return null;
  // Só grava se ninguém assumiu nesse meio-tempo.
  const r = await prisma.conversation.updateMany({ where: { id: conv.id, assignedUserId: null }, data: { assignedUserId: escolhido, assignedAt: agora } });
  if (r.count !== 1) return null;
  conv.assignedUserId = escolhido;
  await prisma.inboxSettings.updateMany({ where: { orgId: conv.orgId }, data: { lastAssignedUserId: escolhido } });
  const nome = elegiveis.find((e) => e.userId === escolhido)?.nome ?? 'atendente';
  await nota(conv, `Conversa distribuída automaticamente para ${nome} (${s.assignStrategy === 'menos_ocupado' ? 'menos ocupado' : 'rodízio'}).`);
  return escolhido;
}

// ---------------- Horário de atendimento ----------------

/**
 * Fora do horário, manda a mensagem automática (no máximo 1 vez a cada X horas por contato).
 * Não conta como "primeira resposta" da equipe nos relatórios.
 */
export async function avisarForaDoHorario(conv: Conversation, contact: Contact, agora = new Date()): Promise<boolean> {
  if (contact.optOut) return false;
  const s = await getInboxSettings(conv.orgId);
  if (!s.hoursEnabled) return false;
  const faixas = faixasDe(s);
  if (!faixas.length) return false;
  if (dentroDoHorario(faixas, agora, await tzDe(conv.orgId))) return false;
  // Trava por contato: só um envio passa, mesmo com mensagens chegando juntas.
  const limite = new Date(agora.getTime() - Math.max(1, s.awayEveryHours) * 3600_000);
  if (!podeAvisarForaDoHorario(contact.awayMessageAt, agora, s.awayEveryHours)) return false;
  const claim = await prisma.contact.updateMany({ where: { id: contact.id, OR: [{ awayMessageAt: null }, { awayMessageAt: { lte: limite } }] }, data: { awayMessageAt: agora } });
  if (claim.count !== 1) return false;
  contact.awayMessageAt = agora;
  const { sendOutbound } = await import('../whatsapp/messaging.js');
  const tinhaResposta = conv.firstResponseAt;
  const msg = await sendOutbound({ conversation: conv, contact, payload: { type: 'text', text: textoForaDoHorario(s.awayMessage, faixas, contact.name) }, sender: 'bot' });
  if (!tinhaResposta) {
    await prisma.conversation.update({ where: { id: conv.id }, data: { firstResponseAt: null } }).catch(() => undefined);
    conv.firstResponseAt = null;
  }
  if (msg.status === 'FAILED') await prisma.contact.update({ where: { id: contact.id }, data: { awayMessageAt: null } }).catch(() => undefined);
  else await nota(conv, 'Mensagem automática de fora do horário enviada.');
  return msg.status !== 'FAILED';
}

/**
 * A conversa foi (ou está) para atendimento humano: distribui e, fora do horário, avisa o cliente.
 * Nunca lança (o caminho da mensagem recebida não pode cair por causa disso).
 */
export async function aoIrParaHumano(conv: Conversation, contact: Contact | null, opts: { avisar?: boolean } = {}): Promise<void> {
  try {
    await distribuirConversa(conv);
  } catch (e) {
    console.error('[inbox] distribuição', conv.orgId, (e as Error).message);
  }
  if (opts.avisar === false) return;
  try {
    const c = contact ?? (await prisma.contact.findFirst({ where: { id: conv.contactId, orgId: conv.orgId } }));
    if (c) await avisarForaDoHorario(conv, c);
  } catch (e) {
    console.error('[inbox] fora do horário', conv.orgId, (e as Error).message);
  }
}

// ---------------- Pesquisa de satisfação ----------------

/** Ao encerrar: envia a pergunta (se ligada) e registra a pesquisa pendente. */
export async function enviarPesquisaAoEncerrar(conv: Conversation): Promise<boolean> {
  try {
    const s = await getInboxSettings(conv.orgId);
    if (!s.csatEnabled) return false;
    const contact = await prisma.contact.findFirst({ where: { id: conv.contactId, orgId: conv.orgId } });
    if (!contact || contact.optOut) return false;
    // Só pergunta se o cliente falou na conversa (conversa aberta só pela empresa não tem atendimento a avaliar).
    if (!conv.lastInboundAt) return false;
    const { sendOutbound } = await import('../whatsapp/messaging.js');
    const msg = await sendOutbound({ conversation: conv, contact, payload: { type: 'text', text: s.csatQuestion.trim() || CSAT_PERGUNTA_PADRAO }, sender: 'bot' });
    if (msg.status === 'FAILED') return false;
    // Uma pesquisa pendente por contato: a anterior (se houver) deixa de valer.
    await prisma.csatRating.updateMany({ where: { orgId: conv.orgId, contactId: contact.id, status: 'PENDENTE' }, data: { status: 'EXPIRADA' } });
    await prisma.csatRating.create({ data: { orgId: conv.orgId, conversationId: conv.id, contactId: contact.id, assignedUserId: conv.assignedUserId } });
    return true;
  } catch (e) {
    console.error('[inbox] pesquisa de satisfação', conv.orgId, (e as Error).message);
    return false;
  }
}

/**
 * Mensagem recebida de um contato com pesquisa pendente (até 24 h): se for nota 1–5, grava, agradece e
 * devolve true (a mensagem foi tratada: não abre conversa nova nem chama IA/fluxos). Outra resposta
 * encerra a espera (sem nota) e segue o caminho normal (false).
 */
export async function tratarRespostaCsat(args: { orgId: string; contact: Contact; channelId: string; text: string; waMessageId: string; timestamp: Date }, agora = new Date()): Promise<boolean> {
  const pend = await prisma.csatRating.findFirst({ where: { orgId: args.orgId, contactId: args.contact.id, status: 'PENDENTE' }, orderBy: { askedAt: 'desc' } });
  if (!pend) return false;
  if (!csatAberta(pend.askedAt, agora)) {
    await prisma.csatRating.updateMany({ where: { id: pend.id, status: 'PENDENTE' }, data: { status: 'EXPIRADA' } });
    return false;
  }
  const conv = await prisma.conversation.findFirst({ where: { id: pend.conversationId, orgId: args.orgId } });
  const score = lerNotaCsat(args.text);
  // Resposta chegou por outro número (ou a conversa sumiu): não mistura, só para de esperar.
  if (!conv || (conv.channelId && conv.channelId !== args.channelId) || conv.status !== 'CLOSED') {
    await prisma.csatRating.updateMany({ where: { id: pend.id, status: 'PENDENTE' }, data: { status: score ? 'EXPIRADA' : 'IGNORADA', answeredAt: agora } });
    return false;
  }
  if (score == null) {
    await prisma.csatRating.updateMany({ where: { id: pend.id, status: 'PENDENTE' }, data: { status: 'IGNORADA', answeredAt: agora } });
    return false;
  }
  const r = await prisma.csatRating.updateMany({ where: { id: pend.id, status: 'PENDENTE' }, data: { status: 'RESPONDIDA', score, answeredAt: agora } });
  if (r.count !== 1) return false;
  try {
    await prisma.message.create({ data: { orgId: args.orgId, conversationId: conv.id, channelId: args.channelId, direction: 'IN', sender: 'contact', type: 'text', body: args.text, waMessageId: args.waMessageId, status: 'RECEIVED', createdAt: args.timestamp > agora ? agora : args.timestamp } });
  } catch (e) {
    if ((e as { code?: string }).code !== 'P2002') throw e;
  }
  await prisma.conversation.update({ where: { id: conv.id }, data: { lastInboundAt: agora, lastMessageAt: agora } });
  conv.lastInboundAt = agora;
  await nota(conv, `⭐ Pesquisa de satisfação: nota ${score} de 5.`);
  const s = await getInboxSettings(args.orgId);
  const { sendOutbound } = await import('../whatsapp/messaging.js');
  await sendOutbound({ conversation: conv, contact: args.contact, payload: { type: 'text', text: s.csatThanks.trim() || CSAT_OBRIGADO_PADRAO }, sender: 'bot' }).catch(() => undefined);
  return true;
}

/** Resumo para Relatórios: notas respondidas no período (por data da resposta). */
export async function resumoCsat(orgId: string, desde: Date) {
  const [respondidas, enviadas] = await Promise.all([
    prisma.csatRating.findMany({ where: { orgId, status: 'RESPONDIDA', answeredAt: { gte: desde } }, select: { score: true, assignedUserId: true } }),
    prisma.csatRating.count({ where: { orgId, askedAt: { gte: desde } } }),
  ]);
  return { respondidas, enviadas };
}

export const CSAT_JANELA = CSAT_JANELA_MS;

// ---------------- Mensagens agendadas ----------------

/** Envia as mensagens agendadas vencidas (claim atômico: cada uma sai uma vez só). */
export async function tickMensagensAgendadas(agora = new Date(), lote = 20): Promise<number> {
  const vencidas = await prisma.scheduledMessage.findMany({ where: { status: 'PENDENTE', sendAt: { lte: agora } }, orderBy: { sendAt: 'asc' }, take: lote });
  let enviadas = 0;
  const { sendOutbound } = await import('../whatsapp/messaging.js');
  for (const sm of vencidas) {
    const claim = await prisma.scheduledMessage.updateMany({ where: { id: sm.id, status: 'PENDENTE' }, data: { status: 'ENVIANDO' } });
    if (claim.count !== 1) continue;
    try {
      const conv = await prisma.conversation.findFirst({ where: { id: sm.conversationId, orgId: sm.orgId } });
      const contact = conv ? await prisma.contact.findFirst({ where: { id: conv.contactId, orgId: sm.orgId } }) : null;
      if (!conv || !contact) {
        await prisma.scheduledMessage.update({ where: { id: sm.id }, data: { status: 'FALHOU', error: 'Conversa ou contato não existe mais' } });
        continue;
      }
      const msg = await sendOutbound({ conversation: conv, contact, payload: { type: 'text', text: sm.body }, sender: 'agent', authorUserId: sm.createdById ?? undefined });
      await prisma.scheduledMessage.update({ where: { id: sm.id }, data: { status: msg.status === 'FAILED' ? 'FALHOU' : 'ENVIADA', messageId: msg.id, error: msg.status === 'FAILED' ? msg.error : null } });
      if (msg.status !== 'FAILED') enviadas++;
    } catch (e) {
      await prisma.scheduledMessage.update({ where: { id: sm.id }, data: { status: 'FALHOU', error: (e as Error).message.slice(0, 300) } }).catch(() => undefined);
    }
  }
  return enviadas;
}
