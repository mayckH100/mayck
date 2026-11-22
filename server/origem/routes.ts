/**
 * v1.44.0 — /api/origens: links de origem (wa.me com código). Leitura: quem acessa Relatórios.
 * Criar/excluir: Proprietário/Administrador.
 */
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { ah, notFound, HttpError } from '../lib/http.js';
import { orgOf, requireRole } from '../auth/session.js';
import { audit } from '../lib/audit.js';
import { normalizarCodigo, linkWaMe, textoDoLink, ORIGENS_FIXAS } from './core.js';

export const origemRouter = Router();
const admins = requireRole('OWNER', 'ADMIN');

/** Número do canal (só dígitos): telefone exibido (API oficial) ou o do aparelho conectado (QR). */
export function numeroDoCanal(c: { displayPhone: string | null; waJid: string | null }): string {
  const d = (c.displayPhone ?? '').replace(/\D/g, '');
  if (d.length >= 10) return d;
  return (c.waJid ?? '').split('@')[0].split(':')[0].replace(/\D/g, '');
}

async function canaisWhats(orgId: string) {
  return prisma.channel.findMany({ where: { orgId, provider: { in: ['whatsapp_cloud', 'whatsapp_qr'] } }, orderBy: { createdAt: 'asc' }, select: { id: true, name: true, displayPhone: true, waJid: true } });
}

origemRouter.get('/', ah(async (req, res) => {
  const orgId = orgOf(req);
  const [links, canais] = await Promise.all([
    prisma.origemLink.findMany({ where: { orgId }, orderBy: { createdAt: 'desc' }, take: 200 }),
    canaisWhats(orgId),
  ]);
  const porId = new Map(canais.map((c) => [c.id, c]));
  const padrao = canais.find((c) => numeroDoCanal(c)) ?? null;
  res.json({
    canais: canais.map((c) => ({ id: c.id, name: c.name, numero: numeroDoCanal(c) || null })),
    fixas: ORIGENS_FIXAS,
    items: links.map((l) => {
      const canal = (l.channelId ? porId.get(l.channelId) : null) ?? padrao;
      const numero = canal ? numeroDoCanal(canal) : '';
      return { id: l.id, code: l.code, name: l.name, text: l.text, channelId: l.channelId, textoCompleto: textoDoLink(l.text, l.code), link: numero ? linkWaMe(numero, l.text, l.code) : null, createdAt: l.createdAt };
    }),
  });
}));

origemRouter.post('/', admins, ah(async (req, res) => {
  const b = z.object({
    name: z.string().trim().min(1, 'Dê um nome (ex.: Bio do Instagram)').max(80),
    code: z.string().trim().max(60).optional(),
    text: z.string().trim().max(300).optional(),
    channelId: z.string().max(60).nullable().optional(),
  }).parse(req.body);
  const orgId = orgOf(req);
  const code = normalizarCodigo(b.code || b.name);
  if (!code) throw new HttpError(400, 'Código inválido: use letras, números e "-" (ex.: instagram-bio)');
  if (ORIGENS_FIXAS[code]) throw new HttpError(400, `O código "${code}" é reservado. Escolha outro.`);
  if (b.channelId && !(await prisma.channel.findFirst({ where: { id: b.channelId, orgId }, select: { id: true } }))) throw notFound('Canal');
  if ((await prisma.origemLink.count({ where: { orgId } })) >= 200) throw new HttpError(400, 'Limite de 200 links de origem');
  if (await prisma.origemLink.findUnique({ where: { orgId_code: { orgId, code } }, select: { id: true } })) throw new HttpError(409, `Já existe um link com o código ${code}`);
  const l = await prisma.origemLink.create({ data: { orgId, code, name: b.name, text: b.text || 'Olá!', channelId: b.channelId || null } });
  await audit(req, 'origem.link.criar', { entity: 'origemLink', entityId: l.id, meta: { code } });
  res.status(201).json({ id: l.id, code: l.code });
}));

origemRouter.delete('/:id', admins, ah(async (req, res) => {
  const orgId = orgOf(req);
  const l = await prisma.origemLink.findFirst({ where: { id: req.params.id, orgId } });
  if (!l) throw notFound('Link de origem');
  await prisma.origemLink.delete({ where: { id: l.id } });
  await audit(req, 'origem.link.excluir', { entity: 'origemLink', entityId: l.id, meta: { code: l.code } });
  res.json({ ok: true });
}));
