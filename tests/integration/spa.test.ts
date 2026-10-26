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
    for (const url of ['/', '/plano', '/master', '/contatos', '/mensagens-antigas']) {
      const r = await request(app).get(url);
      expect(r.status, url).toBe(200);
      expect(r.text, url).toContain('<title>MCKBOT');
    }
    // /api nunca cai no SPA (responde JSON).
    const api = await request(app).get('/api/nao-existe');
    expect([401, 404]).toContain(api.status);
    expect(api.headers['content-type']).toMatch(/json/);
    expect((await request(app).get('/api/health')).body).toEqual({ ok: true });
    expect((await request(app).get('/mensagem-logo.svg')).status).toBe(200);
  });
});
