import type { Request } from 'express';
import rateLimit from 'express-rate-limit';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { prisma } from '../db.js';
import { HttpError } from './http.js';

/**
 * Exclusão definitiva de itens CANCELADOS (agendamentos do MCK Mensagens e compromissos da Agenda).
 * Não existe "senha de exclusão" própria da organização: a confirmação usa a senha de login
 * do próprio usuário que pede a exclusão, conferida no servidor com o hash já existente.
 */

/** 5 tentativas com senha errada a cada 15 minutos, por usuário logado (acertos não contam). */
export const exclusaoLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req) => `del:${req.auth?.userId ?? req.ip}`,
  requestWasSuccessful: (_req, res) => res.statusCode !== 403,
  skipSuccessfulRequests: true,
  message: { error: 'Muitas tentativas de senha. Aguarde alguns minutos e tente novamente.' },
});

const senhaSchema = z.object({ senha: z.string().min(1, 'Informe sua senha para confirmar a exclusão').max(200) });

/** Lê a senha do corpo e confere com a do usuário logado. Senha errada = 403. */
export async function exigirSenhaExclusao(req: Request) {
  const { senha } = senhaSchema.parse(req.body ?? {});
  const u = await prisma.user.findUnique({ where: { id: req.auth!.userId }, select: { passwordHash: true } });
  if (!u || !(await bcrypt.compare(senha, u.passwordHash))) throw new HttpError(403, 'Senha incorreta. A exclusão não foi feita.');
}
