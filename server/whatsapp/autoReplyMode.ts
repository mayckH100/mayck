import { prisma } from '../db.js';

/**
 * "Quem responde automaticamente" em cada canal WhatsApp (QR ou API oficial).
 * - flows: só os fluxos respondem; a IA nunca responde sozinha neste canal.
 * - ai: nenhum fluxo é disparado por mensagens deste canal; só a IA responde (se estiver ligada).
 * - both (padrão): comportamento original — fluxos primeiro e a IA como resposta para o resto.
 */
export const AUTO_REPLY_MODES = ['flows', 'ai', 'both'] as const;
export type AutoReplyMode = (typeof AUTO_REPLY_MODES)[number];

/** Modo de um canal NOVO: "ai" quando a organização tem a IA com resposta automática ligada; senão "both". */
export async function defaultAutoReplyMode(orgId: string): Promise<AutoReplyMode> {
  const ai = await prisma.aiSettings.findUnique({ where: { orgId }, select: { enabled: true, autoReply: true } });
  return ai?.enabled && ai.autoReply ? 'ai' : 'both';
}

export function autoReplyModeOf(c: { autoReplyMode?: string | null } | null | undefined): AutoReplyMode {
  const v = c?.autoReplyMode;
  return v === 'flows' || v === 'ai' ? v : 'both';
}
