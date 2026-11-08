import type { Request, Response, NextFunction } from 'express';
import { orgOf } from '../auth/session.js';
import { isProductActive } from './service.js';
import { erpLiberado, erpPlanoMsg } from './erpAccess.js';

/** MCKBOT vencido/bloqueado: leitura continua liberada, escrita responde 402 (o app mostra o aviso para renovar). */
export function requireMckbotForWrites(req: Request, res: Response, next: NextFunction) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  isProductActive(orgOf(req), 'MCKBOT')
    .then((ok) => (ok ? next() : res.status(402).json({ error: 'Assinatura MCKBOT inativa. Renove o plano para continuar.' })))
    .catch(next);
}

/** Código da resposta 402 do ERP: o app mostra "O ERP faz parte do Plano Completo" (e não o pop-up de renovação). */
export const ERP_PLANO_COMPLETO = 'ERP_PLANO_COMPLETO';
/** Texto padrão (planos de fábrica). O aviso enviado usa os planos do Master: erpPlanoMsg() (v1.25.0). */
export const ERP_PLANO_COMPLETO_MSG = 'O MCK ERP faz parte do Plano Completo (ERP + MCKBOT + MCK Mensagens). Faça o upgrade para continuar usando.';

/**
 * Leitura liberada mesmo sem Plano Completo (caminhos relativos a /api/erp): saber se o ERP está liberado e
 * exportar/baixar os próprios dados já lançados (planilhas, CSV, NF-e emitidas), para não prender os dados do cliente.
 */
const ERP_LIVRE_SEM_PLANO: RegExp[] = [
  /^\/acesso\/?$/,
  /^\/io\/(clientes|fornecedores|produtos)\/exportar\/?$/,
  /^\/bi\/exportar\/?$/,
  /^\/relatorios\/dia\.csv$/,
  /^\/fiscal\/nfe\/?$/,
  /^\/fiscal\/nfe\/[^/]+\/(xml|danfe)\/?$/,
];
export const erpLivreSemPlano = (method: string, path: string) =>
  (method === 'GET' || method === 'HEAD') && ERP_LIVRE_SEM_PLANO.some((r) => r.test(path));

/**
 * MCK ERP (v1.17.0): só com o Plano Completo ativo ou em teste. Sem ele, leitura E escrita respondem 402
 * (code ERP_PLANO_COMPLETO), exceto exportar/baixar os próprios dados. Superadmin (Master) não é afetado.
 * Antes (v1.16.1) bastava MCKBOT ou MCK Mensagens ativo.
 */
export function requirePlanoCompletoErp(req: Request, res: Response, next: NextFunction) {
  if (req.method === 'OPTIONS' || req.auth?.isSuperAdmin) return next();
  if (erpLivreSemPlano(req.method, req.path)) return next();
  // v1.25.0: segue os módulos dos planos no Master (padrão: Plano Completo); a empresa da MCK sempre tem.
  erpLiberado(orgOf(req))
    .then(async (ok) => (ok ? next() : res.status(402).json({ error: await erpPlanoMsg(), code: ERP_PLANO_COMPLETO })))
    .catch(next);
}
