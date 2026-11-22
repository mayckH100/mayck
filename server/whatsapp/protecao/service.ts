/**
 * v1.42.0 — Proteção contra bloqueio do número (WhatsApp por QR): banco e integração.
 * Nada aqui lança para quem envia: em dúvida, libera o envio (a proteção nunca derruba um disparo por erro interno).
 */
import { prisma } from '../../db.js';
import type { Channel, ChannelProtection } from '@prisma/client';
import {
  PROTECAO_PADRAO, avaliarEnvio, avaliarSaude, erroIndicaBloqueio, inicioDoDia, limitesEfetivos, sortearIntervaloMs,
  type Avaliacao, type ProtecaoConfig,
} from './core.js';

const HOUR_MS = 3600e3, DAY_MS = 24 * HOUR_MS;

let random: () => number = Math.random;
/** Somente testes: sorteio previsível do intervalo. */
export function setProtecaoRandom(fn: (() => number) | null) { random = fn ?? Math.random; }

/**
 * QR_PROTECAO=off desliga a trava de envio em massa no servidor todo (emergência). Nos testes automatizados ela
 * só age com QR_PROTECAO=on (os testes antigos disparam vários envios seguidos de propósito).
 */
export function protecaoNoAmbiente(): boolean {
  const v = process.env.QR_PROTECAO;
  if (v === 'off') return false;
  return process.env.NODE_ENV !== 'test' || v === 'on';
}

/** Próximo envio em massa liberado por número (memória; após reinício, recalculado pelo último envio). */
const proximoPorCanal = new Map<string, number>();
export function resetProtecaoState() { proximoPorCanal.clear(); }

export function configDe(row: ChannelProtection | null): ProtecaoConfig {
  if (!row) return { ...PROTECAO_PADRAO };
  return {
    enabled: row.enabled, hourLimit: row.hourLimit, dayLimit: row.dayLimit, minGapSec: row.minGapSec, maxGapSec: Math.max(row.minGapSec, row.maxGapSec),
    warmupEnabled: row.warmupEnabled, warmupDays: row.warmupDays, typingEnabled: row.typingEnabled,
  };
}

export async function lerProtecao(channel: Pick<Channel, 'id' | 'createdAt'>): Promise<{ cfg: ProtecaoConfig; inicioAquecimento: Date; row: ChannelProtection | null }> {
  const row = await prisma.channelProtection.findUnique({ where: { channelId: channel.id } }).catch(() => null);
  return { cfg: configDe(row), inicioAquecimento: row?.warmupStartedAt ?? channel.createdAt, row };
}

const baseEmMassa = (channelId: string) => ({ channelId, direction: 'OUT', bulk: true, status: { not: 'FAILED' } });

/**
 * Pode sair mais um envio em massa por este número agora? Só vale para WhatsApp por QR (a API oficial tem os limites da Meta).
 * Quando libera, já reserva o próximo intervalo aleatório deste número (dois disparos no mesmo número não somam ritmo).
 */
export async function verificarEnvioEmMassa(channelId: string | null | undefined, now = new Date()): Promise<Avaliacao> {
  if (!channelId || !protecaoNoAmbiente()) return { ok: true };
  try {
    const channel = await prisma.channel.findUnique({ where: { id: channelId }, select: { id: true, provider: true, createdAt: true } });
    if (!channel || channel.provider !== 'whatsapp_qr') return { ok: true };
    const { cfg, inicioAquecimento } = await lerProtecao(channel);
    if (!cfg.enabled) return { ok: true };
    const diaIni = inicioDoDia(now);
    const [enviadosHora, enviadosDia] = await Promise.all([
      prisma.message.count({ where: { ...baseEmMassa(channelId), createdAt: { gte: new Date(now.getTime() - HOUR_MS) } } }),
      prisma.message.count({ where: { ...baseEmMassa(channelId), createdAt: { gte: diaIni } } }),
    ]);
    let proximo = proximoPorCanal.get(channelId) ?? null;
    if (proximo === null) {
      const last = await prisma.message.findFirst({ where: baseEmMassa(channelId), orderBy: { createdAt: 'desc' }, select: { createdAt: true } });
      proximo = last ? last.createdAt.getTime() + cfg.minGapSec * 1000 : null;
    }
    const r = avaliarEnvio({ cfg, now, inicioAquecimento, enviadosHora, enviadosDia, proximoPermitido: proximo, inicioDoProximoDia: new Date(diaIni.getTime() + DAY_MS) });
    if (r.ok) proximoPorCanal.set(channelId, now.getTime() + sortearIntervaloMs(cfg, random));
    return r;
  } catch (e) {
    console.warn('[protecao] falha ao verificar limites (envio liberado)', { channelId, error: (e as Error).message });
    return { ok: true };
  }
}

/** "digitando..." antes de respostas automáticas está ligado para este número? (padrão: sim) */
export async function digitandoLigado(channelId: string): Promise<boolean> {
  const row = await prisma.channelProtection.findUnique({ where: { channelId }, select: { typingEnabled: true } }).catch(() => null);
  return row ? row.typingEnabled : PROTECAO_PADRAO.typingEnabled;
}

/** Registra um evento de saúde do número (desconexão, sessão encerrada, restrição). Nunca lança. */
export async function registrarEventoSaude(channelId: string, type: string, detail?: string | null, now = new Date()): Promise<void> {
  try {
    const ch = await prisma.channel.findUnique({ where: { id: channelId }, select: { orgId: true } });
    if (!ch) return;
    // Quedas passageiras seguidas (rede) contam uma vez a cada 10 minutos.
    if (type === 'desconexao' && await prisma.channelHealthEvent.findFirst({ where: { channelId, type, createdAt: { gte: new Date(now.getTime() - 10 * 60_000) } }, select: { id: true } })) return;
    await prisma.channelHealthEvent.create({ data: { channelId, orgId: ch.orgId, type, detail: detail?.slice(0, 300) ?? null, createdAt: now } });
    await prisma.channelHealthEvent.deleteMany({ where: { channelId, createdAt: { lt: new Date(now.getTime() - 30 * DAY_MS) } } });
  } catch (e) {
    console.warn('[protecao] falha ao registrar evento de saúde', { channelId, type, error: (e as Error).message });
  }
}

const OPT_OUT_NOTE = 'Contato pediu para não receber mensagens automáticas';

/** Painel "Saúde do número" de um canal. */
export async function saudeDoNumero(channel: Channel, now = new Date()) {
  const qr = channel.provider === 'whatsapp_qr';
  const { cfg, inicioAquecimento, row } = await lerProtecao(channel);
  const lim = limitesEfetivos(cfg, inicioAquecimento, now);
  const diaIni = inicioDoDia(now);
  const hora = new Date(now.getTime() - HOUR_MS), d7 = new Date(now.getTime() - 7 * DAY_MS);
  const out = { channelId: channel.id, direction: 'OUT' };
  const [enviadosHoje, enviadosHora, emMassaHoje, emMassaHora, falhasHoje, emMassa7dRows, falhas7d, eventos] = await Promise.all([
    prisma.message.count({ where: { ...out, status: { not: 'FAILED' }, createdAt: { gte: diaIni } } }),
    prisma.message.count({ where: { ...out, status: { not: 'FAILED' }, createdAt: { gte: hora } } }),
    prisma.message.count({ where: { ...baseEmMassa(channel.id), createdAt: { gte: diaIni } } }),
    prisma.message.count({ where: { ...baseEmMassa(channel.id), createdAt: { gte: hora } } }),
    prisma.message.count({ where: { ...out, status: 'FAILED', createdAt: { gte: diaIni } } }),
    prisma.message.findMany({ where: { ...baseEmMassa(channel.id), createdAt: { gte: d7 } }, select: { conversationId: true, createdAt: true }, orderBy: { createdAt: 'asc' }, take: 5000 }),
    prisma.message.findMany({ where: { ...out, status: 'FAILED', createdAt: { gte: d7 } }, select: { error: true }, take: 5000 }),
    prisma.channelHealthEvent.findMany({ where: { channelId: channel.id, createdAt: { gte: new Date(now.getTime() - 30 * DAY_MS) } }, orderBy: { createdAt: 'desc' }, take: 50 }),
  ]);
  // Taxa de resposta: conversas com envio em massa que receberam mensagem do contato depois do 1º envio.
  const primeiro = new Map<string, Date>();
  for (const m of emMassa7dRows) if (!primeiro.has(m.conversationId)) primeiro.set(m.conversationId, m.createdAt);
  const convIds = [...primeiro.keys()];
  let responderam = 0, saidas = 0;
  if (convIds.length) {
    const ins = await prisma.message.groupBy({ by: ['conversationId'], where: { conversationId: { in: convIds }, direction: 'IN', createdAt: { gte: d7 }, NOT: { error: { startsWith: 'AUTORESPOSTA' } } }, _max: { createdAt: true } });
    responderam = ins.filter((x) => x._max.createdAt && x._max.createdAt > primeiro.get(x.conversationId)!).length;
    saidas = await prisma.message.count({ where: { conversationId: { in: convIds }, direction: 'INTERNAL', createdAt: { gte: d7 }, body: { startsWith: OPT_OUT_NOTE } } });
  }
  const ev7 = eventos.filter((e) => e.createdAt >= d7);
  // v1.45.0: aquecimento ativo (conversas entre os números da própria empresa) aparece separado e não entra nas taxas.
  const [aquecimentoHoje, aquecimentoRecebidasHoje, aquecimento7d] = await Promise.all([
    prisma.warmupMessage.count({ where: { channelId: channel.id, direction: 'OUT', kind: 'text', createdAt: { gte: diaIni } } }).catch(() => 0),
    prisma.warmupMessage.count({ where: { channelId: channel.id, direction: 'IN', createdAt: { gte: diaIni } } }).catch(() => 0),
    prisma.warmupMessage.count({ where: { channelId: channel.id, direction: 'OUT', kind: 'text', createdAt: { gte: d7 } } }).catch(() => 0),
  ]);
  const dados = {
    qr, protecaoLigada: cfg.enabled, aquecendo: lim.aquecendo,
    enviadosHoje, emMassaHoje, emMassaHora, limiteDia: lim.dia, limiteHora: lim.hora, falhasHoje,
    emMassa7d: convIds.length, responderam7d: responderam, saidas7d: saidas,
    bloqueios7d: falhas7d.filter((f) => erroIndicaBloqueio(f.error)).length,
    desconexoes7d: ev7.length,
    restricoes7d: ev7.filter((e) => e.type === 'restricao').length,
  };
  const saude = avaliarSaude(dados);
  return {
    channelId: channel.id, qr, ...saude,
    numeros: { enviadosHoje, enviadosHora, emMassaHoje, emMassaHora, falhasHoje, conversas7d: convIds.length, responderam7d: responderam, saidas7d: saidas, bloqueios7d: dados.bloqueios7d, desconexoes7d: dados.desconexoes7d, aquecimentoHoje, aquecimentoRecebidasHoje, aquecimento7d },
    limites: { dia: lim.dia, hora: lim.hora, aquecendo: lim.aquecendo, diaAquecimento: lim.diaAquecimento, fimAquecimento: lim.fimAquecimento },
    config: { ...cfg, warmupStartedAt: row?.warmupStartedAt ?? null, inicioAquecimento },
    eventos: eventos.slice(0, 10).map((e) => ({ type: e.type, detail: e.detail, createdAt: e.createdAt })),
  };
}
