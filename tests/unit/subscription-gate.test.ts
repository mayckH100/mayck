import { describe, it, expect } from 'vitest';
import { GATE_APPS, decideGate, isExemptPath, routerPathFromHref, shouldInterceptClick } from '../../web/src/subscriptionGate';
import type { SubscriptionView } from '../../web/src/auth';

const sub = (product: 'MCKBOT' | 'MCKMENSAGEM', status: SubscriptionView['status'], source = 'MANUAL'): SubscriptionView => ({
  product, status, source, active: status === 'TRIAL' || status === 'ATIVA', cycle: 'MENSAL', validUntil: '2026-10-01T00:00:00.000Z',
});

describe('pop-up de renovação: quando aparece', () => {
  it('não aparece com assinatura ativa ou em teste', () => {
    expect(decideGate({ app: 'mckbot', role: 'OWNER', subscriptions: [sub('MCKBOT', 'ATIVA')] }).blocked).toBe(false);
    expect(decideGate({ app: 'mckbot', role: 'OWNER', subscriptions: [sub('MCKBOT', 'TRIAL', 'TRIAL')] }).blocked).toBe(false);
  });

  it('teste grátis vencido → "Seu teste grátis acabou"', () => {
    const d = decideGate({ app: 'mckbot', role: 'OWNER', subscriptions: [sub('MCKBOT', 'VENCIDA', 'TRIAL')] });
    expect(d.blocked).toBe(true);
    expect(d.variant).toBe('trial');
    expect(d.title).toBe('Seu teste grátis acabou');
    expect(d.message).toMatch(/robô, a IA/);
    expect(d.message).toMatch(/dados continuam guardados/);
    expect(d.canPay).toBe(true);
    expect(d.askOwner).toBe(false);
    expect(d.billingPath).toBe('/plano');
  });

  it('plano pago vencido → "Seu plano venceu"; bloqueada → "Conta bloqueada"', () => {
    expect(decideGate({ app: 'mckbot', role: 'OWNER', subscriptions: [sub('MCKBOT', 'VENCIDA', 'MP')] }).title).toBe('Seu plano venceu');
    expect(decideGate({ app: 'mckbot', role: 'OWNER', subscriptions: [sub('MCKBOT', 'BLOQUEADA', 'TRIAL')] }).title).toBe('Conta bloqueada');
  });

  it('olha só o produto do app em uso', () => {
    const subs = [sub('MCKBOT', 'ATIVA'), sub('MCKMENSAGEM', 'VENCIDA', 'TRIAL')];
    expect(decideGate({ app: 'mckbot', role: 'OWNER', subscriptions: subs }).blocked).toBe(false);
    const mm = decideGate({ app: 'mensagem', role: 'OWNER', subscriptions: subs });
    expect(mm.blocked).toBe(true);
    expect(mm.billingPath).toBe('/assinatura');
    expect(mm.message).toMatch(/campanhas/);
  });

  it('superadmin nunca vê', () => {
    expect(decideGate({ app: 'mckbot', role: 'OWNER', isSuperAdmin: true, subscriptions: [sub('MCKBOT', 'BLOQUEADA')] }).blocked).toBe(false);
    expect(decideGate({ app: 'mckbot', role: null, isSuperAdmin: true, paymentRequired: true }).blocked).toBe(false);
  });

  it('equipe vê "peça ao responsável"; sem acesso ao pagamento não tem botão', () => {
    const subsBot = [sub('MCKBOT', 'VENCIDA')];
    const admin = decideGate({ app: 'mckbot', role: 'ADMIN', subscriptions: subsBot });
    expect(admin.askOwner).toBe(true);
    expect(admin.canPay).toBe(true); // a tela Plano do MCKBOT abre para toda a equipe
    const subsMm = [sub('MCKMENSAGEM', 'VENCIDA')];
    expect(decideGate({ app: 'mensagem', role: 'ADMIN', subscriptions: subsMm }).canPay).toBe(true);
    const agent = decideGate({ app: 'mensagem', role: 'AGENT', subscriptions: subsMm });
    expect(agent.blocked).toBe(true);
    expect(agent.askOwner).toBe(true);
    expect(agent.canPay).toBe(false);
  });

  it('402 da API abre mesmo sem o status ter chegado; não abre se o produto está ativo', () => {
    expect(decideGate({ app: 'mckbot', role: 'OWNER', paymentRequired: true }).blocked).toBe(true);
    expect(decideGate({ app: 'mckbot', role: 'OWNER', paymentRequired: true }).variant).toBe('generic');
    expect(decideGate({ app: 'mckbot', role: 'OWNER', paymentRequired: true, subscriptions: [sub('MCKBOT', 'ATIVA')] }).blocked).toBe(false);
  });
});

describe('pop-up de renovação: cliques liberados', () => {
  const bot = GATE_APPS.mckbot, mm = GATE_APPS.mensagem;

  it('páginas de pagamento e perfil/senha são liberadas', () => {
    expect(isExemptPath(bot, '/plano')).toBe(true);
    expect(isExemptPath(bot, '/perfil/')).toBe(true);
    expect(isExemptPath(bot, '/master/clientes/1')).toBe(true);
    expect(isExemptPath(bot, '/inbox')).toBe(false);
    expect(isExemptPath(bot, '/planos-x')).toBe(false);
    expect(isExemptPath(mm, '/assinatura')).toBe(true);
    expect(isExemptPath(mm, '/seguranca')).toBe(true);
    expect(isExemptPath(mm, '/campanhas')).toBe(false);
  });

  it('href → caminho do roteador (com o prefixo /mensagem)', () => {
    expect(routerPathFromHref(bot, '/plano')).toBe('/plano');
    expect(routerPathFromHref(mm, '/mensagem/assinatura')).toBe('/assinatura');
    expect(routerPathFromHref(mm, '/mensagem')).toBe('/');
    expect(routerPathFromHref(mm, '/plano')).toBe(null); // outro app
    expect(routerPathFromHref(bot, 'https://outro.site/plano')).toBe(null);
    expect(routerPathFromHref(bot, '#x')).toBe(null);
  });

  it('decide quais cliques reabrem o pop-up', () => {
    expect(shouldInterceptClick(bot, { pathname: '/inbox' })).toBe(true);
    expect(shouldInterceptClick(bot, { pathname: '/inbox', insideModal: true })).toBe(false);
    expect(shouldInterceptClick(bot, { pathname: '/inbox', exemptMarker: true })).toBe(false);
    expect(shouldInterceptClick(bot, { pathname: '/inbox', label: 'Sair' })).toBe(false);
    expect(shouldInterceptClick(mm, { pathname: '/', label: 'Sair (Ana)' })).toBe(false);
    expect(shouldInterceptClick(bot, { pathname: '/inbox', label: 'Saiba mais' })).toBe(true);
    expect(shouldInterceptClick(bot, { pathname: '/inbox', href: '/plano' })).toBe(false);
    expect(shouldInterceptClick(bot, { pathname: '/inbox', href: '/perfil' })).toBe(false);
    expect(shouldInterceptClick(bot, { pathname: '/inbox', href: '/fluxos' })).toBe(true);
    expect(shouldInterceptClick(mm, { pathname: '/campanhas', href: '/mensagem/assinatura' })).toBe(false);
    expect(shouldInterceptClick(bot, { pathname: '/plano' })).toBe(false); // na página de pagamento nada é bloqueado
    expect(shouldInterceptClick(mm, { pathname: '/seguranca' })).toBe(false);
  });
});
