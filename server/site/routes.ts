/**
 * v1.44.0 — Chat para o site do cliente.
 *  - Admin (/api/channels/site, módulo Canais, Proprietário/Admin para alterar): criar, configurar e excluir o chat;
 *    código <script> para copiar.
 *  - Público (/api/public/chat/:key, sem sessão e sem CSRF, CORS aberto só para leitura/envio do visitante):
 *    config, enviar mensagem e buscar respostas (polling). Limite por IP e por visitante; origem opcional.
 * A mensagem do visitante entra pelo mesmo caminho do WhatsApp (handleInboundMessage): IA, fluxos,
 * distribuição, horário de atendimento e opt-out valem igual. A resposta do atendente/IA fica no banco
 * (sendOutbound marca como enviada) e o widget busca.
 */
import { Router, type Request, type Response, type NextFunction } from 'express';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { prisma } from '../db.js';
import { ah, notFound, HttpError } from '../lib/http.js';
import { orgOf, requireRole } from '../auth/session.js';
import { audit } from '../lib/audit.js';
import { randomToken } from '../lib/crypto.js';
import { appUrl } from '../lib/mailer.js';
import { handleInboundMessage } from '../whatsapp/inbound.js';
import { PROVIDER_SITE } from '../whatsapp/messaging.js';
import { defaultAutoReplyMode } from '../whatsapp/autoReplyMode.js';
import { sanitizeChannelName } from '../whatsapp/channelLabel.js';
import { ORIGEM_SITE } from '../origem/core.js';
import { JanelaLimite, lerDominios, origemPermitida, visitanteValido, waIdDoVisitante, corValida, limparTexto, codigoEmbed } from './core.js';

const MAX_SITES = 3;

// ---------------- Admin ----------------
export const siteAdminRouter = Router();
const admins = requireRole('OWNER', 'ADMIN');

async function vistaSite(req: Request, channelId: string) {
  const ch = await prisma.channel.findFirst({ where: { id: channelId, orgId: orgOf(req), provider: PROVIDER_SITE } });
  const w = ch ? await prisma.siteWidget.findUnique({ where: { channelId: ch.id } }) : null;
  if (!ch || !w) return null;
  return {
    id: ch.id, name: ch.name, autoReplyMode: ch.autoReplyMode, publicKey: w.publicKey, color: w.color, title: w.title, welcome: w.welcome,
    allowedOrigins: w.allowedOrigins, askName: w.askName, embed: codigoEmbed(appUrl(req), w.publicKey), createdAt: ch.createdAt,
  };
}

siteAdminRouter.get('/', ah(async (req, res) => {
  const chans = await prisma.channel.findMany({ where: { orgId: orgOf(req), provider: PROVIDER_SITE }, orderBy: { createdAt: 'asc' }, select: { id: true } });
  res.json({ items: (await Promise.all(chans.map((c) => vistaSite(req, c.id)))).filter(Boolean) });
}));

const siteBody = z.object({
  name: z.string().max(40).optional(),
  color: z.string().max(10).optional(),
  title: z.string().trim().min(1).max(60).optional(),
  welcome: z.string().trim().max(300).optional(),
  allowedOrigins: z.string().max(1000).optional(),
  askName: z.boolean().optional(),
});

function dadosWidget(b: z.infer<typeof siteBody>) {
  return {
    ...(b.color !== undefined ? { color: corValida(b.color) } : {}),
    ...(b.title !== undefined ? { title: b.title } : {}),
    ...(b.welcome !== undefined ? { welcome: b.welcome } : {}),
    ...(b.allowedOrigins !== undefined ? { allowedOrigins: lerDominios(b.allowedOrigins).join('\n') } : {}),
    ...(b.askName !== undefined ? { askName: b.askName } : {}),
  };
}

siteAdminRouter.post('/', admins, ah(async (req, res) => {
  const b = siteBody.parse(req.body ?? {});
  const orgId = orgOf(req);
  if ((await prisma.channel.count({ where: { orgId, provider: PROVIDER_SITE } })) >= MAX_SITES) throw new HttpError(400, `Limite de ${MAX_SITES} chats de site por empresa`);
  const name = sanitizeChannelName(b.name) || 'Site';
  const ch = await prisma.channel.create({ data: { orgId, name, provider: PROVIDER_SITE, status: 'CONNECTED', verifyToken: randomToken(24), autoReplyMode: await defaultAutoReplyMode(orgId) } });
  await prisma.siteWidget.create({ data: { channelId: ch.id, orgId, publicKey: randomBytes(16).toString('hex'), ...dadosWidget(b) } });
  await audit(req, 'site.criar', { entity: 'channel', entityId: ch.id });
  res.status(201).json(await vistaSite(req, ch.id));
}));

siteAdminRouter.put('/:id', admins, ah(async (req, res) => {
  const b = siteBody.parse(req.body ?? {});
  const atual = await vistaSite(req, req.params.id);
  if (!atual) throw notFound('Chat do site');
  const name = b.name !== undefined ? sanitizeChannelName(b.name) : '';
  if (name) await prisma.channel.update({ where: { id: atual.id }, data: { name } });
  await prisma.siteWidget.update({ where: { channelId: atual.id }, data: dadosWidget(b) });
  await audit(req, 'site.config', { entity: 'channel', entityId: atual.id, meta: { campos: Object.keys(b) } });
  res.json(await vistaSite(req, atual.id));
}));

siteAdminRouter.delete('/:id', admins, ah(async (req, res) => {
  const atual = await vistaSite(req, req.params.id);
  if (!atual) throw notFound('Chat do site');
  // As conversas continuam no Inbox (histórico); o widget para de funcionar.
  await prisma.siteWidget.delete({ where: { channelId: atual.id } });
  await prisma.channel.delete({ where: { id: atual.id } });
  await audit(req, 'site.excluir', { entity: 'channel', entityId: atual.id });
  res.json({ ok: true });
}));

// ---------------- Público ----------------
export const sitePublicRouter = Router();

// Limites (memória do processo). Envio: 20/min e 200/h por IP; 10 visitantes novos por hora por IP; leitura: 60/min por IP.
export const limites = {
  envioMin: new JanelaLimite(20, 60_000),
  envioHora: new JanelaLimite(200, 3600_000),
  novosHora: new JanelaLimite(10, 3600_000),
  leituraMin: new JanelaLimite(60, 60_000),
  visitanteMin: new JanelaLimite(12, 60_000),
};
export function resetLimitesSite() { for (const l of Object.values(limites)) l.reset(); }

function cors(req: Request, res: Response, next: NextFunction) {
  const origin = req.get('origin');
  // Sem cookies: o visitante se identifica só pelo id aleatório guardado no navegador.
  res.setHeader('Access-Control-Allow-Origin', origin || '*');
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '600');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  if (req.method === 'OPTIONS') return void res.status(204).end();
  next();
}
sitePublicRouter.use(cors);

function limitar(res: Response, l: JanelaLimite, chave: string) {
  if (l.tentar(chave)) return;
  res.setHeader('Retry-After', String(l.esperaSeg(chave)));
  throw new HttpError(429, 'Muitas mensagens. Aguarde um instante.');
}

async function widgetDa(req: Request) {
  const key = String(req.params.key ?? '');
  if (!/^[0-9a-f]{32}$/.test(key)) throw notFound('Chat');
  const w = await prisma.siteWidget.findUnique({ where: { publicKey: key } });
  if (!w) throw notFound('Chat');
  if (!origemPermitida(req.get('origin'), lerDominios(w.allowedOrigins))) throw new HttpError(403, 'Este site não está autorizado a usar este chat');
  const ch = await prisma.channel.findFirst({ where: { id: w.channelId, provider: PROVIDER_SITE } });
  if (!ch) throw notFound('Chat');
  return { w, ch };
}

/** Corpo JSON (application/json ou text/plain, para evitar o preflight do navegador). */
function corpo(req: Request): Record<string, unknown> {
  const b = req.body;
  if (typeof b === 'string') { try { return JSON.parse(b); } catch { throw new HttpError(400, 'Corpo inválido'); } }
  return (b && typeof b === 'object') ? b : {};
}

sitePublicRouter.get('/:key/config', ah(async (req, res) => {
  limitar(res, limites.leituraMin, req.ip ?? '');
  const { w } = await widgetDa(req);
  res.json({ title: w.title, welcome: w.welcome, color: w.color, askName: w.askName });
}));

sitePublicRouter.post('/:key/messages', ah(async (req, res) => {
  const ip = req.ip ?? '';
  limitar(res, limites.envioMin, ip);
  limitar(res, limites.envioHora, ip);
  const b = corpo(req);
  if (!visitanteValido(b.visitor)) throw new HttpError(400, 'Visitante inválido');
  const text = limparTexto(b.text);
  if (!text) throw new HttpError(400, 'Escreva uma mensagem');
  const { w, ch } = await widgetDa(req);
  limitar(res, limites.visitanteMin, `${w.publicKey}:${b.visitor}`);
  const waId = waIdDoVisitante(w.publicKey, b.visitor);
  const nome = limparTexto(b.name, 60) || null;
  const fone = limparTexto(b.phone, 20).replace(/[^\d+]/g, '');
  let contact = await prisma.contact.findUnique({ where: { orgId_waId: { orgId: ch.orgId, waId } } });
  if (!contact) {
    limitar(res, limites.novosHora, ip);
    try {
      contact = await prisma.contact.create({ data: { orgId: ch.orgId, waId, phone: '', name: nome ?? 'Visitante do site', origem: ORIGEM_SITE, origemEm: new Date(), ...(fone.replace(/\D/g, '').length >= 10 ? { vars: JSON.stringify({ whatsappInformado: fone }) } : {}) } });
    } catch {
      contact = await prisma.contact.findUniqueOrThrow({ where: { orgId_waId: { orgId: ch.orgId, waId } } });
    }
  } else if (nome && contact.name === 'Visitante do site') {
    contact = await prisma.contact.update({ where: { id: contact.id }, data: { name: nome } });
  }
  const waMessageId = 'site_' + randomBytes(12).toString('hex');
  // Processa em segundo plano (a IA pode levar alguns segundos); o widget busca a resposta por polling.
  const p = handleInboundMessage(ch, { phoneNumberId: '', waMessageId, from: waId, timestamp: new Date(), type: 'text', text, profileName: nome ?? undefined })
    .then(async () => {
      await prisma.conversation.updateMany({ where: { orgId: ch.orgId, contactId: contact!.id, channelId: ch.id, origem: null }, data: { origem: ORIGEM_SITE } });
    })
    .catch((e) => console.error('[site] falha ao processar mensagem do visitante', { orgId: ch.orgId, error: (e as Error).message }));
  pendentes.add(p);
  p.finally(() => pendentes.delete(p));
  res.status(202).json({ ok: true, id: waMessageId });
}));

/** Só a imagem do QR da cobrança Pix (servida por este app), sempre com o endereço atual do app. */
function imagemPix(url: string | null, base: string): string | null {
  const m = url ? /\/api\/public\/pix\/([0-9a-f]{48})\.png$/.exec(url) : null;
  return m ? `${base}/api/public/pix/${m[1]}.png` : null;
}

/** Mensagens em processamento (os testes esperam terminar). */
const pendentes = new Set<Promise<unknown>>();
export async function aguardarSite() { await Promise.all([...pendentes]); }

sitePublicRouter.get('/:key/messages', ah(async (req, res) => {
  limitar(res, limites.leituraMin, req.ip ?? '');
  const visitor = String(req.query.visitor ?? '');
  if (!visitanteValido(visitor)) throw new HttpError(400, 'Visitante inválido');
  const { w, ch } = await widgetDa(req);
  const contact = await prisma.contact.findUnique({ where: { orgId_waId: { orgId: ch.orgId, waId: waIdDoVisitante(w.publicKey, visitor) } }, select: { id: true } });
  if (!contact) return void res.json({ items: [] });
  const after = typeof req.query.after === 'string' && !Number.isNaN(Date.parse(req.query.after)) ? new Date(req.query.after) : null;
  const convs = await prisma.conversation.findMany({ where: { orgId: ch.orgId, contactId: contact.id, channelId: ch.id }, select: { id: true } });
  const msgs = await prisma.message.findMany({
    where: { orgId: ch.orgId, conversationId: { in: convs.map((c) => c.id) }, direction: { in: ['IN', 'OUT'] }, status: { not: 'FAILED' }, ...(after ? { createdAt: { gt: after } } : {}) },
    orderBy: { createdAt: after ? 'asc' : 'desc' }, take: 100,
    select: { id: true, direction: true, type: true, body: true, mediaUrl: true, createdAt: true },
  });
  const lista = after ? msgs : msgs.reverse();
  const base = appUrl(req);
  res.json({
    items: lista.map((m) => ({
      id: m.id, de: m.direction === 'IN' ? 'visitante' : 'empresa', texto: m.body ?? '', criadoEm: m.createdAt,
      // Só imagens servidas por este app (QR da cobrança Pix).
      imagem: imagemPix(m.mediaUrl, base),
    })),
  });
}));
