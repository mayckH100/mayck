import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { ah, notFound, badRequest } from '../lib/http.js';
import { orgOf, requireRole } from '../auth/session.js';
import { audit } from '../lib/audit.js';
import { graphSchema, validateGraph, defaultGraph, type FlowGraph } from '../flows/logic.js';
import { parseJson } from '../lib/json.js';
import { startFlow, withConversationLock } from '../flows/engine.js';
import { getMenuSettings, parseWords } from '../flows/menuReturn.js';
import { assertPublicUrl } from '../lib/ssrf.js';
import { httpFetch } from '../lib/fetcher.js';
import { renderDeep, renderTemplate } from '../lib/template.js';
import { decryptOrNull } from '../lib/crypto.js';

export const flowsRouter = Router();
const editors = requireRole('OWNER', 'ADMIN');

async function getFlow(req: import('express').Request) {
  const f = await prisma.flow.findFirst({ where: { id: req.params.id, orgId: orgOf(req) } });
  if (!f) throw notFound('Fluxo');
  return f;
}

flowsRouter.get('/', ah(async (req, res) => {
  const orgId = orgOf(req);
  const flows = await prisma.flow.findMany({ where: { orgId }, orderBy: { updatedAt: 'desc' } });
  const runs = await prisma.flowRun.groupBy({ by: ['flowId', 'status'], where: { orgId }, _count: { _all: true } });
  res.json(flows.map((f) => {
    const mine = runs.filter((r) => r.flowId === f.id);
    const count = (s: string) => mine.find((r) => r.status === s)?._count._all ?? 0;
    return { ...f, runs: { total: mine.reduce((a, r) => a + r._count._all, 0), completed: count('COMPLETED'), failed: count('FAILED'), handoff: count('HANDOFF') } };
  }));
}));

flowsRouter.post('/', editors, ah(async (req, res) => {
  const body = z.object({ name: z.string().trim().min(1).max(100), description: z.string().max(500).optional(), graph: graphSchema.optional() }).parse(req.body);
  const orgId = orgOf(req);
  const flow = await prisma.flow.create({
    data: { orgId, name: body.name, description: body.description, versions: { create: { version: 1, graph: JSON.stringify(body.graph ?? defaultGraph()), createdById: req.auth!.userId } } },
  });
  await audit(req, 'flow.create', { entity: 'flow', entityId: flow.id });
  res.status(201).json(flow);
}));

flowsRouter.post('/import', editors, ah(async (req, res) => {
  const body = z.object({ name: z.string().trim().min(1).max(100), description: z.string().max(500).optional().nullable(), graph: graphSchema }).parse(req.body);
  const flow = await prisma.flow.create({
    data: { orgId: orgOf(req), name: body.name, description: body.description ?? undefined, versions: { create: { version: 1, graph: JSON.stringify(body.graph), createdById: req.auth!.userId } } },
  });
  await audit(req, 'flow.import', { entity: 'flow', entityId: flow.id });
  res.status(201).json(flow);
}));

// ---------- "Voltar ao menu" (configuração por organização) ----------
flowsRouter.get('/menu-settings', ah(async (req, res) => {
  res.json(await getMenuSettings(orgOf(req)));
}));

flowsRouter.put('/menu-settings', editors, ah(async (req, res) => {
  const orgId = orgOf(req);
  const body = z.object({
    menuCommandEnabled: z.boolean(),
    menuCommandWords: z.string().max(300),
    menuFooterEnabled: z.boolean(),
    menuFooterText: z.string().trim().max(200),
    menuButtonEnabled: z.boolean(),
    menuFlowId: z.string().nullable().optional(),
  }).parse(req.body);
  const words = parseWords(body.menuCommandWords);
  if (body.menuCommandEnabled && !words.length) throw badRequest('Informe pelo menos uma palavra para voltar ao menu.');
  if (body.menuFlowId && !(await prisma.flow.findFirst({ where: { id: body.menuFlowId, orgId } }))) throw badRequest('Fluxo do menu não encontrado.');
  const data = { ...body, menuCommandWords: words.join(','), menuFlowId: body.menuFlowId || null };
  await prisma.flowSettings.upsert({ where: { orgId }, create: { orgId, ...data }, update: data });
  await audit(req, 'flow.menu_settings', { entity: 'org', entityId: orgId });
  res.json(await getMenuSettings(orgId));
}));

flowsRouter.get('/:id', ah(async (req, res) => {
  const f = await getFlow(req);
  const v = await prisma.flowVersion.findUnique({ where: { flowId_version: { flowId: f.id, version: f.currentVersion } } });
  const graph = parseJson<FlowGraph>(v?.graph, defaultGraph());
  const stats = await prisma.flowRunStep.groupBy({ by: ['nodeId', 'status'], where: { flowId: f.id, orgId: f.orgId }, _count: { _all: true } });
  const nodeStats: Record<string, { ok: number; warn: number; error: number }> = {};
  for (const s of stats) {
    nodeStats[s.nodeId] ??= { ok: 0, warn: 0, error: 0 };
    nodeStats[s.nodeId][s.status as 'ok' | 'warn' | 'error'] = s._count._all;
  }
  res.json({ flow: f, graph, problems: validateGraph(graph), nodeStats });
}));

flowsRouter.get('/:id/export', ah(async (req, res) => {
  const f = await getFlow(req);
  const v = await prisma.flowVersion.findUnique({ where: { flowId_version: { flowId: f.id, version: f.currentVersion } } });
  res.json({ name: f.name, description: f.description, graph: parseJson(v?.graph, {}) });
}));

flowsRouter.put('/:id', editors, ah(async (req, res) => {
  const body = z.object({ name: z.string().trim().min(1).max(100).optional(), description: z.string().max(500).optional().nullable(), priority: z.number().int().min(-100).max(100).optional(), graph: graphSchema }).parse(req.body);
  const f = await getFlow(req);
  const problems = validateGraph(body.graph as FlowGraph);
  if (f.status === 'ACTIVE' && problems.length) throw badRequest('O fluxo está ativo e tem problemas. Corrija ou pause antes de salvar.', problems);
  const version = f.currentVersion + 1;
  const [updated] = await prisma.$transaction([
    prisma.flow.update({ where: { id: f.id }, data: { name: body.name ?? undefined, description: body.description ?? undefined, priority: body.priority ?? undefined, currentVersion: version } }),
    prisma.flowVersion.create({ data: { flowId: f.id, version, graph: JSON.stringify(body.graph), createdById: req.auth!.userId } }),
  ]);
  await audit(req, 'flow.save', { entity: 'flow', entityId: f.id, meta: { version } });
  res.json({ flow: updated, problems });
}));

flowsRouter.post('/:id/status', editors, ah(async (req, res) => {
  const { status } = z.object({ status: z.enum(['ACTIVE', 'PAUSED']) }).parse(req.body);
  const f = await getFlow(req);
  if (status === 'ACTIVE') {
    const v = await prisma.flowVersion.findUnique({ where: { flowId_version: { flowId: f.id, version: f.currentVersion } } });
    const problems = validateGraph(parseJson<FlowGraph>(v?.graph, { nodes: [], edges: [] }));
    if (problems.length) throw badRequest('Corrija os problemas do fluxo antes de ativar', problems);
  } else {
    await prisma.flowRun.updateMany({ where: { flowId: f.id, status: { in: ['RUNNING', 'WAITING'] } }, data: { status: 'CANCELLED', finishedAt: new Date() } });
  }
  const updated = await prisma.flow.update({ where: { id: f.id }, data: { status } });
  await audit(req, status === 'ACTIVE' ? 'flow.activate' : 'flow.pause', { entity: 'flow', entityId: f.id });
  res.json(updated);
}));

flowsRouter.post('/:id/duplicate', editors, ah(async (req, res) => {
  const f = await getFlow(req);
  const v = await prisma.flowVersion.findUnique({ where: { flowId_version: { flowId: f.id, version: f.currentVersion } } });
  const copy = await prisma.flow.create({
    data: { orgId: f.orgId, name: `${f.name} (cópia)`.slice(0, 100), description: f.description, priority: f.priority, versions: { create: { version: 1, graph: v?.graph ?? JSON.stringify(defaultGraph()), createdById: req.auth!.userId } } },
  });
  await audit(req, 'flow.duplicate', { entity: 'flow', entityId: copy.id, meta: { from: f.id } });
  res.status(201).json(copy);
}));

flowsRouter.delete('/:id', editors, ah(async (req, res) => {
  const f = await getFlow(req);
  await prisma.flowRun.updateMany({ where: { flowId: f.id, status: { in: ['RUNNING', 'WAITING'] } }, data: { status: 'CANCELLED', finishedAt: new Date() } });
  await prisma.flow.delete({ where: { id: f.id } });
  await audit(req, 'flow.delete', { entity: 'flow', entityId: f.id, meta: { name: f.name } });
  res.json({ ok: true });
}));

flowsRouter.get('/:id/versions', ah(async (req, res) => {
  const f = await getFlow(req);
  const versions = await prisma.flowVersion.findMany({ where: { flowId: f.id }, orderBy: { version: 'desc' }, select: { version: true, createdAt: true, createdById: true } });
  res.json({ current: f.currentVersion, versions });
}));

flowsRouter.post('/:id/restore/:version', editors, ah(async (req, res) => {
  const f = await getFlow(req);
  const old = await prisma.flowVersion.findUnique({ where: { flowId_version: { flowId: f.id, version: Number(req.params.version) } } });
  if (!old) throw notFound('Versão');
  const version = f.currentVersion + 1;
  await prisma.$transaction([
    prisma.flowVersion.create({ data: { flowId: f.id, version, graph: old.graph, createdById: req.auth!.userId } }),
    prisma.flow.update({ where: { id: f.id }, data: { currentVersion: version } }),
  ]);
  await audit(req, 'flow.restore', { entity: 'flow', entityId: f.id, meta: { from: old.version, to: version } });
  res.json({ ok: true, version });
}));

flowsRouter.get('/:id/runs', ah(async (req, res) => {
  const f = await getFlow(req);
  const runs = await prisma.flowRun.findMany({ where: { flowId: f.id, orgId: f.orgId }, orderBy: { startedAt: 'desc' }, take: 50 });
  const steps = await prisma.flowRunStep.findMany({ where: { runId: { in: runs.map((r) => r.id) } }, orderBy: { createdAt: 'asc' } });
  const contacts = await prisma.contact.findMany({ where: { id: { in: runs.map((r) => r.contactId) }, orgId: f.orgId }, select: { id: true, name: true, phone: true } });
  res.json(runs.map((r) => ({ ...r, contact: contacts.find((c) => c.id === r.contactId), steps: steps.filter((s) => s.runId === r.id) })));
}));

/** Disparo manual pelo Inbox ("Enviar fluxo"). */
flowsRouter.post('/:id/start', ah(async (req, res) => {
  const { conversationId } = z.object({ conversationId: z.string() }).parse(req.body);
  const f = await getFlow(req);
  const conv = await prisma.conversation.findFirst({ where: { id: conversationId, orgId: f.orgId } });
  if (!conv) throw notFound('Conversa');
  const contact = await prisma.contact.findFirstOrThrow({ where: { id: conv.contactId, orgId: f.orgId } });
  if (conv.mode === 'HUMAN') await prisma.conversation.update({ where: { id: conv.id }, data: { mode: 'BOT', status: 'OPEN' } });
  const run = await withConversationLock(conv.id, () => startFlow(f.id, { ...conv, mode: 'BOT' }, contact));
  await audit(req, 'flow.manual_start', { entity: 'flow', entityId: f.id, meta: { conversationId } });
  res.json(run);
}));

/** Botão "Testar requisição" do bloco HTTP. */
flowsRouter.post('/http-test', editors, ah(async (req, res) => {
  const body = z.object({
    method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']), url: z.string().min(1).max(2000),
    headers: z.string().max(5000).optional(), body: z.string().max(20000).optional(), integrationId: z.string().optional(),
    sampleVars: z.record(z.string()).optional(),
  }).parse(req.body);
  const vars = body.sampleVars ?? {};
  let url = renderTemplate(body.url, vars);
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...(renderDeep(parseJson(body.headers, {}), vars) as Record<string, string>) };
  if (body.integrationId) {
    const integ = await prisma.integration.findFirst({ where: { id: body.integrationId, orgId: orgOf(req) } });
    if (!integ) throw notFound('Integração');
    if (!/^https?:/i.test(url)) url = integ.baseUrl.replace(/\/$/, '') + '/' + url.replace(/^\//, '');
    const secret = decryptOrNull(integ.authValueEnc);
    if (integ.authHeaderName && secret) headers[integ.authHeaderName] = secret;
  }
  try {
    await assertPublicUrl(url);
    const started = Date.now();
    const r = await httpFetch(url, { method: body.method, headers, body: ['POST', 'PUT', 'PATCH'].includes(body.method) && body.body ? JSON.stringify(renderDeep(parseJson(body.body, {}), vars)) : undefined, signal: AbortSignal.timeout(10000) });
    const text = await r.text();
    let json: unknown = null;
    try { json = JSON.parse(text); } catch { /* resposta não é JSON */ }
    res.json({ ok: r.ok, status: r.status, ms: Date.now() - started, json, text: json ? undefined : text.slice(0, 2000) });
  } catch (e) {
    res.json({ ok: false, status: 0, error: (e as Error).message });
  }
}));
