import { prisma } from '../../db.js';
import { sendOutbound } from '../../whatsapp/messaging.js';
import type { OutboundPayload } from '../../whatsapp/cloudClient.js';
import { sendMailResult } from '../../lib/mailer.js';
import { isProductActive } from '../../billing/service.js';
import { parseJson } from '../../lib/json.js';
import { gerarHorarios, regraSchema, localDate, localParts, zonedToUtc, hhmmToMin, type Regra } from './rules.js';
import { renderMensagem, problemaRender } from './vars.js';
import { lerConteudo } from './arquivos.js';
import { COBRAVEIS, atualizarVencidos, evento, reenvioPadraoDe, STATUS_LABEL } from './financeiro.js';
import type { Automacao, Cliente, Ocorrencia, AutomacaoConfig, Boleto } from '@prisma/client';

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

export interface SendResult { ok: boolean; provedorId?: string | null; error?: string | null; partesEnviadas?: number }
export interface AnexoEnvio { nome: string; mime: string; dados: Buffer; arquivoId: string; boletoId?: string | null }
export interface SendArgs {
  orgId: string; automacao: Automacao; cliente: Cliente; texto: string; assunto?: string | null;
  anexos?: AnexoEnvio[];
  /** WhatsApp: partes (texto + anexos) já enviadas numa tentativa anterior — não são repetidas. */
  partesJaEnviadas?: number;
}
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
  // Partes: o texto e depois cada anexo, na ordem definida. Numa nova tentativa, as partes já aceitas não são reenviadas.
  const partes: { payload: OutboundPayload; rotulo: string }[] = [];
  if (a.texto.trim()) partes.push({ payload: { type: 'text', text: a.texto }, rotulo: 'texto' });
  for (const x of a.anexos ?? []) partes.push({ payload: { type: 'file', data: x.dados, filename: x.nome, mime: x.mime }, rotulo: `anexo "${x.nome}"` });
  const ids: string[] = [];
  for (let i = a.partesJaEnviadas ?? 0; i < partes.length; i++) {
    const msg = await sendOutbound({ conversation: conv, contact, payload: partes[i].payload, sender: 'bot', product: 'MCKMENSAGEM' });
    if (msg.status === 'FAILED') return { ok: false, error: `${msg.error ?? 'Falha no envio pelo WhatsApp'}${partes.length > 1 ? ` (${partes[i].rotulo})` : ''}`, partesEnviadas: i };
    if (msg.waMessageId) ids.push(msg.waMessageId);
  }
  return { ok: true, provedorId: ids.join(',') || null, partesEnviadas: partes.length };
}

async function emailReal(a: SendArgs): Promise<SendResult> {
  const r = await sendMailResult({
    to: a.cliente.email!, subject: a.assunto?.trim() || a.automacao.nome, text: a.texto, html: textToHtml(a.texto),
    attachments: (a.anexos ?? []).map((x) => ({ filename: x.nome, content: x.dados, contentType: x.mime })),
  });
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
export const chaveReenvio = (automacaoId: string, clienteId: string, canal: string, boletoId: string, t: Date) => `${automacaoId}:${clienteId}:${canal}:R:${boletoId}:${t.toISOString()}`;

export function regraDe(a: Pick<Automacao, 'regra'>): Regra {
  return regraSchema.parse(parseJson(a.regra, {}));
}

export interface ReenvioCfg { offsets: number[]; horario: string; maxPorBoleto: number; mensagem?: string | null }
export const reenvioDe = (a: Pick<Automacao, 'reenvio' | 'categoria'>): ReenvioCfg | null => {
  if (a.categoria !== 'COBRANCA' || !a.reenvio) return null;
  const r = reenvioPadraoDe(a.reenvio);
  return r.offsets?.length ? r : null;
};

/** Boletos da sequência de cobrança, na ordem dos anexos (envio N → boleto). */
async function boletosDaSequencia(a: Automacao) {
  const anexos = await prisma.automacaoAnexo.findMany({ where: { automacaoId: a.id, boletoId: { not: null } }, orderBy: [{ envio: 'asc' }, { ordem: 'asc' }] });
  const porEnvio = new Map<number, string>();
  for (const x of anexos) if (x.envio != null && !porEnvio.has(x.envio)) porEnvio.set(x.envio, x.boletoId!);
  const ids = [...new Set(anexos.map((x) => x.boletoId!))];
  const boletos = ids.length ? await prisma.boleto.findMany({ where: { orgId: a.orgId, id: { in: ids } } }) : [];
  return { porEnvio, boletos };
}

const addDiasYmd = (ymd: string, n: number) => { const [y, m, d] = ymd.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };
/** Horários de reenvio de um boleto (relativos ao vencimento, no fuso da automação). */
export const horariosReenvio = (b: Pick<Boleto, 'vencimento'>, r: ReenvioCfg, tz: string) =>
  [...new Set(r.offsets)].sort((x, y) => x - y).map((off) => zonedToUtc(addDiasYmd(b.vencimento.toISOString().slice(0, 10), off), r.horario, tz));

/**
 * Gera as ocorrências de [de, ate) que ainda não existem (nunca recria uma chave já existente, processada ou não).
 * COBRANCA: cada envio N recebe o boleto do anexo N; os reenvios relativos ao vencimento viram ocorrências REENVIO.
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
  const regra = regraDe(a);
  const indices: number[] = [];
  const horarios = gerarHorarios({ regra, tz: a.timezone, inicio: a.inicio, fim: a.fim, de, ate, max: a.maxEnvios ?? undefined, limite, indices });
  // Se cortou pelo limite, o horizonte para no último horário gerado (o restante vem na próxima extensão).
  const geradoAte = horarios.length >= limite ? new Date(horarios[horarios.length - 1].getTime() + 1) : ate;
  // Texto por data (regra DATAS): vira o texto daquela ocorrência.
  const textoPorHorario = new Map<number, string>();
  if (regra.tipo === 'DATAS') for (const d of regra.datas) if (d.mensagem?.trim()) textoPorHorario.set(zonedToUtc(d.data, d.horario, a.timezone).getTime(), d.mensagem.trim());
  const seq = a.categoria === 'COBRANCA' ? await boletosDaSequencia(a) : null;

  const candidatas: any[] = [];
  horarios.forEach((t, k) => {
    for (const c of clientes) for (const canal of canais) {
      candidatas.push({
        orgId: a.orgId, automacaoId: a.id, clienteId: c.id, canal, chave: chaveDe(a.id, c.id, canal, t), agendadoPara: t, executarEm: t,
        indice: indices[k] ?? null, mensagem: textoPorHorario.get(t.getTime()) ?? null, boletoId: seq?.porEnvio.get(indices[k]) ?? null,
      });
    }
  });
  const r = reenvioDe(a);
  if (seq && r) {
    for (const b of seq.boletos) {
      if (!(COBRAVEIS as string[]).includes(b.status)) continue;
      for (const t of horariosReenvio(b, r, a.timezone)) {
        if (t < de || t >= geradoAte || t < a.inicio || (a.fim && t > a.fim)) continue;
        for (const canal of canais) {
          if (b.clienteId && clienteIds.includes(b.clienteId)) {
            candidatas.push({ orgId: a.orgId, automacaoId: a.id, clienteId: b.clienteId, canal, chave: chaveReenvio(a.id, b.clienteId, canal, b.id, t), agendadoPara: t, executarEm: t, tipo: 'REENVIO', boletoId: b.id });
          }
        }
      }
    }
  }
  if (!candidatas.length) {
    await prisma.automacao.update({ where: { id: a.id }, data: { geradoAte } });
    return 0;
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
  await prisma.ocorrencia.deleteMany({ where: { automacaoId: a.id, status: 'PENDENTE', editada: false, tentativas: 0, partesEnviadas: 0, agendadoPara: { gte: now } } });
  const fresh = await prisma.automacao.findUniqueOrThrow({ where: { id: a.id } });
  return gerarOcorrencias(fresh, now, new Date(now.getTime() + HORIZONTE_DIAS * 86400e3));
}

/** Há reenvio de cobrança ainda por gerar depois de "apos"? (impede concluir a sequência cedo demais) */
async function temReenvioFuturo(a: Automacao, apos: Date) {
  const r = reenvioDe(a);
  if (!r) return false;
  const { boletos } = await boletosDaSequencia(a);
  return boletos.some((b) => (COBRAVEIS as string[]).includes(b.status) && horariosReenvio(b, r, a.timezone).some((t) => t >= apos && (!a.fim || t <= a.fim)));
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
      if (!futuros.length && !(await temReenvioFuturo(atual, atual.geradoAte ?? now))) await prisma.automacao.update({ where: { id: a.id }, data: { status: 'CONCLUIDA' } });
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

/** Um ciclo do motor: recupera travadas, estende horizontes e marca boletos vencidos (a cada 5 min) e processa as vencidas. */
export async function tickAutomacoes(now = new Date(), opts: { lote?: number } = {}) {
  await recuperarTravadas(now);
  if (now.getTime() - ultimaExtensao > 5 * 60_000 || now.getTime() < ultimaExtensao) {
    ultimaExtensao = now.getTime();
    await atualizarVencidos(now).catch((e) => console.error('[automacoes] falha ao atualizar vencidos', (e as Error).message));
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

export interface EnvioPreparado { ok: true; texto: string; assunto: string | null; anexos: AnexoEnvio[]; boletos: Boleto[] }
export type Preparo = EnvioPreparado | { ok: false; motivo: string };

const motivoBoleto = (b: Boleto) => b.status === 'PAGO' ? 'Boleto já pago — cobrança não enviada'
  : b.status === 'CANCELADO' ? 'Boleto cancelado — cobrança não enviada'
    : b.status === 'EM_ANALISE' ? 'Comprovante do boleto em análise — cobrança suspensa até a conferência'
      : `Boleto com status ${STATUS_LABEL[b.status] ?? b.status} — cobrança não enviada`;

/**
 * Monta texto, assunto e anexos de um envio, conferindo o status atualizado dos boletos antes de qualquer cobrança
 * (seção 15: "verificar se o boleto já foi pago antes de realizar uma cobrança").
 */
export async function prepararEnvio(a: Automacao, cliente: Cliente, o: { indice: number | null; tipo: string; boletoId: string | null; mensagem: string | null; canal: string; ocorrenciaId?: string }): Promise<Preparo> {
  const avulso = o.tipo === 'REENVIO' || o.tipo === 'MANUAL'; // reenvio automático ou manual: só o boleto daquela ocorrência
  const defs = avulso ? []
    : await prisma.automacaoAnexo.findMany({ where: { automacaoId: a.id, OR: [{ envio: null }, ...(o.indice != null ? [{ envio: o.indice }] : [])] }, orderBy: [{ ordem: 'asc' }] });
  const boletoIds = avulso ? (o.boletoId ? [o.boletoId] : []) : defs.filter((d) => d.boletoId).map((d) => d.boletoId!);
  if (boletoIds.length && a.categoria !== 'COBRANCA') return { ok: false, motivo: 'Boleto só pode ser enviado por automações de cobrança' };
  const boletos = boletoIds.length ? await prisma.boleto.findMany({ where: { orgId: a.orgId, id: { in: boletoIds } } }) : [];
  if (boletos.length !== new Set(boletoIds).size) return { ok: false, motivo: 'Boleto da sequência não encontrado' };
  if (boletos.some((b) => b.clienteId !== cliente.id)) return { ok: false, motivo: 'Boleto pertence a outro cliente — envio bloqueado' };
  const cobraveis = boletoIds.map((id) => boletos.find((b) => b.id === id)!).filter((b) => (COBRAVEIS as string[]).includes(b.status));
  if (boletoIds.length && !cobraveis.length) return { ok: false, motivo: motivoBoleto(boletos.find((b) => b.id === boletoIds[0])!) };
  if (o.tipo === 'REENVIO') {
    const b = cobraveis[0];
    if (!b.enviadoEm) return { ok: false, motivo: 'Reenvio ignorado: este boleto ainda não foi enviado nenhuma vez' };
    const r = reenvioDe(a);
    const feitos = await prisma.ocorrencia.count({ where: { automacaoId: a.id, boletoId: b.id, tipo: 'REENVIO', canal: o.canal, status: 'ENVIADA' } });
    if (r && feitos >= r.maxPorBoleto) return { ok: false, motivo: `Limite de ${r.maxPorBoleto} reenvio(s) deste boleto atingido` };
  }
  const principal = cobraveis[0] ?? null;
  const tpl = o.mensagem ?? (avulso ? reenvioDe(a)?.mensagem?.trim() || a.mensagem : a.mensagem);
  const r = renderMensagem(tpl, cliente, a.timezone, { boleto: principal });
  const problema = problemaRender(r);
  if (problema) return { ok: false, motivo: problema };
  const assunto = a.assunto ? renderMensagem(a.assunto, cliente, a.timezone, { boleto: principal }) : null;
  if (assunto && problemaRender(assunto)) return { ok: false, motivo: problemaRender(assunto)! };

  // Arquivos na ordem definida: anexos avulsos e o PDF de cada boleto ainda cobrável.
  const anexos: AnexoEnvio[] = [];
  const itens = avulso ? [{ arquivoId: null as string | null, boletoId: principal?.id ?? null }] : defs;
  for (const d of itens) {
    let arquivoId = d.arquivoId;
    if (d.boletoId) {
      const b = cobraveis.find((x) => x.id === d.boletoId);
      if (!b) continue; // boleto pago/cancelado no meio da sequência: só ele sai da mensagem
      arquivoId = b.arquivoId;
      if (!arquivoId) continue; // boleto sem PDF: segue só com os dados (linha digitável/link) no texto
    }
    if (!arquivoId) continue;
    const arq = await prisma.arquivo.findFirst({ where: { id: arquivoId, orgId: a.orgId } });
    if (!arq) return { ok: false, motivo: 'Arquivo anexado não existe mais' };
    if (arq.clienteId && arq.clienteId !== cliente.id) return { ok: false, motivo: 'Arquivo anexado pertence a outro cliente — envio bloqueado' };
    anexos.push({ nome: arq.nome, mime: arq.mime, dados: await lerConteudo(arq.id), arquivoId: arq.id, boletoId: d.boletoId ?? null });
  }
  return { ok: true, texto: r.texto, assunto: assunto?.texto ?? null, anexos, boletos: cobraveis };
}

/** Atualiza o status de envio dos boletos (não mexe no status financeiro). */
async function marcarBoletosEnviados(boletos: Boleto[], canal: string, tipo: string, now: Date) {
  for (const b of boletos) {
    await prisma.boleto.update({ where: { id: b.id }, data: { statusEnvio: 'ENVIADO', enviadoEm: now, envios: { increment: 1 } } });
    await evento(b, 'ENVIADO', `${tipo === 'REENVIO' ? 'Reenviado' : tipo === 'MANUAL' ? 'Reenviado manualmente' : 'Enviado'} por ${canal === 'EMAIL' ? 'e-mail' : 'WhatsApp'} (o status financeiro não muda com o envio)`, { canal, tipo });
  }
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

  let prep: Preparo;
  try {
    prep = await prepararEnvio(a, cliente, { indice: o.indice, tipo: o.tipo, boletoId: o.boletoId, mensagem: o.mensagem, canal: o.canal, ocorrenciaId: o.id });
  } catch (e) {
    prep = { ok: false, motivo: `Falha ao preparar o envio: ${(e as Error).message}` };
  }
  if (!prep.ok) return finalizar(o, a, 'IGNORADA', prep.motivo, now, null);
  const anexosInfo = prep.anexos.map((x) => ({ arquivoId: x.arquivoId, nome: x.nome, boletoId: x.boletoId ?? null }));
  const extra = { anexos: anexosInfo, boletoId: prep.boletos[0]?.id ?? o.boletoId ?? null };

  let res: SendResult;
  try {
    res = await senders[o.canal as Canal]({ orgId: o.orgId, automacao: a, cliente, texto: prep.texto, assunto: prep.assunto, anexos: prep.anexos, partesJaEnviadas: o.partesEnviadas });
  } catch (e) {
    res = { ok: false, error: (e as Error).message || 'Erro no envio' };
  }
  const tentativas = o.tentativas + 1;
  const partesEnviadas = Math.max(o.partesEnviadas, res.partesEnviadas ?? 0);
  if (res.ok) {
    await prisma.ocorrencia.update({ where: { id }, data: { status: 'ENVIADA', tentativas, enviadoEm: now, provedorId: res.provedorId ?? null, erro: null, lockedAt: null, partesEnviadas } });
    await historico(o, a, 'ENVIADA', { conteudo: prep.texto, assunto: prep.assunto, tentativas, enviadoEm: now, provedorId: res.provedorId ?? null, ...extra });
    await marcarBoletosEnviados(prep.boletos, o.canal, o.tipo, now);
    return 'enviada';
  }
  const erro = (res.error || 'Falha no envio').slice(0, 500);
  if (tentativas < cfg.maxTentativas) {
    const prox = new Date(now.getTime() + cfg.backoffSeg * 1000 * 2 ** (tentativas - 1));
    await prisma.ocorrencia.update({ where: { id }, data: { status: 'PENDENTE', tentativas, erro, executarEm: prox, lockedAt: null, partesEnviadas } });
    await historico(o, a, 'TENTANDO', { conteudo: prep.texto, assunto: prep.assunto, tentativas, erro, ...extra });
    return 'nova_tentativa';
  }
  await prisma.ocorrencia.update({ where: { id }, data: { status: 'FALHOU', tentativas, erro, lockedAt: null, partesEnviadas } });
  await historico(o, a, 'FALHOU', { conteudo: prep.texto, assunto: prep.assunto, tentativas, erro, ...extra });
  for (const b of prep.boletos) {
    if (b.statusEnvio !== 'ENVIADO') await prisma.boleto.update({ where: { id: b.id }, data: { statusEnvio: 'FALHOU' } });
    await evento(b, 'ENVIO_FALHOU', `Falha definitiva no ${o.tipo === 'REENVIO' ? 'reenvio' : 'envio'} por ${o.canal === 'EMAIL' ? 'e-mail' : 'WhatsApp'}: ${erro}`, { canal: o.canal });
  }
  return 'falhou';
}

async function finalizar(o: Ocorrencia, a: Automacao | null, status: 'IGNORADA' | 'CANCELADA', erro: string | null, _now: Date, _p: null): Promise<Acao> {
  await prisma.ocorrencia.update({ where: { id: o.id }, data: { status, erro, lockedAt: null } });
  if (a) await historico(o, a, status, { conteudo: o.mensagem ?? a.mensagem, assunto: a.assunto, tentativas: o.tentativas, erro, boletoId: o.boletoId });
  return status === 'IGNORADA' ? 'ignorada' : 'cancelada';
}

interface HistDados { conteudo: string; assunto?: string | null; tentativas: number; erro?: string | null; enviadoEm?: Date; provedorId?: string | null; anexos?: unknown[]; boletoId?: string | null }

async function historico(o: Ocorrencia, a: Automacao, status: string, d: HistDados) {
  const data = {
    status, conteudo: d.conteudo, assunto: o.canal === 'EMAIL' ? d.assunto ?? a.nome : null, tentativas: d.tentativas,
    erro: d.erro ?? null, enviadoEm: d.enviadoEm ?? null, provedorId: d.provedorId ?? null, agendadoPara: o.agendadoPara,
    anexos: d.anexos?.length ? JSON.stringify(d.anexos) : null, boletoId: d.boletoId ?? null,
  };
  await prisma.mensagemHistorico.upsert({
    where: { ocorrenciaId: o.id },
    create: { orgId: o.orgId, ocorrenciaId: o.id, automacaoId: a.id, clienteId: o.clienteId, categoria: a.categoria, canal: o.canal, ...data },
    update: data,
  });
}

/** Teste de envio para um destinatário autorizado (imediato, não cria ocorrência e não conta como envio da sequência). */
export async function enviarTeste(a: Automacao, cliente: Cliente, canal: Canal, operadorId: string, envio: number | null): Promise<{ ok: boolean; erro?: string | null; texto?: string; anexos?: string[] }> {
  const prep = await prepararEnvio(a, cliente, { indice: envio, tipo: 'ENVIO', boletoId: null, mensagem: null, canal });
  if (!prep.ok) return { ok: false, erro: prep.motivo };
  let res: SendResult;
  try { res = await senders[canal]({ orgId: a.orgId, automacao: a, cliente, texto: `[TESTE] ${prep.texto}`, assunto: prep.assunto ? `[TESTE] ${prep.assunto}` : null, anexos: prep.anexos }); } catch (e) { res = { ok: false, error: (e as Error).message }; }
  await prisma.mensagemHistorico.create({
    data: {
      orgId: a.orgId, automacaoId: a.id, clienteId: cliente.id, categoria: a.categoria, canal, conteudo: `[TESTE] ${prep.texto}`, assunto: canal === 'EMAIL' ? prep.assunto : null,
      status: res.ok ? 'ENVIADA' : 'FALHOU', erro: res.ok ? null : res.error ?? 'Falha', enviadoEm: res.ok ? new Date() : null, provedorId: res.provedorId ?? null, tentativas: 1, operadorId,
      anexos: prep.anexos.length ? JSON.stringify(prep.anexos.map((x) => ({ arquivoId: x.arquivoId, nome: x.nome }))) : null,
    },
  });
  return { ok: res.ok, erro: res.ok ? null : res.error, texto: prep.texto, anexos: prep.anexos.map((x) => x.nome) };
}
