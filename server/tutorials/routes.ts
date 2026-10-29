import { Router, type Request, type Response } from 'express';
import path from 'node:path';
import { existsSync, readFileSync, statSync, createReadStream } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ah, notFound, forbidden } from '../lib/http.js';
import { getSubscription, effectiveStatus, type Product } from '../billing/service.js';

/**
 * Tutoriais em vídeo (área do assinante).
 *
 * Os vídeos NÃO ficam na pasta pública do site: moram em media/tutorials/ e só saem por estas rotas,
 * que exigem login e assinatura PAGA ativa do app correspondente (status ATIVA). Teste grátis (TRIAL),
 * vencida e bloqueada não assistem. O plano Combo ativa as duas assinaturas, então libera os dois vídeos.
 * Superadmin da plataforma sempre assiste.
 */
export const TUTORIAL_APPS = { mckbot: 'MCKBOT', 'mck-mensagens': 'MCKMENSAGEM' } as const satisfies Record<string, Product>;
export type TutorialApp = keyof typeof TUTORIAL_APPS;
export const isApp = (v: string): v is TutorialApp => Object.prototype.hasOwnProperty.call(TUTORIAL_APPS, v);

function mediaDir() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [process.env.TUTORIALS_DIR, path.resolve(process.cwd(), 'media/tutorials'), path.resolve(here, '../../media/tutorials'), path.resolve(here, '../../../media/tutorials')].filter(Boolean) as string[];
  return candidates.find((p) => existsSync(p)) ?? candidates[1];
}

export type TutorialAccess = { allowed: boolean; reason: 'superadmin' | 'pago' | 'teste_gratis' | 'vencida' | 'bloqueada' | 'sem_plano' };

/** Regra de acesso: superadmin sempre; senão, assinatura do app com status efetivo ATIVA (paga). */
export async function tutorialAccess(orgId: string | null, app: TutorialApp, isSuperAdmin: boolean): Promise<TutorialAccess> {
  if (isSuperAdmin) return { allowed: true, reason: 'superadmin' };
  if (!orgId) return { allowed: false, reason: 'sem_plano' };
  const sub = await getSubscription(orgId, TUTORIAL_APPS[app]);
  const st = effectiveStatus(sub);
  if (st === 'ATIVA') return { allowed: true, reason: 'pago' };
  return { allowed: false, reason: st === 'TRIAL' ? 'teste_gratis' : st === 'VENCIDA' ? 'vencida' : 'bloqueada' };
}

export function meta(app: TutorialApp) {
  const f = path.join(mediaDir(), `${app}.json`);
  if (!existsSync(f)) return null;
  try { return JSON.parse(readFileSync(f, 'utf8')) as { title: string; duration: number; chapters: { title: string; start: number }[] }; } catch { return null; }
}

async function guard(req: Request) {
  const app = String(req.params.app);
  if (!isApp(app)) throw notFound('Tutorial');
  const access = await tutorialAccess(req.auth!.orgId, app, !!req.auth!.isSuperAdmin);
  return { app, access };
}

export const tutorialsRouter = Router();

/** Informações do tutorial (sempre respondem, para a tela mostrar o aviso "Disponível para assinantes"). */
tutorialsRouter.get('/:app', ah(async (req, res) => {
  const { app, access } = await guard(req);
  const m = meta(app);
  res.json({ app, product: TUTORIAL_APPS[app], allowed: access.allowed, reason: access.reason, title: m?.title ?? null, duration: m?.duration ?? null, chapters: (m?.chapters ?? []).map((c) => ({ title: c.title, start: c.start })), available: !!m && existsSync(path.join(mediaDir(), `${app}.mp4`)) });
}));

/** Legendas (WebVTT). */
tutorialsRouter.get('/:app/captions.vtt', ah(async (req, res) => {
  const { app, access } = await guard(req);
  if (!access.allowed) throw forbidden('Disponível para assinantes');
  sendTutorialCaptions(res, app);
}));

/** Vídeo com suporte a Range (streaming e pulo de capítulos). */
tutorialsRouter.get('/:app/video', ah(async (req, res) => {
  const { app, access } = await guard(req);
  if (!access.allowed) throw forbidden('Disponível para assinantes');
  sendTutorialVideo(req, res, app);
}));

export const tutorialAvailable = (app: TutorialApp) => !!meta(app) && existsSync(path.join(mediaDir(), `${app}.mp4`));

export function sendTutorialCaptions(res: Response, app: TutorialApp) {
  const f = path.join(mediaDir(), `${app}.vtt`);
  if (!existsSync(f)) throw notFound('Legenda');
  res.setHeader('Cache-Control', 'private, no-store');
  res.type('text/vtt; charset=utf-8').send(readFileSync(f, 'utf8'));
}

/** Envia o MP4 do tutorial (com Range). O acesso já deve ter sido checado por quem chama. */
export function sendTutorialVideo(req: Request, res: Response, app: TutorialApp) {
  const f = path.join(mediaDir(), `${app}.mp4`);
  if (!existsSync(f)) throw notFound('Vídeo');
  const size = statSync(f).size;
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Content-Disposition', 'inline');
  const range = req.headers.range;
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    let start = m && m[1] ? Number(m[1]) : NaN;
    let end = m && m[2] ? Number(m[2]) : NaN;
    if (m && !m[1] && m[2]) { start = Math.max(0, size - Number(m[2])); end = size - 1; } // sufixo: últimos N bytes
    if (Number.isNaN(end) || end >= size) end = size - 1;
    if (!m || Number.isNaN(start) || start > end || start >= size) {
      res.status(416).setHeader('Content-Range', `bytes */${size}`);
      return void res.end();
    }
    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
    res.setHeader('Content-Length', String(end - start + 1));
    if (req.method === 'HEAD') return void res.end();
    return void createReadStream(f, { start, end }).pipe(res);
  }
  res.setHeader('Content-Length', String(size));
  if (req.method === 'HEAD') return void res.end();
  createReadStream(f).pipe(res);
}
