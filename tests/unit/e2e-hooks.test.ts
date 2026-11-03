import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { hooksAllowed, e2eHooksEnabled } from '../../server/lib/testHooks.js';
import { app } from '../helpers.js';

describe('ganchos dos testes de tela (E2E_TEST_HOOKS)', () => {
  it('só ligam com E2E_TEST_HOOKS=1 fora de produção', () => {
    expect(hooksAllowed('development', '1')).toBe(true);
    expect(hooksAllowed('production', '1')).toBe(false);
    expect(hooksAllowed('development', undefined)).toBe(false);
    expect(hooksAllowed('development', 'true')).toBe(false);
    expect(hooksAllowed('test', '1')).toBe(false);
  });
  it('a rota de teste não existe no app normal', async () => {
    expect(e2eHooksEnabled()).toBe(false);
    const r = await request(app).get('/api/__e2e__/signup-code?email=a@b.dev');
    expect(r.status).not.toBe(200);
    expect(r.body?.code).toBeUndefined();
  });
});
