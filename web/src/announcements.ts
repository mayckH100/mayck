// Regras (funções puras, sem React/DOM) do pop-up de Avisos do Painel Master.
// Testadas em tests/unit/avisos.test.ts.
import type { Role, SubscriptionView } from './auth';
import { GATE_APPS, decideGate, isExemptPath, type GateApp } from './subscriptionGate';

export interface ActiveAnnouncement {
  id: string; title: string | null; body: string | null; linkUrl: string | null; linkLabel: string | null; imageUrl: string | null; day: string;
}

/** Dia (AAAA-MM-DD) em São Paulo: o aviso fechado só volta no dia seguinte. */
export function dayKeySP(d = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

/** Chave do localStorage (reserva, caso a API falhe ao registrar o fechamento). */
export const localDismissKey = (userId: string, id: string, day: string) => `mck:aviso:${userId}:${id}:${day}`;

export interface HoldInput {
  app: GateApp;
  pathname: string;
  hasOrg: boolean;
  role?: Role | null;
  isSuperAdmin?: boolean;
  subscriptions?: SubscriptionView[] | null;
  /** Alguma chamada respondeu 402 (o pop-up de renovação abre). */
  paymentRequired?: boolean;
}

/**
 * Os avisos devem esperar? Sim quando: sem organização; superadmin no Painel Master; ou o pop-up de renovação
 * está ativo nesta tela (ele tem prioridade). Nas páginas liberadas (pagamento, perfil) o aviso pode aparecer.
 */
export function shouldHoldAnnouncements(i: HoldInput): boolean {
  if (!i.hasOrg) return true;
  const p = (i.pathname || '/').replace(/\/+$/, '') || '/';
  if (i.app === 'mckbot' && (p === '/master' || p.startsWith('/master/'))) return true;
  const cfg = GATE_APPS[i.app];
  const gate = decideGate({ app: i.app, subscriptions: i.subscriptions, role: i.role, isSuperAdmin: i.isSuperAdmin, paymentRequired: i.paymentRequired });
  return gate.blocked && !isExemptPath(cfg, p);
}

/** Link interno (/plano) ou externo https: externo abre em nova aba. */
export const isExternalLink = (href: string) => /^https:\/\//i.test(href);
