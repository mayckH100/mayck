import { Router } from 'express';
import { prisma } from '../db.js';
import { ah } from '../lib/http.js';
import { orgOf } from '../auth/session.js';
import { billingConfigured } from '../billing/mercadopago.js';
import { getSettings, PLAN_PRODUCTS, type PlanProduct } from '../billing/service.js';
import { DEFAULT_PLAN_CATALOG, planModules } from '../billing/planCatalog.js';
import { INTRO_CYCLE, INTRO_PLAN, publicIntroOffer } from '../billing/introOffer.js';

/**
 * Planos do MCKBOT. Não há cobrança integrada: a troca de plano depende de
 * configurar um meio de pagamento (pendência documentada em docs/DEPLOY.md).
 */
export const PLANS = [
  { id: 'gratis', name: 'Grátis', priceLabel: 'R$ 0', features: ['1 número WhatsApp (Cloud API)', 'Fluxos e automações', 'Inbox e Kanban', 'IA com sua própria chave', 'Até 3 membros'], limits: { channels: 1, members: 3, flows: 10 } },
  { id: 'profissional', name: 'Profissional', priceLabel: 'A definir', features: ['Até 3 números', 'Fluxos ilimitados', 'Relatórios completos', 'Até 10 membros'], limits: { channels: 3, members: 10, flows: 1000 } },
];

export const plansRouter = Router();
plansRouter.get('/', ah(async (req, res) => {
  const orgId = orgOf(req);
  const org = await prisma.organization.findUniqueOrThrow({ where: { id: orgId } });
  const [channels, members, flows] = await Promise.all([
    prisma.channel.count({ where: { orgId } }), prisma.membership.count({ where: { orgId } }), prisma.flow.count({ where: { orgId } }),
  ]);
  res.json({ current: org.plan, plans: PLANS, usage: { channels, members, flows }, billingConfigured: billingConfigured() });
}));

/**
 * Vitrine pública (sem login), só leitura: nomes, descrições, itens, módulos e "visível para venda" editados no
 * Master (v1.25.0, PlatformSettings.plansJson) + os mesmos preços e período de teste (PlatformSettings via getSettings()).
 * Plano oculto não aparece aqui (site /empresa, cadastro e vitrine do app leem este endpoint).
 */
/** Textos padrão (fallback); os exibidos vêm do Master. */
export const PUBLIC_PLAN_INFO: Record<PlanProduct, { label: string; desc: string; features: string[] }> = Object.fromEntries(
  PLAN_PRODUCTS.map((id) => [id, { label: DEFAULT_PLAN_CATALOG[id].name, desc: DEFAULT_PLAN_CATALOG[id].desc, features: DEFAULT_PLAN_CATALOG[id].features }]),
) as Record<PlanProduct, { label: string; desc: string; features: string[] }>;

export async function publicPlanList() {
  const { prices, plans, trialDays, introOffer } = await getSettings();
  const intro = plans[INTRO_PLAN].visible ? publicIntroOffer(introOffer, prices[INTRO_PLAN][INTRO_CYCLE]) : null;
  return {
    trialDays,
    currency: 'BRL',
    // v1.27.0: promoção de entrada do Plano Completo ("R$ 58/mês nos 2 primeiros meses, depois R$ 100/mês"), só cliente nova.
    introOffer: intro,
    plans: PLAN_PRODUCTS.filter((id) => plans[id].visible).map((id) => ({
      id, label: plans[id].name, desc: plans[id].desc, features: plans[id].features, modules: planModules(plans[id]),
      prices: { MENSAL: prices[id].MENSAL, ANUAL: prices[id].ANUAL },
      annualSavings: Math.max(0, prices[id].MENSAL * 12 - prices[id].ANUAL),
      ...(id === INTRO_PLAN && intro ? { introOffer: intro } : {}),
    })),
  };
}

export const publicPlansRouter = Router();
publicPlansRouter.get('/', ah(async (_req, res) => {
  res.set('Cache-Control', 'public, max-age=300');
  res.json(await publicPlanList());
}));
