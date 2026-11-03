import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import { app, prisma } from '../helpers.js';

describe('GET /healthz (monitor de uptime)', () => {
  it('sem login: 200 com o banco ok, sem dados, sem cache; HEAD também funciona', async () => {
    const r = await request(app).get('/healthz');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true });
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.headers['set-cookie']).toBeUndefined();
    expect((await request(app).head('/healthz')).status).toBe(200);
  });

  it('503 quando o banco falha', async () => {
    const spy = vi.spyOn(prisma, '$queryRaw').mockRejectedValueOnce(new Error('db fora'));
    try {
      const r = await request(app).get('/healthz');
      expect(r.status).toBe(503);
      expect(r.body).toEqual({ ok: false });
    } finally {
      spy.mockRestore();
    }
  });
});
