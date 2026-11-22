/**
 * v1.41.0 — /api/inbox: respostas rápidas, configuração do atendimento (distribuição, horário, pesquisa)
 * e mensagens agendadas. Montado com requireOrg + requireModule('inbox').
 * Leitura das respostas rápidas e agendamento: qualquer membro com Inbox (e acesso ao canal da conversa).
 * Criar/editar/excluir respostas rápidas e mudar a configuração: só Proprietário/Administrador.
 */
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { ah, notFound, HttpError } from '../lib/http.js';
import { orgOf, requireRole } from '../auth/session.js';
import { audit } from '../lib/audit.js';
import { channelWhere } from '../lib/permissions.js';
import { parseJson } from '../lib/json.js';
import { parseLocal } from '../agenda/time.js';
import { normalizarAtalho, validarFaixas, descreverHorario, ATALHO_MAX, RESPOSTA_MAX, AWAY_PADRAO, CSAT_PERGUNTA_PADRAO, CSAT_OBRIGADO_PADRAO } from './core.js';
import { getInboxSettings, candidatosDistribuicao, faixasDe } from './service.js';
import { iaDoAssistente, resumirConversa, sugerirResposta, AssistenteIndisponivel } from './assistente.js';
import { pixRouter } from '../pix/routes.js';

export const inboxRouter = Router();
const admins = requireRole('OWNER', 'ADMIN');

// v1.44.0: cobrança Pix na conversa (chave da empresa, cobranças, baixa manual).
inboxRouter.use(pixRouter);

// ---------------- Assistente do atendente (v1.44.0) ----------------

/** A IA da empresa pode ser usada pelo assistente agora? (para habilitar os botões com dica) */
inboxRouter.get('/assistente', ah(async (req, res) => {
  const ia = await iaDoAssistente(orgOf(req));
  res.json(ia.ok ? { disponivel: true } : { disponivel: false, motivo: ia.motivo });
}));

async function assistente(req: import('express').Request, res: import('express').Response, tipo: 'resumo' | 'sugestao') {
  const conv = await prisma.conversation.findFirst({ where: { id: req.params.id, orgId: orgOf(req), ...channelWhere(req) }, select: { id: true, orgId: true } });
  if (!conv) throw notFound('Conversa');
  try {
    if (tipo === 'resumo') return void res.json({ resumo: await resumirConversa(conv.orgId, conv.id) });
    const me = await prisma.user.findUnique({ where: { id: req.auth!.userId }, select: { name: true } });
    res.json({ sugestao: await sugerirResposta(conv.orgId, conv.id, me?.name) });
  } catch (e) {
    if (e instanceof AssistenteIndisponivel) throw new HttpError(400, e.message);
    console.warn('[assistente] falha da IA', { orgId: conv.orgId, tipo, error: (e as Error).message });
    throw new HttpError(502, 'A IA não respondeu agora. Tente de novo em instantes.');
  }
}
inboxRouter.post('/conversas/:id/resumo', ah((req, res) => assistente(req, res, 'resumo')));
inboxRouter.post('/conversas/:id/sugestao', ah((req, res) => assistente(req, res, 'sugestao')));

// ---------------- Respostas rápidas ----------------

inboxRouter.get('/respostas-rapidas', ah(async (req, res) => {
  const items = await prisma.quickReply.findMany({ where: { orgId: orgOf(req) }, orderBy: { shortcut: 'asc' }, take: 500, select: { id: true, shortcut: true, text: true, updatedAt: true } });
  res.json({ items });
}));

const respostaBody = z.object({
  shortcut: z.string().trim().min(1, 'Informe o atalho').max(ATALHO_MAX + 5),
  text: z.string().trim().min(1, 'Informe o texto').max(RESPOSTA_MAX, `O texto pode ter no máximo ${RESPOSTA_MAX} caracteres`),
});

async function salvarResposta(req: import('express').Request, id: string | null) {
  const b = respostaBody.parse(req.body);
  const orgId = orgOf(req);
  const shortcut = normalizarAtalho(b.shortcut);
  if (!shortcut) throw new HttpError(400, 'Atalho inválido: use letras, números, "-" ou "_" (ex.: preco)');
  const dup = await prisma.quickReply.findFirst({ where: { orgId, shortcut, ...(id ? { id: { not: id } } : {}) }, select: { id: true } });
  if (dup) throw new HttpError(409, `Já existe uma resposta rápida com o atalho /${shortcut}`);
  if (id) {
    const cur = await prisma.quickReply.findFirst({ where: { id, orgId } });
    if (!cur) throw notFound('Resposta rápida');
    return prisma.quickReply.update({ where: { id }, data: { shortcut, text: b.text } });
  }
  if ((await prisma.quickReply.count({ where: { orgId } })) >= 500) throw new HttpError(400, 'Limite de 500 respostas rápidas');
  return prisma.quickReply.create({ data: { orgId, shortcut, text: b.text, createdById: req.auth!.userId } });
}

inboxRouter.post('/respostas-rapidas', admins, ah(async (req, res) => {
  const r = await salvarResposta(req, null);
  await audit(req, 'inbox.resposta_rapida.criar', { entity: 'quickReply', entityId: r.id, meta: { shortcut: r.shortcut } });
  res.status(201).json(r);
}));

inboxRouter.put('/respostas-rapidas/:id', admins, ah(async (req, res) => {
  const r = await salvarResposta(req, req.params.id);
  await audit(req, 'inbox.resposta_rapida.editar', { entity: 'quickReply', entityId: r.id, meta: { shortcut: r.shortcut } });
  res.json(r);
}));

inboxRouter.delete('/respostas-rapidas/:id', admins, ah(async (req, res) => {
  const orgId = orgOf(req);
  const cur = await prisma.quickReply.findFirst({ where: { id: req.params.id, orgId } });
  if (!cur) throw notFound('Resposta rápida');
  await prisma.quickReply.delete({ where: { id: cur.id } });
  await audit(req, 'inbox.resposta_rapida.excluir', { entity: 'quickReply', entityId: cur.id, meta: { shortcut: cur.shortcut } });
  res.json({ ok: true });
}));

// ---------------- Configuração do atendimento ----------------

async function configView(orgId: string) {
  const s = await getInboxSettings(orgId);
  const faixas = faixasDe(s);
  const membros = await prisma.membership.findMany({ where: { orgId }, include: { user: { select: { id: true, name: true, disabledAt: true } } }, orderBy: { createdAt: 'asc' } });
  const online = await candidatosDistribuicao(orgId, null, { assignOnlineOnly: true, assignUserIds: '[]' }).catch(() => ({ elegiveis: [] as { userId: string }[] }));
  const on = new Set(online.elegiveis.map((e) => e.userId));
  return {
    autoAssign: s.autoAssign, assignStrategy: s.assignStrategy, assignOnlineOnly: s.assignOnlineOnly, assignUserIds: parseJson<string[]>(s.assignUserIds, []),
    hoursEnabled: s.hoursEnabled, hours: faixas, hoursText: descreverHorario(faixas), awayMessage: s.awayMessage, awayEveryHours: s.awayEveryHours,
    csatEnabled: s.csatEnabled, csatQuestion: s.csatQuestion, csatThanks: s.csatThanks,
    padroes: { awayMessage: AWAY_PADRAO, csatQuestion: CSAT_PERGUNTA_PADRAO, csatThanks: CSAT_OBRIGADO_PADRAO },
    membros: membros.filter((m) => !m.user.disabledAt).map((m) => ({ userId: m.userId, nome: m.user.name, role: m.role, online: on.has(m.userId) })),
  };
}

inboxRouter.get('/config', admins, ah(async (req, res) => { res.json(await configView(orgOf(req))); }));

const configBody = z.object({
  autoAssign: z.boolean().optional(),
  assignStrategy: z.enum(['rodizio', 'menos_ocupado']).optional(),
  assignOnlineOnly: z.boolean().optional(),
  assignUserIds: z.array(z.string().max(40)).max(200).optional(),
  hoursEnabled: z.boolean().optional(),
  hours: z.array(z.object({ dia: z.number().int().min(0).max(6), inicio: z.string().max(5), fim: z.string().max(5) })).max(21).optional(),
  awayMessage: z.string().max(1000).optional(),
  awayEveryHours: z.number().int().min(1).max(168).optional(),
  csatEnabled: z.boolean().optional(),
  csatQuestion: z.string().max(500).optional(),
  csatThanks: z.string().max(500).optional(),
});

inboxRouter.put('/config', admins, ah(async (req, res) => {
  const b = configBody.parse(req.body);
  const orgId = orgOf(req);
  const data: Record<string, unknown> = {};
  for (const k of ['autoAssign', 'assignStrategy', 'assignOnlineOnly', 'hoursEnabled', 'awayEveryHours', 'csatEnabled'] as const) if (b[k] !== undefined) data[k] = b[k];
  for (const k of ['awayMessage', 'csatQuestion', 'csatThanks'] as const) if (b[k] !== undefined) data[k] = b[k]!.trim();
  if (b.assignUserIds) {
    const membros = new Set((await prisma.membership.findMany({ where: { orgId }, select: { userId: true } })).map((m) => m.userId));
    const fora = b.assignUserIds.filter((id) => !membros.has(id));
    if (fora.length) throw new HttpError(400, 'Algum atendente escolhido não faz parte da equipe');
    data.assignUserIds = JSON.stringify([...new Set(b.assignUserIds)]);
  }
  if (b.hours) {
    const v = validarFaixas(b.hours);
    if ('erro' in v) throw new HttpError(400, v.erro);
    data.hours = JSON.stringify(v.faixas);
  }
  const atual = await getInboxSettings(orgId);
  const horasFinais = b.hours ? (data.hours as string) : atual.hours;
  if ((b.hoursEnabled ?? atual.hoursEnabled) && !parseJson<unknown[]>(horasFinais, []).length) throw new HttpError(400, 'Para ligar a mensagem de fora do horário, cadastre ao menos uma faixa de horário');
  await prisma.inboxSettings.upsert({ where: { orgId }, create: { orgId, ...data }, update: data });
  await audit(req, 'inbox.config', { entity: 'inboxSettings', entityId: orgId, meta: { campos: Object.keys(data) } });
  res.json(await configView(orgId));
}));

// ---------------- Mensagens agendadas ----------------

async function convDoMembro(req: import('express').Request, id: string) {
  const c = await prisma.conversation.findFirst({ where: { id, orgId: orgOf(req), ...channelWhere(req) } });
  if (!c) throw notFound('Conversa');
  return c;
}

const vistaAgendada = (m: { id: string; body: string; sendAt: Date; status: string; error: string | null; createdById: string | null; createdAt: Date }, nomes: Map<string, string>) => ({
  id: m.id, body: m.body, sendAt: m.sendAt, status: m.status, error: m.error, createdAt: m.createdAt, autor: m.createdById ? nomes.get(m.createdById) ?? null : null,
});

inboxRouter.get('/conversas/:id/agendadas', ah(async (req, res) => {
  const conv = await convDoMembro(req, req.params.id);
  const items = await prisma.scheduledMessage.findMany({ where: { orgId: conv.orgId, conversationId: conv.id }, orderBy: { sendAt: 'desc' }, take: 50 });
  const users = await prisma.user.findMany({ where: { id: { in: items.map((i) => i.createdById).filter(Boolean) as string[] } }, select: { id: true, name: true } });
  const nomes = new Map(users.map((u) => [u.id, u.name]));
  res.json({ items: items.map((i) => vistaAgendada(i, nomes)) });
}));

inboxRouter.post('/conversas/:id/agendadas', ah(async (req, res) => {
  const b = z.object({ text: z.string().trim().min(1, 'Escreva a mensagem').max(4096), sendAt: z.string().min(10).max(40) }).parse(req.body);
  const conv = await convDoMembro(req, req.params.id);
  const org = await prisma.organization.findUniqueOrThrow({ where: { id: conv.orgId }, select: { timezone: true } });
  const when = parseLocal(b.sendAt, org.timezone || 'America/Sao_Paulo');
  if (!when) throw new HttpError(400, 'Data e hora inválidas');
  const agora = Date.now();
  if (when.getTime() < agora + 60_000) throw new HttpError(400, 'Escolha uma data e hora pelo menos 1 minuto no futuro');
  if (when.getTime() > agora + 90 * 86400_000) throw new HttpError(400, 'Dá para agendar até 90 dias à frente');
  if ((await prisma.scheduledMessage.count({ where: { orgId: conv.orgId, conversationId: conv.id, status: 'PENDENTE' } })) >= 20) throw new HttpError(400, 'Limite de 20 mensagens agendadas por conversa');
  const sm = await prisma.scheduledMessage.create({ data: { orgId: conv.orgId, conversationId: conv.id, contactId: conv.contactId, body: b.text, sendAt: when, createdById: req.auth!.userId } });
  await audit(req, 'inbox.agendar', { entity: 'scheduledMessage', entityId: sm.id, meta: { sendAt: when.toISOString() } });
  res.status(201).json(vistaAgendada(sm, new Map()));
}));

inboxRouter.delete('/agendadas/:id', ah(async (req, res) => {
  const orgId = orgOf(req);
  const sm = await prisma.scheduledMessage.findFirst({ where: { id: req.params.id, orgId } });
  if (!sm) throw notFound('Mensagem agendada');
  await convDoMembro(req, sm.conversationId);
  const r = await prisma.scheduledMessage.updateMany({ where: { id: sm.id, status: 'PENDENTE' }, data: { status: 'CANCELADA' } });
  if (r.count !== 1) throw new HttpError(400, 'Essa mensagem já foi enviada ou cancelada');
  await audit(req, 'inbox.agendar.cancelar', { entity: 'scheduledMessage', entityId: sm.id });
  res.json({ ok: true });
}));
