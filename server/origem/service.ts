/**
 * v1.44.0 — Origem do lead: grava a origem da conversa (sempre a primeira dela) e do contato (primeiro contato).
 * Nunca impede a mensagem de entrar: qualquer erro só é registrado no log.
 */
import type { Contact, Conversation } from '@prisma/client';
import { prisma } from '../db.js';
import { lerCodigo, ORIGEM_ANUNCIO, type Referral } from './core.js';

export interface OrigemDetectada { codigo: string; detalhe?: Referral; texto?: string }

/**
 * Origem de uma mensagem recebida: anúncio Click-to-WhatsApp (referral) ou código de um link de origem cadastrado.
 * Código desconhecido (não cadastrado pela empresa) é ignorado e o texto fica como veio.
 */
export async function detectarOrigem(orgId: string, texto: string | null | undefined, referral?: Referral): Promise<OrigemDetectada | null> {
  const lido = lerCodigo(texto);
  let porLink: OrigemDetectada | null = null;
  if (lido) {
    const link = await prisma.origemLink.findUnique({ where: { orgId_code: { orgId, code: lido.codigo } }, select: { id: true } }).catch(() => null);
    if (link) porLink = { codigo: lido.codigo, texto: lido.texto };
  }
  if (referral) return { codigo: ORIGEM_ANUNCIO, detalhe: referral, ...(porLink ? { texto: porLink.texto } : {}) };
  return porLink;
}

/** Grava a origem na conversa (se ainda não tiver) e no contato (se for o primeiro registro dele). */
export async function registrarOrigem(contact: Pick<Contact, 'id' | 'orgId' | 'origem'>, conv: Pick<Conversation, 'id' | 'origem'>, o: OrigemDetectada, now = new Date()): Promise<void> {
  try {
    const detalhe = o.detalhe ? JSON.stringify(o.detalhe).slice(0, 2000) : null;
    if (!conv.origem) {
      await prisma.conversation.updateMany({ where: { id: conv.id, origem: null }, data: { origem: o.codigo, origemDetalhe: detalhe } });
      conv.origem = o.codigo;
    }
    if (!contact.origem) {
      await prisma.contact.updateMany({ where: { id: contact.id, origem: null }, data: { origem: o.codigo, origemEm: now } });
      contact.origem = o.codigo;
    }
  } catch (e) {
    console.error('[origem] falha ao gravar a origem', { orgId: contact.orgId, error: (e as Error).message });
  }
}
