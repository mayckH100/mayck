/** v1.46.0 — Rotas do assistente "Monte sua IA conversando" (montadas em /api/ai/montar). */
import express, { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { ah, HttpError } from '../../lib/http.js';
import { orgOf, requireRole } from '../../auth/session.js';
import { aplicar, gerarProposta, lerArquivo, situacaoAtual, MAX_ARQUIVO_BYTES } from './service.js';

export const montarRouter = Router();
const admins = requireRole('OWNER', 'ADMIN');

/** Limite simples por organização (a geração usa IA): 12 por 10 min; leitura de arquivo: 20 por 10 min. */
const janelas = new Map<string, number[]>();
export function resetLimitesMontar() { janelas.clear(); }
function limite(chave: string, max: number, janelaMs = 10 * 60_000, agora = Date.now()): boolean {
  const lista = (janelas.get(chave) ?? []).filter((t) => agora - t < janelaMs);
  if (lista.length >= max) { janelas.set(chave, lista); return false; }
  lista.push(agora);
  janelas.set(chave, lista);
  return true;
}
const porOrg = (tipo: string, max: number): RequestHandler => (req, _res, next) => {
  if (!limite(`${tipo}:${orgOf(req)}`, max)) return next(new HttpError(429, 'Muitas tentativas seguidas. Espere alguns minutos e tente de novo.'));
  next();
};

const corpoBinario: RequestHandler = (req, res, next) => {
  express.raw({ type: () => true, limit: MAX_ARQUIVO_BYTES + 1024 })(req, res, (err?: any) => {
    if (err) return next(err.type === 'entity.too.large' ? new HttpError(413, 'Arquivo maior que 8 MB.') : new HttpError(400, 'Falha ao ler o arquivo enviado.'));
    next();
  });
};

montarRouter.get('/', ah(async (req, res) => res.json(await situacaoAtual(orgOf(req)))));

montarRouter.post('/arquivo', admins, porOrg('arquivo', 20), corpoBinario, ah(async (req, res) => {
  const raw = String(req.header('x-file-name') ?? 'arquivo');
  let nome = raw;
  try { nome = decodeURIComponent(raw); } catch { /* nome cru */ }
  nome = nome.replace(/[\\/]/g, '_').slice(0, 120);
  const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  const mime = String(req.header('x-file-type') ?? req.header('content-type') ?? '').split(';')[0].trim().toLowerCase();
  const ext = nome.toLowerCase().split('.').pop() ?? '';
  const porExt: Record<string, string> = { pdf: 'application/pdf', txt: 'text/plain', csv: 'text/csv', ogg: 'audio/ogg', opus: 'audio/ogg', mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav', webm: 'audio/webm' };
  const r = await lerArquivo(orgOf(req), buf, nome, !mime || mime === 'application/octet-stream' ? porExt[ext] ?? '' : mime);
  res.json({ nome, ...r, caracteres: r.texto.length });
}));

montarRouter.post('/gerar', admins, porOrg('gerar', 12), ah(async (req, res) => {
  const b = z.object({
    link: z.string().trim().max(500).optional().nullable(),
    texto: z.string().max(20000).optional().nullable(),
    arquivos: z.array(z.object({ nome: z.string().max(200), tipo: z.enum(['arquivo', 'audio']), texto: z.string().max(30000) })).max(5).optional(),
  }).parse(req.body);
  res.json(await gerarProposta(orgOf(req), b));
}));

montarRouter.post('/aplicar', admins, ah(async (req, res) => {
  const b = z.object({
    confirmar: z.literal(true),
    proposta: z.record(z.string(), z.any()),
    opcoes: z.object({ substituirInstrucoes: z.boolean().default(false), criarFluxo: z.boolean().default(true), ativarFluxo: z.boolean().default(true), horario: z.boolean().default(true), ligarIa: z.boolean().default(true) }),
  }).parse(req.body);
  res.json(await aplicar(orgOf(req), req.auth?.userId ?? null, b.proposta, b.opcoes, req));
}));
