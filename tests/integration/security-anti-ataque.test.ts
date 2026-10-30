import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import request from 'supertest';
import { app, registerClient, Client, uniq, prisma, createTestChannel, inboundPayload, postWebhook } from '../helpers.js';
import { backupDestinations, backupAutoEnabled, backupEmailTo } from '../../server/lib/backup.js';
import { safeErrorForLog } from '../../server/lib/http.js';

describe('Escudo 2: cabeçalhos de segurança', () => {
  it('CSP, HSTS, X-Frame-Options, nosniff, Referrer e Permissions-Policy', async () => {
    const r = await request(app).get('/api/health');
    expect(r.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(r.headers['content-security-policy']).toContain("object-src 'none'");
    expect(r.headers['content-security-policy']).toContain("script-src 'self'");
    expect(r.headers['strict-transport-security']).toContain('max-age=31536000');
    expect(r.headers['x-frame-options']).toBe('DENY');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
    expect(r.headers['permissions-policy']).toContain('camera=()');
    expect(r.headers['x-powered-by']).toBeUndefined();
    expect(r.headers['access-control-allow-origin']).toBeUndefined(); // sem CORS aberto
  });

  it('cookie de sessão é HttpOnly e SameSite', async () => {
    const r = await request(app).post('/api/auth/register').set('x-requested-with', 'mckbot')
      .send({ name: 'Cookie Teste', email: `${uniq()}@t.dev`, password: 'senhaSegura123', orgName: 'Org Cookie' });
    const set = ([] as string[]).concat(r.headers['set-cookie'] ?? []);
    const sid = set.find((c) => c.startsWith('mck_sid='))!;
    expect(sid).toMatch(/HttpOnly/i);
    expect(sid).toMatch(/SameSite=Lax/i);
  });
});

describe('Escudo 2: CSRF e CORS restrito', () => {
  let c: Client;
  beforeAll(async () => { c = await registerClient(); });

  it('recusa requisição que altera dados vinda de outro site (Origin estranha)', async () => {
    const r = await c.agent.patch('/api/profile').set(c.h()).set('origin', 'https://site-malicioso.example').send({ name: 'Hacker' });
    expect(r.status).toBe(403);
    const r2 = await c.agent.patch('/api/profile').set(c.h()).set('origin', 'null').send({ name: 'Hacker' });
    expect(r2.status).toBe(403);
  });

  it('aceita a própria origem e requisição sem Origin (app/testes)', async () => {
    const own = await c.agent.patch('/api/profile').set(c.h()).set('host', 'mckbot.test').set('origin', 'http://mckbot.test').send({ name: 'Dono Ok' });
    expect(own.status).toBe(200);
    expect((await c.patch('/api/profile', { name: 'Dono Ok 2' })).status).toBe(200);
  });

  it('sem token CSRF ou sem X-Requested-With: 403', async () => {
    expect((await c.agent.patch('/api/profile').set('x-requested-with', 'mckbot').send({ name: 'X Y' })).status).toBe(403);
    expect((await c.agent.patch('/api/profile').set('x-csrf-token', c.csrf).send({ name: 'X Y' })).status).toBe(403);
  });

  it('login de outro site também é recusado (login CSRF)', async () => {
    const r = await request(app).post('/api/auth/login').set('x-requested-with', 'mckbot').set('origin', 'https://evil.example').send({ email: 'a@b.dev', password: 'x' });
    expect(r.status).toBe(403);
  });
});

describe('Escudo 2: limites de corpo e entrada', () => {
  it('JSON grande demais → 413, JSON malformado → 400 (nunca 500)', async () => {
    const big = JSON.stringify({ email: 'a@b.dev', password: 'x'.repeat(1_200_000) });
    const r = await request(app).post('/api/auth/login').set('x-requested-with', 'mckbot').set('content-type', 'application/json').send(big);
    expect(r.status).toBe(413);
    const bad = await request(app).post('/api/auth/login').set('x-requested-with', 'mckbot').set('content-type', 'application/json').send('{"email":');
    expect(bad.status).toBe(400);
  });

  it('valida esquema (e-mail inválido, campos longos demais)', async () => {
    const r = await request(app).post('/api/auth/login').set('x-requested-with', 'mckbot').send({ email: '<script>alert(1)</script>', password: 'x' });
    expect(r.status).toBe(400);
    const c = await registerClient();
    expect((await c.patch('/api/profile', { name: 'x'.repeat(500) })).status).toBe(400);
  });

  it('log de erro do Prisma não expõe argumentos da consulta', () => {
    const e = Object.assign(new Error('Invalid `prisma.user.create()` invocation: { passwordHash: "$2a$12$segredo" }'), { name: 'PrismaClientKnownRequestError', code: 'P2002', meta: { target: ['email'] } });
    const out = safeErrorForLog(e);
    expect(out).toContain('P2002');
    expect(out).not.toContain('segredo');
  });
});

describe('Escudo 2: webhook da Meta exige assinatura', () => {
  it('sem assinatura ou com assinatura errada → 401; com a certa → 200', async () => {
    const owner = await registerClient();
    const ctx = await createTestChannel(owner.me.org.id);
    const p = inboundPayload(ctx.phoneNumberId, '5511912340000', 'oi');
    const noSig = await request(app).post(`/api/webhooks/whatsapp/${ctx.ch.id}`).set('content-type', 'application/json').send(JSON.stringify(p.body));
    expect(noSig.status).toBe(401);
    expect((await postWebhook(ctx.ch.id, ctx.appSecret, p.body, true)).status).toBe(401);
    expect((await postWebhook(ctx.ch.id, ctx.appSecret, p.body)).status).toBe(200);
  });
});

describe('Escudo 2: anti-enumeração de usuários', () => {
  it('login e "esqueci a senha" respondem igual para e-mail existente e inexistente', async () => {
    const c = await registerClient();
    const email = c.me.user.email;
    const a = await request(app).post('/api/auth/login').set('x-requested-with', 'mckbot').send({ email, password: 'errada123456' });
    const b = await request(app).post('/api/auth/login').set('x-requested-with', 'mckbot').send({ email: `${uniq()}@naoexiste.dev`, password: 'errada123456' });
    expect(a.status).toBe(401); expect(b.status).toBe(401);
    expect(a.body.error).toBe(b.body.error);
    const f1 = await request(app).post('/api/auth/forgot').set('x-requested-with', 'mckbot').send({ email });
    const f2 = await request(app).post('/api/auth/forgot').set('x-requested-with', 'mckbot').send({ email: `${uniq()}@naoexiste.dev` });
    expect(f1.status).toBe(200); expect(f1.body).toEqual(f2.body);
  });
});

describe('Escudo 2: Perfil — trocar senha e link de redefinição', () => {
  it('logado recebe link de redefinição por e-mail (token criado); deslogado não', async () => {
    const c = await registerClient();
    const r = await c.post('/api/profile/password-reset-link', { app: 'mckbot' });
    expect(r.status).toBe(200);
    expect(r.body.message).toContain(c.me.user.email);
    const tok = await prisma.authToken.findFirst({ where: { userId: c.me.user.id, kind: 'RESET_PASSWORD', usedAt: null } });
    expect(tok).toBeTruthy();
    expect((await request(app).post('/api/profile/password-reset-link').set('x-requested-with', 'mckbot').send({})).status).toBe(401);
    const audit = await prisma.auditLog.findFirst({ where: { userId: c.me.user.id, action: 'profile.password_reset_link' } });
    expect(audit).toBeTruthy();
  });

  it('trocar senha exige a atual e continua funcionando', async () => {
    const c = await registerClient({ password: 'senhaAtual1234' });
    expect((await c.post('/api/profile/password', { current: 'errada', next: 'novaSenha9876' })).status).toBe(400);
    expect((await c.post('/api/profile/password', { current: 'senhaAtual1234', next: 'novaSenha9876' })).status).toBe(200);
  });
});

describe('Escudo 2: isolamento entre empresas (módulos novos)', () => {
  let a: Client, b: Client;
  beforeAll(async () => { a = await registerClient(); b = await registerClient(); });

  it('agenda, leads e auditoria de uma empresa não aparecem para outra', async () => {
    const start = new Date(Date.now() + 3 * 86400e3).toISOString();
    const ev = await a.post('/api/agenda', { title: 'Reunião secreta A', start, durationMin: 30 });
    expect(ev.status).toBe(201);
    const id = ev.body.id ?? ev.body.event?.id;
    const listB = await b.get(`/api/agenda?from=${encodeURIComponent(new Date().toISOString())}&to=${encodeURIComponent(new Date(Date.now() + 10 * 86400e3).toISOString())}`);
    expect(JSON.stringify(listB.body)).not.toContain('Reunião secreta A');
    if (id) {
      expect([403, 404]).toContain((await b.patch(`/api/agenda/${id}`, { title: 'Hack' })).status);
      expect([403, 404]).toContain((await b.del(`/api/agenda/${id}`)).status);
    }
    const lead = await a.post('/api/mckmensagem/leads', { phone: '5511933331111', name: 'Lead A', consentSource: 'MANUAL' });
    expect(lead.status).toBe(201);
    expect(JSON.stringify((await b.get('/api/mckmensagem/leads')).body)).not.toContain('Lead A');
    expect(JSON.stringify((await b.get('/api/audit')).body)).not.toContain(a.me.user.email);
  });
});

describe('Escudo 2: permissões por papel', () => {
  let owner: Client, agent: Client, admin: Client;
  beforeAll(async () => {
    owner = await registerClient();
    const mk = async (role: 'AGENT' | 'ADMIN') => {
      const inv = await owner.post('/api/team/invites', { email: `${uniq()}@t.dev`, role });
      const token = inv.body.link.split('/convite/')[1];
      const c = new Client();
      const r = await c.agent.post('/api/auth/accept-invite').set('x-requested-with', 'mckbot').send({ token, name: 'Membro', password: 'senhaMembro123' });
      c.csrf = r.body.csrfToken; c.me = r.body;
      return c;
    };
    agent = await mk('AGENT'); admin = await mk('ADMIN');
  });

  it('Atendente: sem convites, sem auditoria, sem MCK Mensagens, sem Master', async () => {
    expect((await agent.post('/api/team/invites', { email: `${uniq()}@t.dev`, role: 'AGENT' })).status).toBe(403);
    expect((await agent.get('/api/audit')).status).toBe(403);
    expect((await agent.get('/api/mckmensagem/leads')).status).toBe(403);
    expect((await agent.get('/api/master/dashboard')).status).toBe(403);
    expect((await agent.patch('/api/org', { name: 'Hack' })).status).toBe(403);
  });

  it('Administrador: convida e vê auditoria, mas não entra no Master', async () => {
    expect((await admin.get('/api/audit')).status).toBe(200);
    expect((await admin.post('/api/team/invites', { email: `${uniq()}@t.dev`, role: 'AGENT' })).status).not.toBe(403); // 201 ou 402 (limite do plano)
    expect((await admin.get('/api/master/dashboard')).status).toBe(403);
  });

  it('Proprietário de empresa não é Master', async () => {
    expect((await owner.get('/api/master/dashboard')).status).toBe(403);
  });

  it('Master entra no Painel sem 2FA obrigatória (SUPERADMIN_MFA_REQUIRED=false) e não precisa de etapa extra', async () => {
    const m = await registerClient();
    await prisma.user.update({ where: { id: m.me.user.id }, data: { isSuperAdmin: true, emailVerifiedAt: new Date() } });
    const r = await m.get('/api/master/dashboard');
    expect(r.status).toBe(200);
  });
});

describe('Escudo 2: backup diário por e-mail', () => {
  const keep = { ...process.env };
  afterEach(() => {
    for (const k of ['BACKUP_EMAIL', 'SMTP_USER', 'SMTP_HOST', 'MAIL_FROM', 'ENABLE_BACKUP', 'BACKUP_GITHUB_TOKEN', 'BACKUP_GITHUB_REPO']) {
      if (keep[k] === undefined) delete process.env[k]; else process.env[k] = keep[k];
    }
  });

  it('sem BACKUP_EMAIL usa o SMTP_USER como destino', () => {
    delete process.env.BACKUP_EMAIL;
    process.env.SMTP_HOST = 'smtp.gmail.com'; process.env.MAIL_FROM = 'MCK <mck@teste.dev>'; process.env.SMTP_USER = 'mck@teste.dev';
    expect(backupEmailTo()).toBe('mck@teste.dev');
    expect(backupDestinations()).toMatchObject({ email: true, emailTo: 'mck@teste.dev' });
  });

  it('BACKUP_EMAIL tem prioridade; sem SMTP não há envio por e-mail', () => {
    process.env.BACKUP_EMAIL = 'outro@teste.dev'; process.env.SMTP_USER = 'mck@teste.dev';
    process.env.SMTP_HOST = 'smtp.gmail.com'; process.env.MAIL_FROM = 'x@teste.dev';
    expect(backupDestinations().emailTo).toBe('outro@teste.dev');
    delete process.env.SMTP_HOST;
    expect(backupDestinations().email).toBe(false);
  });

  it('automático liga por padrão com SMTP e respeita ENABLE_BACKUP=false', () => {
    delete process.env.ENABLE_BACKUP; delete process.env.BACKUP_EMAIL; delete process.env.BACKUP_GITHUB_TOKEN;
    process.env.SMTP_HOST = 'smtp.gmail.com'; process.env.MAIL_FROM = 'x@teste.dev'; process.env.SMTP_USER = 'mck@teste.dev';
    expect(backupAutoEnabled()).toBe(true);
    process.env.ENABLE_BACKUP = 'false';
    expect(backupAutoEnabled()).toBe(false);
    delete process.env.ENABLE_BACKUP; delete process.env.SMTP_HOST;
    expect(backupAutoEnabled()).toBe(false);
  });
});
