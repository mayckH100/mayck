import { describe, it, expect } from 'vitest';
import {
  DEFAULT_PLAN_CATALOG, parsePlanCatalog, validatePlanInput, applyPlanInput, planApps, erpBySubscriptions, erpPlanMessage, type PlanCatalog,
} from '../../server/billing/planCatalog.js';
import { effectiveStatus } from '../../server/billing/service.js';

/** v1.25.0 — Planos editáveis no Master: regras puras (padrão, validação, módulos e o ERP pelas assinaturas). */
const clone = (c: PlanCatalog): PlanCatalog => JSON.parse(JSON.stringify(c));
const DAY = 86_400_000;
const sub = (product: string, status: string, days = 30) => ({ product, status, validUntil: new Date(Date.now() + days * DAY) });
const eff = (s: { status: string; validUntil: Date }, n: Date) => effectiveStatus(s, n);

describe('catálogo de planos (v1.25.0)', () => {
  it('sem nada salvo, os planos são os de hoje (COMBO é o único com o ERP, todos à venda)', () => {
    for (const j of ['{}', '', null, 'lixo', '[]']) expect(parsePlanCatalog(j as any)).toEqual(DEFAULT_PLAN_CATALOG);
    expect(DEFAULT_PLAN_CATALOG.COMBO.name).toBe('Plano Completo: MCK ERP + MCKBOT + MCK Mensagens');
    expect(planApps(DEFAULT_PLAN_CATALOG.COMBO)).toEqual(['MCKBOT', 'MCKMENSAGEM']);
    expect(planApps(DEFAULT_PLAN_CATALOG.MCKBOT)).toEqual(['MCKBOT']);
  });

  it('JSON parcial completa com o padrão; plano sem app volta aos módulos padrão', () => {
    const c = parsePlanCatalog(JSON.stringify({ COMBO: { name: '  Combo  Zap ', visible: false, modules: { ERP: false } }, MCKBOT: { modules: { MCKBOT: false } } }));
    expect(c.COMBO).toMatchObject({ name: 'Combo Zap', visible: false, modules: { MCKBOT: true, MCKMENSAGEM: true, ERP: false } });
    expect(c.COMBO.desc).toBe(DEFAULT_PLAN_CATALOG.COMBO.desc);
    expect(c.MCKBOT.modules).toEqual(DEFAULT_PLAN_CATALOG.MCKBOT.modules);
  });

  it('validação: nome obrigatório, pelo menos um módulo e um app', () => {
    const cur = DEFAULT_PLAN_CATALOG.COMBO;
    expect(validatePlanInput('COMBO', cur, { name: '   ' })).toMatch(/nome/i);
    expect(validatePlanInput('COMBO', cur, { modules: { MCKBOT: false, MCKMENSAGEM: false, ERP: false } })).toMatch(/pelo menos um módulo/);
    expect(validatePlanInput('COMBO', cur, { modules: { MCKBOT: false, MCKMENSAGEM: false, ERP: true } })).toMatch(/MCKBOT ou o MCK Mensagens/);
    expect(validatePlanInput('COMBO', cur, { name: 'Combo', modules: { ERP: false } })).toBeNull();
    const next = applyPlanInput(cur, { name: 'Combo', features: [' a ', '', 'b'], modules: { ERP: false }, visible: false });
    expect(next).toMatchObject({ name: 'Combo', features: ['a', 'b'], modules: { MCKBOT: true, MCKMENSAGEM: true, ERP: false }, visible: false });
  });

  it('ERP pelas assinaturas segue os módulos; plano oculto só para quem paga', () => {
    const def = clone(DEFAULT_PLAN_CATALOG);
    expect(erpBySubscriptions(def, [sub('MCKBOT', 'TRIAL'), sub('MCKMENSAGEM', 'TRIAL')], eff)).toBe('COMBO');
    expect(erpBySubscriptions(def, [sub('MCKBOT', 'ATIVA'), sub('MCKMENSAGEM', 'ATIVA', -1)], eff)).toBeNull();
    const semErp = clone(def); semErp.COMBO.modules.ERP = false;
    expect(erpBySubscriptions(semErp, [sub('MCKBOT', 'ATIVA'), sub('MCKMENSAGEM', 'ATIVA')], eff)).toBeNull();
    const botComErp = clone(semErp); botComErp.MCKBOT.modules.ERP = true;
    expect(erpBySubscriptions(botComErp, [sub('MCKBOT', 'ATIVA')], eff)).toBe('MCKBOT');
    const oculto = clone(def); oculto.COMBO.visible = false;
    expect(erpBySubscriptions(oculto, [sub('MCKBOT', 'ATIVA'), sub('MCKMENSAGEM', 'ATIVA')], eff)).toBe('COMBO');
    expect(erpBySubscriptions(oculto, [sub('MCKBOT', 'TRIAL'), sub('MCKMENSAGEM', 'TRIAL')], eff)).toBeNull();
  });

  it('aviso do ERP usa os nomes dos planos à venda', () => {
    expect(erpPlanMessage(DEFAULT_PLAN_CATALOG)).toMatch(/^O MCK ERP faz parte do Plano Completo: MCK ERP/);
    const c = clone(DEFAULT_PLAN_CATALOG); c.COMBO.modules.ERP = false; c.MCKBOT.modules.ERP = true; c.MCKBOT.name = 'Empresarial';
    expect(erpPlanMessage(c)).toBe('O MCK ERP faz parte do plano Empresarial. Faça o upgrade para continuar usando.');
    expect(erpPlanMessage(c, 'ia')).toMatch(/plano Empresarial. Sem ele, a IA usa só os Produtos cadastrados/);
    c.MCKBOT.visible = false;
    expect(erpPlanMessage(c)).toMatch(/não está disponível/);
  });
});
