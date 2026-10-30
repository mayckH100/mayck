import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { ZodError } from 'zod';

export class HttpError extends Error {
  constructor(public status: number, message: string, public details?: unknown) {
    super(message);
  }
}

export const notFound = (what = 'Recurso') => new HttpError(404, `${what} não encontrado`);
export const forbidden = (msg = 'Você não tem permissão para esta ação') => new HttpError(403, msg);
export const badRequest = (msg: string, details?: unknown) => new HttpError(400, msg, details);

export function ah(fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof ZodError) {
    return res.status(400).json({ error: 'Dados inválidos', details: err.flatten() });
  }
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: err.message, details: err.details });
  }
  // Erros do leitor de corpo (JSON malformado, corpo grande demais): 4xx claro, nunca 500.
  const e = err as { status?: number; statusCode?: number; type?: string; expose?: boolean };
  const st = e?.status ?? e?.statusCode;
  if (typeof st === 'number' && st >= 400 && st < 500 && (e.type || e.expose)) {
    const msg = st === 413 ? 'Conteúdo grande demais' : e.type === 'entity.parse.failed' ? 'JSON inválido' : 'Requisição inválida';
    return res.status(st).json({ error: msg });
  }
  console.error('[erro]', safeErrorForLog(err));
  return res.status(500).json({ error: 'Erro interno do servidor' });
}

/**
 * Versão do erro segura para o log: erros do Prisma imprimem os argumentos da consulta (podem conter hash de senha,
 * tokens, telefones), então deles só saem nome, código e alvo. Demais erros: mensagem curta + pilha.
 */
export function safeErrorForLog(err: unknown): string {
  if (!err || typeof err !== 'object') return String(err).slice(0, 500);
  const x = err as { name?: string; code?: string; meta?: { target?: unknown; modelName?: unknown }; message?: string; stack?: string };
  if (typeof x.name === 'string' && x.name.startsWith('PrismaClient')) {
    return `${x.name}${x.code ? ` ${x.code}` : ''}${x.meta?.modelName ? ` modelo=${String(x.meta.modelName)}` : ''}${x.meta?.target ? ` alvo=${JSON.stringify(x.meta.target)}` : ''}`;
  }
  const stack = (x.stack || '').split('\n').slice(1, 6).join('\n');
  return `${x.name ?? 'Error'}: ${String(x.message ?? '').slice(0, 300)}${stack ? `\n${stack}` : ''}`;
}
