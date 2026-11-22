/**
 * v1.45.0 — Aquecimento ATIVO do número (WhatsApp por QR): banco, envio e agendador.
 *
 * - Conversas automáticas entre os números QR conectados da PRÓPRIA empresa (e, se ela quiser, até 5 números extras
 *   que ela declarou serem dela). Nunca envia para contato/cliente: todo destino passa por `destinoPermitido`.
 * - As mensagens ficam na tabela WarmupMessage, fora de Message: não aparecem no Inbox, não abrem conversa nem contato,
 *   não acionam IA/fluxos/SDR/distribuição/horário/pesquisa/repescagem e não entram em leads nem relatórios.
 * - Agendador `tickAquecimento` (a cada 30 s): respostas vencidas (claim atômico) e novas conversas (trava por nextAt).
 * - AQUECIMENTO=off no ambiente para tudo na hora (emergência). O reconhecimento das mensagens recebidas continua
 *   ligado mesmo assim (uma mensagem de aquecimento atrasada nunca vira conversa de cliente).
 */
import { generateMessageIDV2, type WAMessage } from '@whiskeysockets/baileys';
import type { Channel, WarmupConfig } from '@prisma/client';
import { prisma } from '../../db.js';
import { qrManager } from '../qr/manager.js';
import { waIdToJid, jidToNumber } from '../qr/parse.js';
import type { InboundMessage } from '../cloudClient.js';
import { saudeDoNumero } from '../protecao/service.js';
import { isProductActive } from '../../billing/service.js';
import { aiChat } from '../../ai/core.js';
import { mckQuotaStatus } from '../../ai/mckQuota.js';
import {
  AQUECIMENTO_PADRAO, DIAS_NUMERO_NOVO, MOTIVO_TEXTO, REACOES, TEMAS,
  atrasoRespostaMs, conversaLocal, decidirAquecimento, destinoPermitido, diaAtivo, faixaDoDia, mensagemAvulsaLocal,
  mesmoNumero, metaDoDia, msAteFimDaJanela, proximoInicioDaJanela, proximoIntervaloMs, relogio, soDigitos,
  tempoDigitandoAquecimentoMs, validarRoteiroIa, type AquecimentoConfig, type MotivoParada,
} from './core.js';

const MIN_MS = 60_000, HOUR_MS = 3600e3, DAY_MS = 24 * HOUR_MS;
const PROVIDER_QR = 'whatsapp_qr';
/** Teto de mensagens/dia de um número que só ajuda (não está em aquecimento). */
const TETO_PAR = 80;
/** Chamadas de IA para aquecimento por empresa por dia (o resto usa o banco local). */
const IA_POR_DIA = 30;

/** AQUECIMENTO=off desliga o aquecimento ativo no servidor todo (emergência). */
export function aquecimentoNoAmbiente(): boolean {
  return (process.env.AQUECIMENTO ?? '').toLowerCase() !== 'off';
}

let random: () => number = Math.random;
/** Somente testes: sorteios previsíveis. */
export function setAquecimentoRandom(fn: (() => number) | null) { random = fn ?? Math.random; }
const escala = () => Number(process.env.AQUECIMENTO_DELAY_SCALE ?? (process.env.NODE_ENV === 'test' ? 0 : 1));
const esperar = (ms: number) => { const t = ms * escala(); return t > 0 ? new Promise((r) => setTimeout(r, t)) : Promise.resolve(); };

export function configDe(row: WarmupConfig | null): AquecimentoConfig {
  if (!row) return { ...AQUECIMENTO_PADRAO, peerChannelIds: [] };
  return {
    enabled: row.enabled, days: row.days, startHour: row.startHour, endHour: row.endHour,
    peerChannelIds: row.peerChannelIds.split(',').map((s) => s.trim()).filter(Boolean),
    allowAsPeer: row.allowAsPeer, useAi: row.useAi, useExtras: row.useExtras,
  };
}

type CanalQr = Pick<Channel, 'id' | 'orgId' | 'name' | 'displayPhone' | 'waJid' | 'createdAt' | 'status' | 'provider'>;
const numeroDoCanal = (c: Pick<Channel, 'displayPhone' | 'waJid'>) => soDigitos(c.displayPhone) || soDigitos(jidToNumber(c.waJid));

/** Números próprios da empresa: números QR dela + extras declarados. Base da trava `destinoPermitido`. */
export async function numerosProprios(orgId: string): Promise<string[]> {
  const [chs, extras] = await Promise.all([
    prisma.channel.findMany({ where: { orgId, provider: PROVIDER_QR }, select: { displayPhone: true, waJid: true } }),
    prisma.warmupExtraNumber.findMany({ where: { orgId }, select: { phone: true } }),
  ]);
  return [...chs.map(numeroDoCanal), ...extras.map((e) => e.phone)].filter(Boolean);
}

const inicioDe = (row: WarmupConfig | null, channel: Pick<Channel, 'createdAt'>) => row?.startedAt ?? channel.createdAt;

/** Mensagens de aquecimento enviadas (texto) por este número desde `desde`. */
const enviadasDesde = (channelId: string, desde: Date) =>
  prisma.warmupMessage.count({ where: { channelId, direction: 'OUT', kind: 'text', createdAt: { gte: desde } } });

/** Teto de hoje para um número que vai mandar uma resposta (em aquecimento: máximo da faixa; só ajudando: 80). */
async function tetoHoje(channel: CanalQr, now: Date): Promise<number> {
  const row = await prisma.warmupConfig.findUnique({ where: { channelId: channel.id } });
  const cfg = configDe(row);
  if (cfg.enabled) {
    const fx = faixaDoDia(diaAtivo(inicioDe(row, channel), now), cfg.days);
    if (fx) return fx.max;
  }
  return TETO_PAR;
}

// ---------- Envio ----------

/**
 * Envia uma mensagem de aquecimento: confere a trava de número próprio, mostra "digitando…", grava a mensagem
 * (com o id escolhido antes, para o outro número reconhecer) e envia. Devolve false se não saiu.
 */
export async function enviarAquecimento(a: {
  from: CanalQr; para: string; texto: string; peerChannelId?: string | null; exchangeId?: string | null; source?: string; now?: Date;
}): Promise<boolean> {
  const proprios = await numerosProprios(a.from.orgId);
  const destino = soDigitos(a.para);
  // Nunca para o próprio número que envia, nunca para quem não é número próprio da empresa.
  if (!destinoPermitido(destino, proprios) || mesmoNumero(destino, numeroDoCanal(a.from))) {
    console.warn('[aquecimento] destino recusado (não é número próprio)', { channelId: a.from.id });
    return false;
  }
  if (!qrManager.isConnected(a.from.id)) return false;
  const jid = waIdToJid(destino);
  await qrManager.presenceJid(a.from.id, jid, 'composing');
  await esperar(tempoDigitandoAquecimentoMs(a.texto, random));
  await qrManager.presenceJid(a.from.id, jid, 'paused');
  const id = generateMessageIDV2();
  const row = await prisma.warmupMessage.create({ data: {
    orgId: a.from.orgId, channelId: a.from.id, direction: 'OUT', kind: 'text', body: a.texto.slice(0, 500), waMessageId: id, jid,
    peerChannelId: a.peerChannelId ?? null, peerPhone: destino, exchangeId: a.exchangeId ?? null, source: a.source ?? 'local', createdAt: a.now ?? new Date(),
  } });
  try {
    await qrManager.sendRaw(a.from.id, jid, { text: a.texto }, id);
    return true;
  } catch (e) {
    await prisma.warmupMessage.delete({ where: { id: row.id } }).catch(() => undefined);
    console.warn('[aquecimento] falha ao enviar', { channelId: a.from.id, error: (e as Error).message });
    return false;
  }
}

// ---------- Recebimento ----------

/**
 * Mensagem recebida por um número QR: é de aquecimento? Se for, grava em WarmupMessage, marca como lida e às vezes
 * reage, e devolve true (quem chamou NÃO segue para contato/conversa/IA/fluxos). Nunca lança.
 *
 * É de aquecimento quando: (1) o id é de uma mensagem de aquecimento enviada por outro número da empresa; ou
 * (2) vem de outro número QR da empresa com aquecimento entre os dois nas últimas 2 h; ou (3) vem de um número extra
 * declarado pela empresa a quem este número mandou aquecimento nas últimas 3 h.
 */
export async function tratarRecebidoAquecimento(channel: Channel, raw: WAMessage | null, m: InboundMessage, now = new Date()): Promise<boolean> {
  try {
    if (channel.provider !== PROVIDER_QR) return false;
    let peerChannelId: string | null = null, peerPhone: string | null = null;
    const porId = await prisma.warmupMessage.findFirst({ where: { orgId: channel.orgId, waMessageId: m.waMessageId, direction: 'OUT' }, select: { channelId: true } });
    if (porId && porId.channelId !== channel.id) {
      peerChannelId = porId.channelId;
    } else {
      const remetente = soDigitos(m.from);
      if (!remetente) return false;
      const outros = await prisma.channel.findMany({ where: { orgId: channel.orgId, provider: PROVIDER_QR, id: { not: channel.id } }, select: { id: true, displayPhone: true, waJid: true } });
      const outro = outros.find((o) => mesmoNumero(numeroDoCanal(o), remetente));
      if (outro) {
        const recente = await prisma.warmupMessage.findFirst({ where: { createdAt: { gte: new Date(now.getTime() - 2 * HOUR_MS) }, OR: [{ channelId: channel.id, peerChannelId: outro.id }, { channelId: outro.id, peerChannelId: channel.id }] }, select: { id: true } });
        if (!recente) return false;
        peerChannelId = outro.id;
      } else {
        const extras = await prisma.warmupExtraNumber.findMany({ where: { orgId: channel.orgId }, select: { phone: true } });
        const extra = extras.find((e) => mesmoNumero(e.phone, remetente));
        if (!extra) return false;
        const recente = await prisma.warmupMessage.findFirst({ where: { channelId: channel.id, direction: 'OUT', peerPhone: extra.phone, createdAt: { gte: new Date(now.getTime() - 3 * HOUR_MS) } }, select: { id: true } });
        if (!recente) return false;
        peerPhone = extra.phone;
      }
    }
    const dup = await prisma.warmupMessage.findFirst({ where: { channelId: channel.id, direction: 'IN', waMessageId: m.waMessageId }, select: { id: true } });
    if (!dup) {
      await prisma.warmupMessage.create({ data: {
        orgId: channel.orgId, channelId: channel.id, direction: 'IN', kind: 'text', body: (m.text || `[${m.type}]`).slice(0, 500),
        waMessageId: m.waMessageId, jid: raw?.key?.remoteJid ?? null, peerChannelId, peerPhone: peerPhone ?? (soDigitos(m.from) || null), createdAt: now,
      } });
      const pos = posRecebimento(channel, raw, peerChannelId, peerPhone);
      if (escala() === 0) await pos; else void pos;
    }
    return true;
  } catch (e) {
    console.warn('[aquecimento] falha ao conferir mensagem recebida', { channelId: channel.id, error: (e as Error).message });
    return false;
  }
}

/** Depois de receber: marca como lida (2–20 s) e, às vezes (20%), reage com um emoji. */
async function posRecebimento(channel: Channel, raw: WAMessage | null, peerChannelId: string | null, peerPhone: string | null) {
  try {
    const key = raw?.key;
    if (!key?.id || !key.remoteJid) return;
    await esperar(2000 + random() * 18_000);
    await qrManager.markRead(channel.id, { remoteJid: key.remoteJid, id: key.id, participant: key.participant ?? null });
    if (random() < 0.2 && aquecimentoNoAmbiente()) {
      await esperar(1500 + random() * 8000);
      const emoji = REACOES[Math.floor(random() * REACOES.length)] ?? '👍';
      await qrManager.sendRaw(channel.id, key.remoteJid, { react: { text: emoji, key: { remoteJid: key.remoteJid, id: key.id, fromMe: false } } });
      await prisma.warmupMessage.create({ data: { orgId: channel.orgId, channelId: channel.id, direction: 'OUT', kind: 'reaction', body: emoji, peerChannelId, peerPhone, jid: key.remoteJid } });
    }
  } catch { /* detalhe visual: nunca derruba nada */ }
}

// ---------- Frases (IA da empresa ou banco local) ----------

export async function gerarRoteiro(orgId: string, falas: number, usarIa: boolean, now = new Date()): Promise<{ falas: string[]; fonte: 'ia' | 'local' }> {
  const local = { falas: conversaLocal(falas, random), fonte: 'local' as const };
  if (!usarIa) return local;
  try {
    const ai = await prisma.aiSettings.findUnique({ where: { orgId } });
    if (!ai) return local;
    if (ai.provider !== 'mck' && ai.provider !== 'fake' && !ai.apiKeyEnc) return local;
    const dia = relogio(now).inicioDoDia;
    // Nunca tira cota do atendimento: só usa IA com folga (até metade da cota/limite do dia) e no máximo 30 por dia.
    if (ai.provider === 'mck') {
      const q = await mckQuotaStatus(orgId, now);
      if (q.reached || (q.limit > 0 && q.used >= q.limit * 0.5)) return local;
    }
    const [hoje, doAquecimento] = await Promise.all([
      prisma.aiUsage.count({ where: { orgId, createdAt: { gte: dia } } }),
      prisma.aiUsage.count({ where: { orgId, purpose: 'aquecimento', createdAt: { gte: dia } } }),
    ]);
    if (ai.usageLimitEnabled !== false && hoje >= ai.dailyLimit * 0.5) return local;
    if (doAquecimento >= IA_POR_DIA) return local;
    const tema = TEMAS[Math.floor(random() * TEMAS.length)];
    const system = [
      `Escreva uma conversa curta e casual de WhatsApp entre duas pessoas que se conhecem (colegas ou amigos), em português do Brasil, com exatamente ${falas} falas alternadas (a primeira pessoa começa).`,
      `Tema: ${tema}. Linguagem natural do dia a dia, frases curtas (até 120 caracteres), às vezes com 1 emoji, às vezes com "kkk" ou "haha".`,
      'Proibido: links, números de telefone, e-mails, valores, nomes de empresas ou marcas, assunto de venda, promoção ou atendimento. Não use nomes próprios.',
      'Responda SOMENTE com uma lista JSON de textos, por exemplo: ["Oi, tudo bem?", "Tudo sim, e você?"]',
    ].join('\n');
    const r = await aiChat({
      orgId, purpose: 'aquecimento', settings: ai,
      messages: [{ role: 'system', content: system }, { role: 'user', content: 'Escreva a conversa agora.' }],
      temperature: 1, maxTokens: 400, timeoutMs: 15000, retries: 0,
    });
    const ok = validarRoteiroIa(r.text);
    return ok && ok.length >= Math.min(2, falas) ? { falas: ok.slice(0, falas), fonte: 'ia' } : local;
  } catch {
    return local;
  }
}

// ---------- Agendador ----------

export type AquecimentoAcao = { channelId: string; acao: 'iniciada' | 'avulsa' | 'respondida' | 'concluida' | 'cancelada' | MotivoParada | 'falhou' | 'ocupado' };

async function canalQr(id: string): Promise<CanalQr | null> {
  return prisma.channel.findFirst({ where: { id, provider: PROVIDER_QR }, select: { id: true, orgId: true, name: true, displayPhone: true, waJid: true, createdAt: true, status: true, provider: true } });
}

/** Pode este número mandar uma resposta de aquecimento agora? (conectado, sem Risco, na janela, assinatura, teto) */
async function podeResponder(c: CanalQr, now: Date, nivelDe: (c: CanalQr) => Promise<string>): Promise<MotivoParada | null> {
  if (!qrManager.isConnected(c.id)) return 'desconectado';
  const cfg = configDe(await prisma.warmupConfig.findUnique({ where: { channelId: c.id } }));
  const { hora } = relogio(now);
  if (hora < cfg.startHour || hora >= cfg.endHour) return 'fora_horario';
  if ((await nivelDe(c)) === 'RISCO') return 'risco';
  if (!(await isProductActive(c.orgId, 'MCKBOT').catch(() => false))) return 'assinatura';
  if ((await enviadasDesde(c.id, relogio(now).inicioDoDia)) >= (await tetoHoje(c, now))) return 'meta';
  return null;
}

const ABERTA = { in: ['PENDENTE', 'ENVIANDO'] };

/** Um passo do aquecimento. Idempotente: cada resposta e cada nova conversa têm trava atômica no banco. */
export async function tickAquecimento(now = new Date()): Promise<AquecimentoAcao[]> {
  const out: AquecimentoAcao[] = [];
  if (!aquecimentoNoAmbiente()) return out;
  const niveis = new Map<string, string>();
  const nivelDe = async (c: CanalQr) => {
    if (!niveis.has(c.id)) {
      const full = await prisma.channel.findUnique({ where: { id: c.id } });
      niveis.set(c.id, full ? (await saudeDoNumero(full, now).catch(() => null))?.nivel ?? 'BOM' : 'BOM');
    }
    return niveis.get(c.id)!;
  };

  // Envio interrompido no meio (servidor caiu): não reenvia, só encerra a conversa.
  await prisma.warmupExchange.updateMany({ where: { status: 'ENVIANDO', claimedAt: { lt: new Date(now.getTime() - 10 * MIN_MS) } }, data: { status: 'CANCELADA', note: 'interrompida' } });

  // 1) Respostas vencidas (ida e volta).
  const vencidas = await prisma.warmupExchange.findMany({ where: { status: 'PENDENTE', dueAt: { lte: now } }, orderBy: { dueAt: 'asc' }, take: 10 });
  for (const ex of vencidas) {
    const claim = await prisma.warmupExchange.updateMany({ where: { id: ex.id, status: 'PENDENTE' }, data: { status: 'ENVIANDO', claimedAt: now } });
    if (claim.count !== 1) continue;
    const fim = (status: 'CONCLUIDA' | 'CANCELADA', note?: string) => prisma.warmupExchange.update({ where: { id: ex.id }, data: { status, note: note ?? null } });
    let falas: string[] = [];
    try { falas = JSON.parse(ex.lines); } catch { /* inválido */ }
    const i = ex.nextIndex;
    if (i >= falas.length) { await fim('CONCLUIDA'); out.push({ channelId: ex.initiatorChannelId, acao: 'concluida' }); continue; }
    const [ini, par] = await Promise.all([canalQr(ex.initiatorChannelId), canalQr(ex.peerChannelId)]);
    if (!ini || !par) { await fim('CANCELADA', 'canal removido'); continue; }
    const de = i % 2 === 0 ? ini : par, para = i % 2 === 0 ? par : ini;
    const motivo = await podeResponder(de, now, nivelDe);
    if (motivo) { await fim('CANCELADA', motivo); out.push({ channelId: de.id, acao: 'cancelada' }); continue; }
    const ok = await enviarAquecimento({ from: de, para: numeroDoCanal(para), texto: falas[i], peerChannelId: para.id, exchangeId: ex.id, source: ex.source, now });
    if (!ok) { await fim('CANCELADA', 'falha no envio'); out.push({ channelId: de.id, acao: 'falhou' }); continue; }
    if (i + 1 < falas.length) {
      await prisma.warmupExchange.update({ where: { id: ex.id }, data: { status: 'PENDENTE', nextIndex: i + 1, dueAt: new Date(now.getTime() + atrasoRespostaMs(random)), claimedAt: null } });
    } else {
      await prisma.warmupExchange.update({ where: { id: ex.id }, data: { status: 'CONCLUIDA', nextIndex: i + 1 } });
    }
    out.push({ channelId: de.id, acao: 'respondida' });
  }

  // 2) Novas conversas (no máximo uma por número por passo).
  const prontos = await prisma.warmupConfig.findMany({ where: { enabled: true, OR: [{ nextAt: null }, { nextAt: { lte: now } }] }, take: 50 });
  for (const row of prontos) {
    const claim = await prisma.warmupConfig.updateMany({
      where: { channelId: row.channelId, enabled: true, OR: [{ nextAt: null }, { nextAt: { lte: now } }] },
      data: { nextAt: new Date(now.getTime() + 3 * MIN_MS) },
    });
    if (claim.count !== 1) continue;
    const agendar = (at: Date, pausa?: MotivoParada | null) => prisma.warmupConfig.update({
      where: { channelId: row.channelId },
      data: { nextAt: at, ...(pausa === undefined ? {} : { pausedReason: pausa, pausedAt: pausa ? (row.pausedReason === pausa ? row.pausedAt : now) : null }) },
    });
    const ch = await canalQr(row.channelId);
    if (!ch) { await agendar(new Date(now.getTime() + HOUR_MS)); continue; }
    const cfg = configDe(row);
    // Já há conversa em andamento com este número: espera terminar (nunca duas ao mesmo tempo).
    if (await prisma.warmupExchange.findFirst({ where: { status: ABERTA, OR: [{ initiatorChannelId: ch.id }, { peerChannelId: ch.id }] }, select: { id: true } })) {
      await agendar(new Date(now.getTime() + (5 + random() * 10) * MIN_MS)); out.push({ channelId: ch.id, acao: 'ocupado' }); continue;
    }
    const conectado = qrManager.isConnected(ch.id);
    const pares = conectado ? await paresDe(ch, cfg, now, nivelDe) : { canais: [], extras: [] };
    const diaIni = relogio(now).inicioDoDia;
    const enviadosHoje = await enviadasDesde(ch.id, diaIni);
    const d = decidirAquecimento({
      ambienteLigado: true, cfg, inicio: inicioDe(row, ch), now, conectado,
      nivel: conectado ? (await nivelDe(ch)) as 'BOM' : null,
      assinaturaAtiva: conectado ? await isProductActive(ch.orgId, 'MCKBOT').catch(() => false) : true,
      enviadosHoje, temPar: pares.canais.length + pares.extras.length > 0,
    });
    const amanha = () => new Date(proximoInicioDaJanela(new Date(diaIni.getTime() + DAY_MS - 1), cfg.startHour).getTime() + random() * 40 * MIN_MS);
    if (!d.pode) {
      const m = d.motivo;
      if (m === 'fora_horario') await agendar(new Date(proximoInicioDaJanela(now, cfg.startHour).getTime() + random() * 40 * MIN_MS), null);
      else if (m === 'meta') await agendar(amanha(), null);
      else if (m === 'concluido') await agendar(new Date(now.getTime() + DAY_MS), null);
      else await agendar(new Date(now.getTime() + 15 * MIN_MS), m === 'risco' || m === 'desconectado' || m === 'assinatura' || m === 'sem_par' ? m : null);
      out.push({ channelId: ch.id, acao: m });
      continue;
    }
    const meta = metaDoDia(ch.id, relogio(now).data, d.dia, cfg.days);
    if (enviadosHoje >= meta) { await agendar(amanha(), null); out.push({ channelId: ch.id, acao: 'meta' }); continue; }
    const faltam = meta - enviadosHoje;
    const proximo = () => new Date(now.getTime() + proximoIntervaloMs({ faltam: Math.max(0, faltam - 1), msRestantes: msAteFimDaJanela(now, cfg.startHour, cfg.endHour), rand: random }));

    // Par: outro número da empresa (conversa de ida e volta) ou, às vezes (25%), um número extra (mensagem avulsa).
    const usarExtra = pares.extras.length > 0 && (pares.canais.length === 0 || random() < 0.25);
    if (usarExtra) {
      const extra = pares.extras[Math.floor(random() * pares.extras.length)];
      const destino = (await qrManager.resolveNumber(ch.id, extra)) ?? null;
      const roteiro = cfg.useAi ? await gerarRoteiro(ch.orgId, 2, true, now) : { falas: [mensagemAvulsaLocal(random)], fonte: 'local' as const };
      const ok = !!destino && mesmoNumero(destino, extra) && await enviarAquecimento({ from: ch, para: destino, texto: roteiro.falas[0], source: roteiro.fonte, now });
      await agendar(proximo(), null);
      out.push({ channelId: ch.id, acao: ok ? 'avulsa' : 'falhou' });
      continue;
    }
    const par = pares.canais[Math.floor(random() * pares.canais.length)];
    const falas = Math.max(2, Math.min(2 + Math.floor(random() * 5), faltam * 2));
    const roteiro = await gerarRoteiro(ch.orgId, falas, cfg.useAi, now);
    const ex = await prisma.warmupExchange.create({ data: {
      orgId: ch.orgId, initiatorChannelId: ch.id, peerChannelId: par.id, lines: JSON.stringify(roteiro.falas), nextIndex: 1,
      status: 'ENVIANDO', claimedAt: now, dueAt: now, source: roteiro.fonte,
    } });
    const ok = await enviarAquecimento({ from: ch, para: numeroDoCanal(par), texto: roteiro.falas[0], peerChannelId: par.id, exchangeId: ex.id, source: roteiro.fonte, now });
    if (!ok) {
      await prisma.warmupExchange.update({ where: { id: ex.id }, data: { status: 'CANCELADA', note: 'falha no envio' } });
      await agendar(new Date(now.getTime() + 15 * MIN_MS));
      out.push({ channelId: ch.id, acao: 'falhou' });
      continue;
    }
    await prisma.warmupExchange.update({ where: { id: ex.id }, data: roteiro.falas.length > 1
      ? { status: 'PENDENTE', claimedAt: null, dueAt: new Date(now.getTime() + atrasoRespostaMs(random)) }
      : { status: 'CONCLUIDA' } });
    await agendar(proximo(), null);
    out.push({ channelId: ch.id, acao: 'iniciada' });
  }
  return out;
}

/** Pares disponíveis agora: outros números QR da empresa (conectados, sem Risco, permitindo ser par, abaixo do teto) e extras. */
async function paresDe(ch: CanalQr, cfg: AquecimentoConfig, now: Date, nivelDe: (c: CanalQr) => Promise<string>): Promise<{ canais: CanalQr[]; extras: string[] }> {
  const outros = await prisma.channel.findMany({
    where: { orgId: ch.orgId, provider: PROVIDER_QR, id: { not: ch.id } },
    select: { id: true, orgId: true, name: true, displayPhone: true, waJid: true, createdAt: true, status: true, provider: true },
  });
  const configs = new Map((await prisma.warmupConfig.findMany({ where: { channelId: { in: outros.map((o) => o.id) } } })).map((r) => [r.channelId, r]));
  const meu = numeroDoCanal(ch);
  const canais: CanalQr[] = [];
  for (const o of outros) {
    if (cfg.peerChannelIds.length && !cfg.peerChannelIds.includes(o.id)) continue;
    const num = numeroDoCanal(o);
    if (!num || mesmoNumero(num, meu)) continue;
    if (!qrManager.isConnected(o.id)) continue;
    const r = configs.get(o.id);
    if (r && !r.allowAsPeer) continue;
    if (await prisma.warmupExchange.findFirst({ where: { status: ABERTA, OR: [{ initiatorChannelId: o.id }, { peerChannelId: o.id }] }, select: { id: true } })) continue;
    if ((await nivelDe(o)) === 'RISCO') continue;
    if ((await enviadasDesde(o.id, relogio(now).inicioDoDia)) >= (await tetoHoje(o, now))) continue;
    canais.push(o);
  }
  const extras = cfg.useExtras ? (await prisma.warmupExtraNumber.findMany({ where: { orgId: ch.orgId }, select: { phone: true } })).map((e) => e.phone).filter((p) => !mesmoNumero(p, meu)) : [];
  return { canais, extras };
}

// ---------- Tela ----------

/** Status do aquecimento ativo para o cartão do número em Canais. */
export async function statusAquecimento(channel: Channel, now = new Date()) {
  const qr = channel.provider === PROVIDER_QR;
  const row = await prisma.warmupConfig.findUnique({ where: { channelId: channel.id } });
  const cfg = configDe(row);
  const inicio = inicioDe(row, channel);
  const diaIni = relogio(now).inicioDoDia;
  const [enviadasHoje, recebidasHoje, reacoesHoje, total, outros, extras, conversasHoje] = await Promise.all([
    enviadasDesde(channel.id, diaIni),
    prisma.warmupMessage.count({ where: { channelId: channel.id, direction: 'IN', createdAt: { gte: diaIni } } }),
    prisma.warmupMessage.count({ where: { channelId: channel.id, kind: 'reaction', createdAt: { gte: diaIni } } }),
    prisma.warmupMessage.count({ where: { channelId: channel.id, kind: 'text' } }),
    prisma.channel.findMany({ where: { orgId: channel.orgId, provider: PROVIDER_QR, id: { not: channel.id } }, select: { id: true, name: true, displayPhone: true, waJid: true, status: true }, orderBy: { createdAt: 'asc' } }),
    prisma.warmupExtraNumber.count({ where: { orgId: channel.orgId } }),
    prisma.warmupExchange.count({ where: { OR: [{ initiatorChannelId: channel.id }, { peerChannelId: channel.id }], createdAt: { gte: diaIni } } }),
  ]);
  const dia = cfg.enabled ? diaAtivo(inicio, now) : null;
  const fx = dia ? faixaDoDia(dia, cfg.days) : null;
  const conectado = qrManager.isConnected(channel.id) || channel.status === 'CONNECTED';
  const pares = outros.map((o) => ({ id: o.id, nome: o.name, numero: o.displayPhone, conectado: qrManager.isConnected(o.id) || o.status === 'CONNECTED', escolhido: !cfg.peerChannelIds.length || cfg.peerChannelIds.includes(o.id) }));
  const temPar = pares.some((p) => p.escolhido && p.conectado) || (cfg.useExtras && extras > 0);
  let motivo: MotivoParada | null = null;
  if (!aquecimentoNoAmbiente()) motivo = 'ambiente';
  else if (!cfg.enabled) motivo = 'desligado';
  else if (dia && dia > cfg.days) motivo = 'concluido';
  else if (!conectado) motivo = 'desconectado';
  else if (row?.pausedReason === 'risco' || row?.pausedReason === 'assinatura') motivo = row.pausedReason as MotivoParada;
  else if (!temPar) motivo = 'sem_par';
  else if (fx && enviadasHoje >= metaDoDia(channel.id, relogio(now).data, dia!, cfg.days)) motivo = 'meta';
  else if (relogio(now).hora < cfg.startHour || relogio(now).hora >= cfg.endHour) motivo = 'fora_horario';
  const idadeDias = Math.floor((now.getTime() - channel.createdAt.getTime()) / DAY_MS);
  return {
    channelId: channel.id, qr, ambienteLigado: aquecimentoNoAmbiente(),
    config: { ...cfg, startedAt: row?.startedAt ?? null },
    rodando: cfg.enabled && motivo === null,
    motivo, motivoTexto: motivo && motivo !== 'desligado' ? MOTIVO_TEXTO[motivo] : null,
    dia, dias: cfg.days, fimEm: cfg.enabled ? new Date(inicio.getTime() + cfg.days * DAY_MS) : null,
    nivel: fx ? (dia! <= Math.ceil(cfg.days / 3) ? 'Leve' : dia! <= Math.ceil((2 * cfg.days) / 3) ? 'Médio' : 'Forte') : null,
    metaHoje: fx ? metaDoDia(channel.id, relogio(now).data, dia!, cfg.days) : null,
    faixaHoje: fx,
    hoje: { enviadas: enviadasHoje, recebidas: recebidasHoje, reacoes: reacoesHoje, conversas: conversasHoje },
    total,
    proximaEm: cfg.enabled && motivo === null ? row?.nextAt ?? null : null,
    pares, extras,
    avisoNumeroNovo: qr && idadeDias < DIAS_NUMERO_NOVO && !cfg.enabled,
    idadeDias,
  };
}

/** Cancela conversas em andamento deste número (aquecimento desligado/canal removido). */
export async function cancelarConversas(channelId: string) {
  await prisma.warmupExchange.updateMany({ where: { status: 'PENDENTE', OR: [{ initiatorChannelId: channelId }, { peerChannelId: channelId }] }, data: { status: 'CANCELADA', note: 'desligado' } });
}

/** Números de aquecimento em 7 dias e hoje, para a Saúde do número (separados dos envios normais). */
export async function numerosAquecimento(channelId: string, now = new Date()) {
  const diaIni = relogio(now).inicioDoDia;
  const [hoje, recebidasHoje, d7] = await Promise.all([
    enviadasDesde(channelId, diaIni),
    prisma.warmupMessage.count({ where: { channelId, direction: 'IN', createdAt: { gte: diaIni } } }),
    enviadasDesde(channelId, new Date(now.getTime() - 7 * DAY_MS)),
  ]);
  return { aquecimentoHoje: hoje, aquecimentoRecebidasHoje: recebidasHoje, aquecimento7d: d7 };
}
