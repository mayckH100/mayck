import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { app } from '../helpers.js';
import { APP_VERSION } from '../../server/changelog.js';

describe('GET /api/versao', () => {
  it('sem login: versão atual do changelog, commit e rótulo, sem cache; /healthz continua {ok:true}', async () => {
    const r = await request(app).get('/api/versao');
    expect(r.status).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.headers['set-cookie']).toBeUndefined();
    expect(r.body.ok).toBe(true);
    expect(r.body.versao).toBe(APP_VERSION);
    expect(typeof r.body.commit).toBe('string');
    expect(r.body.commit.length).toBeGreaterThan(0);
    expect(r.body.rotulo).toMatch(new RegExp(`^Versão ${APP_VERSION.replace(/\./g, '\\.')}`));
    expect((await request(app).get('/healthz')).body).toEqual({ ok: true });
  });
});
