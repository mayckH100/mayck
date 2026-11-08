import { prisma } from '../db.js';
import { parseWebhook, downloadCloudMedia, type InboundMessage } from './cloudClient.js';
import { decryptOrNull } from '../lib/crypto.js';
import { downloadMediaMessage, normalizeMessageContent } from '@whiskeysockets/baileys';
import { receberMidiaWhatsApp } from '../mckmensagem/automacoes/comprovantes.js';
import { applyStatus, sendOutbound } from './messaging.js';
import { automateInbound, withConversationLock } from '../flows/engine.js';
import { normalize } from '../flows/logic.js';
import { parseBaileysMessage, mapBaileysStatus } from './qr/parse.js';
import { isSavedInPhone } from './qr/addressBook.js';
import type { WAMessage, WAMessageUpdate } from '@whiskeysockets/baileys';
import type { Channel } from '@prisma/client';
import { onLeadInbound, onLeadOptOut } from '../mckmensagem/hooks.js';
import { qualifyLeadInbound } from '../mckmensagem/qualificacao.js';
import { sdrOnInboundInBackground } from '../sdr/ai.js';
import { isOptOutPhrase } from '../sdr/intel.js';
import { getIntelConfig } from '../sdr/intelConfig.js';
import { autoReplyModeOf } from './autoReplyMode.js';
import { checkWhatsappAutoReply, onWhatsappAutoReply } from '../sdr/autoReplyService.js';
import { autoMarkOf } from '../sdr/autoReply.js';
import { openConversationFor, redirectIfActiveElsewhere } from './multiCanal.js';
import { safeSyncContactsToLeads, safeOnContactUpdated } from '../mckmensagem/contactSync.js';
import { transcribeAudio, type TranscribeOutcome } from '../ai/voice/service.js';
import { isAudioType } from '../ai/voice/spoken.js';
import { isProductActive } from '../billing/service.js';

const OPT_OUT = new Set(['sair', 'parar', 'stop', 'descadastrar']);

/** Texto ao cliente quando o áudio não pôde ser ouvido (a IA não responde "[audio]" às cegas). */
export function audioFallbackText(code: string): string {
  if (code === 'longo' || code === 'grande') return 'Seu áudio ficou um pouco longo para eu ouvir por aqui. Pode me mandar um áudio mais curto (até 2 minutos) ou escrever sua mensagem, por favor?';
  if (code === 'inaudivel') return 'Não consegui entender bem o seu áudio. Pode repetir ou escrever sua mensagem, por favor?';
  return 'Desculpe, não consegui ouvir seu áudio agora. Pode me escrever sua mensagem, por favor?';
}

/**
 * v1.23.0: ouve (transcreve) o áudio do cliente com a IA da organização e grava a transcrição na mensagem.
 * Nunca lança. Sem download possível ou com a transcrição desligada → { ok: false, code: 'desligada' }.
 */
async function transcribeInbound(orgId: string, conversationId: string, messageId: string, baixar?: BaixarMidia): Promise<TranscribeOutcome> {
  if (!baixar) return { ok: false, code: 'desligada', reason: 'Sem mídia para baixar' };
  const s = await prisma.aiSettings.findUnique({ where: { orgId }, select: { enabled: true, transcribeAudio: true } }).catch(() => null);
  if (!s?.enabled || !s.transcribeAudio) return { ok: false, code: 'desligada', reason: 'Transcrição de áudio desligada' };
  if (!(await isProductActive(orgId, 'MCKBOT').catch(() => false))) return { ok: false, code: 'desligada', reason: 'Assinatura inativa' };
  let r: TranscribeOutcome;
  try {
    const midia = await baixar();
    r = await transcribeAudio({ orgId, conversationId, audio: midia.dados, mime: midia.mime ?? 'audio/ogg', seconds: midia.segundos ?? null });
  } catch (e) {
    console.warn('[voz] falha ao baixar o áudio recebido', { orgId, conversationId, error: (e as Error).message });
    r = { ok: false, code: 'falha', reason: 'Falha ao baixar o áudio' };
  }
  if (r.ok) await prisma.message.update({ where: { id: messageId }, data: { transcript: r.text } }).catch(() => undefined);
  else if (r.code !== 'desligada') await prisma.message.create({ data: { orgId, conversationId, direction: 'INTERNAL', sender: 'system', type: 'note', body: `Áudio não transcrito: ${r.reason}.`, status: 'NOTE' } }).catch(() => undefined);
  return r;
}

export interface InboundResult { received: number; duplicates: number; statuses: number; ignored: number }

/** Processa um payload de webhook já autenticado (assinatura válida) para um canal. */
export async function processWebhook(channel: Channel, body: unknown): Promise<InboundResult> {
  const { messages, statuses } = parseWebhook(body);
  const result: InboundResult = { received: 0, duplicates: 0, statuses: 0, ignored: 0 };
  await prisma.channel.update({ where: { id: channel.id }, data: { lastWebhookAt: new Date() } });
  for (const m of messages) {
    if (channel.phoneNumberId && m.phoneNumberId && m.phoneNumberId !== channel.phoneNumberId) { result.ignored++; continue; }
    const r = await handleInboundMessage(channel, m);
    if (r === 'duplicate') result.duplicates++; else result.received++;
  }
  for (const s of statuses) {
    if (await applyStatus(channel.id, s.waMessageId, s.status, s.error)) result.statuses++;
  }
  return result;
}

export type BaixarMidia = () => Promise<{ dados: Buffer; nome: string; mime?: string; /** áudio: duração informada pelo WhatsApp */ segundos?: number }>;

const EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf' };
const nomeMidia = (type: string, mime?: string, nome?: string) => nome || `comprovante.${EXT[mime ?? ''] ?? (type === 'image' ? 'jpg' : 'pdf')}`;

/** Download de mídia recebida pela Cloud API (com o token do canal). */
function baixarCloud(channel: Channel, m: InboundMessage): BaixarMidia | undefined {
  if (!m.mediaId) return undefined;
  return async () => {
    const token = decryptOrNull(channel.accessTokenEnc);
    if (!token) throw new Error('Canal sem token para baixar a mídia');
    const r = await downloadCloudMedia(token, m.mediaId!);
    return { dados: r.dados, mime: r.mime, nome: nomeMidia(m.type, r.mime, m.fileName) };
  };
}

/**
 * Contato da mensagem recebida. No modo QR o mesmo cliente pode aparecer pelo número ou pelo LID:
 * um contato criado antes só com o LID passa a ser identificado pelo número quando ele fica conhecido
 * (sem criar um segundo contato).
 */
async function findOrCreateContact(orgId: string, m: InboundMessage) {
  let contact = await prisma.contact.findUnique({ where: { orgId_waId: { orgId, waId: m.from } } });
  if (contact) return contact;
  if (m.lid && m.lid !== m.from) {
    const byLid = await prisma.contact.findUnique({ where: { orgId_waId: { orgId, waId: m.lid } } });
    if (byLid) {
      try {
        const upd = await prisma.contact.update({ where: { id: byLid.id }, data: { waId: m.from, phone: '+' + m.from } });
        await safeOnContactUpdated(byLid, upd); // MCK Mensagens: agora que o número é conhecido, o contato aparece lá
        return upd;
      } catch {
        contact = await prisma.contact.findUnique({ where: { orgId_waId: { orgId, waId: m.from } } });
        return contact ?? byLid;
      }
    }
  }
  try {
    const created = await prisma.contact.create({ data: { orgId, waId: m.from, phone: m.from.includes('@') ? m.from : '+' + m.from, name: m.profileName ?? null } });
    await safeSyncContactsToLeads(orgId, [created]); // MCK Mensagens: novo contato aparece lá (consentimento pendente)
    return created;
  } catch {
    return prisma.contact.findUniqueOrThrow({ where: { orgId_waId: { orgId, waId: m.from } } });
  }
}

export async function handleInboundMessage(channel: Channel, m: InboundMessage, baixar?: BaixarMidia): Promise<'ok' | 'duplicate'> {
  const orgId = channel.orgId;
  // Idempotência rápida: a Meta reenvia o mesmo evento em caso de timeout.
  const already = await prisma.message.findUnique({ where: { channelId_waMessageId: { channelId: channel.id, waMessageId: m.waMessageId } } });
  if (already) return 'duplicate';

  let contact = await findOrCreateContact(orgId, m);
  const isFirst = !contact.lastMessageAt;
  if (!contact.name && m.profileName) {
    contact = await prisma.contact.update({ where: { id: contact.id }, data: { name: m.profileName } });
  }

  // Modo QR: contato salvo na agenda do celular conectado não recebe resposta automática
  // (a menos que o canal permita). A mensagem continua entrando no Inbox normalmente.
  let skipAutoReply = false;
  if (channel.provider === 'whatsapp_qr') {
    const saved = await isSavedInPhone(channel.id, [m.from, m.lid, contact.waId]).catch(() => false);
    if (saved && !contact.savedInPhone) contact = await prisma.contact.update({ where: { id: contact.id }, data: { savedInPhone: true } });
    skipAutoReply = saved && !channel.replySavedContacts;
  }

  return withConversationLock(`contact:${contact.id}`, async () => {
    // Cada WhatsApp conectado tem a sua conversa com o cliente: a resposta sai pelo mesmo número
    // que recebeu (antes a conversa era única por contato e a resposta saía pelo primeiro número).
    let conv = await openConversationFor(orgId, contact!.id, channel.id);

    // v1.22.0: resposta automática do lead (saudação/ausência, menu, "estou dirigindo"...) logo depois de um envio nosso.
    // Verificada ANTES de gravar, dentro da trava do contato: a mensagem já nasce marcada e nenhuma qualificação,
    // extração do SDR ou resposta da IA (que leem o histórico) chega a tratá-la como resposta de uma pessoa.
    const auto = m.type === 'text' && m.text?.trim() && !m.replyId
      ? await checkWhatsappAutoReply({ orgId, conversationId: conv.id, contactId: contact!.id, text: m.text })
      : null;
    const isAuto = !!auto?.automatica;

    let message;
    try {
      message = await prisma.message.create({
        data: {
          orgId, conversationId: conv.id, channelId: channel.id, direction: 'IN', sender: 'contact', type: m.type,
          body: m.text || (m.mediaId ? `[${m.type}]` : `[${m.type}]`), waMessageId: m.waMessageId, status: 'RECEIVED', createdAt: m.timestamp > new Date() ? new Date() : m.timestamp,
          error: isAuto ? autoMarkOf(auto!.motivo) : null,
        },
      });
    } catch (e) {
      if ((e as { code?: string }).code === 'P2002') return 'duplicate' as const;
      throw e;
    }
    const now = new Date();
    conv = await prisma.conversation.update({
      where: { id: conv.id },
      data: { lastInboundAt: now, lastMessageAt: now, unreadCount: { increment: 1 } },
    });
    // Resposta automática não conta como "o contato já falou com a gente" (a 1ª mensagem de verdade continua sendo a 1ª).
    if (!isAuto) contact = await prisma.contact.update({ where: { id: contact!.id }, data: { lastMessageAt: now } });
    if (isAuto) {
      // Fica no Inbox e no histórico do lead com o selo "Resposta automática"; nada mais acontece: sem opt-out,
      // sem "Respondeu" na campanha, sem qualificação/pontuação/etapa, cadência segue, IA e fluxos não respondem.
      await onWhatsappAutoReply(conv, contact!, auto!, now);
      return 'ok' as const;
    }

    // v1.23.0: áudio do cliente → transcrição pela IA; daqui em diante vale como se ele tivesse escrito o texto
    // (opt-out, SDR, qualificação, fluxos e IA). Contato salvo na agenda do celular (sem resposta automática) não é transcrito.
    let text = m.text ?? '';
    let asText = m.type === 'text';
    let audioFail: TranscribeOutcome | null = null;
    if (isAudioType(m.type) && !skipAutoReply) {
      const tr = await transcribeInbound(orgId, conv.id, message.id, baixar ?? baixarCloud(channel, m));
      if (tr.ok) { text = tr.text; asText = true; message = { ...message, body: tr.text, transcript: tr.text }; }
      else if (tr.code !== 'desligada') audioFail = tr;
    }

    // MCK Mensagens: imagem/PDF de cliente com cobrança em aberto (ou que fala de pagamento) vira comprovante em análise.
    if (m.type === 'image' || m.type === 'document') {
      const dl = baixar ?? baixarCloud(channel, m);
      if (dl) {
        try {
          await receberMidiaWhatsApp(orgId, contact, { waMessageId: m.waMessageId, type: m.type, texto: m.text, baixar: dl });
        } catch (e) {
          console.error('[comprovantes] falha ao registrar mídia recebida:', (e as Error).message);
        }
      }
    }

    // v1.21.0: além de SAIR/PARAR, frases como "não quero mais receber" quando o opt-out automático do SDR está ligado.
    const isOptOut = OPT_OUT.has(normalize(text)) || (asText && isOptOutPhrase(text) && (await getIntelConfig(orgId).then((c) => c.optOutAuto).catch(() => false)));
    if (!isOptOut) await onLeadInbound(orgId, contact);
    if (isOptOut) {
      await prisma.contact.update({ where: { id: contact.id }, data: { optOut: true } });
      await onLeadOptOut(orgId, contact);
      await prisma.message.create({ data: { orgId, conversationId: conv.id, direction: 'INTERNAL', sender: 'system', type: 'note', body: 'Contato pediu para não receber mensagens automáticas (opt-out).', status: 'NOTE' } });
      return 'ok' as const;
    }
    // SDR com IA (segundo plano): captura quem chamou, para a cadência quando o lead responde e qualifica pela IA.
    if (!contact.optOut) sdrOnInboundInBackground({ conv, contact, text: asText ? text : '', isFirst, autoReplySkipped: skipAutoReply });
    if (conv.mode === 'HUMAN' || contact.optOut || skipAutoReply) return 'ok' as const;
    // Cliente já em atendimento por outro WhatsApp da organização: não abre atendimento paralelo aqui.
    if (await redirectIfActiveElsewhere(conv, contact, channel, now)) return 'ok' as const;
    // "Quem responde automaticamente" deste canal: flows | ai | both (padrão, comportamento original).
    const mode = autoReplyModeOf(channel);
    if (audioFail) {
      // Áudio que a IA não conseguiu ouvir: com a IA respondendo neste canal, pede para o cliente escrever
      // (em vez de responder "[audio]" às cegas). Sem IA automática, segue o caminho de sempre (fluxos).
      const ai = await prisma.aiSettings.findUnique({ where: { orgId }, select: { enabled: true, autoReply: true } }).catch(() => null);
      if (mode !== 'flows' && ai?.enabled && ai.autoReply && (await isProductActive(orgId, 'MCKBOT').catch(() => false))) {
        await sendOutbound({ conversation: conv, contact, payload: { type: 'text', text: audioFallbackText(audioFail.code) }, sender: 'ai' }).catch(() => undefined);
        return 'ok' as const;
      }
    }
    const finalMessage = message;
    await withConversationLock(conv.id, async () => {
      // MCK Mensagens: lead abordado por campanha que respondeu → qualificação do SDR com IA (quando ligada).
      // No modo "Só fluxos" a IA não responde neste canal, então a qualificação também não roda.
      if (mode !== 'flows' && asText && (await qualifyLeadInbound(conv!, contact!, text))) return;
      await automateInbound(conv!, contact!, finalMessage, { isFirst, replyId: m.replyId, mode });
    });
    return 'ok' as const;
  });
}

// ---------- Modo QR (Baileys) ----------

/** Mensagem recebida pelo socket do Baileys → mesmo pipeline do webhook (contatos, conversas, fluxos, IA). */
export async function handleQrMessage(channelId: string, raw: WAMessage): Promise<'ok' | 'duplicate' | 'ignored'> {
  const m = parseBaileysMessage(raw);
  if (!m) return 'ignored';
  const channel = await prisma.channel.findUnique({ where: { id: channelId } });
  if (!channel) return 'ignored';
  await prisma.channel.update({ where: { id: channel.id }, data: { lastWebhookAt: new Date() } });
  const audio = normalizeMessageContent(raw.message)?.audioMessage ?? null;
  const baixar: BaixarMidia | undefined = m.type === 'audio'
    ? async () => {
      const dados = await downloadMediaMessage(raw, 'buffer', {});
      const segundos = Number(audio?.seconds ?? 0) || undefined;
      return { dados: Buffer.from(dados), mime: audio?.mimetype ?? 'audio/ogg; codecs=opus', nome: 'audio.ogg', segundos };
    }
    : m.type === 'image' || m.type === 'document'
    ? async () => {
      const dados = await downloadMediaMessage(raw, 'buffer', {});
      const c = raw.message?.documentMessage ?? raw.message?.documentWithCaptionMessage?.message?.documentMessage ?? null;
      const mime = c?.mimetype ?? raw.message?.imageMessage?.mimetype ?? undefined;
      return { dados: Buffer.from(dados), mime: mime ?? undefined, nome: nomeMidia(m.type, mime ?? undefined, c?.fileName ?? undefined) };
    }
    : undefined;
  return handleInboundMessage(channel, m, baixar);
}

/** Atualização de entrega/leitura vinda do Baileys. */
export async function handleQrStatus(channelId: string, u: WAMessageUpdate): Promise<boolean> {
  const st = mapBaileysStatus(u.update?.status ?? null);
  if (!st || !u.key?.id) return false;
  return applyStatus(channelId, u.key.id, st, st === 'failed' ? 'Falha informada pelo WhatsApp' : undefined);
}
