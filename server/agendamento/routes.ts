/**
 * v1.46.0 — Rotas da página pública de agendamento.
 *  - /api/agenda/link (logado, módulo Agenda): configuração, serviços, link e QR code.
 *  - /api/public/agendar/:slug (sem login, antes do CSRF): dados da página, horários livres e agendar.
 *  - /agendar/:slug e /agendar.js: a página em si (HTML leve, sem o app React).
 */
import express, { Router, type Request, type RequestHandler } from 'express';
import { z } from 'zod';
import { ah, HttpError } from '../lib/http.js';
import { orgOf, requireRole } from '../auth/session.js';
import { audit } from '../lib/audit.js';
import { agendarPublico, configView, criarServico, editarServico, excluirServico, horariosPublicos, infoPublica, salvarPagina } from './service.js';
import { pareceRobo } from './core.js';
import { AGENDAR_JS, paginaHtml } from './pagina.js';

// ---------------- Dono (logado) ----------------

export const agendamentoAdminRouter = Router();
const admins = requireRole('OWNER', 'ADMIN');

agendamentoAdminRouter.get('/', ah(async (req, res) => res.json(await configView(orgOf(req), req))));

agendamentoAdminRouter.put('/', admins, ah(async (req, res) => {
  const b = z.object({
    enabled: z.boolean().optional(), slug: z.string().trim().max(40).optional(),
    title: z.string().max(100).optional(), intro: z.string().max(500).optional(), maxDaysAhead: z.number().int().min(1).max(90).optional(),
  }).parse(req.body);
  await salvarPagina(orgOf(req), b);
  await audit(req, 'agenda.link_config', { entity: 'booking_page', entityId: orgOf(req), meta: { enabled: b.enabled, slug: b.slug } });
  res.json(await configView(orgOf(req), req));
}));

const servico = z.object({
  name: z.string().trim().min(2, 'Nome do serviço muito curto').max(80),
  durationMin: z.number().int().min(5, 'Duração mínima: 5 min').max(480, 'Duração máxima: 8 horas'),
  priceCents: z.number().int().min(0).max(100_000_000).nullable().optional(),
  description: z.string().max(300).optional(),
  active: z.boolean().optional(), position: z.number().int().min(0).max(1000).optional(),
});
agendamentoAdminRouter.post('/servicos', admins, ah(async (req, res) => res.status(201).json(await criarServico(orgOf(req), servico.parse(req.body)))));
agendamentoAdminRouter.patch('/servicos/:id', admins, ah(async (req, res) => res.json(await editarServico(orgOf(req), String(req.params.id), servico.partial().parse(req.body)))));
agendamentoAdminRouter.delete('/servicos/:id', admins, ah(async (req, res) => { await excluirServico(orgOf(req), String(req.params.id)); res.json({ ok: true }); }));

// ---------------- Público ----------------

/** Limites em memória por IP (e por página no agendar). */
const janelas = new Map<string, number[]>();
export function resetLimitesAgendar() { janelas.clear(); }
function permitir(chave: string, max: number, janelaMs: number, agora = Date.now()): boolean {
  const l = (janelas.get(chave) ?? []).filter((t) => agora - t < janelaMs);
  const ok = l.length < max;
  if (ok) l.push(agora);
  janelas.set(chave, l);
  if (janelas.size > 20000) for (const k of [...janelas.keys()].slice(0, 5000)) janelas.delete(k);
  return ok;
}
const ipDe = (req: Request) => req.ip || req.socket.remoteAddress || '?';
const limite = (tipo: string, max: number, janelaMs: number, porPagina?: { max: number; janelaMs: number }): RequestHandler => (req, _res, next) => {
  if (!permitir(`${tipo}:${ipDe(req)}`, max, janelaMs)) return next(new HttpError(429, 'Muitas tentativas. Espere alguns minutos e tente de novo.'));
  if (porPagina && !permitir(`${tipo}:pagina:${req.params.slug}`, porPagina.max, porPagina.janelaMs)) return next(new HttpError(429, 'Muitos agendamentos nesta página agora. Tente de novo mais tarde.'));
  next();
};

export const agendarPublicRouter = Router();
agendarPublicRouter.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Robots-Tag', 'noindex'); next(); });

agendarPublicRouter.get('/:slug', limite('ler', 60, 60_000), ah(async (req, res) => res.json(await infoPublica(String(req.params.slug)))));

agendarPublicRouter.get('/:slug/horarios', limite('ler', 60, 60_000), ah(async (req, res) => {
  const q = z.object({ servico: z.string().min(1).max(40), dia: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).parse(req.query);
  res.json(await horariosPublicos(String(req.params.slug), q.servico, q.dia));
}));

agendarPublicRouter.post('/:slug', limite('agendar', 5, 10 * 60_000, { max: 30, janelaMs: 3600_000 }), ah(async (req, res) => {
  const b = z.object({
    servicoId: z.string().min(1).max(40), dia: z.string().max(10), hora: z.string().max(5),
    nome: z.string().max(120), whatsapp: z.string().max(30), observacao: z.string().max(500).optional().nullable(),
    site: z.string().max(200).optional(), t: z.number().optional(),
  }).parse(req.body);
  // Robô (campo escondido preenchido ou envio instantâneo): responde como se tivesse dado certo e não grava nada.
  if (pareceRobo(b.site, b.t)) return res.status(201).json({ ok: true, dia: b.dia, hora: b.hora });
  res.status(201).json(await agendarPublico(String(req.params.slug), b));
}));

/** Página e script (registrados antes do app React). */
export function montarPaginaAgendar(app: express.Express) {
  app.get('/agendar.js', (_req, res) => {
    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=600');
    res.send(AGENDAR_JS);
  });
  app.get('/agendar/:slug', (req, res) => {
    const slug = String(req.params.slug).toLowerCase();
    if (!/^[a-z0-9-]{3,40}$/.test(slug)) return res.status(404).type('html').send(paginaHtml(''));
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Robots-Tag', 'noindex');
    res.type('html').send(paginaHtml(slug));
  });
}
