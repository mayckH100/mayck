import express, { Router, type Request } from 'express';
import rateLimit from 'express-rate-limit';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { SdrLead } from '@prisma/client';
import { prisma } from '../db.js';
import { normalizeEmail } from './core.js';
import { getSdrSettings, logEvent, optOutLead, registerReply } from './service.js';
import { inboundEnabled, MIN_INBOUND_SECRET } from './v2config.js';
import { autoReplyHeaders, AUTO_SUBJECT_RE, detectAutoReply } from './autoReply.js';
import { getAutoReplyConfig } from './autoReplyConfig.js';
import { logAutoReplyOnLead } from './autoReplyService.js';

export { inboundEnabled };

/**
 * Resposta do lead por e-mail para a cadência sozinha (v1.19.0).
 * Webhook de entrada no formato do "Inbound parsing" do Brevo: POST JSON `{ items: [{ From, To, Recipients, Cc, Subject,
 * ExtractedMarkdownMessage, RawTextBody, Headers, SpamScore|Spam.Score, ... }] }`.
 *
 * - Desligado sem SDR_INBOUND_SECRET (≥ 16 caracteres): responde 404.
 * - Segredo por `Authorization: Bearer <segredo>`, Basic (senha = segredo), cabeçalho `x-sdr-secret` ou `?token=`.
 * - Com SDR_INBOUND_DOMAIN, os e-mails do SDR saem com "Responder para" `sdr-<token do lead>@<domínio>`: a resposta é
 *   ligada ao lead pelo token. Sem token, vale o remetente: leads com esse e-mail que já receberam e-mail do SDR.
 * - Ignora resposta automática (férias, ausência), aviso de falha de entrega e spam. "Descadastrar/remover/sair" no
 *   texto = pedido para sair. Nunca configura nada no Brevo. Logs só com ids.
 */
export const sdrInboundRouter = Router();

const sha = (s: string) => createHash('sha256').update(s).digest();
function secretOk(req: Request): boolean {
  const expected = process.env.SDR_INBOUND_SECRET ?? '';
  if (expected.length < MIN_INBOUND_SECRET) return false;
  const cands: string[] = [];
  const auth = String(req.headers.authorization ?? '');
  const bearer = /^Bearer\s+(.+)$/i.exec(auth)?.[1];
  if (bearer) cands.push(bearer.trim());
  const basic = /^Basic\s+(.+)$/i.exec(auth)?.[1];
  if (basic) {
    const dec = Buffer.from(basic, 'base64').toString('utf8');
    cands.push(dec.slice(dec.indexOf(':') + 1));
  }
  const h = req.headers['x-sdr-secret'];
  if (typeof h === 'string') cands.push(h);
  if (typeof req.query.token === 'string') cands.push(req.query.token);
  return cands.some((c) => timingSafeEqual(sha(c), sha(expected)));
}

type Mailbox = { Address?: unknown; Name?: unknown } | string | null | undefined;
const addrOf = (m: Mailbox): string | null => normalizeEmail(typeof m === 'string' ? (/<([^>]+)>/.exec(m)?.[1] ?? m) : m?.Address);
const list = (v: unknown): Mailbox[] => (Array.isArray(v) ? v.slice(0, 50) : v ? [v as Mailbox] : []);

function header(h: unknown, name: string): string {
  if (!h || typeof h !== 'object') return '';
  const k = Object.keys(h).find((x) => x.toLowerCase() === name.toLowerCase());
  const v = k ? (h as Record<string, unknown>)[k] : '';
  return (Array.isArray(v) ? v.join(' ') : String(v ?? '')).slice(0, 300);
}

/** Falha de entrega / remetente de sistema: não é o lead (nem resposta automática dele). */
export function isBounce(item: any, from: string | null): boolean {
  if (!from || /^(mailer-daemon|postmaster|no-?reply|bounce)/i.test(from)) return true;
  return /^\s*(undeliverable|delivery status|n[aã]o entregue|mail delivery failed|returned mail)/i.test(String(item?.Subject ?? ''));
}

/** Resposta automática, falha de entrega ou lista: não é o lead respondendo. */
export function isAutomatic(item: any, from: string | null): boolean {
  if (isBounce(item, from)) return true;
  const h = item?.Headers;
  if (autoReplyHeaders(h)) return true;
  if (header(h, 'X-Auto-Response-Suppress').toLowerCase().includes('all')) return true;
  return AUTO_SUBJECT_RE.test(String(item?.Subject ?? ''));
}

export const UNSUB_RE = /\b(descadastr\w*|remov(a|er|e)\s+(meu|o meu|da lista|me)|me\s+remov\w*|n[aã]o\s+(quero|desejo)\s+(mais\s+)?receber|sair\s+da\s+lista|parar?\s+de\s+(me\s+)?(enviar|mandar|receber)|unsubscribe)\b/i;

/** Texto da resposta sem a citação do e-mail original. */
export function replyText(item: any): string {
  const md = String(item?.ExtractedMarkdownMessage ?? '').trim();
  const raw = md || String(item?.RawTextBody ?? '');
  const cut = raw.split(/\n\s*(>|Em .{5,80} escreveu:|On .{5,80} wrote:|-----Original Message-----|De:\s)/)[0];
  return cut.replace(/\s+/g, ' ').trim().slice(0, 1000);
}

const TOKEN_ADDR = /^sdr[-+.]([A-Za-z0-9_-]{16,64})@/i;

async function leadsFor(item: any, from: string | null): Promise<SdrLead[]> {
  const rcpts = [...list(item?.To), ...list(item?.Recipients), ...list(item?.Cc)];
  for (const r of rcpts) {
    const raw = typeof r === 'string' ? (/<([^>]+)>/.exec(r)?.[1] ?? r) : String(r?.Address ?? '');
    const tok = TOKEN_ADDR.exec(raw.trim())?.[1];
    if (tok) {
      const l = await prisma.sdrLead.findUnique({ where: { unsubToken: tok } });
      if (l) return [l];
    }
  }
  if (!from) return [];
  // Sem token: só leads com esse e-mail que já receberam e-mail do SDR (evita mexer em quem nunca foi contatado).
  const leads = await prisma.sdrLead.findMany({ where: { email: from }, take: 20 });
  const out: SdrLead[] = [];
  for (const l of leads) {
    if (await prisma.sdrEvent.findFirst({ where: { orgId: l.orgId, leadId: l.id, type: 'ENVIO', channel: 'EMAIL' }, select: { id: true } })) out.push(l);
  }
  return out;
}

/** Processa um item do webhook. Devolve o que aconteceu (para o teste e o log). */
export async function handleInboundItem(item: any): Promise<'ignorado' | 'sem_lead' | 'resposta' | 'descadastro' | 'automatica'> {
  const from = addrOf(item?.From) ?? addrOf(item?.ReplyTo);
  const spam = Number(item?.SpamScore ?? item?.Spam?.Score ?? 0);
  // Falha de entrega e spam: não é o lead.
  if (spam >= 5 || isBounce(item, from)) return 'ignorado';
  const headerAuto = isAutomatic(item, from);
  const leads = await leadsFor(item, from);
  if (!leads.length) return headerAuto ? 'ignorado' : 'sem_lead';
  const text = replyText(item);
  // v1.22.0: resposta automática (cabeçalhos, assunto ou texto de "fora do escritório"/férias): fica no histórico do
  // lead marcada como "Resposta automática" e a cadência segue (ou pausa, se a empresa escolheu). Não vira resposta.
  const autoOf = async (orgId: string) => {
    if (headerAuto) return { automatica: true, motivo: 'cabeçalho ou assunto de resposta automática do e-mail' };
    const cfg = await getAutoReplyConfig(orgId);
    if (!cfg.enabled) return null;
    const d = detectAutoReply(text, { assunto: String(item?.Subject ?? ''), headers: item?.Headers, frasesExtras: cfg.frases });
    return d.automatica ? d : null;
  };
  const autos = await Promise.all(leads.map((l) => autoOf(l.orgId)));
  if (autos.every(Boolean)) {
    for (const [i, l] of leads.entries()) await logAutoReplyOnLead(l, 'EMAIL', autos[i]!.motivo);
    console.info('[sdr] resposta automática por e-mail ignorada', { leads: leads.map((l) => l.id) });
    return 'automatica';
  }
  const unsub = UNSUB_RE.test(text) || UNSUB_RE.test(String(item?.Subject ?? ''));
  for (const [i, l] of leads.entries()) {
    if (autos[i]) { await logAutoReplyOnLead(l, 'EMAIL', autos[i]!.motivo); continue; }
    if (unsub) {
      await optOutLead(l, 'EMAIL');
      await logEvent(l.orgId, l.id, 'NOTA', 'EMAIL', 'Pediu para sair respondendo o e-mail');
      continue;
    }
    const s = await getSdrSettings(l.orgId);
    await registerReply(l, 'EMAIL', s);
    if (text) await logEvent(l.orgId, l.id, 'NOTA', 'EMAIL', `Resposta por e-mail: ${text.slice(0, 400)}`);
  }
  console.info('[sdr] resposta por e-mail registrada', { leads: leads.map((l) => l.id), descadastro: unsub });
  return unsub ? 'descadastro' : 'resposta';
}

sdrInboundRouter.use(rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'Muitas requisições.' } }));
sdrInboundRouter.post('/', express.json({ limit: '2mb' }), async (req, res) => {
  if (!inboundEnabled()) return res.status(404).json({ error: 'Rota não encontrada' });
  if (!secretOk(req)) return res.status(401).json({ error: 'Não autorizado' });
  const items = Array.isArray(req.body?.items) ? req.body.items.slice(0, 50) : [];
  const out: string[] = [];
  for (const it of items) {
    try {
      out.push(await handleInboundItem(it));
    } catch (e) {
      console.error('[sdr] falha ao processar e-mail recebido', { error: (e as Error).message });
      out.push('erro');
    }
  }
  // Sempre 200 com o resumo: o Brevo tenta de novo em erro, e repetir não ajuda.
  res.json({ ok: true, itens: out });
});
sdrInboundRouter.all('/', (_req, res) => res.status(inboundEnabled() ? 405 : 404).json({ error: inboundEnabled() ? 'Use POST' : 'Rota não encontrada' }));
