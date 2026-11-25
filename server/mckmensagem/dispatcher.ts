import { prisma } from '../db.js';
import { sendOutbound } from '../whatsapp/messaging.js';
import { openConversationFor } from '../whatsapp/multiCanal.js';
import { TZ } from './constants.js';
import { isProductActive } from '../billing/service.js';
import type { Campaign, Lead } from '@prisma/client';
import { verificarEnvioEmMassa, saudeDoNumero } from '../whatsapp/protecao/service.js';
import type { NivelSaude } from '../whatsapp/protecao/core.js';
import { canalConectado, tipoErroEnvio } from '../whatsapp/conexao.js';
import { versoesDaCampanha, escolherVersao, textoParaContato, textosPossiveis, saudacaoDe, diaPermitido, resultadoPorVersao, escolherVencedora } from './variacoes.js';
import { canaisDaCampanha, escolherCanal, LEGENDA_MAX, riscoLiberado } from './campanhaCore.js';
import { midiaParaEnvio, tickRecorrencia } from './campanhaExtras.js';
import type { OutboundPayload } from '../whatsapp/cloudClient.js';

type Sender = typeof sendOutbound;
let sender: Sender = sendOutbound;
/** Permite substituir o envio (somente testes). */
export function setSender(fn: Sender | null) { sender = fn ?? sendOutbound; }

let random: () => number = Math.random;
export function setRandom(fn: (() => number) | null) { random = fn ?? Math.random; }

/** Próximo envio permitido por campanha (intervalo aleatório entre min e max). */
const nextAt = new Map<string, number>();
export function resetDispatcherState() { nextAt.clear(); }

/** Hora local (minutos desde 00:00) e início do dia local em America/Sao_Paulo. */
export function localClock(now: Date, tz = TZ): { minutes: number; dayStart: Date } {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const h = get('hour'), m = get('minute'), s = get('second');
  const dayStart = new Date(now.getTime() - ((h * 60 + m) * 60 + s) * 1000 - now.getMilliseconds());
  return { minutes: h * 60 + m, dayStart };
}

export function hhmmToMinutes(v: string): number {
  const [h, m] = v.split(':').map(Number);
  return h * 60 + m;
}

export function inWindow(c: Pick<Campaign, 'windowStart' | 'windowEnd'>, now: Date): boolean {
  const { minutes } = localClock(now);
  const s = hhmmToMinutes(c.windowStart), e = hhmmToMinutes(c.windowEnd);
  return s <= e ? minutes >= s && minutes < e : minutes >= s || minutes < e; // janela que vira a meia-noite
}

export function personalize(message: string, lead: Pick<Lead, 'name'>): string {
  const first = (lead.name ?? '').trim().split(/\s+/)[0] ?? '';
  return message.replace(/\{\s*nome\s*\}/gi, first).replace(/[ \t]+([,.!?])/g, '$1').replace(/[ \t]{2,}/g, ' ').trim();
}

export type TickResult = { campaignId: string; action: 'sent' | 'failed' | 'skipped' | 'outside_window' | 'daily_limit' | 'waiting_interval' | 'completed' | 'subscription_inactive' | 'number_protection' | 'number_risk' | 'channel_offline' | 'retry_later' | 'outside_day' | 'scheduled' }[];

// ---------------- v1.44.0: pausa automática com o número em Risco ----------------
export const PAUSA_RISCO_AUTO = 'Campanha pausada automaticamente: o número está em nível Risco na Saúde do número (Canais). Ela volta sozinha quando o nível melhorar.';
export const PAUSA_RISCO_MANUAL = 'Campanha pausada automaticamente: o número está em nível Risco na Saúde do número (Canais). Veja as dicas do painel e clique em Retomar quando quiser continuar.';
export type DecisaoRisco = 'pausar' | 'pausar_manual' | 'manter' | 'retomar' | 'seguir';

/** O que fazer com a campanha conforme o nível do número. Puro. nivel null = não deu para avaliar agora. */
export function decisaoRisco(a: { nivel: NivelSaude | null; retomada: string; pausada: boolean }): DecisaoRisco {
  if (a.nivel === 'RISCO') return a.retomada === 'manual' ? 'pausar_manual' : 'pausar';
  if (a.nivel === null) return a.pausada ? 'manter' : 'seguir';
  return a.pausada ? 'retomar' : 'seguir';
}

async function notaCampanha(c: Campaign, texto: string) {
  console.warn('[mckmensagem] campanha', { campaignId: c.id, orgId: c.orgId, aviso: texto });
}

// ---------------- v1.46.1: WhatsApp desconectado não queima a lista ----------------
export const PAUSA_OFFLINE = 'Campanha aguardando: o WhatsApp desconectou. Ela continua sozinha quando reconectar.';
export const RETOMADA_OFFLINE = 'Campanha retomada: WhatsApp reconectado';
/** v1.51.0: número escolhido pela responsável desconectado — não envia e não troca de número. */
export const PAUSA_OFFLINE_FIXO = 'Campanha aguardando: o número escolhido para o envio está desconectado. Nada é enviado e a campanha não troca de número; ela continua sozinha quando esse número reconectar (Canais).';
/** v1.51.0: aviso gravado quando a campanha volta a enviar pelo número em Risco por escolha da responsável. */
export const AVISO_RISCO_LIBERADO = 'Enviando pelo número escolhido mesmo em nível Risco (confirmado em “Enviar mesmo assim”).';
/** Tentativas do envio original que podem falhar por conexão antes de virar FALHOU. */
export const MAX_TENTATIVAS_CONEXAO = 3;

/**
 * Canal da campanha desconectado: não toca nos destinatários (seguem PENDENTE), registra o aviso uma vez e devolve
 * 'channel_offline'. Conectado de novo: tira o aviso, registra a retomada e deixa a campanha seguir (janela, limites,
 * proteção do número e aquecimento continuam valendo no resto do passo).
 */
async function travaOffline(c: Campaign, now: Date): Promise<'channel_offline' | null> {
  const channel = await prisma.channel.findFirst({ where: { id: c.channelId, orgId: c.orgId } });
  return aplicarOffline(c, canalConectado(channel), now, c.envioFixo ? PAUSA_OFFLINE_FIXO : PAUSA_OFFLINE);
}

/** Grava/tira o aviso "aguardando o WhatsApp" conforme a conexão (um número ou, no rodízio, todos). */
async function aplicarOffline(c: Campaign, conectado: boolean, now: Date, motivo: string = PAUSA_OFFLINE): Promise<'channel_offline' | null> {
  if (!conectado) {
    if (c.offlinePausa !== motivo) {
      await prisma.campaign.update({ where: { id: c.id }, data: { offlinePausa: motivo, offlinePausaEm: now } });
      await notaCampanha(c, motivo);
      c.offlinePausa = motivo;
    }
    return 'channel_offline';
  }
  if (c.offlinePausa) {
    await prisma.campaign.update({ where: { id: c.id }, data: { offlinePausa: null, offlinePausaEm: null } });
    await notaCampanha(c, RETOMADA_OFFLINE);
    c.offlinePausa = null;
  }
  return null;
}

/** Confere a Saúde do número (só QR) antes de enviar. Devolve 'number_risk' quando a campanha deve esperar. */
async function travaRisco(c: Campaign, now: Date): Promise<'number_risk' | null> {
  const channel = await prisma.channel.findFirst({ where: { id: c.channelId, orgId: c.orgId } });
  const qr = channel?.provider === 'whatsapp_qr';
  const nivel = qr ? ((await saudeDoNumero(channel!, now).catch(() => null))?.nivel ?? null) : 'BOM';
  return aplicarRisco(c, nivel, now);
}

/** Pausa/retoma pela Saúde do número (no rodízio: RISCO só quando nenhum número conectado está saudável). */
async function aplicarRisco(c: Campaign, nivel: NivelSaude | null, now: Date): Promise<'number_risk' | null> {
  const d = decisaoRisco({ nivel, retomada: c.riscoRetomada, pausada: !!c.riscoPausa });
  if (d === 'pausar' || d === 'pausar_manual') {
    const motivo = d === 'pausar' ? PAUSA_RISCO_AUTO : PAUSA_RISCO_MANUAL;
    if (c.riscoPausa !== motivo || d === 'pausar_manual') {
      await prisma.campaign.update({ where: { id: c.id }, data: { riscoPausa: motivo, riscoPausaEm: now, ...(d === 'pausar_manual' ? { status: 'PAUSADA' } : {}) } });
      if (c.riscoPausa !== motivo) await notaCampanha(c, motivo);
      c.riscoPausa = motivo;
    }
    return 'number_risk';
  }
  if (d === 'manter') return 'number_risk';
  if (d === 'retomar') {
    await prisma.campaign.update({ where: { id: c.id }, data: { riscoPausa: null, riscoPausaEm: null } });
    await notaCampanha(c, 'Campanha retomada: o número saiu do nível Risco.');
    c.riscoPausa = null;
  }
  return null;
}

/** v1.51.0: com o Risco liberado, tira o aviso de pausa por Risco que tenha ficado de antes. */
async function limparPausaRisco(c: Campaign) {
  if (!c.riscoPausa) return;
  await prisma.campaign.update({ where: { id: c.id }, data: { riscoPausa: null, riscoPausaEm: null } });
  await notaCampanha(c, AVISO_RISCO_LIBERADO);
  c.riscoPausa = null;
}

/** Um passo do disparador: no máximo um envio por campanha EM_ANDAMENTO por chamada. */
export async function tick(now = new Date()): Promise<TickResult> {
  const out: TickResult = [];
  // v1.49.0: campanhas que se repetem criam a execução nova (para o público atual) quando chega a hora.
  await tickRecorrencia(now).catch((e) => console.error('[mckmensagem] repetição', e));
  // v1.48.0: início agendado chegou → EM_ANDAMENTO (updateMany com status = trava contra corrida).
  const agendadas = await prisma.campaign.findMany({ where: { status: 'AGENDADA', iniciarEm: { lte: now } }, select: { id: true } });
  for (const a of agendadas) {
    const u = await prisma.campaign.updateMany({ where: { id: a.id, status: 'AGENDADA' }, data: { status: 'EM_ANDAMENTO' } });
    if (u.count) console.warn('[mckmensagem] campanha', { campaignId: a.id, aviso: 'Início agendado: campanha começou' });
  }
  const campaigns = await prisma.campaign.findMany({ where: { status: 'EM_ANDAMENTO' }, orderBy: { createdAt: 'asc' } });
  for (const c of campaigns) {
    try {
      out.push({ campaignId: c.id, action: await stepCampaign(c, now) });
    } catch (e) {
      console.error('[mckmensagem] erro na campanha', c.id, e);
    }
  }
  return out;
}

async function stepCampaign(c: Campaign, now: Date): Promise<TickResult[number]['action']> {
  // Assinatura do MCKMENSAGEM inativa: pausa sem consumir destinatários (retoma ao renovar).
  if (!(await isProductActive(c.orgId, 'MCKMENSAGEM'))) return 'subscription_inactive';
  if (!inWindow(c, now)) return 'outside_window';
  // v1.48.0: dias da semana da campanha (padrão: todos).
  if (!diaPermitido(c.diasSemana, now)) return 'outside_day';
  // v1.49.0: rodízio entre vários números (desligado por padrão; sem ele o caminho abaixo é o de sempre).
  if (canaisDaCampanha(c).length > 1) return stepRodizio(c, now);
  const { dayStart } = localClock(now);
  const sentToday = await prisma.campaignRecipient.count({ where: { campaignId: c.id, status: 'ENVIADA', sentAt: { gte: dayStart } } });
  if (sentToday >= c.dailyLimit) return 'daily_limit';

  let next = nextAt.get(c.id);
  if (next === undefined) {
    const last = await prisma.campaignRecipient.findFirst({ where: { campaignId: c.id, sentAt: { not: null } }, orderBy: { sentAt: 'desc' } });
    next = last?.sentAt ? last.sentAt.getTime() + c.minIntervalSec * 1000 : 0;
  }
  if (now.getTime() < next) return 'waiting_interval';
  // v1.46.1: WhatsApp do canal desconectado → espera sem tocar nos destinatários (só se ainda há fila).
  if (await prisma.campaignRecipient.count({ where: { campaignId: c.id, status: 'PENDENTE' } }) > 0 && await travaOffline(c, now)) return 'channel_offline';
  // v1.44.0: número em nível Risco na Saúde do número → pausa (volta sozinha ou espera o Retomar, conforme a campanha).
  // v1.51.0: número escolhido pela responsável com "Enviar mesmo assim" → usa esse número mesmo em Risco (só esta trava
  // sai; limites por hora/dia, intervalo, aquecimento, horário e dias continuam valendo).
  if (riscoLiberado(c)) await limparPausaRisco(c);
  else if (await travaRisco(c, now)) return 'number_risk';

  // v1.48.0: teste A/B com vencedora automática (desligado por padrão).
  await talvezEscolherVencedora(c, now);

  // Pula (IGNORADA) quem não pode receber até achar alguém elegível.
  for (;;) {
    const r = await prisma.campaignRecipient.findFirst({ where: { campaignId: c.id, status: 'PENDENTE' }, orderBy: { id: 'asc' } });
    if (!r) {
      await prisma.campaign.update({ where: { id: c.id }, data: { status: 'CONCLUIDA' } });
      nextAt.delete(c.id);
      return 'completed';
    }
    const lead = await prisma.lead.findFirst({ where: { id: r.leadId, orgId: c.orgId } });
    const reason = !lead ? 'Lead não encontrado'
      : !lead.consentAt ? 'Lead sem consentimento registrado'
      : lead.optOutAt ? 'Lead pediu para não receber mensagens (opt-out)'
      : lead.status === 'DESCARTADO' ? 'Lead descartado'
      : null;
    if (reason || !lead) {
      await prisma.campaignRecipient.update({ where: { id: r.id }, data: { status: 'IGNORADA', error: reason } });
      continue;
    }
    // v1.42.0: proteção do número (QR): teto por hora/dia, aquecimento e intervalo aleatório entre envios do mesmo número
    // (vale para todas as campanhas e cadências que usam o número). Segurado: o destinatário continua pendente.
    const prot = await verificarEnvioEmMassa(c.channelId, now);
    if (!prot.ok) {
      nextAt.set(c.id, now.getTime() + Math.min(prot.tentarEmMs, 10 * 60_000));
      return 'number_protection';
    }
    const res = await sendToLead(c, lead, r, now);
    if (res === 'duplicate') continue; // já tinha recebido: marcado ENVIADA sem reenviar; segue para o próximo
    const gap = c.minIntervalSec + random() * Math.max(0, c.maxIntervalSec - c.minIntervalSec);
    // Falha de conexão: espera um pouco mais antes de tentar de novo (o próximo passo também confere a conexão).
    nextAt.set(c.id, now.getTime() + (res === 'retry' ? Math.max(gap, 120) : gap) * 1000);
    return res === 'sent' ? 'sent' : res === 'retry' ? 'retry_later' : 'failed';
  }
}

const NAO_FALHOU = { not: 'FAILED' } as const;

/**
 * Regra do dono: nunca enviar duas vezes para quem já recebeu. Procura uma mensagem desta campanha que já saiu para o
 * contato: a guardada no destinatário (qualquer status menos FAILED) ou uma mensagem em massa com o mesmo texto,
 * em qualquer conversa do contato, depois da criação da campanha. Devolve o id dela (ou null).
 */
export async function jaRecebeu(c: Pick<Campaign, 'id' | 'orgId' | 'createdAt'>, r: { messageId: string | null }, contactId: string | null, texto: string | string[]): Promise<string | null> {
  if (r.messageId) {
    const m = await prisma.message.findFirst({ where: { id: r.messageId, orgId: c.orgId, status: NAO_FALHOU }, select: { id: true } });
    if (m) return m.id;
  }
  if (!contactId) return null;
  const convIds = (await prisma.conversation.findMany({ where: { orgId: c.orgId, contactId }, select: { id: true } })).map((x) => x.id);
  if (!convIds.length) return null;
  const m = await prisma.message.findFirst({
    where: { orgId: c.orgId, conversationId: { in: convIds }, direction: 'OUT', bulk: true, body: Array.isArray(texto) ? { in: texto } : texto, status: NAO_FALHOU, createdAt: { gte: c.createdAt } },
    orderBy: { createdAt: 'asc' }, select: { id: true },
  });
  return m?.id ?? null;
}

type ResultadoEnvio = 'sent' | 'failed' | 'retry' | 'duplicate';

/**
 * v1.48.0: versão e texto do contato. Sem variações, {saudacao} nem {a|b}, é igual ao personalize antigo.
 * `possiveis` = o mesmo texto com as 3 saudações (trava de duplicidade não depende do horário).
 */
export function textoDaCampanha(c: Pick<Campaign, 'id' | 'message' | 'variacoes' | 'abVencedora'>, lead: Pick<Lead, 'id' | 'name'> & Partial<Pick<Lead, 'dono' | 'empresa'>>, gravada: number | null | undefined, now: Date) {
  const versoes = versoesDaCampanha(c);
  const versao = escolherVersao({ campaignId: c.id, leadId: lead.id, total: versoes.length, gravada, vencedora: c.abVencedora });
  const base = { campaignId: c.id, leadId: lead.id, nome: lead.name, dono: lead.dono ?? null, empresa: lead.empresa ?? null };
  return { versao, texto: textoParaContato(versoes[versao], { ...base, saudacao: saudacaoDe(now) }), possiveis: textosPossiveis(versoes[versao], base) };
}

/** Resultado do A/B por versão (enviadas, respostas, taxa). */
export async function resultadoAb(c: Pick<Campaign, 'id' | 'message' | 'variacoes'>, now = new Date()) {
  const total = versoesDaCampanha(c).length;
  const envios = await prisma.campaignRecipient.findMany({ where: { campaignId: c.id, status: 'ENVIADA' }, select: { variante: true, sentAt: true, respondeuAt: true } });
  return resultadoPorVersao(total, envios, now);
}

async function talvezEscolherVencedora(c: Campaign, now: Date) {
  if (!c.abAutoVencedora || c.abVencedora != null || versoesDaCampanha(c).length < 2) return;
  const v = escolherVencedora(await resultadoAb(c, now), c.abMinimo);
  if (v == null) return;
  const u = await prisma.campaign.updateMany({ where: { id: c.id, abVencedora: null }, data: { abVencedora: v, abVencedoraEm: now } });
  if (u.count) {
    c.abVencedora = v; c.abVencedoraEm = now;
    await notaCampanha(c, `Teste A/B: versão ${String.fromCharCode(65 + v)} venceu; o resto da fila recebe essa versão.`);
  }
}

async function sendToLead(c: Campaign, lead: Lead, rec: { id: string; messageId: string | null; tentativas: number; variante?: number | null }, now: Date, canalId: string = c.channelId): Promise<ResultadoEnvio> {
  const recipientId = rec.id;
  const waId = lead.phone.replace(/\D/g, '');
  let contact = lead.contactId ? await prisma.contact.findFirst({ where: { id: lead.contactId, orgId: c.orgId } }) : null;
  contact ??= await prisma.contact.findUnique({ where: { orgId_waId: { orgId: c.orgId, waId } } });
  if (!contact) {
    contact = await prisma.contact.create({ data: { orgId: c.orgId, waId, phone: lead.phone, name: lead.name ?? null, tags: lead.tags } });
  }
  if (contact.optOut) {
    await prisma.lead.update({ where: { id: lead.id }, data: { optOutAt: now, contactId: contact.id } });
    await prisma.campaignRecipient.update({ where: { id: recipientId }, data: { status: 'IGNORADA', error: 'Contato com opt-out no MCKBOT' } });
    return 'failed';
  }
  const { versao, texto, possiveis } = textoDaCampanha(c, lead, rec.variante, now);
  if (rec.variante !== versao) await prisma.campaignRecipient.update({ where: { id: recipientId }, data: { variante: versao } });
  // Proteção contra duplicidade: já recebeu esta campanha → marca ENVIADA (com a mensagem que saiu) e não reenvia.
  const anterior = await jaRecebeu(c, rec, contact.id, [...new Set([texto, ...possiveis])]);
  if (anterior) {
    const m = await prisma.message.findUnique({ where: { id: anterior }, select: { createdAt: true } });
    await prisma.campaignRecipient.update({ where: { id: recipientId }, data: { status: 'ENVIADA', sentAt: m?.createdAt ?? now, error: null, messageId: anterior } });
    await prisma.lead.update({ where: { id: lead.id }, data: { contactId: contact.id } });
    return 'duplicate';
  }
  // Conversa do contato no WhatsApp da campanha (não "puxa" a conversa de outro número da organização).
  const conv = await openConversationFor(c.orgId, contact.id, canalId);

  // v1.49.0: com imagem/PDF, o texto vai como legenda (uma mensagem só). Arquivo sumiu: pausa a campanha sem
  // gastar o contato (ele continua na fila) em vez de mandar só o texto.
  let payload: OutboundPayload;
  try {
    payload = await payloadDaCampanha(c, versao, texto);
  } catch (e) {
    await prisma.campaign.updateMany({ where: { id: c.id, status: 'EM_ANDAMENTO' }, data: { status: 'PAUSADA' } });
    await notaCampanha(c, `Campanha pausada: ${(e as Error).message}`);
    return 'retry';
  }
  let msg;
  try {
    msg = await sender({ conversation: conv, contact, payload, sender: 'bot', product: 'MCKMENSAGEM', bulk: true });
  } catch (e) {
    return falhaDeEnvio(rec, (e as Error).message?.slice(0, 500) || 'Erro no envio', null);
  }
  if (msg.status === 'FAILED') {
    await prisma.lead.update({ where: { id: lead.id }, data: { contactId: contact.id } });
    return falhaDeEnvio(rec, msg.error ?? 'Falha no envio', msg.id ?? null);
  }
  await prisma.campaignRecipient.update({ where: { id: recipientId }, data: { status: 'ENVIADA', sentAt: now, error: null, messageId: msg.id } });
  await prisma.lead.update({
    where: { id: lead.id },
    data: { contactId: contact.id, campaignId: lead.campaignId ?? c.id, ...(lead.status === 'NOVO' || lead.status === 'SEM_RESPOSTA' ? { status: 'CONTATADO' } : {}) },
  });
  return 'sent';
}

/** v1.49.0: texto puro ou arquivo (imagem/PDF) com o texto como legenda. */
export async function payloadDaCampanha(c: Pick<Campaign, 'orgId' | 'midias'>, versao: number, texto: string): Promise<OutboundPayload> {
  const m = await midiaParaEnvio(c, versao);
  if (!m) return { type: 'text', text: texto };
  return { type: 'file', data: m.dados, filename: m.nome, mime: m.mime, caption: texto.slice(0, LEGENDA_MAX) };
}

// ---------------- v1.49.0: rodízio entre vários números ----------------

const chaveIntervalo = (c: Campaign, canal: string) => `${c.id}:${canal}`;
/** Destinatários deste número na campanha (sem número gravado = número principal). */
export function filtroDoCanal(c: Pick<Campaign, 'channelId'>, canal: string) {
  return canal === c.channelId ? { OR: [{ channelId: null }, { channelId: canal }] } : { channelId: canal };
}

/**
 * Um passo da campanha com rodízio: cada número tem o próprio limite por dia (o da campanha), o próprio intervalo,
 * a proteção do número (verificarEnvioEmMassa) e a Saúde; número desconectado ou em Risco fica de fora.
 * O mesmo contato fica sempre no mesmo número (CampaignRecipient.channelId gravado no primeiro envio).
 * Um envio por passo, como no caminho de um número só.
 */
async function stepRodizio(c: Campaign, now: Date): Promise<TickResult[number]['action']> {
  const todos = canaisDaCampanha(c);
  const pendentes = await prisma.campaignRecipient.count({ where: { campaignId: c.id, status: 'PENDENTE' } });
  if (!pendentes) {
    await prisma.campaign.update({ where: { id: c.id }, data: { status: 'CONCLUIDA' } });
    for (const k of todos) nextAt.delete(chaveIntervalo(c, k));
    return 'completed';
  }
  const chans = await prisma.channel.findMany({ where: { id: { in: todos }, orgId: c.orgId, provider: { not: 'site' } } });
  const validos = todos.filter((id) => chans.some((x) => x.id === id));
  const { dayStart } = localClock(now);
  const saudaveis: string[] = [];
  const livres: string[] = [];
  let algumConectado = false, algumNoLimite = false;
  for (const ch of chans) {
    if (!canalConectado(ch)) continue;
    algumConectado = true;
    const nivel = ch.provider === 'whatsapp_qr' ? ((await saudeDoNumero(ch, now).catch(() => null))?.nivel ?? null) : 'BOM';
    if (nivel === 'RISCO') continue;
    saudaveis.push(ch.id);
    const hoje = await prisma.campaignRecipient.count({ where: { campaignId: c.id, status: 'ENVIADA', sentAt: { gte: dayStart }, ...filtroDoCanal(c, ch.id) } });
    if (hoje >= c.dailyLimit) { algumNoLimite = true; continue; }
    const k = chaveIntervalo(c, ch.id);
    let next = nextAt.get(k);
    if (next === undefined) {
      const last = await prisma.campaignRecipient.findFirst({ where: { campaignId: c.id, sentAt: { not: null }, ...filtroDoCanal(c, ch.id) }, orderBy: { sentAt: 'desc' } });
      next = last?.sentAt ? last.sentAt.getTime() + c.minIntervalSec * 1000 : 0;
      nextAt.set(k, next);
    }
    if (now.getTime() >= next) livres.push(ch.id);
  }
  // Nenhum número conectado: espera sem tocar na fila. Conectados, mas todos em Risco: pausa como a campanha de um número.
  if (await aplicarOffline(c, algumConectado, now)) return 'channel_offline';
  if (await aplicarRisco(c, saudaveis.length ? 'BOM' : 'RISCO', now)) return 'number_risk';
  if (!livres.length) return algumNoLimite ? 'daily_limit' : 'waiting_interval';

  await talvezEscolherVencedora(c, now);
  let protegido = false;
  let cursor: string | undefined;
  for (let lidos = 0; lidos < 500 && livres.length;) {
    const lote = await prisma.campaignRecipient.findMany({ where: { campaignId: c.id, status: 'PENDENTE', ...(cursor ? { id: { gt: cursor } } : {}) }, orderBy: { id: 'asc' }, take: 100 });
    if (!lote.length) break;
    for (const r of lote) {
      cursor = r.id; lidos++;
      if (!livres.length) break;
      const lead = await prisma.lead.findFirst({ where: { id: r.leadId, orgId: c.orgId } });
      const reason = !lead ? 'Lead não encontrado'
        : !lead.consentAt ? 'Lead sem consentimento registrado'
        : lead.optOutAt ? 'Lead pediu para não receber mensagens (opt-out)'
        : lead.status === 'DESCARTADO' ? 'Lead descartado'
        : null;
      if (reason || !lead) {
        await prisma.campaignRecipient.update({ where: { id: r.id }, data: { status: 'IGNORADA', error: reason } });
        continue;
      }
      // Número em que o contato já conversa (entre os da campanha): mantém a conversa no mesmo número.
      let preferido: string | null = null;
      if (!r.channelId) {
        const waId = lead.phone.replace(/\D/g, '');
        const contato = lead.contactId ? { id: lead.contactId } : await prisma.contact.findUnique({ where: { orgId_waId: { orgId: c.orgId, waId } }, select: { id: true } });
        if (contato) preferido = (await prisma.conversation.findFirst({ where: { orgId: c.orgId, contactId: contato.id, channelId: { in: validos } }, orderBy: { lastMessageAt: 'desc' }, select: { channelId: true } }))?.channelId ?? null;
      }
      const canal = escolherCanal({ chave: lead.id, atribuido: r.channelId, preferido, todos: validos, saudaveis });
      if (!canal || !livres.includes(canal)) continue; // o número dele está fora agora: espera, sem trocar de número
      const prot = await verificarEnvioEmMassa(canal, now);
      if (!prot.ok) {
        nextAt.set(chaveIntervalo(c, canal), now.getTime() + Math.min(prot.tentarEmMs, 10 * 60_000));
        livres.splice(livres.indexOf(canal), 1);
        protegido = true;
        continue;
      }
      if (r.channelId !== canal) await prisma.campaignRecipient.updateMany({ where: { id: r.id, status: 'PENDENTE' }, data: { channelId: canal } });
      const res = await sendToLead(c, lead, r, now, canal);
      if (res === 'duplicate') continue;
      const gap = c.minIntervalSec + random() * Math.max(0, c.maxIntervalSec - c.minIntervalSec);
      nextAt.set(chaveIntervalo(c, canal), now.getTime() + (res === 'retry' ? Math.max(gap, 120) : gap) * 1000);
      return res === 'sent' ? 'sent' : res === 'retry' ? 'retry_later' : 'failed';
    }
  }
  if (!(await prisma.campaignRecipient.count({ where: { campaignId: c.id, status: 'PENDENTE' } }))) {
    await prisma.campaign.update({ where: { id: c.id }, data: { status: 'CONCLUIDA' } });
    return 'completed';
  }
  return protegido ? 'number_protection' : 'waiting_interval';
}

/**
 * v1.46.1: falha de conexão/passageira (socket fechado, timeout, não conectado, 5xx) volta para PENDENTE contando a
 * tentativa (até MAX_TENTATIVAS_CONEXAO); erro definitivo (número inválido, sem WhatsApp, bloqueado...) vira FALHOU.
 * Só sai de PENDENTE (updateMany com status): nunca mexe em quem já foi marcado ENVIADA.
 */
async function falhaDeEnvio(rec: { id: string; tentativas: number }, erro: string, messageId: string | null): Promise<ResultadoEnvio> {
  const tentativas = rec.tentativas + 1;
  const conexao = tipoErroEnvio(erro) === 'conexao';
  if (conexao && tentativas < MAX_TENTATIVAS_CONEXAO) {
    await prisma.campaignRecipient.updateMany({
      where: { id: rec.id, status: 'PENDENTE' },
      data: { tentativas, error: `${erro} (tentativa ${tentativas} de ${MAX_TENTATIVAS_CONEXAO}; tenta de novo sozinha)`.slice(0, 500), ...(messageId ? { messageId } : {}) },
    });
    return 'retry';
  }
  await prisma.campaignRecipient.updateMany({
    where: { id: rec.id, status: 'PENDENTE' },
    data: { status: 'FALHOU', error: erro.slice(0, 500), ...(conexao ? { tentativas } : {}), ...(messageId ? { messageId } : {}) },
  });
  return 'failed';
}

// ---------------- v1.46.1: reenviar os que falharam por desconexão (campanhas antigas) ----------------

/**
 * Devolve à fila (PENDENTE) os destinatários FALHOU cujo erro foi de conexão. Nunca toca em ENVIADA/IGNORADA e
 * pula quem já recebeu esta campanha (mensagem do destinatário com status diferente de FAILED ou mensagem em massa
 * com o mesmo texto depois da criação da campanha), marcando-o ENVIADA. Campanha CONCLUIDA volta a EM_ANDAMENTO.
 */
export async function reenviarFalhasDeConexao(c: Campaign): Promise<{ devolvidos: number; jaRecebidos: number }> {
  const falhas = await prisma.campaignRecipient.findMany({ where: { campaignId: c.id, status: 'FALHOU' } });
  let devolvidos = 0, jaRecebidos = 0;
  for (const r of falhas) {
    if (tipoErroEnvio(r.error) !== 'conexao') continue;
    const lead = await prisma.lead.findFirst({ where: { id: r.leadId, orgId: c.orgId } });
    if (!lead) continue;
    const waId = lead.phone.replace(/\D/g, '');
    const contact = (lead.contactId ? await prisma.contact.findFirst({ where: { id: lead.contactId, orgId: c.orgId } }) : null)
      ?? await prisma.contact.findUnique({ where: { orgId_waId: { orgId: c.orgId, waId } } });
    const t = textoDaCampanha(c, lead, r.variante, new Date());
    const anterior = await jaRecebeu(c, r, contact?.id ?? null, [...new Set([t.texto, ...t.possiveis, personalize(c.message, lead)])]);
    if (anterior) {
      const m = await prisma.message.findUnique({ where: { id: anterior }, select: { createdAt: true } });
      const u = await prisma.campaignRecipient.updateMany({ where: { id: r.id, status: 'FALHOU' }, data: { status: 'ENVIADA', sentAt: m?.createdAt ?? new Date(), error: null, messageId: anterior } });
      jaRecebidos += u.count;
      continue;
    }
    const u = await prisma.campaignRecipient.updateMany({ where: { id: r.id, status: 'FALHOU' }, data: { status: 'PENDENTE', tentativas: 0, error: null } });
    devolvidos += u.count;
  }
  if (devolvidos && c.status === 'CONCLUIDA') await prisma.campaign.update({ where: { id: c.id }, data: { status: 'EM_ANDAMENTO' } });
  return { devolvidos, jaRecebidos };
}

/** Quantos FALHOU desta campanha foram por conexão (para mostrar o botão). */
export async function contarFalhasDeConexao(campaignId: string): Promise<number> {
  const falhas = await prisma.campaignRecipient.findMany({ where: { campaignId, status: 'FALHOU' }, select: { error: true } });
  return falhas.filter((f) => tipoErroEnvio(f.error) === 'conexao').length;
}
