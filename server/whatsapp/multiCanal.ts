import { prisma } from '../db.js';
import type { Channel, Contact, Conversation } from '@prisma/client';
import { channelLabels, type ChannelLabelInfo } from './channelLabel.js';
import { sendOutbound } from './messaging.js';

/**
 * Vários WhatsApps conectados na mesma organização.
 *
 * 1) Cada número tem a sua própria conversa com o cliente: a conversa aberta é procurada por
 *    contato + canal. Antes a conversa era única por contato, então quem escrevia para o
 *    WhatsApp 2 caía na conversa do WhatsApp 1 e a resposta (IA/fluxo) saía pelo WhatsApp 1
 *    (ou era bloqueada pelo modo "humano" da outra conversa) — parecia que só um número respondia.
 *
 * 2) Atendimento em andamento em outro número: se o cliente já está sendo atendido por outro
 *    WhatsApp da organização (conversa não encerrada com atendente/aguardando atendente ou com
 *    atividade recente), o número novo não abre um atendimento paralelo: avisa UMA vez (por janela)
 *    para continuar pelo outro número e registra nota interna nas duas conversas.
 */

/** Janela em que uma conversa conta como "atendimento em andamento" (e em que o aviso não se repete). */
export const ATENDIMENTO_ATIVO_JANELA_MS = 48 * 3600 * 1000;

/** Marca da nota interna do aviso (usada para não repetir o aviso dentro da janela). */
export const NOTA_DESVIO_PREFIXO = '↪️ Atendimento em outro WhatsApp:';

/**
 * Conversa aberta do contato NESTE canal. Uma conversa aberta ainda sem canal é adotada;
 * conversa aberta de outro canal nunca é reaproveitada (cada número tem a sua).
 */
export async function openConversationFor(orgId: string, contactId: string, channelId: string): Promise<Conversation> {
  const conv = await prisma.conversation.findFirst({
    where: { orgId, contactId, status: { not: 'CLOSED' }, OR: [{ channelId }, { channelId: null }] },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  });
  if (!conv) return prisma.conversation.create({ data: { orgId, contactId, channelId } });
  if (!conv.channelId) return prisma.conversation.update({ where: { id: conv.id }, data: { channelId } });
  return conv;
}

/** Conversa com atendimento em andamento do mesmo contato em OUTRO WhatsApp conectado da organização. */
export async function activeConversationElsewhere(conv: Conversation, channel: Channel, now = new Date()): Promise<Conversation | null> {
  const since = new Date(now.getTime() - ATENDIMENTO_ATIVO_JANELA_MS);
  const outros = await prisma.channel.findMany({ where: { orgId: conv.orgId, id: { not: channel.id }, status: 'CONNECTED' }, select: { id: true } });
  if (!outros.length) return null;
  return prisma.conversation.findFirst({
    where: {
      orgId: conv.orgId, contactId: conv.contactId, id: { not: conv.id },
      status: { not: 'CLOSED' },
      channelId: { in: outros.map((c) => c.id) },
      OR: [{ mode: 'HUMAN' }, { waitingSince: { not: null } }, { lastMessageAt: { gte: since } }],
    },
    orderBy: [{ lastMessageAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }],
  });
}

/** Texto do aviso ao cliente: "Seu atendimento já está em andamento pelo nosso WhatsApp Carla (11 98765-4321)…". */
export function redirectText(other: Pick<ChannelLabelInfo, 'name' | 'phone'> | null | undefined): string {
  const nome = other?.name ? ` ${other.name}` : '';
  const fone = other?.phone ? ` (${other.phone})` : '';
  const alvo = nome || fone ? `pelo nosso WhatsApp${nome}${fone}` : 'pelo nosso outro WhatsApp';
  return `Seu atendimento já está em andamento ${alvo}. Por favor, continue a conversa por lá 😊`;
}

/**
 * Se o cliente já está sendo atendido por outro número, este canal não abre atendimento paralelo.
 * Devolve true quando a mensagem foi tratada aqui (aviso enviado agora ou já enviado na janela):
 * nesse caso nenhum fluxo/IA roda neste canal. Se este canal já está atendendo o cliente
 * (respostas de bot/IA/atendente na janela), segue o atendimento normal (false).
 */
export async function redirectIfActiveElsewhere(conv: Conversation, contact: Contact, channel: Channel, now = new Date()): Promise<boolean> {
  const other = await activeConversationElsewhere(conv, channel, now);
  if (!other) return false;
  const since = new Date(now.getTime() - ATENDIMENTO_ATIVO_JANELA_MS);
  const atendendoAqui = await prisma.message.findFirst({
    where: { conversationId: conv.id, direction: 'OUT', sender: { in: ['bot', 'ai', 'agent'] }, createdAt: { gte: since } },
    select: { id: true },
  });
  if (atendendoAqui) return false;
  const jaAvisado = await prisma.message.findFirst({
    where: { conversationId: conv.id, direction: 'INTERNAL', body: { startsWith: NOTA_DESVIO_PREFIXO }, createdAt: { gte: since } },
    select: { id: true },
  });
  if (jaAvisado) return true; // aviso já dado nesta janela: não repete (a mensagem fica no Inbox)

  const labels = await channelLabels(conv.orgId);
  const aqui = labels.get(channel.id);
  const la = other.channelId ? labels.get(other.channelId) : undefined;
  const nota = `${NOTA_DESVIO_PREFIXO} cliente escreveu pelo ${aqui?.via ?? channel.name}; orientado a voltar ao ${la?.via ?? 'outro WhatsApp'}.`;
  await prisma.message.createMany({
    data: [conv, other].map((c) => ({ orgId: conv.orgId, conversationId: c.id, direction: 'INTERNAL', sender: 'system', type: 'note', body: nota, status: 'NOTE' })),
  });
  await sendOutbound({ conversation: conv, contact, payload: { type: 'text', text: redirectText(la) }, sender: 'system' });
  return true;
}
