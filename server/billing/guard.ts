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
