import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { app, registerClient, loginClient, uniq, prisma } from '../helpers.js';
import { config } from '../../server/config.js';

describe('Autenticação e sessão', () => {
  it('cadastro cria usuário, organização (dono), etapas do Kanban e cookie httpOnly', async () => {
    const email = `${uniq()}@teste.dev`;
    const res = await request(app).post('/api/auth/register').set('x-requested-with', 'mckbot').send({ name: 'Ana', email, password: 'senhaSegura123', orgName: 'Loja da Ana' });
    expect(res.status).toBe(201);
    expect(res.body.role).toBe('OWNER');
    expect(res.body.csrfToken).toBeTruthy();
    const cookie = String(res.headers['set-cookie']);
    expect(cookie).toMatch(/mck_sid=/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    const user = await prisma.user.findUnique({ where: { email } });
    expect(user!.passwordHash).toMatch(/^\$2[aby]\$12\$/);
    expect(await prisma.kanbanStage.count({ where: { orgId: res.body.org.id } })).toBe(5);
  });

  it('rejeita senha curta e e-mail duplicado', async () => {
    const c = await registerClient();
    const r1 = await request(app).post('/api/auth/register').set('x-requested-with', 'mckbot').send({ name: 'X', email: `${uniq()}@t.dev`, password: '123', orgName: 'Org' });
    expect(r1.status).toBe(400);
    const r2 = await request(app).post('/api/auth/register').set('x-requested-with', 'mckbot').send({ name: 'X Y', email: c.me.user.email, password: 'senhaSegura123', orgName: 'Org' });
    expect(r2.status).toBe(409);
  });

  it('login correto, senha errada e logout', async () => {
    const c = await registerClient({ password: 'minhaSenha999' });
    const ok = await loginClient(c.me.user.email, 'minhaSenha999');
    expect(ok.res.status).toBe(200);
    expect((await ok.c.get('/api/auth/me')).status).toBe(200);
    const bad = await loginClient(c.me.user.email, 'errada');
    expect(bad.res.status).toBe(401);
    expect((await ok.c.post('/api/auth/logout')).status).toBe(200);
    expect((await ok.c.get('/api/auth/me')).status).toBe(401);
  });

  it('CSRF: bloqueia mutações sem X-Requested-With ou com token errado', async () => {
    const c = await registerClient();
    const noHeader = await c.agent.post('/api/contacts').send({ phone: '5511988887777' });
    expect(noHeader.status).toBe(403);
    const wrong = await c.agent.post('/api/contacts').set({ 'x-requested-with': 'mckbot', 'x-csrf-token': 'invalido' }).send({ phone: '5511988887777' });
    expect(wrong.status).toBe(403);
    const right = await c.post('/api/contacts', { phone: '5511988887777' });
    expect(right.status).toBe(201);
  });

  it('rotas protegidas exigem login', async () => {
    expect((await request(app).get('/api/dashboard')).status).toBe(401);
    expect((await request(app).get('/api/flows')).status).toBe(401);
  });

  it('rate limit no login devolve 429 após o limite', async () => {
    const c = await registerClient();
    const prev = config.LOGIN_RATE_LIMIT;
    config.LOGIN_RATE_LIMIT = 4; // o cadastro conta 1 tentativa no mesmo limitador (IP + e-mail)
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 5; i++) statuses.push((await loginClient(c.me.user.email, 'errada')).res.status);
      expect(statuses.slice(0, 3)).toEqual([401, 401, 401]);
      expect(statuses[3]).toBe(429);
      expect(statuses[4]).toBe(429);
    } finally {
      config.LOGIN_RATE_LIMIT = prev;
    }
  });

  it('troca de senha exige a atual e encerra outras sessões', async () => {
    const c = await registerClient({ password: 'senhaAntiga123' });
    const other = await loginClient(c.me.user.email, 'senhaAntiga123');
    expect((await c.post('/api/profile/password', { current: 'errada', next: 'senhaNova12345' })).status).toBe(400);
    expect((await c.post('/api/profile/password', { current: 'senhaAntiga123', next: 'senhaNova12345' })).status).toBe(200);
    expect((await other.c.get('/api/auth/me')).status).toBe(401);
    expect((await loginClient(c.me.user.email, 'senhaNova12345')).res.status).toBe(200);
  });
});
