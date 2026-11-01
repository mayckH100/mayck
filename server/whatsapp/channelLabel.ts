import { prisma } from '../db.js';
import type { Channel } from '@prisma/client';

/**
 * "Nome do WhatsApp" de cada número conectado (ex.: WhatsApp 1 · Carla, WhatsApp 2 · Vendas).
 * O nome fica no campo Channel.name; o número "WhatsApp N" vem da ordem de criação na organização.
 * Canais sem nome próprio (nomes padrão antigos como "WhatsApp principal") aparecem só como "WhatsApp N".
 */

export const CHANNEL_NAME_MAX = 40;

/** Limpa o nome digitado: remove caracteres de controle/invisíveis e < >, junta espaços (o limite de 40 é validado por quem chama). */
export function sanitizeChannelName(raw: unknown): string {
  return String(raw ?? '')
    .normalize('NFC')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g, '')
    .replace(/[<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Nome padrão (sem nome próprio): vazio, "WhatsApp", "WhatsApp principal" ou "WhatsApp <n>". */
export function isDefaultChannelName(name: string | null | undefined): boolean {
  const n = sanitizeChannelName(name).toLowerCase();
  return !n || /^whats\s*app(\s+(principal|\d+))?$/.test(n);
}

/** Nome próprio do canal (vazio quando é um nome padrão). */
export const customChannelName = (name: string | null | undefined) => (isDefaultChannelName(name) ? '' : sanitizeChannelName(name));

/** "WhatsApp 2 · Amanda" (ou só "WhatsApp 2" sem nome próprio). */
export function channelLabel(ordinal: number, name: string | null | undefined): string {
  const custom = customChannelName(name);
  return `WhatsApp ${ordinal}${custom ? ` · ${custom}` : ''}`;
}

/** Telefone para leitura: +55 11 99999-0000 → "11 99999-0000"; outros países ficam com +DDI. */
export function formatChannelPhone(raw: string | null | undefined): string | null {
  const d = String(raw ?? '').replace(/\D/g, '');
  if (!d) return null;
  if (d.startsWith('55') && (d.length === 12 || d.length === 13)) {
    const ddd = d.slice(2, 4), n = d.slice(4);
    return `${ddd} ${n.slice(0, n.length - 4)}-${n.slice(-4)}`;
  }
  return `+${d}`;
}

export interface ChannelLabelInfo { id: string; ordinal: number; name: string; label: string; phone: string | null; via: string }

type ChannelRow = Pick<Channel, 'id' | 'name' | 'displayPhone' | 'createdAt'>;

function infoOf(c: ChannelRow, ordinal: number): ChannelLabelInfo {
  const label = channelLabel(ordinal, c.name);
  const phone = formatChannelPhone(c.displayPhone);
  return { id: c.id, ordinal, name: customChannelName(c.name), label, phone, via: phone ? `${label} (${phone})` : label };
}

/** Rótulos de todos os canais da organização (ordem de criação). Só canais da própria organização. */
export async function channelLabels(orgId: string): Promise<Map<string, ChannelLabelInfo>> {
  const list = await prisma.channel.findMany({ where: { orgId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: { id: true, name: true, displayPhone: true, createdAt: true } });
  return new Map(list.map((c, i) => [c.id, infoOf(c, i + 1)] as const));
}

/** Rótulo de um canal da organização (nulo se o canal não existir nela). */
export async function channelInfo(orgId: string, channelId: string | null | undefined): Promise<ChannelLabelInfo | null> {
  if (!channelId) return null;
  return (await channelLabels(orgId)).get(channelId) ?? null;
}

/** Linha para avisos internos: "📲 Via: WhatsApp 2 · Amanda (11 99999-0000)". Vazio se não houver canal. */
export async function viaLine(orgId: string, channelId: string | null | undefined): Promise<string> {
  const info = await channelInfo(orgId, channelId);
  return info ? `📲 Via: ${info.via}` : '';
}
