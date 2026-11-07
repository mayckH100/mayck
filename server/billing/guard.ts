import type { Request, Response, NextFunction } from 'express';
import { orgOf } from '../auth/session.js';
import { isProductActive } from './service.js';

/** MCKBOT vencido/bloqueado: leitura continua liberada, escrita responde 402 (o app mostra o aviso para renovar). */
export function requireMckbotForWrites(req: Request, res: Response, next: NextFunction) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  isProductActive(orgOf(req), 'MCKBOT')
    .then((ok) => (ok ? next() : res.status(402).json({ error: 'Assinatura MCKBOT inativa. Renove o plano para continuar.' })))
    .catch(next);
}

/**
 * MCK ERP: não tem assinatura própria (vem no Plano Completo). Sem nenhum produto ativo (teste ou pago),
 * a leitura continua liberada e a escrita responde 402 — antes o ERP seguia funcionando de graça
 * depois que o teste/plano vencia.
 */
export function requireAnyProductForWrites(req: Request, res: Response, next: NextFunction) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  const orgId = orgOf(req);
  Promise.all([isProductActive(orgId, 'MCKBOT'), isProductActive(orgId, 'MCKMENSAGEM')])
    .then(([a, b]) => (a || b ? next() : res.status(402).json({ error: 'Assinatura inativa. Renove o plano para continuar usando o MCK ERP.' })))
    .catch(next);
}
