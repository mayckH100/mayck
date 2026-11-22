/**
 * v1.44.0 — Cobrança Pix na conversa (rotas dentro de /api/inbox, módulo Inbox).
 *  - GET/PUT /pix/config: chave Pix da empresa (alterar: Proprietário/Administrador).
 *  - GET/POST /conversas/:id/pix: cobranças da conversa / nova cobrança (envia QR + copia e cola ao cliente).
 *  - POST /pix/:id/status: marcar paga, pendente ou cancelada (baixa manual).
 * Público: GET /api/public/pix/:token.png (imagem do QR, usada no chat do site; token aleatório por cobrança).
 */
import { Router } from 'express';
import { randomBytes } from 'node:crypto';
import QRCode from 'qrcode';
import { z } from 'zod';
import { prisma } from '../db.js';
import { ah, notFound, HttpError } from '../lib/http.js';
import { orgOf, requireRole } from '../auth/session.js';
import { audit } from '../lib/audit.js';
import { channelWhere } from '../lib/permissions.js';
import { sendOutbound, resolveChannel, isSiteChannel } from '../whatsapp/messaging.js';
import { clearWaiting } from '../lib/waiting.js';
import { appUrl } from '../lib/mailer.js';
import { TIPOS_CHAVE, ROTULO_TIPO, normalizarChave, valorEmCentavos, txidDe, codigoCobranca, textoCobranca, brCodeValido, brl, type TipoChave } from './core.js';

export const pixRouter = Router();
const admins = requireRole('OWNER', 'ADMIN');

export async function qrPng(code: string): Promise<Buffer> {
  return QRCode.toBuffer(code, { type: 'png', width: 360, margin: 2, errorCorrectionLevel: 'M' });
}

const vistaConfig = (c: { keyType: string; key: string; name: string; city: string } | null) => c
  ? { configurado: true, keyType: c.keyType, keyTypeLabel: ROTULO_TIPO[c.keyType as TipoChave] ?? c.keyType, key: c.key, name: c.name, city: c.city }
  : { configurado: false };

pixRouter.get('/pix/config', ah(async (req, res) => {
  res.json(vistaConfig(await prisma.pixSettings.findUnique({ where: { orgId: orgOf(req) } })));
}));

pixRouter.put('/pix/config', admins, ah(async (req, res) => {
  const b = z.object({
    keyType: z.enum(TIPOS_CHAVE),
    key: z.string().trim().min(3, 'Informe a chave Pix').max(100),
    name: z.string().trim().min(2, 'Informe o nome do recebedor (como aparece no banco)').max(60),
    city: z.string().trim().min(2, 'Informe a cidade').max(40),
  }).parse(req.body);
  const n = normalizarChave(b.keyType, b.key);
  if (!n.ok) throw new HttpError(400, n.erro);
  const orgId = orgOf(req);
  const data = { keyType: b.keyType, key: n.chave, name: b.name, city: b.city };
  const saved = await prisma.pixSettings.upsert({ where: { orgId }, create: { orgId, ...data }, update: data });
  await audit(req, 'pix.config', { entity: 'pixSettings', entityId: orgId, meta: { keyType: b.keyType } });
  res.json(vistaConfig(saved));
}));

const vistaCobranca = (c: { id: string; amountCents: number; description: string; status: string; code: string; createdAt: Date; paidAt: Date | null }) => ({
  id: c.id, amountCents: c.amountCents, valor: brl(c.amountCents), description: c.description, status: c.status, code: c.code, createdAt: c.createdAt, paidAt: c.paidAt,
});

async function convDoMembro(req: import('express').Request, id: string) {
  const c = await prisma.conversation.findFirst({ where: { id, orgId: orgOf(req), ...channelWhere(req) } });
  if (!c) throw notFound('Conversa');
  return c;
}

pixRouter.get('/conversas/:id/pix', ah(async (req, res) => {
  const conv = await convDoMembro(req, req.params.id);
  const items = await prisma.pixCharge.findMany({ where: { orgId: conv.orgId, conversationId: conv.id }, orderBy: { createdAt: 'desc' }, take: 50 });
  res.json({ items: items.map(vistaCobranca) });
}));

pixRouter.post('/conversas/:id/pix', ah(async (req, res) => {
  const b = z.object({ valor: z.union([z.string().max(30), z.number()]), descricao: z.string().trim().max(120).optional() }).parse(req.body);
  const conv = await convDoMembro(req, req.params.id);
  if (conv.status === 'CLOSED') throw new HttpError(400, 'Reabra a conversa para enviar uma cobrança');
  const cfg = await prisma.pixSettings.findUnique({ where: { orgId: conv.orgId } });
  if (!cfg) throw new HttpError(400, 'Cadastre a chave Pix da empresa primeiro (Inbox › 💠 Cobrar Pix › Chave Pix)');
  const cents = valorEmCentavos(b.valor);
  if (!cents) throw new HttpError(400, 'Valor inválido (ex.: 150,00)');
  const contact = await prisma.contact.findFirstOrThrow({ where: { id: conv.contactId, orgId: conv.orgId } });
  const descricao = b.descricao ?? '';
  // Cria a cobrança, gera o código com o txid dela e guarda.
  const publicToken = randomBytes(24).toString('hex');
  const rascunho = await prisma.pixCharge.create({ data: { orgId: conv.orgId, conversationId: conv.id, contactId: contact.id, amountCents: cents, description: descricao, txid: 'tmp', code: '', publicToken, createdById: req.auth!.userId } });
  const txid = txidDe(rascunho.id);
  const code = codigoCobranca(cfg, cents, txid);
  if (!brCodeValido(code)) {
    await prisma.pixCharge.delete({ where: { id: rascunho.id } });
    throw new HttpError(400, 'Não foi possível gerar o código Pix com esses dados. Confira a chave, o nome e a cidade.');
  }
  const charge = await prisma.pixCharge.update({ where: { id: rascunho.id }, data: { txid, code } });

  // Enviar é uma ação do atendente: a conversa passa para atendimento humano (como ao enviar uma mensagem).
  if (conv.mode !== 'HUMAN') {
    await prisma.conversation.update({ where: { id: conv.id }, data: { mode: 'HUMAN', assignedUserId: conv.assignedUserId ?? req.auth!.userId } });
    await prisma.flowRun.updateMany({ where: { conversationId: conv.id, status: { in: ['RUNNING', 'WAITING'] } }, data: { status: 'CANCELLED', finishedAt: new Date() } });
  }
  const resumo = textoCobranca(cents, descricao, cfg.name);
  const channel = await resolveChannel(conv);
  const base = { conversation: conv, contact, sender: 'agent' as const, authorUserId: req.auth!.userId };
  const imagem = isSiteChannel(channel)
    ? await sendOutbound({ ...base, payload: { type: 'image', link: `${appUrl(req)}/api/public/pix/${publicToken}.png`, caption: resumo } })
    : await sendOutbound({ ...base, payload: { type: 'file', data: await qrPng(code), filename: 'pix.png', mime: 'image/png', caption: resumo } });
  const copia = await sendOutbound({ ...base, payload: { type: 'text', text: code } });
  if (imagem.status !== 'FAILED' || copia.status !== 'FAILED') await clearWaiting(conv);
  await prisma.message.create({ data: { orgId: conv.orgId, conversationId: conv.id, direction: 'INTERNAL', sender: 'system', type: 'note', body: `💠 Cobrança Pix de ${brl(cents)}${descricao ? ` (${descricao})` : ''} enviada. Marque como paga depois de conferir no extrato do banco.`, status: 'NOTE', authorUserId: req.auth!.userId } });
  await audit(req, 'pix.cobrar', { entity: 'pixCharge', entityId: charge.id, meta: { amountCents: cents, imagem: imagem.status, codigo: copia.status } });
  const falhou = imagem.status === 'FAILED' && copia.status === 'FAILED';
  res.status(falhou ? 502 : 201).json({ ...vistaCobranca(charge), envio: { imagem: imagem.status, codigo: copia.status, erro: copia.error ?? imagem.error ?? null } });
}));

pixRouter.post('/pix/:id/status', ah(async (req, res) => {
  const { status } = z.object({ status: z.enum(['PENDENTE', 'PAGA', 'CANCELADA']) }).parse(req.body);
  const orgId = orgOf(req);
  const c = await prisma.pixCharge.findFirst({ where: { id: req.params.id, orgId } });
  if (!c) throw notFound('Cobrança');
  await convDoMembro(req, c.conversationId);
  const u = await prisma.pixCharge.update({ where: { id: c.id }, data: { status, paidAt: status === 'PAGA' ? new Date() : null, paidById: status === 'PAGA' ? req.auth!.userId : null } });
  if (status !== c.status) {
    const txt = status === 'PAGA' ? `✅ Cobrança Pix de ${brl(c.amountCents)} marcada como paga.` : status === 'CANCELADA' ? `Cobrança Pix de ${brl(c.amountCents)} cancelada.` : `Cobrança Pix de ${brl(c.amountCents)} voltou para pendente.`;
    await prisma.message.create({ data: { orgId, conversationId: c.conversationId, direction: 'INTERNAL', sender: 'system', type: 'note', body: txt, status: 'NOTE', authorUserId: req.auth!.userId } });
  }
  await audit(req, 'pix.status', { entity: 'pixCharge', entityId: c.id, meta: { de: c.status, para: status } });
  res.json(vistaCobranca(u));
}));

// ---------------- Público: imagem do QR (chat do site) ----------------
export const publicPixRouter = Router();
publicPixRouter.get('/:token.png', ah(async (req, res) => {
  const token = String(req.params.token ?? '');
  if (!/^[0-9a-f]{48}$/.test(token)) throw notFound('Imagem');
  const c = await prisma.pixCharge.findUnique({ where: { publicToken: token }, select: { code: true, status: true } });
  if (!c || c.status === 'CANCELADA') throw notFound('Imagem');
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  res.type('png').send(await qrPng(c.code));
}));
