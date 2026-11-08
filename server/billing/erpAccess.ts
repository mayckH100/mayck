/**
 * v1.25.0 — Quem tem o MCK ERP (rotas /api/erp, alertas, relatório diário e a IA com a fonte 'erp'/'ambos'):
 *  - a empresa da própria MCK (isMckOrg), sempre;
 *  - quem tem um plano com o módulo "MCK ERP" marcado no Painel Master, ativo ou em teste
 *    (plano oculto/fora de venda: só quem já paga). Padrão: só o Plano Completo (COMBO), como na 1.17.0.
 * O superadmin é tratado nas rotas (req.auth.isSuperAdmin).
 */
import { erpPlanoDaEmpresa, getSettings } from './service.js';
import { erpPlanMessage } from './planCatalog.js';
import { isMckOrg } from '../sdr/access.js';

export async function erpLiberado(orgId: string, now = new Date()): Promise<boolean> {
  if (await erpPlanoDaEmpresa(orgId, now)) return true;
  return isMckOrg(orgId);
}

/** Aviso "o ERP faz parte do plano …" com os nomes dos planos à venda que incluem o ERP. */
export async function erpPlanoMsg(kind: 'erp' | 'ia' = 'erp'): Promise<string> {
  const { plans } = await getSettings();
  return erpPlanMessage(plans, kind);
}

/** Planos à venda com o ERP (para o botão de upgrade). */
export async function planosComErp(): Promise<{ id: string; name: string }[]> {
  const { plans } = await getSettings();
  return (Object.keys(plans) as (keyof typeof plans)[]).filter((c) => plans[c].modules.ERP && plans[c].visible).map((c) => ({ id: c, name: plans[c].name }));
}
