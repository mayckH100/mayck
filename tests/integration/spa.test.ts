import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { app } from '../helpers.js';

// Só roda quando o frontend já foi compilado (npm run build:local).
const built = existsSync(path.resolve(process.cwd(), 'dist/web/mensagem.html'));

describe.skipIf(!built)('SPA: MCKBOT na raiz e MCK Mensagens em /mensagem', () => {
  it('serve a entrada do MCK Mensagens em /mensagem e /mensagem/*', async () => {
    for (const url of ['/mensagem', '/mensagem/', '/mensagem/contatos', '/mensagem/campanhas/abc', '/mensagem/assinatura?billing=success']) {
      const r = await request(app).get(url);
      expect(r.status, url).toBe(200);
      expect(r.text, url).toContain('MCK Mensagens');
    }
  });
  it('não quebra as rotas do MCKBOT nem a API', async () => {
    for (const url of ['/plano', '/master', '/contatos', '/mensagens-antigas', '/login', '/entrar', '/cadastro']) {
      const r = await request(app).get(url);
      expect(r.status, url).toBe(200);
      expect(r.text, url).toMatch(/<title>MCK DESENVOLVIMENTO · MCKBOT/);
      expect(r.headers['x-robots-tag'], url).toBe('noindex, follow');
    }
    // Raiz: logado (cookie), PWA e retornos de pagamento continuam abrindo o app.
    for (const [url, cookie] of [['/', 'mck_sid=qualquer'], ['/?source=pwa', ''], ['/?billing=success', '']] as const) {
      const req = request(app).get(url);
      const r = cookie ? await req.set('Cookie', cookie) : await req;
      expect(r.status, url).toBe(200);
      expect(r.text, url).toMatch(/<title>MCK DESENVOLVIMENTO · MCKBOT/);
      expect(r.headers['x-mck-shell'], url).toBe('app');
    }
    // /api nunca cai no SPA (responde JSON).
    const api = await request(app).get('/api/nao-existe');
    expect([401, 404]).toContain(api.status);
    expect(api.headers['content-type']).toMatch(/json/);
    expect((await request(app).get('/api/health')).body).toEqual({ ok: true });
    expect((await request(app).get('/mensagem-logo.svg')).status).toBe(200);
  });
});

describe('raiz "/" para visitantes e buscadores: site da MCK DESENVOLVIMENTO', () => {
  it('sem cookie: landing indexável com H1, CNPJ, links, canonical e verificação do Search Console', async () => {
    const r = await request(app).get('/');
    expect(r.status).toBe(200);
    expect(r.headers['x-robots-tag']).toBeUndefined();
    expect(r.headers['x-mck-shell']).toBeUndefined();
    expect(r.headers.vary).toMatch(/Cookie/);
    expect(r.text).toMatch(/<title>MCK DESENVOLVIMENTO · /);
    expect(r.text).toContain('<h1>MCK Desenvolvimento');
    expect(r.text).toContain('58.460.367/0001-78');
    expect(r.text).toContain('<link rel="canonical" href="https://mckbot.onrender.com/">');
    expect(r.text).toContain('google-site-verification" content="rdaXqM9TD2Du7cMhAdreVM4lB35CmbSZdb8ZNeJQ12M"');
    expect(r.text).toContain('href="/login"');
    expect(r.text).toContain('href="/empresa/planos.html"');
  });
  it('/empresa e /empresa/ servem a mesma home (canonical na raiz) e /index.html redireciona', async () => {
    for (const url of ['/empresa', '/empresa/']) {
      const r = await request(app).get(url);
      expect(r.status, url).toBe(200);
      expect(r.text, url).toContain('<link rel="canonical" href="https://mckbot.onrender.com/">');
      expect(r.text, url).toContain('google-site-verification');
    }
    const ix = await request(app).get('/index.html');
    expect(ix.status).toBe(301);
    expect(ix.headers.location).toBe('/');
  });
});
