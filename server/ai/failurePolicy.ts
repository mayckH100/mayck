import { prisma } from '../db.js';

/**
 * Falha da IA repetida na mesma conversa (caso de 2026-11-04: o cliente recebeu duas vezes seguidas
 * "Desculpe, não consegui responder agora…"). Regra:
 * - 1ª falha: o texto de falha configurado (ou o padrão).
 * - 2ª falha seguida (a última mensagem enviada ao cliente, nos últimos 30 min, já foi o texto de falha):
 *   texto diferente, explicando a instabilidade e oferecendo um atendente.
 * - 3ª em diante dentro da janela: não manda nada (o cliente já foi avisado; o dono recebe o alerta).
 */
export const SECOND_FAILURE_TEXT = 'Peço desculpas pela demora: estou com uma instabilidade momentânea para responder. Tente de novo em alguns minutos ou, se preferir falar com uma pessoa da equipe, escreva "atendente".';

/** Janela (ms) em que falhas seguidas contam como repetidas. AI_FAILURE_REPEAT_MIN; padrão 30 min. */
export function failureRepeatWindowMs(): number {
  const v = Number(process.env.AI_FAILURE_REPEAT_MIN);
  return (Number.isFinite(v) && v > 0 ? v : 30) * 60_000;
}

const same = (a: string | null | undefined, b: string) => (a ?? '').trim() === b.trim();

/** Puro: texto a mandar dada a última mensagem enviada ao cliente dentro da janela (null = nada). */
export function failureTextForStreak(lastOutBody: string | null | undefined, fail: string): string | null {
  if (lastOutBody == null) return fail;
  if (same(lastOutBody, SECOND_FAILURE_TEXT)) return null;
  if (same(lastOutBody, fail)) return same(fail, SECOND_FAILURE_TEXT) ? null : SECOND_FAILURE_TEXT;
  return fail;
}

/** Decide o texto de falha olhando a última mensagem enviada nesta conversa. Nunca lança (erro → texto normal). */
export async function failureTextFor(orgId: string, conversationId: string, fail: string, now = new Date()): Promise<string | null> {
  if (!conversationId) return fail;
  try {
    const last = await prisma.message.findFirst({
      where: { orgId, conversationId, direction: 'OUT', createdAt: { gte: new Date(now.getTime() - failureRepeatWindowMs()) } },
      orderBy: { createdAt: 'desc' }, select: { body: true },
    });
    return failureTextForStreak(last?.body ?? null, fail);
  } catch {
    return fail;
  }
}
