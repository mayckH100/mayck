import { Router } from 'express';
import { prisma } from '../db.js';
import { ah, forbidden, notFound } from '../lib/http.js';
import { getSiteSettings } from '../lib/site-settings.js';
import { CODE_RE, confirmedUses, couponAvailability, normalizeCode, publicCouponView } from '../billing/coupons.js';
import { TUTORIAL_APPS, isApp, meta, sendTutorialCaptions, sendTutorialVideo, tutorialAvailable } from '../tutorials/routes.js';

/**
 * API pública (sem login, só leitura) do site oficial /empresa.
 * Os dados vêm do Painel Master > Configurações > Site oficial.
 */
export const publicSiteRouter = Router();

/** Promoção em destaque: só aparece se o cupom existir e estiver válido agora (ativo, no prazo, com usos). */
async function activePromo(code: string, text: string) {
  const norm = normalizeCode(code);
  if (!norm || !CODE_RE.test(norm)) return null;
  const c = await prisma.coupon.findUnique({ where: { code: norm } });
  if (!c) return null;
  if (couponAvailability(c, await confirmedUses(c.id))) return null;
  return { code: c.code, text, coupon: publicCouponView(c) };
}

publicSiteRouter.get('/', ah(async (_req, res) => {
  const s = await getSiteSettings();
  const wa = s.whatsapp.replace(/\D/g, '');
  res.set('Cache-Control', 'public, max-age=60');
  res.json({
    contactEmail: s.contactEmail,
    whatsapp: wa || null,
    whatsappUrl: wa ? `https://wa.me/${wa}` : null,
    facebookUrl: s.facebookUrl,
    tutorialsPublic: s.tutorialsPublic,
    tutorials: s.tutorialsPublic
      ? Object.keys(TUTORIAL_APPS).filter((a) => isApp(a) && tutorialAvailable(a)).map((a) => {
        const m = isApp(a) ? meta(a) : null;
        return { app: a, title: m?.title ?? null, duration: m?.duration ?? null, video: `/api/public/site/tutorials/${a}/video`, captions: `/api/public/site/tutorials/${a}/captions.vtt` };
      })
      : [],
    promo: s.promoCoupon ? await activePromo(s.promoCoupon, s.promoText) : null,
  });
}));

/** Tutoriais completos no site: só quando o Master liga "tutoriais completos públicos no site". */
async function publicTutorial(appParam: string) {
  if (!isApp(appParam)) throw notFound('Tutorial');
  if (!(await getSiteSettings()).tutorialsPublic) throw forbidden('Disponível para assinantes');
  return appParam;
}
publicSiteRouter.get('/tutorials/:app/video', ah(async (req, res) => sendTutorialVideo(req, res, await publicTutorial(String(req.params.app)))));
publicSiteRouter.get('/tutorials/:app/captions.vtt', ah(async (req, res) => sendTutorialCaptions(res, await publicTutorial(String(req.params.app)))));
