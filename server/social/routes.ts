import { Router, type Response } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { ah, badRequest, HttpError, notFound } from '../lib/http.js';
import { audit } from '../lib/audit.js';
import { config, isProd } from '../config.js';
import { superAdminMfaRequired } from '../auth/session.js';
import {
  PROVIDERS, PROVIDER_LABEL, STATE_COOKIE, STATE_TTL_MS, TARGETS, authUrlFor, connectFor, makeState, notConfiguredMessage,
  providerConfigured, readState, type Provider,
} from './providers.js';
import { approveAndPublish, listAccounts, postView, publicNovidades, saveAccount } from './service.js';

/**
 * Novidades (publicação nas redes sociais) — exclusivo do administrador da plataforma (Painel Master).
 *  - socialRouter: montado em /api/social com requireSuperAdmin (contas, conectar, publicações).
 *  - socialCallbackRouter: retorno do OAuth (/api/social/:rede/callback), público, validado por state assinado + cookie.
 *  - publicNovidadesRouter: GET /api/novidades (site /empresa/novidades), público, só leitura.
 */

/** Rota OAuth → rede ("meta" conecta o Instagram pelo Facebook Login). */
const SLUGS: Record<string, Provider> = { meta: 'instagram', instagram: 'instagram', youtube: 'youtube', linkedin: 'linkedin', tiktok: 'tiktok' };
const providerOfSlug = (s: string): Provider => {
  const p = SLUGS[s];
  if (!p) throw notFound('Rede social');
  return p;
};
const cookieOpts = () => ({ httpOnly: true, sameSite: 'lax' as const, secure: config.COOKIE_SECURE ? config.COOKIE_SECURE === 'true' : isProd, path: '/api/social' });
const backTo = (res: Response, status: 'ok' | 'erro', provider: Provider | null, msg?: string) => {
  const q = new URLSearchParams({ aba: 'novidades', social: status, ...(provider ? { rede: provider } : {}), ...(msg ? { msg: msg.slice(0, 200) } : {}) });
  res.redirect(`/master?${q.toString()}`);
};

export const socialRouter = Router();

socialRouter.get('/accounts', ah(async (_req, res) => {
  res.json({ accounts: await listAccounts() });
}));

/** Início do OAuth: grava o state assinado num cookie e redireciona para a rede. Sem configuração, volta ao painel com o aviso. */
socialRouter.get('/:slug/connect', ah(async (req, res) => {
  const p = providerOfSlug(String(req.params.slug));
  if (!providerConfigured(p)) return void backTo(res, 'erro', p, notConfiguredMessage(p));
  const state = makeState(req.auth!.userId, p);
  res.cookie(STATE_COOKIE, state, { ...cookieOpts(), maxAge: STATE_TTL_MS });
  res.redirect(authUrlFor(p, state));
}));

socialRouter.delete('/accounts/:provider', ah(async (req, res) => {
  const p = String(req.params.provider);
  if (!(PROVIDERS as readonly string[]).includes(p)) throw notFound('Rede social');
  const r = await prisma.socialAccount.deleteMany({ where: { provider: p } });
  await audit(req, 'master.social.disconnect', { orgId: null, entity: 'social', entityId: p });
  res.json({ ok: true, removed: r.count });
}));

// ---------- Publicações ----------
const httpsUrl = z.string().trim().max(2000).url('URL inválida').refine((u) => /^https:\/\//i.test(u), 'A mídia precisa ser um link público https');
const postSchema = z.object({
  title: z.string().trim().min(1, 'Informe o título').max(150),
  body: z.string().trim().max(5000).default(''),
  mediaUrl: httpsUrl.nullable().optional().or(z.literal('').transform(() => null)),
  mediaType: z.enum(['image', 'video']).nullable().optional(),
  targets: z.array(z.enum(TARGETS)).min(1, 'Escolha ao menos um destino').max(TARGETS.length),
}).superRefine((v, ctx) => {
  if (v.mediaUrl && !v.mediaType) ctx.addIssue({ code: 'custom', path: ['mediaType'], message: 'Diga se a mídia é imagem ou vídeo' });
  if (v.targets.includes('instagram') && !v.mediaUrl) ctx.addIssue({ code: 'custom', path: ['mediaUrl'], message: 'O Instagram exige imagem ou vídeo' });
  if (v.targets.includes('youtube') && (!v.mediaUrl || v.mediaType !== 'video')) ctx.addIssue({ code: 'custom', path: ['mediaUrl'], message: 'O YouTube exige um vídeo' });
});
const postData = (v: z.infer<typeof postSchema>) => ({
  title: v.title, body: v.body, mediaUrl: v.mediaUrl || null, mediaType: v.mediaUrl ? v.mediaType ?? null : null, targets: JSON.stringify([...new Set(v.targets)]),
});

socialRouter.get('/posts', ah(async (_req, res) => {
  const rows = await prisma.socialPost.findMany({ orderBy: { createdAt: 'desc' }, take: 100 });
  res.json({ items: rows.map(postView) });
}));

socialRouter.post('/posts', ah(async (req, res) => {
  const v = postSchema.parse(req.body ?? {});
  const p = await prisma.socialPost.create({ data: { ...postData(v), status: 'draft', createdById: req.auth!.userId } });
  await audit(req, 'master.social.post_create', { orgId: null, entity: 'social_post', entityId: p.id });
  res.status(201).json(postView(p));
}));

async function editablePost(id: string) {
  const p = await prisma.socialPost.findUnique({ where: { id } });
  if (!p) throw notFound('Publicação');
  return p;
}

socialRouter.put('/posts/:id', ah(async (req, res) => {
  const cur = await editablePost(String(req.params.id));
  if (cur.status !== 'draft') throw badRequest('Só rascunhos podem ser editados');
  const v = postSchema.parse(req.body ?? {});
  const r = await prisma.socialPost.updateMany({ where: { id: cur.id, status: 'draft' }, data: postData(v) });
  if (!r.count) throw badRequest('Só rascunhos podem ser editados');
  res.json(postView((await prisma.socialPost.findUnique({ where: { id: cur.id } }))!));
}));

socialRouter.delete('/posts/:id', ah(async (req, res) => {
  const cur = await editablePost(String(req.params.id));
  if (cur.status === 'approved') throw badRequest('Aguarde a publicação terminar para excluir');
  await prisma.socialPost.deleteMany({ where: { id: cur.id, status: { not: 'approved' } } });
  await audit(req, 'master.social.post_delete', { orgId: null, entity: 'social_post', entityId: cur.id, meta: { status: cur.status } });
  res.json({ ok: true });
}));

/**
 * Aprovação explícita: { confirm: true }. Responde 202 na hora (status "approved" = publicando) e publica em segundo plano;
 * a tela acompanha pelo GET /posts. Em "partial"/"failed", tenta de novo só os destinos que falharam.
 */
socialRouter.post('/posts/:id/publish', ah(async (req, res) => {
  const { confirm } = z.object({ confirm: z.literal(true, { errorMap: () => ({ message: 'Confirme a aprovação para publicar' }) }) }).parse(req.body ?? {});
  void confirm;
  const cur = await editablePost(String(req.params.id));
  if (cur.status === 'published') throw badRequest('Esta publicação já foi publicada em todos os destinos');
  const { started, promise } = await approveAndPublish(cur.id);
  if (!started) throw new HttpError(409, 'Esta publicação já está sendo publicada');
  promise.catch((e) => console.error('[novidades] falha ao publicar', (e as Error)?.message));
  await audit(req, 'master.social.post_publish', { orgId: null, entity: 'social_post', entityId: cur.id, meta: { from: cur.status } });
  res.status(202).json(postView((await prisma.socialPost.findUnique({ where: { id: cur.id } }))!));
}));

// ---------- Retorno do OAuth ----------
export const socialCallbackRouter = Router();
socialCallbackRouter.get('/:slug/callback', ah(async (req, res) => {
  const slug = String(req.params.slug);
  const p = SLUGS[slug];
  if (!p) return void res.status(404).json({ error: 'Rede social não encontrada' });
  const st = readState(req.query.state, req.cookies?.[STATE_COOKIE], p);
  res.clearCookie(STATE_COOKIE, cookieOpts());
  if (!st) return void backTo(res, 'erro', p, 'Link de conexão inválido ou expirado. Clique em "Conectar" de novo.');
  if (!req.auth || req.auth.userId !== st.u || !req.auth.isSuperAdmin || (superAdminMfaRequired() && !req.auth.mfaEnabled)) {
    return void backTo(res, 'erro', p, 'Entre no Painel Master com o mesmo usuário e tente de novo.');
  }
  if (req.query.error) return void backTo(res, 'erro', p, `Conexão cancelada no ${PROVIDER_LABEL[p]}.`);
  const code = String(req.query.code ?? '');
  if (!code) return void backTo(res, 'erro', p, 'Retorno sem código de autorização.');
  try {
    const acc = await connectFor(p, code);
    const row = await saveAccount(acc);
    await audit(req, 'master.social.connect', { orgId: null, entity: 'social', entityId: row.id, meta: { provider: p, account: acc.accountName } });
    backTo(res, 'ok', p);
  } catch (e) {
    await audit(req, 'master.social.connect_failed', { orgId: null, entity: 'social', meta: { provider: p, error: (e as Error).message?.slice(0, 300) } });
    backTo(res, 'erro', p, (e as Error).message);
  }
}));

// ---------- Público: site /empresa/novidades ----------
export const publicNovidadesRouter = Router();
publicNovidadesRouter.get('/', ah(async (_req, res) => {
  res.set('Cache-Control', 'public, max-age=60');
  res.json({ items: await publicNovidades(50) });
}));
