import { Router, raw } from 'express';
import rateLimit from 'express-rate-limit';
import { prisma } from '../db.js';
import { decryptOrNull, safeEqual } from '../lib/crypto.js';
import { verifyHubSignature } from '../whatsapp/signature.js';
import { processWebhook } from '../whatsapp/inbound.js';
import { config } from '../config.js';

/**
 * Webhook da WhatsApp Cloud API — uma URL por canal: /api/webhooks/whatsapp/:channelId
 * GET  → verificação (hub.mode=subscribe, hub.verify_token, hub.challenge)
 * POST → eventos, autenticados por X-Hub-Signature-256 (HMAC-SHA256 do corpo bruto com o App Secret).
 */
export const webhookRouter = Router();

const limiter = rateLimit({
  windowMs: 60 * 1000,
  limit: () => config.WEBHOOK_RATE_LIMIT,
  keyGenerator: (req) => `wh:${req.params.channelId ?? req.ip}`,
  standardHeaders: 'draft-7', legacyHeaders: false,
});

webhookRouter.get('/whatsapp/:channelId', limiter, async (req, res) => {
  const channel = await prisma.channel.findUnique({ where: { id: req.params.channelId } });
  const mode = req.query['hub.mode'];
  const token = String(req.query['hub.verify_token'] ?? '');
  const challenge = String(req.query['hub.challenge'] ?? '');
  if (channel && mode === 'subscribe' && token && safeEqual(token, channel.verifyToken)) {
    return res.status(200).type('text/plain').send(challenge);
  }
  return res.sendStatus(403);
});

webhookRouter.post('/whatsapp/:channelId', limiter, raw({ type: '*/*', limit: '2mb' }), async (req, res) => {
  const channel = await prisma.channel.findUnique({ where: { id: req.params.channelId } });
  if (!channel) return res.sendStatus(404);
  const secret = decryptOrNull(channel.appSecretEnc);
  const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
  if (!secret || !verifyHubSignature(rawBody, req.header('x-hub-signature-256'), secret)) {
    await prisma.channel.update({ where: { id: channel.id }, data: { lastError: 'Webhook recebido com assinatura inválida' } });
    return res.status(401).json({ error: 'Assinatura inválida' });
  }
  let body: unknown;
  try {
    body = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return res.status(400).json({ error: 'JSON inválido' });
  }
  try {
    const result = await processWebhook(channel, body);
    return res.status(200).json(result);
  } catch (e) {
    console.error('[webhook] erro ao processar', e);
    await prisma.channel.update({ where: { id: channel.id }, data: { lastError: `Erro ao processar webhook: ${(e as Error).message}` } });
    // 500 faz a Meta reenviar; a idempotência por message id evita duplicidade no reenvio.
    return res.status(500).json({ error: 'Falha ao processar' });
  }
});
