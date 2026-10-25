import { Router } from 'express';
import { prisma } from '../db.js';
import { ah } from '../lib/http.js';
import { orgOf } from '../auth/session.js';

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
  res.json({ current: org.plan, plans: PLANS, usage: { channels, members, flows }, billingConfigured: false });
}));
