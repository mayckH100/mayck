// Regras (funções puras, sem React/DOM) do pop-up "renove sua assinatura".
// Testadas em tests/unit/subscription-gate.test.ts.
import type { Role, SubStatus, SubscriptionView } from './auth';

export type GateApp = 'mckbot' | 'mensagem';
export type GateVariant = 'trial' | 'expired' | 'blocked' | 'generic';

export interface GateAppConfig {
  app: GateApp;
  product: 'MCKBOT' | 'MCKMENSAGEM';
  productName: string;
  /** Prefixo do roteador no navegador ("" no MCKBOT, "/mensagem" no MCK Mensagens). */
  base: string;
  /** Página de planos/pagamento do app (caminho do roteador, sem o prefixo). */
  billingPath: string;
  /** Páginas (caminho do roteador) onde o clique nunca é bloqueado: pagamento, perfil/senha, Master. */
  exemptPaths: string[];
  /** Papéis que conseguem abrir a página de pagamento neste app. */
  billingRoles: Role[];
}

export const GATE_APPS: Record<GateApp, GateAppConfig> = {
  mckbot: {
    app: 'mckbot', product: 'MCKBOT', productName: 'MCKBOT', base: '', billingPath: '/plano',
    exemptPaths: ['/plano', '/assinatura', '/perfil', '/master', '/redefinir-senha', '/verificar-email', '/convite'],
    billingRoles: ['OWNER', 'ADMIN', 'AGENT'], // a tela Plano aparece para toda a equipe no MCKBOT
  },
  mensagem: {
    app: 'mensagem', product: 'MCKMENSAGEM', productName: 'MCK Mensagens', base: '/mensagem', billingPath: '/assinatura',
    exemptPaths: ['/assinatura', '/plano', '/seguranca', '/redefinir-senha', '/verificar-email'],
    billingRoles: ['OWNER', 'ADMIN'], // atendente (AGENT) não acessa a Assinatura do MCK Mensagens
  },
};

export const isInactiveStatus = (s?: SubStatus | null) => s === 'VENCIDA' || s === 'BLOQUEADA';

/** O caminho (do roteador) é de uma página liberada? */
export function isExemptPath(cfg: GateAppConfig, pathname: string): boolean {
  const p = (pathname || '/').replace(/\/+$/, '') || '/';
  return cfg.exemptPaths.some((e) => p === e || p.startsWith(`${e}/`));
}

/** Converte o href de um link (absoluto ou relativo) no caminho do roteador do app, ou null se for de outro app/site. */
export function routerPathFromHref(cfg: GateAppConfig, href: string | null | undefined, origin = 'http://x'): string | null {
  if (!href || href.startsWith('#') || /^(mailto|tel|javascript):/i.test(href)) return null;
  let u: URL;
  try { u = new URL(href, `${origin}${cfg.base}/`); } catch { return null; }
  if (u.origin !== new URL(origin).origin) return null;
  if (!cfg.base) return u.pathname;
  if (u.pathname === cfg.base) return '/';
  return u.pathname.startsWith(`${cfg.base}/`) ? u.pathname.slice(cfg.base.length) : null;
}

export interface GateInput {
  app: GateApp;
  subscriptions?: SubscriptionView[] | null;
  role?: Role | null;
  isSuperAdmin?: boolean;
  /** Alguma chamada da API respondeu 402 nesta sessão. */
  paymentRequired?: boolean;
}

export interface GateDecision {
  /** O app está bloqueado para escrita e o pop-up deve aparecer. */
  blocked: boolean;
  variant: GateVariant;
  title: string;
  message: string;
  /** Pode pagar: mostra "Renovar agora". */
  canPay: boolean;
  /** Não é o titular: mostra "Peça ao responsável da conta para renovar". */
  askOwner: boolean;
  billingPath: string;
}

export function decideGate(input: GateInput): GateDecision {
  const cfg = GATE_APPS[input.app];
  const sub = input.subscriptions?.find((s) => s.product === cfg.product);
  const inactive = !!sub && isInactiveStatus(sub.status);
  const blocked = !input.isSuperAdmin && !!input.role && (inactive || (!!input.paymentRequired && !(sub && sub.active)));
  let variant: GateVariant = 'generic';
  if (inactive && sub) variant = sub.status === 'BLOQUEADA' ? 'blocked' : sub.source === 'TRIAL' ? 'trial' : 'expired';
  const paused = cfg.app === 'mckbot'
    ? 'O robô, a IA e os fluxos automáticos estão pausados.'
    : 'As campanhas, os disparos e a qualificação do SDR com IA estão pausados.';
  const kept = 'Seus dados continuam guardados: você ainda pode consultar e exportar tudo.';
  const titles: Record<GateVariant, string> = {
    trial: 'Seu teste grátis acabou',
    expired: 'Seu plano venceu',
    blocked: 'Conta bloqueada',
    generic: 'Assinatura inativa',
  };
  const leads: Record<GateVariant, string> = {
    trial: `O período de teste grátis do ${cfg.productName} terminou.`,
    expired: `A assinatura do ${cfg.productName} venceu.`,
    blocked: `A assinatura do ${cfg.productName} está bloqueada.`,
    generic: `A assinatura do ${cfg.productName} está inativa.`,
  };
  const owner = input.role === 'OWNER';
  const canPay = !!input.role && cfg.billingRoles.includes(input.role);
  // Quem não é o titular vê "Peça ao responsável da conta para renovar." à parte (askOwner).
  const action = !owner ? '' : variant === 'blocked' ? 'Regularize a assinatura para voltar a usar tudo.' : 'Renove para voltar a usar tudo.';
  return {
    blocked,
    variant,
    title: titles[variant],
    message: `${leads[variant]} ${paused} ${kept} ${action}`.trim(),
    canPay,
    askOwner: !owner,
    billingPath: cfg.billingPath,
  };
}

export interface ClickInfo {
  /** Caminho atual do roteador (useLocation().pathname). */
  pathname: string;
  /** O clique foi dentro do pop-up. */
  insideModal?: boolean;
  /** O alvo (ou um ancestral) está marcado como liberado: Sair, menu, etc. */
  exemptMarker?: boolean;
  /** href do link clicado, se houver. */
  href?: string | null;
  /** Texto do botão/link clicado (para reconhecer "Sair"). */
  label?: string | null;
}

/** Este clique deve reabrir o pop-up (e ser bloqueado)? */
export function shouldInterceptClick(cfg: GateAppConfig, c: ClickInfo, origin?: string): boolean {
  if (c.insideModal || c.exemptMarker) return false;
  if (isExemptPath(cfg, c.pathname)) return false;
  if (c.label && /^\s*sair\b/i.test(c.label)) return false;
  const target = routerPathFromHref(cfg, c.href, origin);
  if (target && isExemptPath(cfg, target)) return false;
  return true;
}
