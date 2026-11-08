/**
 * v1.25.0 — Planos editáveis pelo Painel Master (Configurações › Planos e preços).
 *
 * Os CÓDIGOS dos planos (MCKBOT, MCKMENSAGEM, COMBO) nunca mudam: assinaturas, pagamentos do Mercado Pago, cupons e
 * eventos de cobrança continuam apontando para eles. O que o Master edita é o que cada código É:
 *  - nome exibido, descrição curta e itens do "o que está incluso";
 *  - módulos que o plano libera (MCKBOT, MCK Mensagens, MCK ERP);
 *  - "visível para venda": plano oculto não aparece no site, na vitrine nem no checkout de clientes novos, mas quem
 *    já é assinante continua com o acesso e pode renovar no mesmo plano.
 * Preços continuam em PlatformSettings.pricesJson (mesma regra de antes). Este arquivo é puro (sem banco).
 */

export const PLAN_CODES = ['MCKBOT', 'MCKMENSAGEM', 'COMBO'] as const;
export type PlanCode = (typeof PLAN_CODES)[number];
/** Assinaturas existem por app; o ERP não tem assinatura própria: vem de um plano que o inclui. */
export const APP_PRODUCTS = ['MCKBOT', 'MCKMENSAGEM'] as const;
export type AppProduct = (typeof APP_PRODUCTS)[number];

export const PLAN_MODULES = ['MCKBOT', 'MCKMENSAGEM', 'ERP'] as const;
export type PlanModule = (typeof PLAN_MODULES)[number];
export const MODULE_LABEL: Record<PlanModule, string> = { MCKBOT: 'MCKBOT', MCKMENSAGEM: 'MCK Mensagens', ERP: 'MCK ERP' };

export interface PlanConfig {
  name: string;
  desc: string;
  features: string[];
  modules: Record<PlanModule, boolean>;
  visible: boolean;
}
export type PlanCatalog = Record<PlanCode, PlanConfig>;

export const PLAN_LIMITS = { name: 80, desc: 300, features: 12, feature: 140 } as const;

/** Valores de hoje (v1.24.0): os mesmos textos da vitrine pública e o COMBO como único plano com o ERP. */
export const DEFAULT_PLAN_CATALOG: PlanCatalog = {
  MCKBOT: {
    name: 'MCKBOT',
    desc: 'Atendimento automatizado no WhatsApp com fluxos e IA.',
    features: ['Conexão por QR code ou Cloud API', 'Fluxos e automações', 'Inbox e Kanban', 'IA com a sua própria chave'],
    modules: { MCKBOT: true, MCKMENSAGEM: false, ERP: false },
    visible: true,
  },
  MCKMENSAGEM: {
    name: 'MCK Mensagens',
    desc: 'Campanhas no WhatsApp para contatos com consentimento.',
    features: ['Contatos com origem do consentimento', 'Mensagens personalizadas com {nome}', 'Limites seguros e janela de horário', 'Opt-out automático'],
    modules: { MCKBOT: false, MCKMENSAGEM: true, ERP: false },
    visible: true,
  },
  COMBO: {
    name: 'Plano Completo: MCK ERP + MCKBOT + MCK Mensagens',
    desc: 'Tudo incluso: ERP, atendimento no WhatsApp e campanhas. Uma só cobrança. O MCK ERP só vem neste plano.',
    features: ['MCK ERP: vendas, estoque, compras, financeiro, fiscal e BI', 'SDR com IA: pré-vendas automática (qualifica, acompanha e marca reuniões)', 'Tudo do MCKBOT', 'Tudo do MCK Mensagens', 'Uma só cobrança'],
    modules: { MCKBOT: true, MCKMENSAGEM: true, ERP: true },
    visible: true,
  },
};

export const isPlanCode = (v: unknown): v is PlanCode => typeof v === 'string' && (PLAN_CODES as readonly string[]).includes(v);

const clean = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');

/** Lê o JSON salvo, completando com o padrão (campo ausente ou inválido = valor de hoje). Nunca lança. */
export function parsePlanCatalog(json: string | null | undefined): PlanCatalog {
  let raw: any = {};
  try { raw = json ? JSON.parse(json) : {}; } catch { raw = {}; }
  if (!raw || typeof raw !== 'object') raw = {};
  const out = {} as PlanCatalog;
  for (const code of PLAN_CODES) {
    const d = DEFAULT_PLAN_CATALOG[code];
    const r = raw[code] && typeof raw[code] === 'object' ? raw[code] : {};
    const modules = { ...d.modules };
    if (r.modules && typeof r.modules === 'object') for (const m of PLAN_MODULES) if (typeof r.modules[m] === 'boolean') modules[m] = r.modules[m];
    const features = Array.isArray(r.features) ? r.features.map((f: unknown) => clean(f, PLAN_LIMITS.feature)).filter(Boolean).slice(0, PLAN_LIMITS.features) : d.features;
    out[code] = {
      name: clean(r.name, PLAN_LIMITS.name) || d.name,
      desc: typeof r.desc === 'string' ? clean(r.desc, PLAN_LIMITS.desc) : d.desc,
      features,
      // Plano sem nenhum app não teria assinatura para renovar: volta ao padrão.
      modules: modules.MCKBOT || modules.MCKMENSAGEM ? modules : { ...d.modules },
      visible: typeof r.visible === 'boolean' ? r.visible : d.visible,
    };
  }
  return out;
}

export type PlanInput = Partial<{ name: string; desc: string; features: string[]; modules: Partial<Record<PlanModule, boolean>>; visible: boolean }>;

/** Erro de validação legível (vai para o Master como 400). */
export function validatePlanInput(code: PlanCode, cur: PlanConfig, input: PlanInput): string | null {
  const name = input.name !== undefined ? clean(input.name, 1000) : cur.name;
  if (!name) return `Informe o nome do plano ${cur.name || code}.`;
  if (name.length > PLAN_LIMITS.name) return `O nome do plano pode ter até ${PLAN_LIMITS.name} caracteres.`;
  const modules = { ...cur.modules, ...(input.modules ?? {}) };
  if (!PLAN_MODULES.some((m) => modules[m])) return `Escolha pelo menos um módulo para o plano ${name}.`;
  if (!modules.MCKBOT && !modules.MCKMENSAGEM) return `O plano ${name} precisa incluir o MCKBOT ou o MCK Mensagens (a assinatura é por app; o MCK ERP vem junto com um deles).`;
  return null;
}

/** Aplica a edição (já validada) sobre o plano atual. */
export function applyPlanInput(cur: PlanConfig, input: PlanInput): PlanConfig {
  return {
    name: input.name !== undefined ? clean(input.name, PLAN_LIMITS.name) : cur.name,
    desc: input.desc !== undefined ? clean(input.desc, PLAN_LIMITS.desc) : cur.desc,
    features: input.features !== undefined ? input.features.map((f) => clean(f, PLAN_LIMITS.feature)).filter(Boolean).slice(0, PLAN_LIMITS.features) : cur.features,
    modules: { ...cur.modules, ...(input.modules ?? {}) },
    visible: input.visible !== undefined ? input.visible : cur.visible,
  };
}

/** Assinaturas (apps) que o plano renova: os módulos MCKBOT / MCK Mensagens marcados. */
export const planApps = (cfg: PlanConfig): AppProduct[] => APP_PRODUCTS.filter((p) => cfg.modules[p]);
export const planModules = (cfg: PlanConfig): PlanModule[] => PLAN_MODULES.filter((m) => cfg.modules[m]);
export const planIncludes = (cfg: PlanConfig, m: PlanModule) => !!cfg.modules[m];

type SubLike = { product: string; status: string; validUntil: Date };
type Eff = (s: SubLike, now: Date) => string;

/**
 * Puro: o ERP está liberado pelas assinaturas? Algum plano com o módulo ERP tem todas as suas assinaturas:
 *  - plano visível: ativas ou em teste (como era o Plano Completo);
 *  - plano oculto (fora de venda): só pagas (ATIVA) — quem já é assinante continua; teste novo não ganha o ERP.
 */
export function erpBySubscriptions(catalog: PlanCatalog, subs: SubLike[], effective: Eff, now = new Date()): PlanCode | null {
  for (const code of PLAN_CODES) {
    const cfg = catalog[code];
    if (!cfg.modules.ERP) continue;
    const apps = planApps(cfg);
    if (!apps.length) continue;
    const ok = apps.every((p) => {
      const s = subs.find((x) => x.product === p);
      if (!s) return false;
      const st = effective(s, now);
      return cfg.visible ? st === 'TRIAL' || st === 'ATIVA' : st === 'ATIVA';
    });
    if (ok) return code;
  }
  return null;
}

/** Texto do aviso "o ERP faz parte do plano X" conforme os planos à venda. */
export function erpPlanMessage(catalog: PlanCatalog, kind: 'erp' | 'ia' = 'erp'): string {
  // "do Plano Completo: …" / "do plano Empresarial"
  const names = PLAN_CODES.filter((c) => catalog[c].modules.ERP && catalog[c].visible).map((c) => (/^plano\b/i.test(catalog[c].name) ? catalog[c].name : `plano ${catalog[c].name}`));
  if (kind === 'ia') {
    return names.length
      ? `O estoque do MCK ERP faz parte do ${names.join(' ou do ')}. Sem ele, a IA usa só os Produtos cadastrados.`
      : 'O estoque do MCK ERP não está disponível no seu plano. A IA usa só os Produtos cadastrados.';
  }
  return names.length
    ? `O MCK ERP faz parte do ${names.join(' ou do ')}. Faça o upgrade para continuar usando.`
    : 'O MCK ERP não está disponível no seu plano no momento. Fale com o suporte.';
}
