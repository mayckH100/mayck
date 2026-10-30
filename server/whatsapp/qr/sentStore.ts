import { proto } from '@whiskeysockets/baileys';
import { prisma } from '../../db.js';
import { encrypt, decrypt } from '../../lib/crypto.js';

/**
 * Guarda a mensagem enviada COMPLETA (protobuf, cifrado) para o reenvio pedido pelo celular do
 * cliente quando ele não consegue decifrar ("Aguardando mensagem"). Antes só o texto era salvo:
 * mídia/documentos não podiam ser reenviados e o menu numerado voltava diferente.
 */
export const SENT_RETENTION_DAYS = 14;

export async function saveSent(channelId: string, waMessageId: string, message: unknown): Promise<void> {
  if (!waMessageId || !message) return;
  const bytes = proto.Message.encode(proto.Message.fromObject(message as Record<string, unknown>)).finish();
  const dataEnc = encrypt(Buffer.from(bytes).toString('base64'));
  await prisma.waSentMessage.upsert({
    where: { channelId_waMessageId: { channelId, waMessageId } },
    create: { channelId, waMessageId, dataEnc },
    update: { dataEnc },
  });
}

export async function loadSent(channelId: string, waMessageId: string): Promise<proto.IMessage | undefined> {
  const row = await prisma.waSentMessage.findUnique({ where: { channelId_waMessageId: { channelId, waMessageId } } });
  if (!row) return undefined;
  try {
    return proto.Message.decode(Buffer.from(decrypt(row.dataEnc), 'base64'));
  } catch {
    return undefined;
  }
}

let lastPrune = 0;
/** Apaga as mensagens guardadas há mais de 14 dias (no máximo a cada 6 h). */
export async function pruneSent(force = false): Promise<number> {
  if (!force && Date.now() - lastPrune < 6 * 3600e3) return 0;
  lastPrune = Date.now();
  const r = await prisma.waSentMessage.deleteMany({ where: { createdAt: { lt: new Date(Date.now() - SENT_RETENTION_DAYS * 86400e3) } } });
  return r.count;
}
