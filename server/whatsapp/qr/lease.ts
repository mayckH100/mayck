import { hostname } from 'node:os';
import { randomBytes } from 'node:crypto';
import { prisma } from '../../db.js';

/**
 * Trava única por canal QR, guardada no banco (Channel.qrLeaseOwner/qrLeaseUntil).
 *
 * No deploy do Render a instância nova sobe ANTES da antiga cair. Sem trava, as duas abrem
 * a mesma sessão do WhatsApp ao mesmo tempo, cada uma com sua cópia das chaves do Signal:
 * uma avança a "catraca" de criptografia e a outra envia com chave velha, e o celular do
 * cliente mostra "Aguardando mensagem". Com a trava, só uma instância conecta por vez; a
 * nova espera a antiga salvar as chaves e liberar (SIGTERM), ou a trava expirar se ela cair.
 */
export const INSTANCE_ID = (process.env.RENDER_INSTANCE_ID || `${hostname()}-${process.pid}`) + '-' + randomBytes(3).toString('hex');
export const LEASE_TTL_MS = 60_000;

/** Tenta pegar (ou renovar) a trava. Atômico: um único UPDATE condicional no banco. */
export async function acquireLease(channelId: string, now = new Date()): Promise<boolean> {
  const r = await prisma.channel.updateMany({
    where: {
      id: channelId,
      OR: [{ qrLeaseOwner: null }, { qrLeaseOwner: INSTANCE_ID }, { qrLeaseUntil: null }, { qrLeaseUntil: { lt: now } }],
    },
    data: { qrLeaseOwner: INSTANCE_ID, qrLeaseUntil: new Date(now.getTime() + LEASE_TTL_MS) },
  });
  return r.count === 1;
}

/** Renova a trava que esta instância já tem. false = outra instância assumiu. */
export async function renewLease(channelId: string): Promise<boolean> {
  const r = await prisma.channel.updateMany({
    where: { id: channelId, qrLeaseOwner: INSTANCE_ID },
    data: { qrLeaseUntil: new Date(Date.now() + LEASE_TTL_MS) },
  });
  return r.count === 1;
}

/** Libera a trava (só se for desta instância). */
export async function releaseLease(channelId: string): Promise<void> {
  await prisma.channel.updateMany({ where: { id: channelId, qrLeaseOwner: INSTANCE_ID }, data: { qrLeaseOwner: null, qrLeaseUntil: null } }).catch(() => undefined);
}
