import {
  normalizeMessageContent, isJidGroup, isJidBroadcast, isJidStatusBroadcast, isJidNewsletter, jidDecode, jidNormalizedUser,
  type WAMessage, type AnyMessageContent,
} from '@whiskeysockets/baileys';
import type { InboundMessage, OutboundPayload } from '../cloudClient.js';

/** Converte o timestamp do Baileys (number ou Long) para Date. */
function toDate(ts: unknown): Date {
  if (ts == null) return new Date();
  const n = typeof ts === 'number' ? ts : Number((ts as { toNumber?: () => number }).toNumber?.() ?? ts);
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000) : new Date();
}

/** Número (só dígitos) de um JID de usuário: "5511999990000:12@s.whatsapp.net" → "5511999990000". */
export function jidToNumber(jid?: string | null): string | null {
  if (!jid) return null;
  const d = jidDecode(jid);
  if (!d?.user) return null;
  if (d.server !== 's.whatsapp.net' && d.server !== 'c.us' && d.server !== 'hosted') return null;
  return /^\d{6,20}$/.test(d.user) ? d.user : null;
}

/** JID @lid normalizado (sem aparelho), ou null se não for LID. */
export function lidOf(jid?: string | null): string | null {
  if (!jid) return null;
  const d = jidDecode(jid);
  if (!d?.user || (d.server !== 'lid' && d.server !== 'hosted.lid')) return null;
  return jidNormalizedUser(jid);
}

/**
 * Identidades do remetente de uma conversa individual. Desde a migração do WhatsApp para LID, a
 * mensagem pode chegar com remoteJid "...@lid"; o Baileys 7 informa o outro lado em key.remoteJidAlt
 * (número quando remoteJid é LID e vice-versa). `senderPn` é o campo antigo (6.x), mantido por segurança.
 */
export function senderIdentities(key: { remoteJid?: string | null; remoteJidAlt?: string | null; senderPn?: string | null } | null | undefined): { phone: string | null; lid: string | null } {
  const remote = key?.remoteJid ?? null;
  const alt = key?.remoteJidAlt ?? null;
  const legacyPn = key?.senderPn ?? null;
  return {
    phone: jidToNumber(remote) ?? jidToNumber(alt) ?? jidToNumber(legacyPn),
    lid: lidOf(remote) ?? lidOf(alt),
  };
}

/** waId salvo no contato → JID de envio. waId pode ser só dígitos ou um JID completo (ex.: contato só com LID). */
export function waIdToJid(waId: string): string {
  return waId.includes('@') ? waId : `${waId.replace(/\D/g, '')}@s.whatsapp.net`;
}

/**
 * Converte uma mensagem recebida pelo Baileys no formato interno de entrada.
 * Retorna null para o que deve ser ignorado: mensagens próprias, grupos, status/broadcast,
 * canais (newsletter) e mensagens sem conteúdo útil (reações, protocolo, chaves).
 */
export function parseBaileysMessage(msg: WAMessage): InboundMessage | null {
  const key = msg.key;
  if (!key || key.fromMe) return null;
  const remote = key.remoteJid ?? '';
  if (!remote || isJidGroup(remote) || isJidBroadcast(remote) || isJidStatusBroadcast(remote) || isJidNewsletter(remote)) return null;
  if (!key.id) return null;

  // Contato identificado por LID: usa o número real quando conhecido (remoteJidAlt / mapeamento LID→número);
  // sem o número, o contato fica identificado pelo próprio LID (o envio para LID também funciona).
  const ids = senderIdentities(key as never);
  const from = ids.phone ?? ids.lid;
  if (!from) return null;

  const content = normalizeMessageContent(msg.message);
  if (!content) return null;

  let type = 'text';
  let text = '';
  let replyId: string | undefined;
  let mediaId: string | undefined;

  if (content.conversation != null) text = content.conversation;
  else if (content.extendedTextMessage) text = content.extendedTextMessage.text ?? '';
  else if (content.imageMessage) { type = 'image'; text = content.imageMessage.caption ?? ''; mediaId = key.id; }
  else if (content.videoMessage) { type = 'video'; text = content.videoMessage.caption ?? ''; mediaId = key.id; }
  else if (content.documentMessage) { type = 'document'; text = content.documentMessage.caption ?? ''; mediaId = key.id; }
  else if (content.audioMessage) { type = 'audio'; mediaId = key.id; }
  else if (content.stickerMessage) { type = 'sticker'; mediaId = key.id; }
  else if (content.locationMessage) { type = 'location'; text = `[localização] ${content.locationMessage.degreesLatitude},${content.locationMessage.degreesLongitude}`; }
  else if (content.buttonsResponseMessage) { type = 'interactive'; text = content.buttonsResponseMessage.selectedDisplayText ?? ''; replyId = content.buttonsResponseMessage.selectedButtonId ?? undefined; }
  else if (content.listResponseMessage) { type = 'interactive'; text = content.listResponseMessage.title ?? ''; replyId = content.listResponseMessage.singleSelectReply?.selectedRowId ?? undefined; }
  else if (content.templateButtonReplyMessage) { type = 'interactive'; text = content.templateButtonReplyMessage.selectedDisplayText ?? ''; replyId = content.templateButtonReplyMessage.selectedId ?? undefined; }
  else if (content.contactMessage) { type = 'contacts'; text = `[contato] ${content.contactMessage.displayName ?? ''}`.trim(); }
  else return null; // reação, protocolo (apagar/editar), distribuição de chave etc.

  return {
    phoneNumberId: '',
    waMessageId: key.id,
    from,
    profileName: msg.pushName ?? undefined,
    timestamp: toDate(msg.messageTimestamp),
    type,
    text,
    replyId,
    mediaId,
    ...(ids.lid ? { lid: ids.lid } : {}),
  };
}

/** Status numérico do Baileys (proto.WebMessageInfo.Status) → status interno. */
export function mapBaileysStatus(status: number | null | undefined): 'sent' | 'delivered' | 'read' | 'failed' | null {
  switch (status) {
    case 0: return 'failed';
    case 2: return 'sent';
    case 3: return 'delivered';
    case 4: case 5: return 'read';
    default: return null;
  }
}

const MIME: Record<string, string> = {
  pdf: 'application/pdf', doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', csv: 'text/csv', txt: 'text/plain',
  zip: 'application/zip', mp3: 'audio/mpeg', ogg: 'audio/ogg', m4a: 'audio/mp4', aac: 'audio/aac', opus: 'audio/ogg; codecs=opus',
};
function mimeFromUrl(url: string, fallback: string) {
  const ext = (url.split('?')[0].split('#')[0].split('.').pop() ?? '').toLowerCase();
  return MIME[ext] ?? fallback;
}

/** Texto com opções numeradas (WhatsApp Web não tem botões interativos confiáveis). */
export function numberedOptions(text: string, options: { title: string }[]): string {
  return `${text}\n\n${options.map((o, i) => `${i + 1}. ${o.title}`).join('\n')}\n\nResponda com o número da opção.`;
}

/** Monta o conteúdo do Baileys a partir do payload interno. Modelos (templates) não existem no modo QR. */
export function buildQrContent(p: OutboundPayload): AnyMessageContent {
  switch (p.type) {
    case 'text': return { text: p.text };
    case 'buttons': return { text: numberedOptions(p.text, p.buttons) };
    case 'image': return { image: { url: p.link }, caption: p.caption };
    case 'video': return { video: { url: p.link }, caption: p.caption };
    case 'audio': return { audio: { url: p.link }, mimetype: mimeFromUrl(p.link, 'audio/mp4') };
    case 'document': {
      const fileName = p.filename || decodeURIComponent(p.link.split('?')[0].split('/').pop() || 'documento');
      return { document: { url: p.link }, fileName, mimetype: mimeFromUrl(fileName, mimeFromUrl(p.link, 'application/octet-stream')), caption: p.caption };
    }
    case 'file':
      return /^image\/(jpeg|png|webp)$/.test(p.mime)
        ? { image: p.data, caption: p.caption, mimetype: p.mime }
        : { document: p.data, fileName: p.filename, mimetype: p.mime, caption: p.caption };
    case 'media_id': throw new Error('Mídia por id só existe na API oficial');
    case 'template': throw new Error('Modelos (templates) só existem na API oficial. No modo QR envie uma mensagem de texto.');
  }
}
