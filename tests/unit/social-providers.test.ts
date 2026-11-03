import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setFetch, resetFetch } from '../../server/lib/fetcher.js';
import { setResolver } from '../../server/lib/ssrf.js';
import {
  makeState, readState, metaAuthUrl, youtubeAuthUrl, redirectUri, providerConfigured, notConfiguredMessage,
  metaConnect, publishInstagram, publishYouTube, publishLinkedIn, STATE_TTL_MS, type ConnectedAccount,
} from '../../server/social/providers.js';
import { finalStatus } from '../../server/social/service.js';

interface Call { url: string; method: string; body: any; headers: Record<string, string> }
let calls: Call[] = [];
type Handler = (url: string, init: RequestInit) => Response | Promise<Response> | undefined;
let handlers: Handler[] = [];
const json = (b: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json', ...headers } });
const bodyOf = (init: RequestInit) => {
  const b = init.body as any;
  if (!b) return null;
  if (typeof b === 'string') { try { return JSON.parse(b); } catch { return Object.fromEntries(new URLSearchParams(b)); } }
  return b;
};

const ENV = ['META_APP_ID', 'META_APP_SECRET', 'GOOGLE_YT_CLIENT_ID', 'GOOGLE_YT_CLIENT_SECRET', 'LINKEDIN_CLIENT_ID', 'LINKEDIN_CLIENT_SECRET', 'TIKTOK_CLIENT_KEY', 'TIKTOK_CLIENT_SECRET', 'PUBLIC_URL'];
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  for (const k of ENV) delete process.env[k];
  calls = []; handlers = [];
  setResolver(async () => ['93.184.216.34']);
  setFetch(async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, method: String(init.method ?? 'GET'), body: bodyOf(init), headers: Object.fromEntries(new Headers(init.headers).entries()) });
    for (const h of handlers) { const r = await h(url, init); if (r) return r; }
    return json({ error: { message: `sem mock para ${url}` } }, 599);
  });
});
afterEach(() => {
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  resetFetch();
  setResolver(null);
});

const igAcc: ConnectedAccount = { accountId: '17841400000000000', accountName: '@mck', accessToken: 'PAGE_TOKEN', refreshToken: null, expiresAt: null, extra: {} };

describe('Novidades — state do OAuth', () => {
  it('aceita só o state assinado igual ao cookie, da mesma rede e no prazo', () => {
    const s = makeState('user1', 'instagram');
    expect(readState(s, s, 'instagram')).toEqual({ u: 'user1', p: 'instagram' });
    expect(readState(s, undefined, 'instagram')).toBeNull(); // sem cookie
    expect(readState(s, makeState('user1', 'instagram'), 'instagram')).toBeNull(); // cookie de outro início
    expect(readState(s, s, 'youtube')).toBeNull(); // outra rede
    const [body, sig] = s.split('.');
    const forged = `${Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url').toString()), u: 'hacker' })).toString('base64url')}.${sig}`;
    expect(readState(forged, forged, 'instagram')).toBeNull(); // assinatura não confere
    const old = makeState('user1', 'instagram', Date.now() - STATE_TTL_MS - 1000);
    expect(readState(old, old, 'instagram')).toBeNull(); // expirado
  });
});

describe('Novidades — configuração e URLs', () => {
  it('Meta usa o app padrão, a URL pública padrão e os escopos de publicação', () => {
    const u = new URL(metaAuthUrl('ST'));
    expect(u.origin + u.pathname).toBe('https://www.facebook.com/v21.0/dialog/oauth');
    expect(u.searchParams.get('client_id')).toBe('1865951357919820');
    expect(u.searchParams.get('redirect_uri')).toBe('https://mckbot.onrender.com/api/social/meta/callback');
    expect(u.searchParams.get('scope')).toBe('instagram_basic,instagram_content_publish,pages_show_list,pages_read_engagement,business_management');
    expect(u.searchParams.get('state')).toBe('ST');
    process.env.PUBLIC_URL = 'https://exemplo.dev/';
    expect(redirectUri('youtube')).toBe('https://exemplo.dev/api/social/youtube/callback');
  });

  it('YouTube pede acesso offline com consentimento e escopos de upload', () => {
    process.env.GOOGLE_YT_CLIENT_ID = 'yt-id';
    const u = new URL(youtubeAuthUrl('ST'));
    expect(u.searchParams.get('access_type')).toBe('offline');
    expect(u.searchParams.get('prompt')).toBe('consent');
    expect(u.searchParams.get('scope')).toBe('https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly');
    expect(u.searchParams.get('client_id')).toBe('yt-id');
  });

  it('redes sem variáveis aparecem como não configuradas; TikTok sempre não disponível', () => {
    expect(providerConfigured('instagram')).toBe(false);
    expect(providerConfigured('youtube')).toBe(false);
    expect(providerConfigured('linkedin')).toBe(false);
    process.env.META_APP_SECRET = 's';
    process.env.LINKEDIN_CLIENT_ID = 'a'; process.env.LINKEDIN_CLIENT_SECRET = 'b';
    expect(providerConfigured('instagram')).toBe(true);
    expect(providerConfigured('linkedin')).toBe(true);
    process.env.TIKTOK_CLIENT_KEY = 'k'; process.env.TIKTOK_CLIENT_SECRET = 's';
    expect(providerConfigured('tiktok')).toBe(false);
    expect(notConfiguredMessage('tiktok')).toMatch(/TikTok/);
  });
});

describe('Novidades — Meta/Instagram', () => {
  it('conexão: troca o código, gera token longo e guarda o token da Página que tem Instagram', async () => {
    process.env.META_APP_SECRET = 'segredo';
    handlers.push((url) => {
      if (url.includes('/oauth/access_token') && url.includes('code=CODE')) return json({ access_token: 'SHORT' });
      if (url.includes('grant_type=fb_exchange_token')) return json({ access_token: 'LONG', expires_in: 5184000 });
      if (url.includes('/me/accounts')) return json({ data: [
        { id: 'P0', name: 'Sem IG', access_token: 'T0' },
        { id: 'P1', name: 'MCK DESENVOLVIMENTO', access_token: 'PAGE_TOKEN', instagram_business_account: { id: 'IG1', username: 'mck.dev' } },
      ] });
      return undefined;
    });
    const acc = await metaConnect('CODE');
    expect(acc).toMatchObject({ provider: 'instagram', accountId: 'IG1', accountName: '@mck.dev', accessToken: 'PAGE_TOKEN', expiresAt: null, extra: { pageId: 'P1' } });
    const ex = new URL(calls[1].url);
    expect(ex.searchParams.get('fb_exchange_token')).toBe('SHORT');
    expect(ex.searchParams.get('client_secret')).toBe('segredo');
    expect(new URL(calls[2].url).searchParams.get('access_token')).toBe('LONG');
  });

  it('conexão sem Página com Instagram profissional dá erro claro', async () => {
    process.env.META_APP_SECRET = 's';
    handlers.push((url) => (url.includes('/me/accounts') ? json({ data: [{ id: 'P0', name: 'x', access_token: 't' }] }) : url.includes('access_token') ? json({ access_token: 'X' }) : undefined));
    await expect(metaConnect('C')).rejects.toThrow(/Instagram/);
  });

  it('imagem: cria o contêiner com image_url + legenda e publica', async () => {
    handlers.push((url, init) => {
      if (url.endsWith('/media') && init.method === 'POST') return json({ id: 'CONT1' });
      if (url.endsWith('/media_publish')) return json({ id: 'MEDIA1' });
      if (url.includes('/MEDIA1?')) return json({ permalink: 'https://www.instagram.com/p/abc/' });
      return undefined;
    });
    const r = await publishInstagram(igAcc, { title: 'Título', body: 'Texto', mediaUrl: 'https://cdn.exemplo.dev/a.jpg', mediaType: 'image' });
    expect(r).toEqual({ id: 'MEDIA1', url: 'https://www.instagram.com/p/abc/' });
    expect(calls[0].url).toBe('https://graph.facebook.com/v21.0/17841400000000000/media');
    expect(calls[0].body).toMatchObject({ image_url: 'https://cdn.exemplo.dev/a.jpg', caption: 'Título\n\nTexto', access_token: 'PAGE_TOKEN' });
    expect(calls[1].body).toMatchObject({ creation_id: 'CONT1' });
  });

  it('vídeo: publica como REELS e espera o processamento (status FINISHED)', async () => {
    let polls = 0;
    handlers.push((url, init) => {
      if (url.endsWith('/media') && init.method === 'POST') return json({ id: 'CONT2' });
      if (url.includes('/CONT2?')) return json({ status_code: ++polls < 3 ? 'IN_PROGRESS' : 'FINISHED' });
      if (url.endsWith('/media_publish')) return json({ id: 'MEDIA2' });
      if (url.includes('/MEDIA2?')) return json({}, 500);
      return undefined;
    });
    const r = await publishInstagram(igAcc, { title: 'T', body: '', mediaUrl: 'https://cdn.exemplo.dev/v.mp4', mediaType: 'video' }, { pollIntervalMs: 0 });
    expect(r).toEqual({ id: 'MEDIA2', url: null });
    expect(calls[0].body).toMatchObject({ media_type: 'REELS', video_url: 'https://cdn.exemplo.dev/v.mp4' });
    expect(polls).toBe(3);
  });

  it('vídeo com erro de processamento e post sem mídia falham sem publicar', async () => {
    handlers.push((url, init) => {
      if (url.endsWith('/media') && init.method === 'POST') return json({ id: 'C3' });
      if (url.includes('/C3?')) return json({ status_code: 'ERROR', status: 'Formato inválido' });
      return undefined;
    });
    await expect(publishInstagram(igAcc, { title: 'T', body: '', mediaUrl: 'https://x.dev/v.mp4', mediaType: 'video' }, { pollIntervalMs: 0 })).rejects.toThrow(/não processou/);
    expect(calls.some((c) => c.url.endsWith('/media_publish'))).toBe(false);
    await expect(publishInstagram(igAcc, { title: 'T', body: '', mediaUrl: null, mediaType: null })).rejects.toThrow(/exige/);
    await expect(publishInstagram(igAcc, { title: 'T', body: '', mediaUrl: 'http://x.dev/a.jpg', mediaType: 'image' })).rejects.toThrow(/https/);
  });

  it('erro da Graph API vira mensagem legível', async () => {
    handlers.push(() => json({ error: { message: 'Invalid OAuth access token' } }, 400));
    await expect(publishInstagram(igAcc, { title: 'T', body: '', mediaUrl: 'https://x.dev/a.jpg', mediaType: 'image' })).rejects.toThrow('Instagram: Invalid OAuth access token');
  });
});

describe('Novidades — YouTube', () => {
  it('renova o token, baixa o vídeo e envia multipart como público', async () => {
    process.env.GOOGLE_YT_CLIENT_ID = 'id'; process.env.GOOGLE_YT_CLIENT_SECRET = 'sec';
    let refreshed: any = null;
    handlers.push((url, init) => {
      if (url === 'https://oauth2.googleapis.com/token') return json({ access_token: 'NEW_AT', expires_in: 3600 });
      if (url === 'https://cdn.exemplo.dev/v.mp4') return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200, headers: { 'content-type': 'video/mp4' } });
      if (url.startsWith('https://www.googleapis.com/upload/youtube/v3/videos')) {
        const raw = Buffer.from(init.body as Uint8Array).toString('utf8');
        expect(raw).toContain('"privacyStatus":"public"');
        expect(raw).toContain('"title":"Vídeo novo"');
        return json({ id: 'VID1', status: { privacyStatus: 'private' } });
      }
      return undefined;
    });
    const acc: ConnectedAccount = { accountId: 'UC1', accountName: 'Canal', accessToken: 'OLD', refreshToken: 'RT', expiresAt: new Date(Date.now() - 1000), extra: {} };
    const r = await publishYouTube(acc, { title: 'Vídeo novo', body: 'Descrição', mediaUrl: 'https://cdn.exemplo.dev/v.mp4', mediaType: 'video' }, { onTokenRefresh: (t) => { refreshed = t; } });
    expect(r.id).toBe('VID1');
    expect(r.url).toBe('https://youtu.be/VID1');
    expect(r.note).toMatch(/private/);
    expect(refreshed?.accessToken).toBe('NEW_AT');
    expect(calls[0].body).toMatchObject({ grant_type: 'refresh_token', refresh_token: 'RT' });
    const up = calls.find((c) => c.url.includes('/upload/'))!;
    expect(up.headers.authorization).toBe('Bearer NEW_AT');
    expect(up.headers['content-type']).toMatch(/^multipart\/related; boundary=/);
  });

  it('exige vídeo e recusa mídia em endereço interno (SSRF)', async () => {
    const acc: ConnectedAccount = { accountId: 'UC1', accountName: null, accessToken: 'AT', refreshToken: 'RT', expiresAt: new Date(Date.now() + 3600_000), extra: {} };
    await expect(publishYouTube(acc, { title: 'T', body: '', mediaUrl: 'https://x.dev/a.jpg', mediaType: 'image' })).rejects.toThrow(/exige um vídeo/);
    setResolver(async () => ['10.0.0.5']);
    await expect(publishYouTube(acc, { title: 'T', body: '', mediaUrl: 'https://interno.test/v.mp4', mediaType: 'video' })).rejects.toThrow(/interno/);
  });
});

describe('Novidades — LinkedIn', () => {
  it('publica texto na Página da organização', async () => {
    handlers.push((url) => (url === 'https://api.linkedin.com/rest/posts' ? new Response(null, { status: 201, headers: { 'x-restli-id': 'urn:li:share:1' } }) : undefined));
    const r = await publishLinkedIn({ accountId: '145406914', accountName: null, accessToken: 'LI', refreshToken: null, expiresAt: null, extra: {} }, { title: 'T', body: 'B', mediaUrl: 'https://x.dev/v.mp4', mediaType: 'video' });
    expect(r.id).toBe('urn:li:share:1');
    expect(calls[0].body).toMatchObject({ author: 'urn:li:organization:145406914', visibility: 'PUBLIC', lifecycleState: 'PUBLISHED' });
    expect(calls[0].body.commentary).toContain('https://x.dev/v.mp4');
    expect(calls[0].headers['linkedin-version']).toMatch(/^\d{6}$/);
  });
});

describe('Novidades — status final', () => {
  it('published / partial / failed', () => {
    expect(finalStatus(['site', 'instagram'], { site: { ok: true, at: '' }, instagram: { ok: true, at: '' } })).toBe('published');
    expect(finalStatus(['site', 'instagram'], { site: { ok: true, at: '' }, instagram: { ok: false, at: '' } })).toBe('partial');
    expect(finalStatus(['instagram'], { instagram: { ok: false, at: '' } })).toBe('failed');
  });
});
