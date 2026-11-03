import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { registerClient, loginClient, Client, prisma, uniq } from '../helpers.js';
import { setFetch, resetFetch } from '../../server/lib/fetcher.js';
import { makeState, STATE_COOKIE } from '../../server/social/providers.js';
import { waitPublishing } from '../../server/social/service.js';
import { decrypt } from '../../server/lib/crypto.js';

const PASS = 'senhaSegura123';
const ENV = ['META_APP_SECRET', 'GOOGLE_YT_CLIENT_ID', 'GOOGLE_YT_CLIENT_SECRET', 'LINKEDIN_CLIENT_ID', 'LINKEDIN_CLIENT_SECRET', 'PUBLIC_URL'];
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });

/** Extrai o state do Location do redirecionamento para a rede. */
const stateOf = (location: string) => new URL(location).searchParams.get('state')!;

describe('Novidades (redes sociais do Painel Master)', () => {
  let admin: Client;
  let owner: Client;
  let saved: Record<string, string | undefined> = {};
  let igPublishes = 0;

  beforeAll(async () => {
    saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
    for (const k of ENV) delete process.env[k];
    const email = `${uniq('social')}@teste.dev`;
    const first = await registerClient({ email });
    await prisma.user.update({ where: { id: first.me.user.id }, data: { isSuperAdmin: true } });
    admin = (await loginClient(email, PASS)).c;
    owner = await registerClient();
    setFetch(async (input, init = {}) => {
      const url = String(input);
      if (url.includes('/oauth/access_token') && url.includes('code=BOM')) return json({ access_token: 'SHORT' });
      if (url.includes('grant_type=fb_exchange_token')) return json({ access_token: 'LONG' });
      if (url.includes('/me/accounts')) return json({ data: [{ id: 'P1', name: 'MCK', access_token: 'PAGE_SECRET_TOKEN', instagram_business_account: { id: 'IG1', username: 'mck.dev' } }] });
      if (url.endsWith('/IG1/media') && init.method === 'POST') return json({ id: 'CONT' });
      if (url.includes('/CONT?')) return json({ status_code: 'FINISHED' });
      if (url.endsWith('/IG1/media_publish')) { igPublishes++; return json({ id: 'M1' }); }
      if (url.includes('/M1?')) return json({ permalink: 'https://www.instagram.com/p/m1/' });
      return json({ error: { message: `sem mock: ${url}` } }, 500);
    });
  });
  afterAll(async () => {
    for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    resetFetch();
    await prisma.socialPost.deleteMany({});
    await prisma.socialAccount.deleteMany({});
  });
  beforeEach(() => { delete process.env.META_APP_SECRET; });

  it('rotas do Master: 401 sem login e 403 para quem não é superadmin (inclusive OWNER)', async () => {
    const anon = new Client();
    for (const url of ['/api/social/accounts', '/api/social/posts', '/api/social/meta/connect', '/api/social/youtube/connect']) {
      expect((await anon.get(url)).status).toBe(401);
      expect((await owner.get(url)).status).toBe(403);
    }
    expect((await owner.post('/api/social/posts', { title: 'x', targets: ['site'] })).status).toBe(403);
    expect((await owner.post('/api/social/posts/qualquer/publish', { confirm: true })).status).toBe(403);
    expect((await owner.del('/api/social/accounts/instagram')).status).toBe(403);
    expect((await admin.get('/api/social/accounts')).status).toBe(200);
    // Público: só leitura
    const pub = await anon.get('/api/novidades');
    expect(pub.status).toBe(200);
    expect(Array.isArray(pub.body.items)).toBe(true);
  });

  it('status das redes: sem variáveis, todas "não configuradas"', async () => {
    const r = await admin.get('/api/social/accounts');
    expect(r.body.accounts.map((a: any) => a.provider)).toEqual(['instagram', 'youtube', 'linkedin', 'tiktok']);
    expect(r.body.accounts.every((a: any) => !a.configured && !a.connected && a.message)).toBe(true);
  });

  it('conectar sem configuração volta ao painel com o aviso; TikTok sempre stub', async () => {
    for (const slug of ['meta', 'youtube', 'linkedin', 'tiktok']) {
      const r = await admin.get(`/api/social/${slug}/connect`);
      expect(r.status).toBe(302);
      expect(r.headers.location).toMatch(/^\/master\?aba=novidades&social=erro/);
      expect(decodeURIComponent(r.headers.location)).toMatch(/configurado|disponível/);
    }
  });

  it('OAuth Meta: start redireciona com state em cookie; callback valida o state e guarda o token cifrado', async () => {
    process.env.META_APP_SECRET = 'segredo';
    const start = await admin.get('/api/social/meta/connect');
    expect(start.status).toBe(302);
    expect(start.headers.location).toMatch(/^https:\/\/www\.facebook\.com\/v21\.0\/dialog\/oauth\?/);
    const loc = new URL(start.headers.location);
    expect(loc.searchParams.get('client_id')).toBe('1865951357919820');
    expect(loc.searchParams.get('redirect_uri')).toBe('https://mckbot.onrender.com/api/social/meta/callback');
    const cookie = String(start.headers['set-cookie']);
    expect(cookie).toContain(`${STATE_COOKIE}=`);
    expect(cookie).toMatch(/HttpOnly/i);
    const state = stateOf(start.headers.location);

    // state forjado (assinado mas sem o cookie igual) é recusado
    const forged = makeState(admin.me.user.id, 'instagram');
    const bad = await admin.get(`/api/social/meta/callback?code=BOM&state=${encodeURIComponent(forged)}`);
    expect(bad.headers.location).toMatch(/social=erro/);
    expect(await prisma.socialAccount.count()).toBe(0);

    // o callback anterior limpou o cookie: começa de novo
    const start2 = await admin.get('/api/social/meta/connect');
    const state2 = stateOf(start2.headers.location);
    expect(state2).not.toBe(state);
    // outro usuário (OWNER) com o state não consegue concluir
    const other = await owner.get(`/api/social/meta/callback?code=BOM&state=${encodeURIComponent(state2)}`);
    expect(other.headers.location).toMatch(/social=erro/);

    const ok = await admin.get(`/api/social/meta/callback?code=BOM&state=${encodeURIComponent(state2)}`);
    expect(ok.status).toBe(302);
    expect(ok.headers.location).toBe('/master?aba=novidades&social=ok&rede=instagram');
    const acc = await prisma.socialAccount.findUnique({ where: { provider: 'instagram' } });
    expect(acc).toMatchObject({ accountId: 'IG1', accountName: '@mck.dev' });
    expect(acc!.accessToken).not.toContain('PAGE_SECRET_TOKEN'); // cifrado
    expect(decrypt(acc!.accessToken)).toBe('PAGE_SECRET_TOKEN');
    const st = await admin.get('/api/social/accounts');
    const ig = st.body.accounts.find((a: any) => a.provider === 'instagram');
    expect(ig).toMatchObject({ configured: true, connected: true, accountName: '@mck.dev' });
    expect(JSON.stringify(st.body)).not.toContain('PAGE_SECRET_TOKEN');
  });

  it('publicação: rascunho → aprovação explícita → resultados por rede; falha numa rede não impede as outras', async () => {
    process.env.META_APP_SECRET = 'segredo';
    // validações
    expect((await admin.post('/api/social/posts', { title: 'Sem mídia', targets: ['instagram'] })).status).toBe(400);
    expect((await admin.post('/api/social/posts', { title: 'Http', mediaUrl: 'http://x.dev/a.jpg', mediaType: 'image', targets: ['site'] })).status).toBe(400);
    expect((await admin.post('/api/social/posts', { title: 'YT imagem', mediaUrl: 'https://x.dev/a.jpg', mediaType: 'image', targets: ['youtube'] })).status).toBe(400);

    const c = await admin.post('/api/social/posts', { title: 'Nova função', body: 'IA marca reuniões', mediaUrl: 'https://cdn.exemplo.dev/a.jpg', mediaType: 'image', targets: ['site', 'instagram', 'linkedin'] });
    expect(c.status).toBe(201);
    expect(c.body.status).toBe('draft');
    const id = c.body.id;
    // rascunho não aparece no site
    expect((await new Client().get('/api/novidades')).body.items.find((x: any) => x.id === id)).toBeUndefined();
    // editar rascunho
    const e = await admin.put(`/api/social/posts/${id}`, { title: 'Nova função!', body: 'IA marca reuniões', mediaUrl: 'https://cdn.exemplo.dev/a.jpg', mediaType: 'image', targets: ['site', 'instagram', 'linkedin'] });
    expect(e.status).toBe(200);
    expect(e.body.title).toBe('Nova função!');

    // sem confirmação explícita não publica
    expect((await admin.post(`/api/social/posts/${id}/publish`, {})).status).toBe(400);
    expect(igPublishes).toBe(0);

    const p = await admin.post(`/api/social/posts/${id}/publish`, { confirm: true });
    expect(p.status).toBe(202);
    expect(p.body.status).toBe('approved');
    await waitPublishing(id);
    const done = (await admin.get('/api/social/posts')).body.items.find((x: any) => x.id === id);
    expect(done.status).toBe('partial');
    expect(done.results.site.ok).toBe(true);
    expect(done.results.instagram).toMatchObject({ ok: true, id: 'M1', url: 'https://www.instagram.com/p/m1/' });
    expect(done.results.linkedin.ok).toBe(false);
    expect(done.results.linkedin.error).toMatch(/LinkedIn não configurado/);
    expect(done.publishedAt).toBeTruthy();
    expect(igPublishes).toBe(1);
    // não edita depois de sair do rascunho
    expect((await admin.put(`/api/social/posts/${id}`, { title: 'x', targets: ['site'] })).status).toBe(400);

    // site público
    const pub = await new Client().get('/api/novidades');
    const item = pub.body.items.find((x: any) => x.id === id);
    expect(item).toMatchObject({ title: 'Nova função!', mediaType: 'image', links: { instagram: 'https://www.instagram.com/p/m1/' } });
    expect(JSON.stringify(pub.body)).not.toMatch(/results|createdById/);

    // tentar de novo: só o que falhou (Instagram não é publicado duas vezes)
    const again = await admin.post(`/api/social/posts/${id}/publish`, { confirm: true });
    expect(again.status).toBe(202);
    await waitPublishing(id);
    expect(igPublishes).toBe(1);

    // excluir sai do site
    expect((await admin.del(`/api/social/posts/${id}`)).status).toBe(200);
    expect((await new Client().get('/api/novidades')).body.items.find((x: any) => x.id === id)).toBeUndefined();
  });

  it('desconectar remove a conta', async () => {
    expect((await admin.del('/api/social/accounts/instagram')).status).toBe(200);
    expect(await prisma.socialAccount.count({ where: { provider: 'instagram' } })).toBe(0);
    expect((await admin.del('/api/social/accounts/orkut')).status).toBe(404);
  });
});
