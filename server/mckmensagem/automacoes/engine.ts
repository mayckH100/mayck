import { prisma } from '../../db.js';
import { sendOutbound } from '../../whatsapp/messaging.js';
import { sendMailResult } from '../../lib/mailer.js';
import { isProductActive } from '../../billing/service.js';
import { parseJson } from '../../lib/json.js';
import { gerarHorarios, regraSchema, localDate, localParts, zonedToUtc, hhmmToMin, type Regra } from './rules.js';
import { renderMensagem, problemaRender } from './vars.js';
import type { Automacao, Cliente, Ocorrencia, AutomacaoConfig } from '@prisma/client';

/**
 * Motor de execução das Automações (seção 15 da especificação).
 * - Fila persistente: tabela Ocorrencia (uma linha por envio programado, cliente e canal).
 * - Idempotência: "chave" única por automação+cliente+canal+horário original; claim atômico (PENDENTE → PROCESSANDO).
 * - Retomada após restart: ocorrências presas em PROCESSANDO voltam para PENDENTE; vencidas são processadas.
 */

export const HORIZONTE_DIAS = 62;
export const LOCK_MS = 5 * 60_000;
const MAX_LINHAS_POR_GERACAO = 20_000;
export const CANAIS = ['WHATSAPP', 'EMAIL'] as const;
export type Canal = typeof CANAIS[number];

export interface SendResult { ok: boolean; provedorId?: string | null; error?: string | null }
export interface SendArgs { orgId: string; automacao: Automacao; cliente: Cliente; texto: string; assunto?: string | null }
type Sender = (a: SendArgs) => Promise<SendResult>;

// ---------------- Envio real (substituível nos testes) ----------------

async function whatsappReal(a: SendArgs): Promise<SendResult> {
  const phone = (a.cliente.whatsapp || a.cliente.telefone)!;
  const waId = phone.replace(/\D/g, '');
  let contact = a.cliente.contactId ? await prisma.contact.findFirst({ where: { id: a.cliente.contactId, orgId: a.orgId } }) : null;
  contact ??= await prisma.contact.findUnique({ where: { orgId_waId: { orgId: a.orgId, waId } } });
  contact ??= await prisma.contact.create({ data: { orgId: a.orgId, waId, phone, name: a.cliente.nome, email: a.cliente.email } });
  if (a.cliente.contactId !== contact.id) await prisma.cliente.update({ where: { id: a.cliente.id }, data: { contactId: contact.id } });
  if (contact.optOut) return { ok: false, error: 'Contato pediu para não receber mensagens automáticas (opt-out)' };
  let conv = await prisma.conversation.findFirst({ where: { orgId: a.orgId, contactId: contact.id, status: { not: 'CLOSED' } }, orderBy: { createdAt: 'desc' } });
  conv ??= await prisma.conversation.create({ data: { orgId: a.orgId, contactId: contact.id, channelId: a.automacao.channelId } });
  if (a.automacao.channelId && conv.channelId !== a.automacao.channelId) conv = await prisma.conversation.update({ where: { id: conv.id }, data: { channelId: a.automacao.channelId } });
  const msg = await sendOutbound({ conversation: conv, contact, payload: { type: 'text', text: a.texto }, sender: 'bot', product: 'MCKMENSAGEM' });
  if (msg.status === 'FAILED') return { ok: false, error: msg.error ?? 'Falha no envio pelo WhatsApp' };
  return { ok: true, provedorId: msg.waMessageId };
}

async function emailReal(a: SendArgs): Promise<SendResult> {
  const r = await sendMailResult({ to: a.cliente.email!, subject: a.assunto?.trim() || a.automacao.nome, text: a.texto, html: textToHtml(a.texto) });
  return r.ok ? { ok: true, provedorId: r.messageId ?? null } : { ok: false, error: r.error ?? 'Falha no envio do e-mail' };
}

const escHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const textToHtml = (t: string) => `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5">${escHtml(t).replace(/\n/g, '<br>')}</div>`;

const senders: Record<Canal, Sender> = { WHATSAPP: whatsappReal, EMAIL: emailReal };
/** Somente testes: substitui o envio de um canal (null restaura o real). */
export function setAutomacaoSender(canal: Canal, fn: Sender | null) {
  senders[canal] = fn ?? (canal === 'WHATSAPP' ? whatsappReal : emailReal);
}

// ---------------- Configuração ----------------

export async function getConfig(orgId: string): Promise<AutomacaoConfig> {
  return (await prisma.automacaoConfig.findUnique({ where: { orgId } }))
    ?? prisma.automacaoConfig.upsert({ where: { orgId }, create: { orgId }, update: {} });
}

/** Próximo instante permitido pela janela de horário (o próprio "now" se já estiver dentro). */
export function proximoNaJanela(now: Date, cfg: Pick<AutomacaoConfig, 'janelaInicio' | 'janelaFim' | 'timezone'>): Date {
  const p = localParts(now, cfg.timezone);
  const m = p.h * 60 + p.min;
  const s = hhmmToMin(cfg.janelaInicio), e = hhmmToMin(cfg.janelaFim);
  const dentro = s === e ? true : s < e ? m >= s && m < e : m >= s || m < e;
  if (dentro) return now;
  const hoje = localDate(now, cfg.timezone);
  if (m < s) return zonedToUtc(hoje, cfg.janelaInicio, cfg.timezone);
  const [y, mo, d] = hoje.split('-').map(Number);
  return zonedToUtc(new Date(Date.UTC(y, mo - 1, d + 1)).toISOString().slice(0, 10), cfg.janelaInicio, cfg.timezone);
}

function inicioDoDia(now: Date, tz: string) {
  return zonedToUtc(localDate(now, tz), '00:00', tz);
}

// ---------------- Geração de ocorrências ----------------

export const chaveDe = (automacaoId: string, clienteId: string, canal: string, t: Date) => `${automacaoId}:${clienteId}:${canal}:${t.toISOString()}`;

export function regraDe(a: Pick<Automacao, 'regra'>): Regra {
  return regraSchema.parse(parseJson(a.regra, {}));
}

/**
 * Gera as ocorrências de [de, ate) que ainda não existem (nunca recria uma chave já existente, processada ou não).
 * Retorna quantas foram criadas.
 */
export async function gerarOcorrencias(a: Automacao, de: Date, ate: Date): Promise<number> {
  const clienteIds = parseJson<string[]>(a.clienteIds, []);
  const canais = parseJson<string[]>(a.canais, []).filter((c): c is Canal => (CANAIS as readonly string[]).includes(c));
  const clientes = clienteIds.length ? await prisma.cliente.findMany({ where: { orgId: a.orgId, id: { in: clienteIds } }, select: { id: true } }) : [];
  if (!clientes.length || !canais.length) {
    await prisma.automacao.update({ where: { id: a.id }, data: { geradoAte: ate } });
    return 0;
  }
  const porHorario = clientes.length * canais.length;
  const limite = Math.max(1, Math.floor(MAX_LINHAS_POR_GERACAO / porHorario));
  const horarios = gerarHorarios({ regra: regraDe(a), tz: a.timezone, inicio: a.inicio, fim: a.fim, de, ate, max: a.maxEnvios ?? undefined, limite });
  // Se cortou pelo limite, o horizonte para no último horário gerado (o restante vem na próxima extensão).
  const geradoAte = horarios.length >= limite ? new Date(horarios[horarios.length - 1].getTime() + 1) : ate;
  if (!horarios.length) {
    await prisma.automacao.update({ where: { id: a.id }, data: { geradoAte } });
    return 0;
  }
  const candidatas: any[] = [];
  for (const t of horarios) for (const c of clientes) for (const canal of canais) {
    candidatas.push({ orgId: a.orgId, automacaoId: a.id, clienteId: c.id, canal, chave: chaveDe(a.id, c.id, canal, t), agendadoPara: t, executarEm: t });
  }
  const existentes = new Set<string>();
  for (let i = 0; i < candidatas.length; i += 500) {
    const ks = candidatas.slice(i, i + 500).map((x) => x.chave);
    for (const o of await prisma.ocorrencia.findMany({ where: { chave: { in: ks } }, select: { chave: true } })) existentes.add(o.chave);
  }
  const data = candidatas.filter((x) => !existentes.has(x.chave));
  for (let i = 0; i < data.length; i += 500) await prisma.ocorrencia.createMany({ data: data.slice(i, i + 500) });
  await prisma.automacao.update({ where: { id: a.id }, data: { geradoAte } });
  return data.length;
}

/** Ativa/reprograma: apaga só as PENDENTES futuras não editadas e regenera a partir de agora. Nada processado é tocado. */
export async function reprogramar(a: Automacao, now = new Date()): Promise<number> {
  await prisma.ocorrencia.deleteMany({ where: { automacaoId: a.id, status: 'PENDENTE', editada: false, tentativas: 0, agendadoPara: { gte: now } } });
  const fresh = await prisma.automacao.findUniqueOrThrow({ where: { id: a.id } });
  return gerarOcorrencias(fresh, now, new Date(now.getTime() + HORIZONTE_DIAS * 86400e3));
}

/** Estende o horizonte das automações ativas e conclui as que não têm mais nada a enviar. */
export async function estenderHorizontes(now = new Date()) {
  const alvo = new Date(now.getTime() + HORIZONTE_DIAS * 86400e3);
  const ativas = await prisma.automacao.findMany({ where: { status: 'ATIVA' } });
  for (const a of ativas) {
    try {
      const de = a.geradoAte && a.geradoAte > now ? a.geradoAte : now;
      if (!a.geradoAte || a.geradoAte.getTime() < now.getTime() + (HORIZONTE_DIAS - 7) * 86400e3) await gerarOcorrencias(a, de, alvo);
      const abertas = await prisma.ocorrencia.count({ where: { automacaoId: a.id, status: { in: ['PENDENTE', 'PROCESSANDO'] } } });
      if (abertas) continue;
      const atual = await prisma.automacao.findUniqueOrThrow({ where: { id: a.id } });
      const futuros = gerarHorarios({ regra: regraDe(atual), tz: atual.timezone, inicio: atual.inicio, fim: atual.fim, de: atual.geradoAte ?? now, ate: new Date(8.64e15), max: atual.maxEnvios ?? undefined, limite: 1 });
      if (!futuros.length) await prisma.automacao.update({ where: { id: a.id }, data: { status: 'CONCLUIDA' } });
    } catch (e) {
      console.error('[automacoes] falha ao gerar ocorrências', a.id, (e as Error).message);
    }
  }
}

// ---------------- Execução ----------------

export type Acao = 'enviada' | 'falhou' | 'nova_tentativa' | 'ignorada' | 'cancelada' | 'adiada' | 'ocupada';

/** Libera ocorrências presas em PROCESSANDO (servidor reiniciou no meio do envio). */
export async function recuperarTravadas(now = new Date()) {
  const r = await prisma.ocorrencia.updateMany({ where: { status: 'PROCESSANDO', lockedAt: { lt: new Date(now.getTime() - LOCK_MS) } }, data: { status: 'PENDENTE', lockedAt: null } });
  return r.count;
}

let ultimaExtensao = 0;
export function resetEngineState() { ultimaExtensao = 0; }

/** Um ciclo do motor: recupera travadas, estende horizontes (a cada 5 min) e processa as vencidas. */
export async function tickAutomacoes(now = new Date(), opts: { lote?: number } = {}) {
  await recuperarTravadas(now);
  if (now.getTime() - ultimaExtensao > 5 * 60_000 || now.getTime() < ultimaExtensao) {
    ultimaExtensao = now.getTime();
    await estenderHorizontes(now);
  }
  const ativas = (await prisma.automacao.findMany({ where: { status: 'ATIVA' }, select: { id: true } })).map((a) => a.id);
  if (!ativas.length) return [] as { id: string; acao: Acao }[];
  const vencidas = await prisma.ocorrencia.findMany({
    where: { status: 'PENDENTE', executarEm: { lte: now }, automacaoId: { in: ativas } },
    orderBy: { executarEm: 'asc' }, take: opts.lote ?? 25, select: { id: true },
  });
  const out: { id: string; acao: Acao }[] = [];
  for (const v of vencidas) {
    try { out.push({ id: v.id, acao: await processarOcorrencia(v.id, now) }); } catch (e) { console.error('[automacoes] erro na ocorrência', v.id, e); }
  }
  return out;
}

/** Processa uma ocorrência com claim atômico: só quem muda PENDENTE → PROCESSANDO envia. */
export async function processarOcorrencia(id: string, now = new Date()): Promise<Acao> {
  const claim = await prisma.ocorrencia.updateMany({ where: { id, status: 'PENDENTE' }, data: { status: 'PROCESSANDO', lockedAt: now } });
  if (claim.count !== 1) return 'ocupada';
  const o = await prisma.ocorrencia.findUniqueOrThrow({ where: { id } });
  const a = await prisma.automacao.findFirst({ where: { id: o.automacaoId, orgId: o.orgId } });
  const voltar = (executarEm: Date) => prisma.ocorrencia.update({ where: { id }, data: { status: 'PENDENTE', lockedAt: null, executarEm } });

  if (!a || a.status === 'CANCELADA') return finalizar(o, a, 'CANCELADA', 'Automação cancelada', now, null);
  if (a.status !== 'ATIVA') { await voltar(o.executarEm); return 'adiada'; }
  if (!(await isProductActive(o.orgId, 'MCKMENSAGEM'))) { await voltar(new Date(now.getTime() + 3600e3)); return 'adiada'; }

  const cfg = await getConfig(o.orgId);
  const janela = proximoNaJanela(now, cfg);
  if (janela.getTime() > now.getTime()) { await voltar(janela); return 'adiada'; }
  const enviadasHoje = await prisma.mensagemHistorico.count({ where: { orgId: o.orgId, status: 'ENVIADA', enviadoEm: { gte: inicioDoDia(now, cfg.timezone) } } });
  if (enviadasHoje >= cfg.limiteDiario) {
    const amanha = proximoNaJanela(new Date(inicioDoDia(now, cfg.timezone).getTime() + 86400e3 + hhmmToMin(cfg.janelaInicio) * 60e3), cfg);
    await voltar(amanha);
    return 'adiada';
  }

  const cliente = await prisma.cliente.findFirst({ where: { id: o.clienteId, orgId: o.orgId } });
  const motivo = !cliente ? 'Cliente não encontrado'
    : !cliente.consentimentoAt ? 'Cliente sem consentimento registrado para receber mensagens'
    : a.categoria === 'MARKETING' && cliente.marketingOptOutAt ? 'Cliente pediu para não receber marketing (opt-out)'
    : o.canal === 'WHATSAPP' && !(cliente.whatsapp || cliente.telefone) ? 'Cliente sem WhatsApp/telefone cadastrado'
    : o.canal === 'WHATSAPP' && !cliente.prefWhatsapp ? 'Cliente não aceita WhatsApp nas preferências de comunicação'
    : o.canal === 'EMAIL' && !cliente.email ? 'Cliente sem e-mail cadastrado'
    : o.canal === 'EMAIL' && !cliente.prefEmail ? 'Cliente não aceita e-mail nas preferências de comunicação'
    : null;
  if (motivo || !cliente) return finalizar(o, a, 'IGNORADA', motivo, now, null);

  const r = renderMensagem(o.mensagem ?? a.mensagem, cliente, a.timezone);
  const problema = problemaRender(r);
  if (problema) return finalizar(o, a, 'IGNORADA', problema, now, null);
  const assunto = a.assunto ? renderMensagem(a.assunto, cliente, a.timezone) : null;
  if (assunto && problemaRender(assunto)) return finalizar(o, a, 'IGNORADA', problemaRender(assunto), now, null);

  let res: SendResult;
  try {
    res = await senders[o.canal as Canal]({ orgId: o.orgId, automacao: a, cliente, texto: r.texto, assunto: assunto?.texto });
  } catch (e) {
    res = { ok: false, error: (e as Error).message || 'Erro no envio' };
  }
  const tentativas = o.tentativas + 1;
  if (res.ok) {
    await prisma.ocorrencia.update({ where: { id }, data: { status: 'ENVIADA', tentativas, enviadoEm: now, provedorId: res.provedorId ?? null, erro: null, lockedAt: null } });
    await historico(o, a, 'ENVIADA', { conteudo: r.texto, assunto: assunto?.texto, tentativas, enviadoEm: now, provedorId: res.provedorId ?? null });
    return 'enviada';
  }
  const erro = (res.error || 'Falha no envio').slice(0, 500);
  if (tentativas < cfg.maxTentativas) {
    const prox = new Date(now.getTime() + cfg.backoffSeg * 1000 * 2 ** (tentativas - 1));
    await prisma.ocorrencia.update({ where: { id }, data: { status: 'PENDENTE', tentativas, erro, executarEm: prox, lockedAt: null } });
    await historico(o, a, 'TENTANDO', { conteudo: r.texto, assunto: assunto?.texto, tentativas, erro });
    return 'nova_tentativa';
  }
  await prisma.ocorrencia.update({ where: { id }, data: { status: 'FALHOU', tentativas, erro, lockedAt: null } });
  await historico(o, a, 'FALHOU', { conteudo: r.texto, assunto: assunto?.texto, tentativas, erro });
  return 'falhou';
}

async function finalizar(o: Ocorrencia, a: Automacao | null, status: 'IGNORADA' | 'CANCELADA', erro: string | null, _now: Date, _p: null): Promise<Acao> {
  await prisma.ocorrencia.update({ where: { id: o.id }, data: { status, erro, lockedAt: null } });
  if (a) await historico(o, a, status, { conteudo: o.mensagem ?? a.mensagem, assunto: a.assunto, tentativas: o.tentativas, erro });
  return status === 'IGNORADA' ? 'ignorada' : 'cancelada';
}

async function historico(o: Ocorrencia, a: Automacao, status: string, d: { conteudo: string; assunto?: string | null; tentativas: number; erro?: string | null; enviadoEm?: Date; provedorId?: string | null }) {
  const data = {
    status, conteudo: d.conteudo, assunto: o.canal === 'EMAIL' ? d.assunto ?? a.nome : null, tentativas: d.tentativas,
    erro: d.erro ?? null, enviadoEm: d.enviadoEm ?? null, provedorId: d.provedorId ?? null, agendadoPara: o.agendadoPara,
  };
  await prisma.mensagemHistorico.upsert({
    where: { ocorrenciaId: o.id },
    create: { orgId: o.orgId, ocorrenciaId: o.id, automacaoId: a.id, clienteId: o.clienteId, categoria: a.categoria, canal: o.canal, ...data },
    update: data,
  });
}
