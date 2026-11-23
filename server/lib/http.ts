import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { z, ZodError } from 'zod';

/**
 * v1.46.0: mensagens de validação em português simples (antes vinham do zod em inglês, ex.: "Too small: expected string…").
 * Só vale quando o esquema não tem mensagem própria.
 */
z.config({
  customError: (iss: any) => {
    const n = Number(iss.minimum ?? iss.maximum);
    switch (iss.code) {
      case 'too_small':
        if (iss.origin === 'string') return n <= 1 ? 'obrigatório' : `mínimo de ${n} caracteres`;
        if (iss.origin === 'array' || iss.origin === 'set') return `escolha pelo menos ${n}`;
        return `o mínimo é ${n}`;
      case 'too_big':
        if (iss.origin === 'string') return `máximo de ${n} caracteres`;
        if (iss.origin === 'array' || iss.origin === 'set') return `no máximo ${n} itens`;
        return `o máximo é ${n}`;
      case 'invalid_type': return iss.input === undefined || iss.input === null ? 'obrigatório' : 'valor inválido';
      case 'invalid_format':
        if (iss.format === 'email') return 'e-mail inválido';
        if (iss.format === 'url') return 'endereço (link) inválido';
        return 'formato inválido';
      case 'invalid_value': return 'opção inválida';
      default: return 'valor inválido';
    }
  },
});

/** Nome do campo para a mensagem de erro (o que o usuário vê na tela). */
const ROTULOS: Record<string, string> = {
  name: 'Nome', nome: 'Nome', email: 'E-mail', phone: 'Telefone', telefone: 'Telefone', whatsapp: 'WhatsApp', password: 'Senha', senha: 'Senha',
  title: 'Título', titulo: 'Título', text: 'Texto', texto: 'Texto', body: 'Mensagem', message: 'Mensagem', description: 'Descrição', descricao: 'Descrição',
  instructions: 'Instruções', tone: 'Tom de voz', model: 'Modelo', apiKey: 'Chave da API', baseUrl: 'URL', url: 'Link', link: 'Link',
  durationMin: 'Duração', start: 'Data e hora', startAt: 'Data e hora', dailyLimit: 'Limite diário', price: 'Preço', priceCents: 'Preço', preco: 'Preço',
  quantity: 'Quantidade', quantidade: 'Quantidade', slug: 'Endereço', shortcut: 'Atalho', content: 'Conteúdo', documento: 'CPF/CNPJ', cnpj: 'CNPJ', cpf: 'CPF',
};
export function mensagemDeValidacao(err: ZodError): string {
  const partes: string[] = [];
  for (const i of err.issues.slice(0, 4)) {
    const campo = [...i.path].reverse().find((p) => typeof p === 'string') as string | undefined;
    const rotulo = campo ? ROTULOS[campo] ?? campo.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase()) : '';
    partes.push(rotulo ? `${rotulo}: ${i.message}` : i.message);
  }
  return `Confira os dados — ${[...new Set(partes)].join('; ')}`;
}

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
    return res.status(400).json({ error: mensagemDeValidacao(err), details: { ...err.flatten(), amigavel: true } });
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
