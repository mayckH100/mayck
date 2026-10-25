import { prisma } from '../db.js';
import { config } from '../config.js';
import { parseJson, getPath } from '../lib/json.js';
import { renderTemplate, renderDeep } from '../lib/template.js';
import { assertPublicUrl } from '../lib/ssrf.js';
import { httpFetch } from '../lib/fetcher.js';
import { decryptOrNull } from '../lib/crypto.js';
import { sendOutbound, handoffToHuman } from '../whatsapp/messaging.js';
import { generateAiReply } from '../ai/service.js';
import {
  type FlowGraph, type FlowNode, type Trigger, matchTriggers, evaluateCondition, matchMenuOption, validateAnswer, nextNodeId,
} from './logic.js';
import type { Conversation, Contact, FlowRun, Message } from '@prisma/client';
import type { OutboundPayload } from '../whatsapp/cloudClient.js';

// ---------- Trava por conversa (evita processamento concorrente/duplicado) ----------
const locks = new Map<string, Promise<unknown>>();
export async function withConversationLock<T>(conversationId: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(conversationId) ?? Promise.resolve();
  const run = prev.catch(() => undefined).then(fn);
  locks.set(conversationId, run);
  try {
    return await run;
  } finally {
    if (locks.get(conversationId) === run) locks.delete(conversationId);
  }
}

interface Input { text: string; replyId?: string }
type StepOutcome =
  | { kind: 'next'; handle: string; status?: 'ok' | 'warn'; detail?: string }
  | { kind: 'wait'; waitType: 'reply' | 'timer'; resumeAt?: Date; detail?: string }
  | { kind: 'stop'; status: 'COMPLETED' | 'FAILED' | 'HANDOFF'; detail?: string; error?: string };

async function loadGraph(flowId: string, version: number): Promise<FlowGraph> {
  const v = await prisma.flowVersion.findUnique({ where: { flowId_version: { flowId, version } } });
  return parseJson<FlowGraph>(v?.graph, { nodes: [], edges: [] });
}

function contextVars(conv: Conversation, contact: Contact, runVars: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return {
    ...parseJson<Record<string, unknown>>(contact.vars, {}),
    ...runVars,
    contact_name: contact.name ?? contact.phone,
    contact_phone: contact.phone,
    contact_id: contact.id,
    contact_tags: parseJson<string[]>(contact.tags, []).join(','),
    conversation_id: conv.id,
    organization_id: conv.orgId,
    ...extra,
  };
}

async function logStep(run: FlowRun, node: FlowNode, status: 'ok' | 'warn' | 'error', detail?: string) {
  await prisma.flowRunStep.create({ data: { orgId: run.orgId, runId: run.id, flowId: run.flowId, nodeId: node.id, nodeType: node.type, status, detail: detail?.slice(0, 1000) } });
}

async function send(conv: Conversation, contact: Contact, payload: OutboundPayload, sender: 'bot' | 'ai' = 'bot'): Promise<Message> {
  return sendOutbound({ conversation: conv, contact, payload, sender });
}

function failedSend(m: Message): StepOutcome | null {
  return m.status === 'FAILED' ? { kind: 'stop', status: 'FAILED', error: `Falha ao enviar mensagem: ${m.error}` } : null;
}

function menuPayload(node: FlowNode, vars: Record<string, unknown>): OutboundPayload {
  const options: { id: string; label: string }[] = node.data.options ?? [];
  const text = renderTemplate(node.data.text ?? 'Escolha uma opção:', vars);
  if (node.data.style === 'buttons' && options.length <= 3) {
    return { type: 'buttons', text, buttons: options.map((o) => ({ id: o.id, title: o.label })) };
  }
  return { type: 'text', text: `${text}\n\n${options.map((o, i) => `${i + 1}. ${o.label}`).join('\n')}` };
}

async function setContactVar(contact: Contact, key: string, value: unknown) {
  const vars = parseJson<Record<string, unknown>>(contact.vars, {});
  vars[key] = value;
  contact.vars = JSON.stringify(vars);
  await prisma.contact.update({ where: { id: contact.id }, data: { vars: contact.vars } });
}

/** Executa um bloco. `input` existe apenas quando o run está retomando um bloco que aguardava resposta. */
async function executeNode(node: FlowNode, run: FlowRun, runVars: Record<string, unknown>, conv: Conversation, contact: Contact, input?: Input): Promise<StepOutcome> {
  const d = node.data ?? {};
  const vars = contextVars(conv, contact, runVars);
  switch (node.type) {
    case 'start':
      return { kind: 'next', handle: 'next' };

    case 'send_text': {
      const m = await send(conv, contact, { type: 'text', text: renderTemplate(d.text ?? '', vars), previewUrl: !!d.previewUrl });
      return failedSend(m) ?? { kind: 'next', handle: 'next' };
    }

    case 'send_media': {
      const m = await send(conv, contact, { type: d.mediaType ?? 'image', link: renderTemplate(d.url ?? '', vars), caption: renderTemplate(d.caption ?? '', vars) || undefined, filename: d.filename } as OutboundPayload);
      return failedSend(m) ?? { kind: 'next', handle: 'next' };
    }

    case 'menu': {
      const options = d.options ?? [];
      if (!input) {
        runVars.__retries = 0;
        const m = await send(conv, contact, menuPayload(node, vars));
        return failedSend(m) ?? { kind: 'wait', waitType: 'reply', detail: 'Aguardando escolha do menu' };
      }
      const opt = matchMenuOption(options, input.text, input.replyId);
      if (opt) {
        runVars[d.variable || 'menu_choice'] = opt.label;
        return { kind: 'next', handle: `opt-${opt.id}`, detail: `Escolheu: ${opt.label}` };
      }
      const retries = Number(runVars.__retries ?? 0) + 1;
      runVars.__retries = retries;
      if (nextNodeId({ nodes: [], edges: (run as any).__edges }, node.id, 'invalid') || retries >= Number(d.maxRetries ?? 3)) {
        return { kind: 'next', handle: 'invalid', status: 'warn', detail: `Resposta inválida: ${input.text}` };
      }
      const m = await send(conv, contact, { type: 'text', text: renderTemplate(d.invalidText || 'Opção inválida. Responda com o número de uma das opções.', vars) });
      return failedSend(m) ?? { kind: 'wait', waitType: 'reply', detail: 'Resposta inválida, aguardando novamente' };
    }

    case 'ask': {
      if (!input) {
        runVars.__retries = 0;
        const m = await send(conv, contact, { type: 'text', text: renderTemplate(d.question ?? '', vars) });
        return failedSend(m) ?? { kind: 'wait', waitType: 'reply', detail: `Aguardando ${d.variable}` };
      }
      if (validateAnswer(d.validation, input.text)) {
        runVars[d.variable] = input.text.trim();
        await setContactVar(contact, d.variable, input.text.trim());
        if (d.variable === 'nome' || d.variable === 'name') await prisma.contact.update({ where: { id: contact.id }, data: { name: input.text.trim() } });
        if (d.variable === 'email' && validateAnswer('email', input.text)) await prisma.contact.update({ where: { id: contact.id }, data: { email: input.text.trim() } });
        return { kind: 'next', handle: 'next', detail: `${d.variable} = ${input.text.trim()}` };
      }
      const retries = Number(runVars.__retries ?? 0) + 1;
      runVars.__retries = retries;
      if (retries >= Number(d.maxRetries ?? 3)) return { kind: 'next', handle: 'invalid', status: 'warn', detail: 'Tentativas esgotadas' };
      const m = await send(conv, contact, { type: 'text', text: renderTemplate(d.errorText || 'Resposta inválida, tente novamente.', vars) });
      return failedSend(m) ?? { kind: 'wait', waitType: 'reply', detail: 'Resposta inválida' };
    }

    case 'condition': {
      const ok = evaluateCondition(d.rules ?? [], d.logic ?? 'all', vars);
      return { kind: 'next', handle: ok ? 'yes' : 'no', detail: ok ? 'sim' : 'não' };
    }

    case 'tag': {
      const tags = new Set(parseJson<string[]>(contact.tags, []));
      const tag = String(d.tag ?? '').trim();
      if (tag) d.action === 'remove' ? tags.delete(tag) : tags.add(tag);
      contact.tags = JSON.stringify([...tags]);
      await prisma.contact.update({ where: { id: contact.id }, data: { tags: contact.tags } });
      if (d.stageId) {
        const st = await prisma.kanbanStage.findFirst({ where: { id: d.stageId, orgId: conv.orgId } });
        if (st) await prisma.contact.update({ where: { id: contact.id }, data: { stageId: st.id } });
      }
      return { kind: 'next', handle: 'next', detail: `${d.action === 'remove' ? 'removida' : 'adicionada'}: ${tag}` };
    }

    case 'wait': {
      const seconds = Math.max(1, Math.min(Number(d.seconds) || 1, 7 * 24 * 3600));
      return { kind: 'wait', waitType: 'timer', resumeAt: new Date(Date.now() + seconds * 1000), detail: `Espera de ${seconds}s` };
    }

    case 'http': {
      let url = renderTemplate(d.url ?? '', vars);
      const headers: Record<string, string> = { 'Content-Type': 'application/json', ...(renderDeep(parseJson<Record<string, string>>(d.headers, {}), vars) as Record<string, string>) };
      if (d.integrationId) {
        const integ = await prisma.integration.findFirst({ where: { id: d.integrationId, orgId: conv.orgId } });
        if (!integ) return { kind: 'next', handle: 'error', status: 'warn', detail: 'Integração não encontrada' };
        if (!/^https?:/i.test(url)) url = integ.baseUrl.replace(/\/$/, '') + '/' + url.replace(/^\//, '');
        const secret = decryptOrNull(integ.authValueEnc);
        if (integ.authHeaderName && secret) headers[integ.authHeaderName] = secret;
      }
      const method = String(d.method ?? 'GET').toUpperCase();
      try {
        await assertPublicUrl(url);
        const res = await httpFetch(url, {
          method, headers,
          body: ['POST', 'PUT', 'PATCH'].includes(method) && d.body ? JSON.stringify(renderDeep(parseJson(d.body, {}), vars)) : undefined,
          signal: AbortSignal.timeout(Number(d.timeoutMs) || 10000),
        });
        const json = await res.json().catch(() => null);
        runVars.http_status = res.status;
        if (!res.ok) {
          runVars.http_error = (json as any)?.error?.message ?? (json as any)?.message ?? `HTTP ${res.status}`;
          return { kind: 'next', handle: 'error', status: 'warn', detail: `${method} ${url} → ${res.status}` };
        }
        runVars.http_error = '';
        for (const m of (d.mappings ?? []) as { variable: string; path: string }[]) {
          if (!m.variable) continue;
          const val = getPath(json, m.path);
          runVars[m.variable] = val;
          await setContactVar(contact, m.variable, val);
        }
        return { kind: 'next', handle: 'success', detail: `${method} ${url} → ${res.status}` };
      } catch (e) {
        runVars.http_status = 0;
        runVars.http_error = (e as Error).message;
        return { kind: 'next', handle: 'error', status: 'warn', detail: `${method} ${url} → ${(e as Error).message}` };
      }
    }

    case 'ai': {
      const text = input?.text ?? String(runVars.last_message ?? '');
      const r = await generateAiReply({ orgId: conv.orgId, conversationId: conv.id, text, extraInstructions: d.instructions });
      if (r.text) {
        const m = await send(conv, contact, { type: 'text', text: r.text }, 'ai');
        const f = failedSend(m);
        if (f) return f;
      }
      if (r.handoff) {
        if (nextNodeId({ nodes: [], edges: (run as any).__edges }, node.id, 'handoff')) return { kind: 'next', handle: 'handoff', status: 'warn', detail: r.reason };
        await handoffToHuman(conv, r.reason ?? 'IA');
        return { kind: 'stop', status: 'HANDOFF', detail: r.reason };
      }
      if (d.continueConversation) return { kind: 'wait', waitType: 'reply', detail: 'IA aguardando próxima mensagem' };
      return { kind: 'next', handle: 'next', detail: 'Resposta da IA enviada' };
    }

    case 'handoff': {
      if (d.message) {
        const m = await send(conv, contact, { type: 'text', text: renderTemplate(d.message, vars) });
        const f = failedSend(m);
        if (f) return f;
      }
      await handoffToHuman(conv, d.reason || 'Bloco Transferir para humano');
      return { kind: 'stop', status: 'HANDOFF', detail: 'Transferido para humano' };
    }

    case 'end': {
      if (d.message) {
        const m = await send(conv, contact, { type: 'text', text: renderTemplate(d.message, vars) });
        const f = failedSend(m);
        if (f) return f;
      }
      if (d.closeConversation) {
        await prisma.conversation.update({ where: { id: conv.id }, data: { status: 'CLOSED', closedAt: new Date() } });
      }
      return { kind: 'stop', status: 'COMPLETED', detail: d.closeConversation ? 'Conversa encerrada' : 'Fluxo encerrado' };
    }
  }
  return { kind: 'stop', status: 'FAILED', error: `Tipo de bloco desconhecido: ${(node as FlowNode).type}` };
}

/**
 * Laço principal: executa blocos a partir de `startNodeId` até pausar (aguardar), terminar ou estourar o limite de passos.
 */
async function drive(runId: string, startNodeId: string | null, input?: Input) {
  let run = await prisma.flowRun.findUniqueOrThrow({ where: { id: runId } });
  const graph = await loadGraph(run.flowId, run.flowVersion);
  (run as any).__edges = graph.edges;
  const conv = await prisma.conversation.findUniqueOrThrow({ where: { id: run.conversationId } });
  const contact = await prisma.contact.findUniqueOrThrow({ where: { id: run.contactId } });
  const runVars = parseJson<Record<string, unknown>>(run.vars, {});
  let nodeId = startNodeId;
  let pendingInput = input;
  if (input) runVars.last_message = input.text;
  let steps = run.stepCount;
  const segmentLimit = config.FLOW_MAX_STEPS;
  let segmentSteps = 0;

  const finish = async (status: string, error?: string) => {
    await prisma.flowRun.update({ where: { id: run.id }, data: { status, error, currentNodeId: nodeId, vars: JSON.stringify(runVars), stepCount: steps, finishedAt: new Date(), waitType: null, resumeAt: null } });
  };

  while (true) {
    if (!nodeId) return finish('COMPLETED');
    const node = graph.nodes.find((n) => n.id === nodeId);
    if (!node) return finish('FAILED', `Bloco ${nodeId} não existe na versão ${run.flowVersion}`);
    if (segmentSteps >= segmentLimit) {
      await logStep(run, node, 'error', `Limite de ${segmentLimit} passos atingido (possível loop)`);
      return finish('FAILED', `Limite de ${segmentLimit} passos atingido — possível loop no fluxo`);
    }
    steps++;
    segmentSteps++;
    let out: StepOutcome;
    try {
      out = await executeNode(node, run, runVars, conv, contact, pendingInput);
    } catch (e) {
      out = { kind: 'stop', status: 'FAILED', error: (e as Error).message };
    }
    pendingInput = undefined;
    if (out.kind === 'next') {
      await logStep(run, node, out.status ?? 'ok', out.detail);
      nodeId = nextNodeId(graph, node.id, out.handle);
      continue;
    }
    if (out.kind === 'wait') {
      await logStep(run, node, 'ok', out.detail);
      if (out.resumeAt) noteTimer(out.resumeAt);
      run = await prisma.flowRun.update({
        where: { id: run.id },
        data: { status: 'WAITING', waitType: out.waitType, resumeAt: out.resumeAt ?? null, currentNodeId: node.id, vars: JSON.stringify(runVars), stepCount: steps },
      });
      return;
    }
    await logStep(run, node, out.status === 'FAILED' ? 'error' : out.status === 'HANDOFF' ? 'warn' : 'ok', out.error ?? out.detail);
    return finish(out.status, out.error);
  }
}

/** Retoma um run que aguardava resposta. A troca WAITING→RUNNING é atômica (protege contra duplicidade). */
async function resumeWithReply(run: FlowRun, input: Input) {
  const claimed = await prisma.flowRun.updateMany({ where: { id: run.id, status: 'WAITING', waitType: 'reply' }, data: { status: 'RUNNING', waitType: null } });
  if (claimed.count !== 1) return false;
  await drive(run.id, run.currentNodeId, input);
  return true;
}

// ---------- Agendamento econômico ----------
// Guarda em memória o próximo vencimento de bloco "Aguardar" para não consultar o banco à toa
// (no Neon grátis, consultas constantes impedem o banco de "dormir" e consomem as CU-horas).
let nextDueAt: number | null = null;
let nextDueLoaded = false;
export function noteTimer(at: Date) {
  nextDueAt = nextDueAt === null ? at.getTime() : Math.min(nextDueAt, at.getTime());
}
async function refreshNextDue() {
  const next = await prisma.flowRun.findFirst({ where: { status: 'WAITING', waitType: 'timer' }, orderBy: { resumeAt: 'asc' }, select: { resumeAt: true } });
  nextDueAt = next?.resumeAt ? next.resumeAt.getTime() : null;
  nextDueLoaded = true;
}
/** Usado pelo agendador do servidor: só chama tick() quando há espera vencida. */
export async function scheduledTick(now = new Date()) {
  if (!nextDueLoaded) await refreshNextDue();
  if (nextDueAt === null || now.getTime() < nextDueAt) return 0;
  const n = await tick(now);
  await refreshNextDue();
  return n;
}

/** Retoma runs cujo bloco Aguardar venceu. Chamado pelo agendador (e pelos testes). */
export async function tick(now = new Date()) {
  const due = await prisma.flowRun.findMany({ where: { status: 'WAITING', waitType: 'timer', resumeAt: { lte: now } }, take: 100 });
  let resumed = 0;
  for (const run of due) {
    await withConversationLock(run.conversationId, async () => {
      const claimed = await prisma.flowRun.updateMany({ where: { id: run.id, status: 'WAITING', waitType: 'timer' }, data: { status: 'RUNNING', waitType: null, resumeAt: null } });
      if (claimed.count !== 1) return;
      const graph = await loadGraph(run.flowId, run.flowVersion);
      resumed++;
      await drive(run.id, nextNodeId(graph, run.currentNodeId!, 'next'));
    });
  }
  return resumed;
}

/** Inicia um fluxo (por gatilho ou manualmente pelo Inbox). */
export async function startFlow(flowId: string, conv: Conversation, contact: Contact, opts: { triggerMessageId?: string; lastMessage?: string } = {}) {
  const flow = await prisma.flow.findFirst({ where: { id: flowId, orgId: conv.orgId } });
  if (!flow) throw new Error('Fluxo não encontrado');
  // Apenas um run ativo por conversa.
  await prisma.flowRun.updateMany({ where: { conversationId: conv.id, status: { in: ['RUNNING', 'WAITING'] } }, data: { status: 'CANCELLED', finishedAt: new Date() } });
  let run: FlowRun;
  try {
    run = await prisma.flowRun.create({
      data: {
        orgId: conv.orgId, flowId: flow.id, flowVersion: flow.currentVersion, conversationId: conv.id, contactId: contact.id,
        status: 'RUNNING', triggerMessageId: opts.triggerMessageId ?? null, vars: JSON.stringify({ last_message: opts.lastMessage ?? '' }),
      },
    });
  } catch (e) {
    if ((e as { code?: string }).code === 'P2002') return null; // mesma mensagem já disparou um run
    throw e;
  }
  const graph = await loadGraph(flow.id, flow.currentVersion);
  const start = graph.nodes.find((n) => n.type === 'start');
  await drive(run.id, start?.id ?? null);
  return prisma.flowRun.findUnique({ where: { id: run.id } });
}

/** Escolhe o fluxo ativo cujo gatilho é mais específico para a mensagem. */
export async function findMatchingFlow(orgId: string, text: string, isFirst: boolean, now = new Date()) {
  const org = await prisma.organization.findUnique({ where: { id: orgId } });
  const flows = await prisma.flow.findMany({ where: { orgId, status: 'ACTIVE' }, orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }] });
  let best: { flowId: string; score: number } | null = null;
  for (const f of flows) {
    const g = await loadGraph(f.id, f.currentVersion);
    const start = g.nodes.find((n) => n.type === 'start');
    const score = matchTriggers((start?.data.triggers ?? []) as Trigger[], { text, isFirst, now, timeZone: org?.timezone ?? 'America/Sao_Paulo' });
    if (score !== null && (!best || score > best.score)) best = { flowId: f.id, score };
  }
  return best?.flowId ?? null;
}

/**
 * Decide o que fazer com uma mensagem recebida em modo BOT:
 * 1) retomar fluxo que aguarda resposta; 2) iniciar fluxo por gatilho; 3) IA automática; 4) nada.
 */
export async function automateInbound(conv: Conversation, contact: Contact, message: Message, opts: { isFirst: boolean; replyId?: string }) {
  const text = message.body ?? '';
  const waiting = await prisma.flowRun.findFirst({ where: { conversationId: conv.id, status: 'WAITING', waitType: 'reply' }, orderBy: { startedAt: 'desc' } });
  if (waiting) {
    await resumeWithReply(waiting, { text, replyId: opts.replyId });
    return 'flow_resumed' as const;
  }
  const flowId = await findMatchingFlow(conv.orgId, text, opts.isFirst);
  if (flowId) {
    await startFlow(flowId, conv, contact, { triggerMessageId: message.id, lastMessage: text });
    return 'flow_started' as const;
  }
  const ai = await prisma.aiSettings.findUnique({ where: { orgId: conv.orgId } });
  if (ai?.enabled && ai.autoReply) {
    const r = await generateAiReply({ orgId: conv.orgId, conversationId: conv.id, text });
    if (r.text) await sendOutbound({ conversation: conv, contact, payload: { type: 'text', text: r.text }, sender: 'ai' });
    if (r.handoff) await handoffToHuman(conv, r.reason ?? 'IA');
    return 'ai' as const;
  }
  return 'none' as const;
}
