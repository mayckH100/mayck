import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { ah, notFound, badRequest } from '../lib/http.js';
import { orgOf, requireRole } from '../auth/session.js';
import { encrypt, decryptOrNull, randomToken, maskSecret } from '../lib/crypto.js';
import { checkPhoneNumber } from '../whatsapp/cloudClient.js';
import { audit } from '../lib/audit.js';
import { config } from '../config.js';
import { qrManager } from '../whatsapp/qr/manager.js';
import { PROVIDER_CLOUD, PROVIDER_QR, isQrChannel } from '../whatsapp/messaging.js';
import type { Channel } from '@prisma/client';

export const channelsRouter = Router();

function publicUrl(req: import('express').Request) {
  return (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
}

async function view(c: Channel, req: import('express').Request) {
  const day = new Date(Date.now() - 24 * 3600e3), week = new Date(Date.now() - 7 * 24 * 3600e3), month = new Date(Date.now() - 30 * 24 * 3600e3);
  const base = { orgId: c.orgId, channelId: c.id, direction: { in: ['IN', 'OUT'] } };
  const [today, d7, d30, total] = await Promise.all([
    prisma.message.count({ where: { ...base, createdAt: { gte: day } } }),
    prisma.message.count({ where: { ...base, createdAt: { gte: week } } }),
    prisma.message.count({ where: { ...base, createdAt: { gte: month } } }),
    prisma.message.count({ where: base }),
  ]);
  const qr = isQrChannel(c) ? qrManager.info(c.id) : null;
  return {
    id: c.id, name: c.name, provider: c.provider, status: qr?.live && qr.status ? qr.status : c.status,
    connectedAt: c.connectedAt, phoneNumberId: c.phoneNumberId, wabaId: c.wabaId, displayPhone: c.displayPhone,
    hasAccessToken: !!c.accessTokenEnc, accessTokenPreview: maskSecret(decryptOrNull(c.accessTokenEnc)), hasAppSecret: !!c.appSecretEnc,
    verifyToken: req.auth?.role === 'AGENT' ? null : c.verifyToken,
    webhookUrl: `${publicUrl(req)}/api/webhooks/whatsapp/${c.id}`,
    lastError: c.lastError, lastWebhookAt: c.lastWebhookAt, lastCheckedAt: c.lastCheckedAt, createdAt: c.createdAt,
    stats: { today, d7, d30, total }, graphApiVersion: config.GRAPH_API_VERSION,
  };
}

channelsRouter.get('/', ah(async (req, res) => {
  const list = await prisma.channel.findMany({ where: { orgId: orgOf(req) }, orderBy: { createdAt: 'asc' } });
  res.json(await Promise.all(list.map((c) => view(c, req))));
}));

channelsRouter.post('/', requireRole('OWNER', 'ADMIN'), ah(async (req, res) => {
  const { name, provider } = z.object({
    name: z.string().trim().min(1).max(60),
    provider: z.enum([PROVIDER_QR, PROVIDER_CLOUD]).default(PROVIDER_QR),
  }).parse(req.body);
  const c = await prisma.channel.create({ data: { orgId: orgOf(req), name, provider, verifyToken: randomToken(24) } });
  await audit(req, 'channel.create', { entity: 'channel', entityId: c.id });
  res.status(201).json(await view(c, req));
}));

const credsSchema = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  phoneNumberId: z.string().trim().regex(/^\d{5,30}$/, 'Phone Number ID deve conter apenas dígitos').optional(),
  wabaId: z.string().trim().regex(/^\d{5,30}$/, 'WABA ID deve conter apenas dígitos').optional().or(z.literal('')),
  accessToken: z.string().trim().min(20).max(1000).optional(),
  appSecret: z.string().trim().min(8).max(200).optional(),
});

channelsRouter.patch('/:id', requireRole('OWNER', 'ADMIN'), ah(async (req, res) => {
  const body = credsSchema.parse(req.body);
  const c = await prisma.channel.findFirst({ where: { id: req.params.id, orgId: orgOf(req) } });
  if (!c) throw notFound('Canal');
  const credsChanged = body.phoneNumberId !== undefined || body.accessToken !== undefined || body.appSecret !== undefined;
  // Salvar credenciais da Cloud API transforma o canal em "API oficial" (encerra a sessão QR, se houver).
  if (credsChanged && isQrChannel(c)) await qrManager.stop(c.id, { logout: true });
  const updated = await prisma.channel.update({
    where: { id: c.id },
    data: {
      name: body.name ?? undefined,
      phoneNumberId: body.phoneNumberId ?? undefined,
      wabaId: body.wabaId === '' ? null : body.wabaId ?? undefined,
      accessTokenEnc: body.accessToken ? encrypt(body.accessToken) : undefined,
      appSecretEnc: body.appSecret ? encrypt(body.appSecret) : undefined,
      // Credenciais alteradas exigem nova verificação real antes de marcar como conectado.
      ...(credsChanged ? { status: 'NOT_CONNECTED', lastError: null, provider: PROVIDER_CLOUD, waJid: null } : {}),
    },
  });
  await audit(req, 'channel.update', { entity: 'channel', entityId: c.id, meta: { fields: Object.keys(body) } });
  res.json(await view(updated, req));
}));

/** Verifica as credenciais consultando a Graph API de verdade. Só aqui o canal vira CONNECTED. */
channelsRouter.post('/:id/verify', requireRole('OWNER', 'ADMIN'), ah(async (req, res) => {
  const c = await prisma.channel.findFirst({ where: { id: req.params.id, orgId: orgOf(req) } });
  if (!c) throw notFound('Canal');
  if (isQrChannel(c)) throw badRequest('Este canal usa conexão por QR code. Use "Conectar por QR code" ou cadastre as credenciais da API oficial.');
  const token = decryptOrNull(c.accessTokenEnc);
  if (!c.phoneNumberId || !token || !c.appSecretEnc) throw badRequest('Preencha Phone Number ID, token de acesso e App Secret antes de verificar');
  let updated: Channel;
  try {
    const info = await checkPhoneNumber({ phoneNumberId: c.phoneNumberId, accessToken: token });
    updated = await prisma.channel.update({ where: { id: c.id }, data: { status: 'CONNECTED', displayPhone: info.displayPhone ?? c.displayPhone, lastError: null, lastCheckedAt: new Date() } });
  } catch (e) {
    updated = await prisma.channel.update({ where: { id: c.id }, data: { status: 'ERROR', lastError: (e as Error).message, lastCheckedAt: new Date() } });
  }
  await audit(req, 'channel.verify', { entity: 'channel', entityId: c.id, meta: { status: updated.status } });
  res.json(await view(updated, req));
}));

// ---------- Conexão por QR code (WhatsApp Web / Baileys) ----------

async function qrView(c: Channel) {
  const fresh = await prisma.channel.findUniqueOrThrow({ where: { id: c.id } });
  const live = qrManager.info(c.id);
  return {
    channelId: c.id,
    provider: fresh.provider,
    status: live.live && live.status ? live.status : fresh.status,
    qr: live.qr,
    phone: live.phone ?? fresh.displayPhone,
    connectedAt: fresh.connectedAt,
    lastError: live.lastError ?? fresh.lastError,
  };
}

/** Inicia a conexão: gera o QR (ou reconecta com a sessão salva). */
channelsRouter.post('/:id/qr/start', requireRole('OWNER', 'ADMIN'), ah(async (req, res) => {
  let c = await prisma.channel.findFirst({ where: { id: req.params.id, orgId: orgOf(req) } });
  if (!c) throw notFound('Canal');
  if (!isQrChannel(c)) {
    // Troca para o modo QR: as credenciais da API oficial ficam salvas, mas deixam de ser usadas.
    c = await prisma.channel.update({ where: { id: c.id }, data: { provider: PROVIDER_QR, status: 'NOT_CONNECTED', lastError: null } });
  }
  await qrManager.start(c.id);
  await audit(req, 'channel.qr_start', { entity: 'channel', entityId: c.id });
  res.json(await qrView(c));
}));

/** Estado atual + QR como data URL PNG (a tela consulta a cada poucos segundos). */
channelsRouter.get('/:id/qr', requireRole('OWNER', 'ADMIN'), ah(async (req, res) => {
  const c = await prisma.channel.findFirst({ where: { id: req.params.id, orgId: orgOf(req) } });
  if (!c) throw notFound('Canal');
  res.set('Cache-Control', 'no-store');
  res.json(await qrView(c));
}));

/** Desconecta o aparelho (logout no WhatsApp) e apaga a sessão salva. */
channelsRouter.post('/:id/qr/disconnect', requireRole('OWNER', 'ADMIN'), ah(async (req, res) => {
  const c = await prisma.channel.findFirst({ where: { id: req.params.id, orgId: orgOf(req) } });
  if (!c) throw notFound('Canal');
  await qrManager.stop(c.id, { logout: true });
  await prisma.channel.update({ where: { id: c.id }, data: { status: 'NOT_CONNECTED', waJid: null, lastError: null } });
  await audit(req, 'channel.qr_disconnect', { entity: 'channel', entityId: c.id });
  res.json(await qrView(c));
}));

channelsRouter.post('/:id/disconnect', requireRole('OWNER', 'ADMIN'), ah(async (req, res) => {
  const c = await prisma.channel.findFirst({ where: { id: req.params.id, orgId: orgOf(req) } });
  if (!c) throw notFound('Canal');
  if (isQrChannel(c)) {
    await qrManager.stop(c.id, { logout: true });
    const u = await prisma.channel.update({ where: { id: c.id }, data: { status: 'NOT_CONNECTED', waJid: null, lastError: null } });
    await audit(req, 'channel.disconnect', { entity: 'channel', entityId: c.id });
    return res.json(await view(u, req));
  }
  const updated = await prisma.channel.update({ where: { id: c.id }, data: { status: 'NOT_CONNECTED', accessTokenEnc: null } });
  await audit(req, 'channel.disconnect', { entity: 'channel', entityId: c.id });
  res.json(await view(updated, req));
}));

channelsRouter.post('/:id/rotate-verify-token', requireRole('OWNER', 'ADMIN'), ah(async (req, res) => {
  const c = await prisma.channel.findFirst({ where: { id: req.params.id, orgId: orgOf(req) } });
  if (!c) throw notFound('Canal');
  const updated = await prisma.channel.update({ where: { id: c.id }, data: { verifyToken: randomToken(24) } });
  await audit(req, 'channel.rotate_verify_token', { entity: 'channel', entityId: c.id });
  res.json(await view(updated, req));
}));

channelsRouter.delete('/:id', requireRole('OWNER', 'ADMIN'), ah(async (req, res) => {
  const c = await prisma.channel.findFirst({ where: { id: req.params.id, orgId: orgOf(req) } });
  if (!c) throw notFound('Canal');
  await qrManager.stop(c.id, { logout: isQrChannel(c) });
  await prisma.waAuthState.deleteMany({ where: { channelId: c.id } });
  await prisma.channel.delete({ where: { id: c.id } });
  await audit(req, 'channel.delete', { entity: 'channel', entityId: c.id });
  res.json({ ok: true });
}));
