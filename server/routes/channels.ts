import { Router } from 'express';
import { allowedChannels } from '../lib/permissions.js';
import { z } from 'zod';
import { prisma } from '../db.js';
import { ah, notFound, badRequest, HttpError } from '../lib/http.js';
import { orgOf, requireRole } from '../auth/session.js';
import { encrypt, decryptOrNull, randomToken, maskSecret } from '../lib/crypto.js';
import { checkPhoneNumber } from '../whatsapp/cloudClient.js';
import { audit } from '../lib/audit.js';
import { config } from '../config.js';
import { qrManager } from '../whatsapp/qr/manager.js';
import { normalizePairingPhone, pairingPerHour } from '../whatsapp/qr/pairing.js';
import { countSavedPhoneContacts } from '../whatsapp/qr/addressBook.js';
import { PROVIDER_CLOUD, PROVIDER_QR, isQrChannel } from '../whatsapp/messaging.js';
import { AUTO_REPLY_MODES, autoReplyModeOf, defaultAutoReplyMode } from '../whatsapp/autoReplyMode.js';
import { channelInfo, channelLabels, sanitizeChannelName, customChannelName, CHANNEL_NAME_MAX, type ChannelLabelInfo } from '../whatsapp/channelLabel.js';
import type { Channel } from '@prisma/client';
import { DISARM_DOWN_ALERT } from '../whatsapp/downAlerts.js';

/** "Nome do WhatsApp": limpo (sem caracteres invisíveis/HTML), 1 a 40 caracteres. */
const channelNameSchema = z.string().max(200).transform(sanitizeChannelName).pipe(z.string().min(1, 'Informe o nome do WhatsApp').max(CHANNEL_NAME_MAX, `Nome do WhatsApp: no máximo ${CHANNEL_NAME_MAX} caracteres`));

export const channelsRouter = Router();

function publicUrl(req: import('express').Request) {
  return (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
}

async function view(c: Channel, req: import('express').Request, info?: ChannelLabelInfo | null) {
  const lbl = info ?? await channelInfo(c.orgId, c.id);
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
    id: c.id, name: c.name, provider: c.provider,
    // Nome do WhatsApp: "WhatsApp 2 · Amanda" (ordinal pela ordem de criação; displayName vazio = sem nome próprio).
    ordinal: lbl?.ordinal ?? null, displayName: customChannelName(c.name), label: lbl?.label ?? c.name, status: qr?.live && qr.status ? qr.status : c.status,
    connectedAt: c.connectedAt, phoneNumberId: c.phoneNumberId, wabaId: c.wabaId, displayPhone: c.displayPhone,
    hasAccessToken: !!c.accessTokenEnc, accessTokenPreview: maskSecret(decryptOrNull(c.accessTokenEnc)), hasAppSecret: !!c.appSecretEnc,
    verifyToken: req.auth?.role === 'AGENT' ? null : c.verifyToken,
    webhookUrl: `${publicUrl(req)}/api/webhooks/whatsapp/${c.id}`,
    lastError: c.lastError, lastWebhookAt: c.lastWebhookAt, lastCheckedAt: c.lastCheckedAt, createdAt: c.createdAt,
    stats: { today, d7, d30, total }, graphApiVersion: config.GRAPH_API_VERSION,
    autoReplyMode: autoReplyModeOf(c),
    // Alerta de WhatsApp desconectado: episódio confirmado (> 5 min fora do ar) e "voltou a conectar" (24 h).
    downAlert: downAlertView(c),
    ...(isQrChannel(c) ? {
      replySavedContacts: c.replySavedContacts,
      addressBook: { syncedAt: c.addressBookSyncedAt, savedContacts: await countSavedPhoneContacts(c.id) },
    } : {}),
  };
}

function downAlertView(c: Channel) {
  const backRecent = c.waBackAt && Date.now() - c.waBackAt.getTime() < 24 * 3600e3 ? c.waBackAt : null;
  return { downSince: c.waDownAlertAt ? c.waDownSince : null, alertedAt: c.waDownAlertAt, backAt: c.status === 'CONNECTED' ? backRecent : null };
}

/**
 * Alertas de WhatsApp desconectado para o aviso no app (MCKBOT e MCK Mensagens). Só Proprietário/Administrador.
 * down: episódios confirmados (> 5 min fora do ar); back: voltou a conectar nas últimas 24 h depois de um alerta.
 */
channelsRouter.get('/alertas', requireRole('OWNER', 'ADMIN'), ah(async (req, res) => {
  const orgId = orgOf(req);
  const list = await prisma.channel.findMany({ where: { orgId, OR: [{ waDownAlertAt: { not: null } }, { waBackAt: { gte: new Date(Date.now() - 24 * 3600e3) } }] } });
  const labels = await channelLabels(orgId);
  const label = (c: Channel) => labels.get(c.id)?.label ?? c.name;
  res.set('Cache-Control', 'no-store');
  res.json({
    down: list.filter((c) => c.waDownAlertAt && c.status !== 'CONNECTED').map((c) => ({ id: c.id, label: label(c), downSince: c.waDownSince, alertedAt: c.waDownAlertAt })),
    back: list.filter((c) => c.status === 'CONNECTED' && c.waBackAt).map((c) => ({ id: c.id, label: label(c), backAt: c.waBackAt })),
  });
}));

channelsRouter.get('/', ah(async (req, res) => {
  const allowed = allowedChannels(req); // membro com canais limitados só vê os seus
  const list = await prisma.channel.findMany({ where: { orgId: orgOf(req), ...(allowed ? { id: { in: allowed } } : {}) }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
  const labels = await channelLabels(orgOf(req));
  res.json(await Promise.all(list.map((c) => view(c, req, labels.get(c.id)))));
}));

channelsRouter.post('/', requireRole('OWNER', 'ADMIN'), ah(async (req, res) => {
  const body = z.object({
    name: z.string().max(200).optional(),
    provider: z.enum([PROVIDER_QR, PROVIDER_CLOUD]).default(PROVIDER_QR),
  }).parse(req.body ?? {});
  const orgId = orgOf(req);
  // Sem nome informado: "WhatsApp N" (próximo número da organização).
  const typed = sanitizeChannelName(body.name);
  if (typed.length > CHANNEL_NAME_MAX) throw badRequest(`Nome do WhatsApp: no máximo ${CHANNEL_NAME_MAX} caracteres`);
  const name = typed || `WhatsApp ${(await prisma.channel.count({ where: { orgId } })) + 1}`;
  // Novo número com a IA automática da organização ligada: começa no modo "Só IA" (todo WhatsApp
  // conectado responde com a IA). Sem IA ligada, mantém "Fluxos + IA". O dono pode trocar em Canais.
  const autoReplyMode = await defaultAutoReplyMode(orgId);
  const c = await prisma.channel.create({ data: { orgId, name, provider: body.provider, verifyToken: randomToken(24), autoReplyMode } });
  await audit(req, 'channel.create', { entity: 'channel', entityId: c.id, meta: { name, autoReplyMode } });
  res.status(201).json(await view(c, req));
}));

const credsSchema = z.object({
  name: channelNameSchema.optional(),
  phoneNumberId: z.string().trim().regex(/^\d{5,30}$/, 'Phone Number ID deve conter apenas dígitos').optional(),
  wabaId: z.string().trim().regex(/^\d{5,30}$/, 'WABA ID deve conter apenas dígitos').optional().or(z.literal('')),
  accessToken: z.string().trim().min(20).max(1000).optional(),
  appSecret: z.string().trim().min(8).max(200).optional(),
  /** Modo QR: responder automaticamente também os contatos salvos na agenda do celular. */
  replySavedContacts: z.boolean().optional(),
  /** Quem responde automaticamente neste canal: flows (só fluxos) | ai (só IA) | both (fluxos + IA). */
  autoReplyMode: z.enum(AUTO_REPLY_MODES).optional(),
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
      replySavedContacts: body.replySavedContacts ?? undefined,
      autoReplyMode: body.autoReplyMode ?? undefined,
      // Credenciais alteradas exigem nova verificação real antes de marcar como conectado.
      ...(credsChanged ? { status: 'NOT_CONNECTED', lastError: null, provider: PROVIDER_CLOUD, waJid: null, ...DISARM_DOWN_ALERT } : {}),
    },
  });
  if (body.replySavedContacts !== undefined && body.replySavedContacts !== c.replySavedContacts) {
    await audit(req, 'channel.reply_saved_contacts', { entity: 'channel', entityId: c.id, meta: { antes: c.replySavedContacts, depois: body.replySavedContacts } });
  }
  const modeAntes = autoReplyModeOf(c);
  if (body.autoReplyMode !== undefined && body.autoReplyMode !== modeAntes) {
    await audit(req, 'channel.auto_reply_mode', { entity: 'channel', entityId: c.id, meta: { antes: modeAntes, depois: body.autoReplyMode } });
  }
  if (body.name !== undefined && body.name !== c.name) {
    await audit(req, 'channel.rename', { entity: 'channel', entityId: c.id, meta: { antes: c.name, depois: body.name } });
  }
  const otherFields = Object.keys(body).filter((k) => k !== 'replySavedContacts' && k !== 'autoReplyMode' && k !== 'name');
  if (otherFields.length) await audit(req, 'channel.update', { entity: 'channel', entityId: c.id, meta: { fields: otherFields } });
  res.json(await view(updated, req));
}));

/** Verifica as credenciais consultando a Graph API de verdade. Só aqui o canal vira CONNECTED. */
channelsRouter.post('/:id/verify', requireRole('OWNER', 'ADMIN'), ah(async (req, res) => {
  const c = await prisma.channel.findFirst({ where: { id: req.params.id, orgId: orgOf(req) } });
  if (!c) throw notFound('Canal');
  if (isQrChannel(c)) throw badRequest('Este canal usa conexão por QR code. Use "Conectar WhatsApp" ou cadastre as credenciais da API oficial.');
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
    pairing: live.pairing,
  };
}

/** Inicia a conexão: gera o QR (ou reconecta com a sessão salva). */
channelsRouter.post('/:id/qr/start', requireRole('OWNER', 'ADMIN'), ah(async (req, res) => {
  let c = await prisma.channel.findFirst({ where: { id: req.params.id, orgId: orgOf(req) } });
  if (!c) throw notFound('Canal');
  if (!isQrChannel(c)) {
    // Troca para o modo QR: as credenciais da API oficial ficam salvas, mas deixam de ser usadas.
    c = await prisma.channel.update({ where: { id: c.id }, data: { provider: PROVIDER_QR, status: 'NOT_CONNECTED', lastError: null, ...DISARM_DOWN_ALERT } });
  }
  await qrManager.start(c.id);
  await audit(req, 'channel.qr_start', { entity: 'channel', entityId: c.id });
  res.json(await qrView(c));
}));

/**
 * Conectar com número de telefone: gera o código de pareamento de 8 caracteres (XXXX-XXXX).
 * Só Proprietário/Administrador; até N códigos por canal por hora (contados na Auditoria, valem
 * entre instâncias e reinícios). O código vai só na resposta: nunca em log nem na Auditoria.
 */
channelsRouter.post('/:id/qr/pairing-code', requireRole('OWNER', 'ADMIN'), ah(async (req, res) => {
  let c = await prisma.channel.findFirst({ where: { id: req.params.id, orgId: orgOf(req) } });
  if (!c) throw notFound('Canal');
  const { phone } = z.object({ phone: z.string().max(40) }).parse(req.body ?? {});
  const check = normalizePairingPhone(phone);
  if (!check.ok) throw badRequest(check.error);
  const limit = pairingPerHour();
  const since = new Date(Date.now() - 3600e3);
  const recent = await prisma.auditLog.findMany({
    where: { orgId: c.orgId, entity: 'channel', entityId: c.id, action: { in: ['channel.pairing_code', 'channel.pairing_code_falha'] }, createdAt: { gte: since } },
    select: { createdAt: true }, orderBy: { createdAt: 'asc' },
  });
  if (recent.length >= limit) {
    const waitMin = Math.max(1, Math.ceil((recent[0].createdAt.getTime() + 3600e3 - Date.now()) / 60e3));
    res.set('Retry-After', String(waitMin * 60));
    throw new HttpError(429, `Limite de ${limit} códigos por hora para este canal. Tente de novo em ${waitMin} min ou use o QR code.`);
  }
  if (!isQrChannel(c)) {
    c = await prisma.channel.update({ where: { id: c.id }, data: { provider: PROVIDER_QR, status: 'NOT_CONNECTED', lastError: null, ...DISARM_DOWN_ALERT } });
  }
  try {
    const r = await qrManager.requestPairingCode(c.id, check.digits);
    await audit(req, 'channel.pairing_code', { entity: 'channel', entityId: c.id, meta: { phone: r.phone } });
    res.set('Cache-Control', 'no-store');
    res.json({ ...(await qrView(c)), code: r.code, expiresAt: r.expiresAt, phone: r.phone, remaining: Math.max(0, limit - recent.length - 1) });
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    await audit(req, 'channel.pairing_code_falha', { entity: 'channel', entityId: c.id, meta: { status } }).catch(() => undefined);
    throw e;
  }
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
  // Desconexão feita de propósito pelo dono: não gera alerta de WhatsApp desconectado.
  await prisma.channel.update({ where: { id: c.id }, data: { status: 'NOT_CONNECTED', waJid: null, lastError: null, ...DISARM_DOWN_ALERT } });
  await audit(req, 'channel.qr_disconnect', { entity: 'channel', entityId: c.id });
  res.json(await qrView(c));
}));

channelsRouter.post('/:id/disconnect', requireRole('OWNER', 'ADMIN'), ah(async (req, res) => {
  const c = await prisma.channel.findFirst({ where: { id: req.params.id, orgId: orgOf(req) } });
  if (!c) throw notFound('Canal');
  if (isQrChannel(c)) {
    await qrManager.stop(c.id, { logout: true });
    const u = await prisma.channel.update({ where: { id: c.id }, data: { status: 'NOT_CONNECTED', waJid: null, lastError: null, ...DISARM_DOWN_ALERT } });
    await audit(req, 'channel.disconnect', { entity: 'channel', entityId: c.id });
    return res.json(await view(u, req));
  }
  const updated = await prisma.channel.update({ where: { id: c.id }, data: { status: 'NOT_CONNECTED', accessTokenEnc: null, ...DISARM_DOWN_ALERT } });
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
