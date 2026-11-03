import { createHmac, randomBytes } from 'node:crypto';
import { httpFetch } from '../lib/fetcher.js';
import { safeFetch } from '../lib/ssrf.js';
import { getMasterKey, safeEqual } from '../lib/crypto.js';

/**
 * Novidades (Painel Master): conexão OAuth e publicação nas redes sociais da MCK DESENVOLVIMENTO.
 * Variáveis (todas opcionais; sem elas a rede aparece como "não configurada"):
 *  - Instagram (via Meta/Facebook Login): META_APP_ID (padrão 1865951357919820), META_APP_SECRET, META_GRAPH_VERSION (padrão v21.0)
 *  - YouTube: GOOGLE_YT_CLIENT_ID, GOOGLE_YT_CLIENT_SECRET
 *  - LinkedIn (Página da empresa): LINKEDIN_CLIENT_ID, LINKEDIN_CLIENT_SECRET, LINKEDIN_ORG_ID (padrão 145406914), LINKEDIN_API_VERSION
 *  - TikTok: TIKTOK_CLIENT_KEY, TIKTOK_CLIENT_SECRET (integração ainda não implementada)
 *  - PUBLIC_URL: endereço público do app (padrão https://mckbot.onrender.com) — base das URLs de retorno do OAuth.
 */

export const PROVIDERS = ['instagram', 'youtube', 'linkedin', 'tiktok'] as const;
export type Provider = (typeof PROVIDERS)[number];
/** Destinos de uma publicação: as redes + o próprio site (/empresa/novidades). */
export const TARGETS = ['site', ...PROVIDERS] as const;
export type Target = (typeof TARGETS)[number];
export const isProvider = (p: unknown): p is Provider => typeof p === 'string' && (PROVIDERS as readonly string[]).includes(p);

export const PROVIDER_LABEL: Record<Target, string> = { site: 'Site', instagram: 'Instagram', youtube: 'YouTube', linkedin: 'LinkedIn', tiktok: 'TikTok' };

export const publicUrl = () => (process.env.PUBLIC_URL || 'https://mckbot.onrender.com').replace(/\/+$/, '');
/** Rota OAuth de cada rede (Instagram conecta pelo Facebook Login → "meta"). */
export const oauthSlug = (p: Provider) => (p === 'instagram' ? 'meta' : p);
export const redirectUri = (p: Provider) => `${publicUrl()}/api/social/${oauthSlug(p)}/callback`;

export const metaAppId = () => process.env.META_APP_ID || '1865951357919820';
const metaVersion = () => process.env.META_GRAPH_VERSION || 'v21.0';
const GRAPH = () => `https://graph.facebook.com/${metaVersion()}`;
export const linkedinOrgId = () => process.env.LINKEDIN_ORG_ID || '145406914';
const linkedinVersion = () => process.env.LINKEDIN_API_VERSION || '202510';

export function providerConfigured(p: Provider): boolean {
  switch (p) {
    case 'instagram': return !!(metaAppId() && process.env.META_APP_SECRET);
    case 'youtube': return !!(process.env.GOOGLE_YT_CLIENT_ID && process.env.GOOGLE_YT_CLIENT_SECRET);
    case 'linkedin': return !!(process.env.LINKEDIN_CLIENT_ID && process.env.LINKEDIN_CLIENT_SECRET);
    case 'tiktok': return false; // ainda não implementado (exige app aprovado no TikTok for Developers)
  }
}

export function notConfiguredMessage(p: Provider): string {
  switch (p) {
    case 'instagram': return 'Instagram não configurado: defina META_APP_SECRET (e META_APP_ID) no servidor.';
    case 'youtube': return 'YouTube não configurado: defina GOOGLE_YT_CLIENT_ID e GOOGLE_YT_CLIENT_SECRET no servidor.';
    case 'linkedin': return 'LinkedIn não configurado: defina LINKEDIN_CLIENT_ID e LINKEDIN_CLIENT_SECRET no servidor.';
    case 'tiktok': return process.env.TIKTOK_CLIENT_KEY && process.env.TIKTOK_CLIENT_SECRET
      ? 'TikTok ainda não disponível: a publicação pela API do TikTok exige app aprovado (Content Posting API). Em breve.'
      : 'TikTok não configurado: defina TIKTOK_CLIENT_KEY e TIKTOK_CLIENT_SECRET no servidor (integração em breve).';
  }
}

// ---------- state do OAuth (assinado; também guardado em cookie para conferir no retorno) ----------
export const STATE_COOKIE = 'mck_social_state';
export const STATE_TTL_MS = 10 * 60_000;
const mac = (s: string) => createHmac('sha256', getMasterKey()).update(`social-oauth:${s}`).digest('base64url');
export function makeState(userId: string, provider: Provider, now = Date.now()): string {
  const body = Buffer.from(JSON.stringify({ u: userId, p: provider, e: now + STATE_TTL_MS, n: randomBytes(12).toString('hex') })).toString('base64url');
  return `${body}.${mac(body)}`;
}
/** Valida o state do retorno: assinatura, validade, rede e igualdade com o cookie gravado no início. */
export function readState(state: unknown, cookie: unknown, provider: Provider, now = Date.now()): { u: string; p: Provider } | null {
  const s = String(state ?? '');
  const c = String(cookie ?? '');
  if (!s || !c || !safeEqual(s, c)) return null;
  const [body, sig] = s.split('.');
  if (!body || !sig || !safeEqual(sig, mac(body))) return null;
  try {
    const v = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (typeof v?.e !== 'number' || v.e <= now || v.p !== provider || typeof v.u !== 'string') return null;
    return { u: v.u, p: v.p };
  } catch { return null; }
}

// ---------- HTTP ----------
export class ProviderError extends Error {
  constructor(message: string, public status?: number) { super(message); }
}
const TIMEOUT = 30_000;

async function readJson(res: Response): Promise<any> {
  const text = await res.text().catch(() => '');
  try { return text ? JSON.parse(text) : {}; } catch { return { raw: text.slice(0, 300) }; }
}
function errMsg(j: any, fallback: string): string {
  const m = j?.error?.error_user_msg || j?.error?.message || j?.error_description || j?.message || (typeof j?.error === 'string' ? j.error : null);
  return String(m || fallback).slice(0, 500);
}
async function jsonCall(url: string, init: RequestInit, who: string): Promise<any> {
  const res = await httpFetch(url, { ...init, signal: init.signal ?? AbortSignal.timeout(TIMEOUT) });
  const j = await readJson(res);
  if (!res.ok) throw new ProviderError(`${who}: ${errMsg(j, `HTTP ${res.status}`)}`, res.status);
  return j;
}
const form = (o: Record<string, string>) => ({ method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(o).toString() });

/** Baixa uma mídia pública (https) com proteção SSRF e limite de tamanho. */
export async function downloadMedia(url: string, maxBytes: number): Promise<{ data: Buffer; contentType: string }> {
  if (!/^https:\/\//i.test(url)) throw new ProviderError('A mídia precisa ser uma URL pública https');
  const res = await safeFetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new ProviderError(`Não foi possível baixar a mídia (HTTP ${res.status})`);
  const len = Number(res.headers.get('content-length') || 0);
  if (len && len > maxBytes) throw new ProviderError(`Mídia grande demais (máx. ${Math.round(maxBytes / 1024 / 1024)} MB)`);
  const data = Buffer.from(await res.arrayBuffer());
  if (data.length > maxBytes) throw new ProviderError(`Mídia grande demais (máx. ${Math.round(maxBytes / 1024 / 1024)} MB)`);
  if (!data.length) throw new ProviderError('A mídia baixada está vazia');
  return { data, contentType: (res.headers.get('content-type') || 'application/octet-stream').split(';')[0].trim() };
}

// ---------- Conta conectada (tokens já decifrados) ----------
export interface ConnectedAccount {
  accountId: string;
  accountName: string | null;
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
  extra: Record<string, unknown>;
}
export interface NewAccount extends ConnectedAccount { provider: Provider }

export interface PostInput { title: string; body: string; mediaUrl: string | null; mediaType: 'image' | 'video' | null }
export interface PublishOk { id: string; url: string | null; note?: string }
export interface PublishOpts { pollIntervalMs?: number; maxPolls?: number; onTokenRefresh?: (t: { accessToken: string; expiresAt: Date }) => Promise<void> | void }

export const captionOf = (p: PostInput) => [p.title.trim(), p.body.trim()].filter(Boolean).join('\n\n');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// =====================================================================
// Meta / Instagram
// =====================================================================
export const META_SCOPES = ['instagram_basic', 'instagram_content_publish', 'pages_show_list', 'pages_read_engagement', 'business_management'];

export function metaAuthUrl(state: string): string {
  const q = new URLSearchParams({ client_id: metaAppId(), redirect_uri: redirectUri('instagram'), state, scope: META_SCOPES.join(','), response_type: 'code' });
  return `https://www.facebook.com/${metaVersion()}/dialog/oauth?${q.toString()}`;
}

/** Código → token curto → token longo → Páginas; guarda o token da Página que tem conta do Instagram profissional. */
export async function metaConnect(code: string): Promise<NewAccount> {
  const base = { client_id: metaAppId(), client_secret: process.env.META_APP_SECRET ?? '' };
  const short = await jsonCall(`${GRAPH()}/oauth/access_token?${new URLSearchParams({ ...base, redirect_uri: redirectUri('instagram'), code }).toString()}`, {}, 'Meta');
  if (!short.access_token) throw new ProviderError('Meta: não devolveu token de acesso');
  const long = await jsonCall(`${GRAPH()}/oauth/access_token?${new URLSearchParams({ ...base, grant_type: 'fb_exchange_token', fb_exchange_token: short.access_token }).toString()}`, {}, 'Meta');
  const userToken = long.access_token || short.access_token;
  const pages = await jsonCall(`${GRAPH()}/me/accounts?${new URLSearchParams({ fields: 'id,name,access_token,instagram_business_account{id,username}', access_token: userToken, limit: '100' }).toString()}`, {}, 'Meta');
  const page = (Array.isArray(pages.data) ? pages.data : []).find((p: any) => p?.instagram_business_account?.id && p?.access_token);
  if (!page) throw new ProviderError('Nenhuma Página do Facebook com conta profissional do Instagram vinculada foi autorizada. Vincule o Instagram à Página e conecte de novo.');
  const ig = page.instagram_business_account;
  return {
    provider: 'instagram', accountId: String(ig.id), accountName: ig.username ? `@${ig.username}` : String(page.name ?? ig.id),
    accessToken: String(page.access_token), refreshToken: null, expiresAt: null, // token de Página obtido de token longo não expira
    extra: { pageId: String(page.id), pageName: page.name ?? null },
  };
}

export async function publishInstagram(acc: ConnectedAccount, post: PostInput, opts: PublishOpts = {}): Promise<PublishOk> {
  if (!post.mediaUrl || !post.mediaType) throw new ProviderError('O Instagram exige uma imagem ou um vídeo');
  if (!/^https:\/\//i.test(post.mediaUrl)) throw new ProviderError('A mídia precisa ser uma URL pública https');
  const caption = captionOf(post).slice(0, 2200);
  const token = acc.accessToken;
  const params: Record<string, string> = post.mediaType === 'video'
    ? { media_type: 'REELS', video_url: post.mediaUrl, caption, access_token: token }
    : { image_url: post.mediaUrl, caption, access_token: token };
  const container = await jsonCall(`${GRAPH()}/${encodeURIComponent(acc.accountId)}/media`, form(params), 'Instagram');
  const creationId = String(container.id ?? '');
  if (!creationId) throw new ProviderError('Instagram: não devolveu o contêiner da mídia');
  {
    // Imagem e vídeo: espera o contêiner ficar FINISHED antes de publicar (imagem costuma levar poucos segundos).
    const isVideo = post.mediaType === 'video';
    const every = opts.pollIntervalMs ?? (isVideo ? 5000 : 2000);
    const max = opts.maxPolls ?? (isVideo ? 60 : 30); // vídeo ~5 min, imagem ~1 min
    let status = '';
    for (let i = 0; i < max; i++) {
      const st = await jsonCall(`${GRAPH()}/${encodeURIComponent(creationId)}?${new URLSearchParams({ fields: 'status_code,status', access_token: token }).toString()}`, {}, 'Instagram');
      status = String(st.status_code ?? '');
      if (status === 'FINISHED') break;
      if (status === 'ERROR' || status === 'EXPIRED') throw new ProviderError(`Instagram não processou a mídia (${st.status || status})`);
      await sleep(every);
    }
    if (status !== 'FINISHED') throw new ProviderError('Instagram: a mídia demorou demais para processar. Tente publicar de novo.');
  }
  const pub = await jsonCall(`${GRAPH()}/${encodeURIComponent(acc.accountId)}/media_publish`, form({ creation_id: creationId, access_token: token }), 'Instagram');
  const mediaId = String(pub.id ?? '');
  if (!mediaId) throw new ProviderError('Instagram: publicação sem id');
  let url: string | null = null;
  try {
    const m = await jsonCall(`${GRAPH()}/${encodeURIComponent(mediaId)}?${new URLSearchParams({ fields: 'permalink', access_token: token }).toString()}`, {}, 'Instagram');
    url = typeof m.permalink === 'string' ? m.permalink : null;
  } catch { /* link é opcional */ }
  return { id: mediaId, url };
}

// =====================================================================
// YouTube (Google OAuth)
// =====================================================================
export const YT_SCOPES = ['https://www.googleapis.com/auth/youtube.upload', 'https://www.googleapis.com/auth/youtube.readonly'];
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';
export const YT_MAX_BYTES = 200 * 1024 * 1024;

export function youtubeAuthUrl(state: string): string {
  const q = new URLSearchParams({
    client_id: process.env.GOOGLE_YT_CLIENT_ID ?? '', redirect_uri: redirectUri('youtube'), response_type: 'code',
    scope: YT_SCOPES.join(' '), access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${q.toString()}`;
}
const ytCreds = () => ({ client_id: process.env.GOOGLE_YT_CLIENT_ID ?? '', client_secret: process.env.GOOGLE_YT_CLIENT_SECRET ?? '' });

export async function youtubeConnect(code: string): Promise<NewAccount> {
  const t = await jsonCall(GOOGLE_TOKEN, form({ ...ytCreds(), code, grant_type: 'authorization_code', redirect_uri: redirectUri('youtube') }), 'Google');
  if (!t.refresh_token) throw new ProviderError('O Google não devolveu acesso permanente. Remova o acesso do MCKBOT em myaccount.google.com/permissions e conecte de novo.');
  const ch = await jsonCall('https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true', { headers: { Authorization: `Bearer ${t.access_token}` } }, 'YouTube');
  const c = Array.isArray(ch.items) ? ch.items[0] : null;
  if (!c?.id) throw new ProviderError('Esta conta Google não tem canal do YouTube. Crie o canal e conecte de novo.');
  return {
    provider: 'youtube', accountId: String(c.id), accountName: c.snippet?.title ?? null,
    accessToken: String(t.access_token), refreshToken: String(t.refresh_token),
    expiresAt: new Date(Date.now() + Number(t.expires_in ?? 3600) * 1000), extra: {},
  };
}

async function youtubeToken(acc: ConnectedAccount, opts: PublishOpts): Promise<string> {
  if (acc.accessToken && acc.expiresAt && acc.expiresAt.getTime() > Date.now() + 60_000) return acc.accessToken;
  if (!acc.refreshToken) throw new ProviderError('YouTube: conexão sem refresh token. Conecte de novo.');
  const t = await jsonCall(GOOGLE_TOKEN, form({ ...ytCreds(), refresh_token: acc.refreshToken, grant_type: 'refresh_token' }), 'Google');
  const expiresAt = new Date(Date.now() + Number(t.expires_in ?? 3600) * 1000);
  await opts.onTokenRefresh?.({ accessToken: String(t.access_token), expiresAt });
  return String(t.access_token);
}

/** Baixa o vídeo da URL e envia por upload multipart (privacyStatus public; app não verificado pelo Google fica privado). */
export async function publishYouTube(acc: ConnectedAccount, post: PostInput, opts: PublishOpts = {}): Promise<PublishOk> {
  if (!post.mediaUrl || post.mediaType !== 'video') throw new ProviderError('O YouTube exige um vídeo');
  const token = await youtubeToken(acc, opts);
  const video = await downloadMedia(post.mediaUrl, YT_MAX_BYTES);
  const meta = {
    snippet: { title: post.title.trim().slice(0, 100) || 'Novidade', description: post.body.trim().slice(0, 5000), categoryId: '28' },
    status: { privacyStatus: 'public', selfDeclaredMadeForKids: false },
  };
  const boundary = `mck${randomBytes(12).toString('hex')}`;
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: ${video.contentType.startsWith('video/') ? video.contentType : 'video/mp4'}\r\n\r\n`),
    video.data,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const r = await jsonCall('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=multipart&part=snippet,status', {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': `multipart/related; boundary=${boundary}` }, body: new Uint8Array(body), signal: AbortSignal.timeout(10 * 60_000),
  }, 'YouTube');
  if (!r.id) throw new ProviderError('YouTube: envio sem id do vídeo');
  const priv = r.status?.privacyStatus;
  return {
    id: String(r.id), url: `https://youtu.be/${r.id}`,
    note: priv && priv !== 'public' ? `O YouTube deixou o vídeo como "${priv}" (app ainda não verificado pelo Google).` : undefined,
  };
}

// =====================================================================
// LinkedIn (Página da empresa: w_organization_social)
// =====================================================================
export const LINKEDIN_SCOPES = ['w_organization_social'];
const LI_MAX_IMAGE = 20 * 1024 * 1024;

export function linkedinAuthUrl(state: string): string {
  const q = new URLSearchParams({ response_type: 'code', client_id: process.env.LINKEDIN_CLIENT_ID ?? '', redirect_uri: redirectUri('linkedin'), state, scope: LINKEDIN_SCOPES.join(' ') });
  return `https://www.linkedin.com/oauth/v2/authorization?${q.toString()}`;
}

export async function linkedinConnect(code: string): Promise<NewAccount> {
  const t = await jsonCall('https://www.linkedin.com/oauth/v2/accessToken', form({
    grant_type: 'authorization_code', code, redirect_uri: redirectUri('linkedin'),
    client_id: process.env.LINKEDIN_CLIENT_ID ?? '', client_secret: process.env.LINKEDIN_CLIENT_SECRET ?? '',
  }), 'LinkedIn');
  if (!t.access_token) throw new ProviderError('LinkedIn: não devolveu token de acesso');
  return {
    provider: 'linkedin', accountId: linkedinOrgId(), accountName: `Página ${linkedinOrgId()}`,
    accessToken: String(t.access_token), refreshToken: t.refresh_token ? String(t.refresh_token) : null,
    expiresAt: t.expires_in ? new Date(Date.now() + Number(t.expires_in) * 1000) : null, extra: {},
  };
}

const liHeaders = (token: string) => ({ Authorization: `Bearer ${token}`, 'LinkedIn-Version': linkedinVersion(), 'X-Restli-Protocol-Version': '2.0.0' });

/** Texto na Página; imagem vai anexada (Images API); vídeo vai como link no texto. */
export async function publishLinkedIn(acc: ConnectedAccount, post: PostInput): Promise<PublishOk> {
  if (acc.expiresAt && acc.expiresAt.getTime() < Date.now()) throw new ProviderError('LinkedIn: a conexão expirou. Conecte de novo.');
  const author = `urn:li:organization:${acc.accountId}`;
  let commentary = captionOf(post);
  let content: unknown;
  if (post.mediaUrl && post.mediaType === 'image') {
    const img = await downloadMedia(post.mediaUrl, LI_MAX_IMAGE);
    const init = await jsonCall('https://api.linkedin.com/rest/images?action=initializeUpload', {
      method: 'POST', headers: { ...liHeaders(acc.accessToken), 'Content-Type': 'application/json' }, body: JSON.stringify({ initializeUploadRequest: { owner: author } }),
    }, 'LinkedIn');
    const uploadUrl = init?.value?.uploadUrl;
    const image = init?.value?.image;
    if (!uploadUrl || !image) throw new ProviderError('LinkedIn: não devolveu o endereço de envio da imagem');
    const up = await httpFetch(uploadUrl, { method: 'PUT', headers: { Authorization: `Bearer ${acc.accessToken}`, 'Content-Type': img.contentType }, body: new Uint8Array(img.data), signal: AbortSignal.timeout(120_000) });
    if (!up.ok) throw new ProviderError(`LinkedIn: falha ao enviar a imagem (HTTP ${up.status})`, up.status);
    content = { media: { id: image, title: post.title.slice(0, 200) } };
  } else if (post.mediaUrl) {
    commentary = `${commentary}\n\n${post.mediaUrl}`;
  }
  const res = await httpFetch('https://api.linkedin.com/rest/posts', {
    method: 'POST', headers: { ...liHeaders(acc.accessToken), 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(TIMEOUT),
    body: JSON.stringify({
      author, commentary: commentary.slice(0, 3000), visibility: 'PUBLIC',
      distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
      ...(content ? { content } : {}), lifecycleState: 'PUBLISHED', isReshareDisabledByAuthor: false,
    }),
  });
  if (!res.ok) throw new ProviderError(`LinkedIn: ${errMsg(await readJson(res), `HTTP ${res.status}`)}`, res.status);
  const id = res.headers.get('x-restli-id') || res.headers.get('x-linkedin-id') || '';
  return { id, url: id ? `https://www.linkedin.com/feed/update/${id}/` : null };
}

// ---------- tabela de despacho ----------
export function authUrlFor(p: Provider, state: string): string {
  switch (p) {
    case 'instagram': return metaAuthUrl(state);
    case 'youtube': return youtubeAuthUrl(state);
    case 'linkedin': return linkedinAuthUrl(state);
    case 'tiktok': throw new ProviderError(notConfiguredMessage('tiktok'), 503);
  }
}
export function connectFor(p: Provider, code: string): Promise<NewAccount> {
  switch (p) {
    case 'instagram': return metaConnect(code);
    case 'youtube': return youtubeConnect(code);
    case 'linkedin': return linkedinConnect(code);
    case 'tiktok': return Promise.reject(new ProviderError(notConfiguredMessage('tiktok'), 503));
  }
}
export function publishFor(p: Provider, acc: ConnectedAccount, post: PostInput, opts: PublishOpts = {}): Promise<PublishOk> {
  switch (p) {
    case 'instagram': return publishInstagram(acc, post, opts);
    case 'youtube': return publishYouTube(acc, post, opts);
    case 'linkedin': return publishLinkedIn(acc, post);
    case 'tiktok': return Promise.reject(new ProviderError(notConfiguredMessage('tiktok'), 503));
  }
}
