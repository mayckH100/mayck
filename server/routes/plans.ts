import { Router } from 'express';
import { prisma } from '../db.js';
import { ah } from '../lib/http.js';
import { orgOf } from '../auth/session.js';
import { billingConfigured } from '../billing/mercadopago.js';
import { getSettings, PLAN_PRODUCTS, type PlanProduct } from '../billing/service.js';

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
 * Vitrine pública (sem login), só leitura: mesmos preços e período de teste que o Master edita
 * em Configurações da plataforma (PlatformSettings via getSettings()).
 */
export const PUBLIC_PLAN_INFO: Record<PlanProduct, { label: string; desc: string; features: string[] }> = {
  MCKBOT: { label: 'MCKBOT', desc: 'Atendimento automatizado no WhatsApp com fluxos e IA.', features: ['Conexão por QR code ou Cloud API', 'Fluxos e automações', 'Inbox e Kanban', 'IA com a sua própria chave'] },
  MCKMENSAGEM: { label: 'MCK Mensagens', desc: 'Campanhas no WhatsApp para contatos com consentimento.', features: ['Contatos com origem do consentimento', 'Mensagens personalizadas com {nome}', 'Limites seguros e janela de horário', 'Opt-out automático'] },
  COMBO: { label: 'Combo MCKBOT + MCK Mensagens', desc: 'Os dois apps juntos, com desconto. Renova os dois de uma vez.', features: ['Tudo do MCKBOT', 'Tudo do MCK Mensagens', 'Uma só cobrança'] },
};

export const publicPlansRouter = Router();
publicPlansRouter.get('/', ah(async (_req, res) => {
  const { prices, trialDays } = await getSettings();
  res.set('Cache-Control', 'public, max-age=300');
  res.json({
    trialDays,
    currency: 'BRL',
    plans: PLAN_PRODUCTS.map((id) => ({
      id, ...PUBLIC_PLAN_INFO[id],
      prices: { MENSAL: prices[id].MENSAL, ANUAL: prices[id].ANUAL },
      annualSavings: Math.max(0, prices[id].MENSAL * 12 - prices[id].ANUAL),
    })),
  });
}));
