import type { SocialAccount, SocialPost } from '@prisma/client';
import { prisma } from '../db.js';
import { decrypt, decryptOrNull, encrypt, encryptOrNull } from '../lib/crypto.js';
import { parseJson } from '../lib/json.js';
import {
  PROVIDERS, PROVIDER_LABEL, TARGETS, isProvider, notConfiguredMessage, providerConfigured, publishFor,
  type ConnectedAccount, type NewAccount, type PostInput, type Provider, type PublishOpts, type Target,
} from './providers.js';

/** Resultado de um destino na publicação. */
export interface TargetResult { ok: boolean; id?: string | null; url?: string | null; note?: string; error?: string; at: string }
export type Results = Partial<Record<Target, TargetResult>>;

export const POST_STATUSES = ['draft', 'approved', 'published', 'partial', 'failed'] as const;
export type PostStatus = (typeof POST_STATUSES)[number];

export const targetsOf = (p: Pick<SocialPost, 'targets'>): Target[] =>
  (parseJson<unknown[]>(p.targets, []) ?? []).filter((t): t is Target => typeof t === 'string' && (TARGETS as readonly string[]).includes(t));
export const resultsOf = (p: Pick<SocialPost, 'results'>): Results => {
  const r = parseJson<Results>(p.results, {});
  return r && typeof r === 'object' && !Array.isArray(r) ? r : {};
};

export function accountView(a: SocialAccount | null, p: Provider) {
  return {
    provider: p, label: PROVIDER_LABEL[p], configured: providerConfigured(p),
    message: providerConfigured(p) ? null : notConfiguredMessage(p),
    connected: !!a, accountId: a?.accountId ?? null, accountName: a?.accountName ?? null,
    expiresAt: a?.expiresAt?.toISOString() ?? null, connectedAt: a?.updatedAt.toISOString() ?? null,
  };
}

export async function listAccounts() {
  const rows = await prisma.socialAccount.findMany();
  return PROVIDERS.map((p) => accountView(rows.find((r) => r.provider === p) ?? null, p));
}

/** Grava (ou substitui) a conta da rede, sempre com os tokens cifrados. */
export async function saveAccount(a: NewAccount) {
  const data = {
    accountId: a.accountId, accountName: a.accountName, accessToken: encrypt(a.accessToken), refreshToken: encryptOrNull(a.refreshToken),
    expiresAt: a.expiresAt, extra: JSON.stringify(a.extra ?? {}),
  };
  return prisma.socialAccount.upsert({ where: { provider: a.provider }, create: { provider: a.provider, ...data }, update: data });
}

export function decryptAccount(a: SocialAccount): ConnectedAccount {
  return {
    accountId: a.accountId, accountName: a.accountName, accessToken: decrypt(a.accessToken), refreshToken: decryptOrNull(a.refreshToken),
    expiresAt: a.expiresAt, extra: parseJson<Record<string, unknown>>(a.extra, {}) ?? {},
  };
}

export function postView(p: SocialPost) {
  return {
    id: p.id, title: p.title, body: p.body, mediaUrl: p.mediaUrl, mediaType: p.mediaType, targets: targetsOf(p), status: p.status as PostStatus,
    results: resultsOf(p), publishedAt: p.publishedAt?.toISOString() ?? null, createdAt: p.createdAt.toISOString(), updatedAt: p.updatedAt.toISOString(),
  };
}

/** Status final a partir dos resultados dos destinos pedidos. */
export function finalStatus(targets: Target[], results: Results): PostStatus {
  const oks = targets.filter((t) => results[t]?.ok).length;
  if (targets.length && oks === targets.length) return 'published';
  return oks > 0 ? 'partial' : 'failed';
}

// Publicações em andamento (o pedido HTTP responde antes; a tela acompanha pelo status "approved").
const inflight = new Map<string, Promise<SocialPost | null>>();
export const waitPublishing = (id: string) => inflight.get(id) ?? Promise.resolve(null);

/**
 * Aprova e publica. Só sai de draft/failed/partial (troca atômica para "approved": nunca publica duas vezes ao mesmo tempo).
 * Em "partial"/"failed" só tenta de novo os destinos que ainda não deram certo. Falha numa rede não impede as outras.
 * Devolve null se a publicação não estava num status que permite publicar.
 */
export async function approveAndPublish(id: string, opts: PublishOpts = {}): Promise<{ started: boolean; promise: Promise<SocialPost | null> }> {
  const r = await prisma.socialPost.updateMany({ where: { id, status: { in: ['draft', 'failed', 'partial'] } }, data: { status: 'approved' } });
  if (!r.count) return { started: false, promise: Promise.resolve(null) };
  const promise = runPublish(id, opts).finally(() => inflight.delete(id));
  inflight.set(id, promise);
  return { started: true, promise };
}

async function runPublish(id: string, opts: PublishOpts): Promise<SocialPost | null> {
  const post = await prisma.socialPost.findUnique({ where: { id } });
  if (!post) return null;
  const targets = targetsOf(post);
  const results: Results = resultsOf(post);
  const input: PostInput = { title: post.title, body: post.body, mediaUrl: post.mediaUrl, mediaType: (post.mediaType as PostInput['mediaType']) ?? null };
  const accounts = await prisma.socialAccount.findMany();
  for (const t of targets) {
    if (results[t]?.ok) continue; // já publicado numa tentativa anterior
    const at = new Date().toISOString();
    if (t === 'site') { results.site = { ok: true, url: '/empresa/novidades', at }; continue; }
    if (!isProvider(t)) continue;
    try {
      if (!providerConfigured(t)) throw new Error(notConfiguredMessage(t));
      const row = accounts.find((a) => a.provider === t);
      if (!row) throw new Error(`${PROVIDER_LABEL[t]} não conectado. Clique em "Conectar" na aba Novidades.`);
      const acc = decryptAccount(row);
      const out = await publishFor(t, acc, input, {
        ...opts,
        onTokenRefresh: async (tok) => { await prisma.socialAccount.update({ where: { id: row.id }, data: { accessToken: encrypt(tok.accessToken), expiresAt: tok.expiresAt } }); },
      });
      results[t] = { ok: true, id: out.id || null, url: out.url, ...(out.note ? { note: out.note } : {}), at };
    } catch (e) {
      results[t] = { ok: false, error: String((e as Error)?.message ?? e).slice(0, 500), at };
    }
  }
  const status = finalStatus(targets, results);
  return prisma.socialPost.update({
    where: { id },
    data: { status, results: JSON.stringify(results), publishedAt: status === 'failed' ? post.publishedAt : post.publishedAt ?? new Date() },
  });
}

/** Itens públicos do site: publicações com destino "site" já publicadas (total ou parcialmente). */
export async function publicNovidades(limit = 50) {
  const rows = await prisma.socialPost.findMany({ where: { status: { in: ['published', 'partial'] } }, orderBy: { publishedAt: 'desc' }, take: Math.min(limit * 2, 200) });
  return rows
    .filter((p) => resultsOf(p).site?.ok)
    .slice(0, limit)
    .map((p) => {
      const r = resultsOf(p);
      const links: Record<string, string> = {};
      for (const t of PROVIDERS) { const u = r[t]?.ok ? r[t]?.url : null; if (u && /^https:\/\//.test(u)) links[t] = u; }
      return { id: p.id, title: p.title, body: p.body, mediaUrl: p.mediaUrl, mediaType: p.mediaType, publishedAt: p.publishedAt?.toISOString() ?? null, links };
    });
}
