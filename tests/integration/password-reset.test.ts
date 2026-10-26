import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { app, registerClient, loginClient, uniq, prisma } from '../helpers.js';
import { outbox } from '../../server/lib/mailer.js';
import { sha256 } from '../../server/lib/crypto.js';

const H = { 'x-requested-with': 'mckbot' };
const forgot = (email: string, extra: object = {}) => request(app).post('/api/auth/forgot').set(H).send({ email, ...extra });
const reset = (token: string, password: string) => request(app).post('/api/auth/reset').set(H).send({ token, password });

/** O envio é em segundo plano: espera o e-mail chegar na caixa de saída de teste. */
async function waitMail(to: string, kind: string, timeout = 5000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const m = outbox.find((x) => x.to === to && x.kind === kind);
    if (m) return m;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`e-mail ${kind} para ${to} não chegou`);
}
const tokenFrom = (text: string) => /token=([A-Za-z0-9_-]+)/.exec(text)![1];

describe('Recuperação de senha', () => {
  beforeEach(() => { outbox.length = 0; });

  it('cadastro envia e-mail de boas-vindas com link de confirmação (não bloqueia o login)', async () => {
    const c = await registerClient();
    const mail = await waitMail(c.me.user.email, 'welcome');
    expect(mail.subject).toMatch(/MCKBOT/);
    expect(mail.html).toContain('#d90429');
    expect(c.me.user.emailVerified).toBe(false);
    const token = tokenFrom(mail.text);
    expect(mail.text).toContain('/verificar-email?token=');
    const v = await request(app).post('/api/auth/verify-email').set(H).send({ token });
    expect(v.status).toBe(200);
    expect((await c.get('/api/auth/me')).body.user.emailVerified).toBe(true);
    // uso único
    expect((await request(app).post('/api/auth/verify-email').set(H).send({ token })).status).toBe(400);
  });

  it('forgot responde igual para e-mail existente e inexistente', async () => {
    const c = await registerClient();
    const a = await forgot(c.me.user.email);
    const b = await forgot(`${uniq()}@naoexiste.dev`);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body).toEqual(b.body);
    const mail = await waitMail(c.me.user.email, 'reset');
    expect(mail.text).toContain('/redefinir-senha?token=');
    // só o hash fica no banco, com validade de 1 hora
    const token = tokenFrom(mail.text);
    const row = await prisma.authToken.findUnique({ where: { tokenHash: sha256(token) } });
    expect(row?.kind).toBe('RESET_PASSWORD');
    const ttl = row!.expiresAt.getTime() - row!.createdAt.getTime();
    expect(ttl).toBeGreaterThan(59 * 60 * 1000);
    expect(ttl).toBeLessThanOrEqual(60 * 60 * 1000 + 1000);
    expect(await prisma.authToken.count({ where: { tokenHash: token } })).toBe(0);
  });

  it('link do MCK Mensagens aponta para /mensagem', async () => {
    const c = await registerClient();
    await forgot(c.me.user.email, { app: 'mensagem' });
    const mail = await waitMail(c.me.user.email, 'reset');
    expect(mail.text).toContain('/mensagem/redefinir-senha?token=');
    expect(mail.html).toContain('#e10a2c');
  });

  it('reset troca a senha, invalida sessões antigas, avisa por e-mail e o token é de uso único', async () => {
    const c = await registerClient({ password: 'senhaAntiga123' });
    const email = c.me.user.email;
    const other = await loginClient(email, 'senhaAntiga123');
    expect((await other.c.get('/api/auth/me')).status).toBe(200);
    await forgot(email);
    const token = tokenFrom((await waitMail(email, 'reset')).text);

    expect((await request(app).get(`/api/auth/reset/${token}`)).body.valid).toBe(true);
    expect((await reset(token, 'curta')).status).toBe(400); // senha fraca não consome o token
    const ok = await reset(token, 'senhaNova4567');
    expect(ok.status).toBe(200);

    // sessões antigas caem
    expect((await c.get('/api/auth/me')).status).toBe(401);
    expect((await other.c.get('/api/auth/me')).status).toBe(401);
    // senha antiga não entra, nova entra
    expect((await loginClient(email, 'senhaAntiga123')).res.status).toBe(401);
    expect((await loginClient(email, 'senhaNova4567')).res.status).toBe(200);
    // aviso de senha alterada
    await waitMail(email, 'password_changed');
    // uso único
    expect((await reset(token, 'outraSenha999')).status).toBe(400);
    expect((await request(app).get(`/api/auth/reset/${token}`)).body.valid).toBe(false);
  });

  it('token expirado ou inventado é recusado; novo pedido invalida o link anterior', async () => {
    const c = await registerClient();
    const email = c.me.user.email;
    await forgot(email);
    const t1 = tokenFrom((await waitMail(email, 'reset')).text);
    outbox.length = 0;
    await forgot(email);
    const t2 = tokenFrom((await waitMail(email, 'reset')).text);
    expect(t2).not.toBe(t1);
    expect((await reset(t1, 'senhaNova4567')).status).toBe(400);

    await prisma.authToken.update({ where: { tokenHash: sha256(t2) }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await reset(t2, 'senhaNova4567')).status).toBe(400);
    expect((await reset('x'.repeat(43), 'senhaNova4567')).status).toBe(400);
  });

  it('forgot tem rate limit por e-mail', async () => {
    const email = `${uniq()}@limite.dev`;
    const codes: number[] = [];
    for (let i = 0; i < 7; i++) codes.push((await forgot(email)).status);
    expect(codes.slice(0, 5).every((s) => s === 200)).toBe(true);
    expect(codes[6]).toBe(429);
  });

  it('forgot e reset exigem o cabeçalho anti-CSRF', async () => {
    expect((await request(app).post('/api/auth/forgot').send({ email: 'a@b.dev' })).status).toBe(403);
    expect((await request(app).post('/api/auth/reset').send({ token: 'x'.repeat(43), password: 'senhaNova4567' })).status).toBe(403);
  });
});

describe('Planos públicos', () => {
  it('GET /api/public/plans responde sem login, com os preços do Master', async () => {
    const res = await request(app).get('/api/public/plans');
    expect(res.status).toBe(200);
    const ids = res.body.plans.map((p: any) => p.id);
    expect(ids).toEqual(['MCKBOT', 'MCKMENSAGEM', 'COMBO']);
    const s = await prisma.platformSettings.findUnique({ where: { id: 'default' } });
    const stored = s ? JSON.parse(s.pricesJson || '{}') : {};
    const bot = res.body.plans.find((p: any) => p.id === 'MCKBOT');
    expect(bot.prices.MENSAL).toBe(Number(stored?.MCKBOT?.MENSAL ?? 3990));
    expect(typeof res.body.trialDays).toBe('number');
    // não expõe segredos da plataforma
    expect(JSON.stringify(res.body)).not.toMatch(/webhook|secret|token/i);
  });

  it('reflete o preço alterado no Master', async () => {
    const { updateSettings, getSettings } = await import('../../server/billing/service.js');
    const before = (await getSettings()).prices.COMBO.MENSAL;
    await updateSettings({ prices: { COMBO: { MENSAL: 7777 } } });
    const res = await request(app).get('/api/public/plans');
    expect(res.body.plans.find((p: any) => p.id === 'COMBO').prices.MENSAL).toBe(7777);
    await updateSettings({ prices: { COMBO: { MENSAL: before } } });
  });

  it('é só leitura', async () => {
    const r = await request(app).post('/api/public/plans').set(H).send({});
    expect(r.status).toBeGreaterThanOrEqual(400);
  });
});

describe('PWA', () => {
  it('rota assetlinks para TWA responde 404 sem configuração', async () => {
    expect((await request(app).get('/.well-known/assetlinks.json')).status).toBe(404);
  });
});
