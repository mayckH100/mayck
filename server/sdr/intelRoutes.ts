import { Router, type Request } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { ah, notFound } from '../lib/http.js';
import { orgOf, requireRole } from '../auth/session.js';
import { audit } from '../lib/audit.js';
import { parseJson } from '../lib/json.js';
import { getSdrSettings, questionsOf } from './service.js';
import { getIntelConfig, setIntelConfig, questionsFor, type IntelConfig } from './intelConfig.js';
import { replyDatesOf } from './followupTiming.js';
import { bestSendHour, buildHandoff, explainScore, METODOS, METODO_LABEL, METODO_QUESTIONS, DEFAULT_OBJECOES } from './intel.js';
import type { Answers, Temperature } from './core.js';
import { enrichLead, leadEmpresa } from './cnpj.js';
import { isValidCnpj, onlyDigits } from '../lib/documento.js';

/** SDR com IA › Inteligência (v1.21.0): `/api/sdr/inteligencia` (montado dentro do sdrRouter: mesmo acesso do SDR). */
export const sdrIntelRouter = Router();
const admins = requireRole('OWNER', 'ADMIN');

async function intelView(orgId: string) {
  const [c, s] = await Promise.all([getIntelConfig(orgId), getSdrSettings(orgId)]);
  const { salvo: _s, ...cfg } = c;
  return {
    ...cfg,
    objecoesPadrao: DEFAULT_OBJECOES,
    metodos: METODOS.map((id) => ({ id, label: METODO_LABEL[id], perguntas: id === 'PADRAO' ? questionsOf(s) : METODO_QUESTIONS[id] })),
  };
}

sdrIntelRouter.get('/', ah(async (req, res) => res.json(await intelView(orgOf(req)))));

const schema = z.object({
  metodo: z.enum(METODOS).optional(),
  objecoes: z.object({
    enabled: z.boolean().optional(),
    itens: z.array(z.object({ id: z.string().max(40).optional(), titulo: z.string().max(80), gatilhos: z.union([z.array(z.string().max(60)).max(15), z.string().max(900)]), resposta: z.string().max(600) })).max(20).optional(),
  }).optional(),
  cnpj: z.boolean().optional(),
  resumo: z.boolean().optional(),
  followupIa: z.boolean().optional(),
  melhorHorario: z.boolean().optional(),
});

sdrIntelRouter.put('/', admins, ah(async (req, res) => {
  const b = schema.parse(req.body) as Partial<IntelConfig>;
  const orgId = orgOf(req);
  await setIntelConfig(orgId, b, { userId: req.auth?.userId, ip: req.ip });
  await audit(req, 'sdr.inteligencia', { orgId, entity: 'sdr_settings', entityId: orgId, meta: { campos: Object.keys(b) } });
  res.json(await intelView(orgId));
}));

async function leadOf(req: Request) {
  const l = await prisma.sdrLead.findFirst({ where: { id: req.params.id, orgId: orgOf(req) } });
  if (!l) throw notFound('Lead');
  return l;
}

/** Leitura inteligente do lead para o vendedor: explicação da pontuação (e, nas próximas partes, resumo, CNPJ, intenção). */
sdrIntelRouter.get('/leads/:id', ah(async (req, res) => {
  const l = await leadOf(req);
  const s = await getSdrSettings(l.orgId);
  const qs = await questionsFor(l.orgId, s);
  const explicacao = explainScore(qs, parseJson<Answers>(l.answersJson, {}), l.score, l.temperature as Temperature, s.warmScore, s.hotScore);
  const resumo = buildHandoff(parseJson<Answers>(l.answersJson, {}), l, explicacao.proximaAcao);
  const tz = (await prisma.organization.findUnique({ where: { id: l.orgId }, select: { timezone: true } }))?.timezone ?? 'America/Sao_Paulo';
  const melhor = bestSendHour(await replyDatesOf(l), s, tz);
  res.json({ metodo: (await getIntelConfig(l.orgId)).metodo, explicacao, resumo, melhorHorario: { ...melhor, fuso: tz }, empresa: await leadEmpresa(l.orgId, l.id) });
}));

/** Enriquecer pelo CNPJ informado pela equipe. Falha silenciosa: responde 200 com `empresa: null` e um aviso. */
sdrIntelRouter.post('/leads/:id/cnpj', ah(async (req, res) => {
  const l = await leadOf(req);
  const cnpj = onlyDigits(String(req.body?.cnpj ?? ''));
  if (cnpj.length !== 14 || !isValidCnpj(cnpj)) return res.json({ empresa: null, aviso: 'CNPJ inválido' });
  const empresa = await enrichLead(l, cnpj);
  res.json({ empresa, aviso: empresa ? null : 'Não foi possível consultar agora. O lead segue normalmente.' });
}));
