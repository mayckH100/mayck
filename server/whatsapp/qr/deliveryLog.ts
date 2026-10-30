import { prisma } from '../../db.js';
import { jidToNumber } from './parse.js';

/**
 * Mede o problema "Aguardando mensagem": transforma os avisos internos do Baileys sobre
 * reenvio (retry) e falha de descriptografia em eventos na Auditoria, por contato.
 *
 *  whatsapp.retry_pedido        o celular do cliente não decifrou nossa mensagem e pediu de novo
 *  whatsapp.retry_sem_mensagem  pediu de novo, mas não tínhamos a mensagem para reenviar (fica presa)
 *  whatsapp.retry_limite        reenviada vezes demais; o WhatsApp desiste
 *  whatsapp.retry_erro          o reenvio falhou
 *  whatsapp.decrypt_falha       nós não conseguimos decifrar uma mensagem recebida do cliente
 */
export const DELIVERY_EVENTS: Record<string, string> = {
  'recv retry request': 'whatsapp.retry_pedido',
  'recv retry request, but message not available': 'whatsapp.retry_sem_mensagem',
  'will not send message again, as sent too many times': 'whatsapp.retry_limite',
  'error in sending message again': 'whatsapp.retry_erro',
  'failed to decrypt message': 'whatsapp.decrypt_falha',
};

type Obj = Record<string, any> | undefined;

export function describeEvent(obj: unknown, msg?: string): { action: string; jid: string | null; msgId: string | null } | null {
  const action = msg ? DELIVERY_EVENTS[msg] : undefined;
  if (!action) return null;
  const o = (obj && typeof obj === 'object' ? obj : {}) as Record<string, any>;
  const key: Obj = o.key;
  const attrs: Obj = o.attrs;
  const jid: string | null = key?.participant || key?.remoteJid || attrs?.participant || attrs?.from || o.jid || null;
  const msgId: string | null = key?.id || (Array.isArray(o.ids) ? o.ids[0] : null) || attrs?.id || o.id || null;
  return { action, jid, msgId };
}

const MAX_PER_HOUR = 300;
const seen = new Set<string>();
const hourly = new Map<string, { hour: number; n: number }>();

/** Registra o evento (sem duplicar o mesmo evento da mesma mensagem; teto por hora por canal). */
export async function recordDeliveryEvent(channelId: string, orgId: string | null, ev: { action: string; jid: string | null; msgId: string | null }, extra: Record<string, unknown> = {}) {
  const dedupe = `${channelId}:${ev.action}:${ev.msgId ?? ''}:${ev.jid ?? ''}`;
  if (ev.msgId) {
    if (seen.has(dedupe)) return false;
    seen.add(dedupe);
    if (seen.size > 20_000) seen.delete(seen.values().next().value as string);
  }
  const hour = Math.floor(Date.now() / 3600e3);
  const h = hourly.get(channelId);
  if (!h || h.hour !== hour) hourly.set(channelId, { hour, n: 1 });
  else if (++h.n > MAX_PER_HOUR) return false;
  const numero = jidToNumber(ev.jid) ?? ev.jid;
  if (process.env.NODE_ENV !== 'test') console.warn(`[whatsapp-qr] ${ev.action} canal=${channelId} contato=${numero ? `***${String(numero).slice(-4)}` : '?'} msg=${ev.msgId ?? '?'}`); // número mascarado no log (completo só na Auditoria)
  await prisma.auditLog.create({
    data: {
      orgId, action: ev.action, entity: 'contact', entityId: numero ?? undefined,
      meta: JSON.stringify({ channelId, msgId: ev.msgId, ...extra }),
    },
  }).catch(() => undefined);
  return true;
}

export function resetDeliveryLogForTests() { seen.clear(); hourly.clear(); }
