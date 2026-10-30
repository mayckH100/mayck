import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { app, registerClient, loginClient, Client, prisma, uniq } from '../helpers.js';
import { outbox } from '../../server/lib/mailer.js';
import { totpCode, currentStep } from '../../server/lib/totp.js';
import { readBackupFile, createBackupFile, runBackup, restoreOrder, maybeDailyBackup } from '../../server/lib/backup.js';
import { setFetch, resetFetch } from '../../server/lib/fetcher.js';

const H = { 'x-requested-with': 'mckbot' };
const PASS = 'senhaSegura123';

async function waitMail(to: string, kind: string, timeout = 3000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const m = outbox.find((x) => x.to === to && x.kind === kind);
    if (m) return m;
    await new Promise((r) => setTimeout(r, 25));
  }
  return null;
}

/** Ativa a 2FA para o cliente logado e devolve o segredo + códigos de recuperação. */
async function enableMfa(c: Client) {
  const setup = await c.post('/api/auth/2fa/setup', { password: PASS });
  expect(setup.status).toBe(200);
  expect(setup.body.qr).toMatch(/^data:image\/png;base64,/);
  const secret: string = setup.body.secret;
  const en = await c.post('/api/auth/2fa/enable', { code: totpCode(secret, currentStep()) });
  expect(en.status).toBe(200);
  return { secret, codes: en.body.recoveryCodes as string[] };
}

describe('Escudo de segurança', () => {
  beforeEach(() => { outbox.length = 0; });
  afterEach(() => { process.env.SUPERADMIN_MFA_REQUIRED = 'false'; delete process.env.ACCOUNT_LOCK_THRESHOLD; });

  it('2FA: ativa com QR, login pede código, aceita TOTP e código de recuperação (uso único)', async () => {
    const c = await registerClient();
    const email = c.me.user.email;
    expect((await c.post('/api/auth/2fa/enable', { code: '123456' })).status).toBe(400); // sem setup
    const { secret, codes } = await enableMfa(c);
    expect(codes).toHaveLength(10);
    expect((await c.get('/api/auth/2fa')).body).toMatchObject({ enabled: true, recoveryCodesLeft: 10 });
    expect(await waitMail(email, 'mfa_enabled')).toBeTruthy();
    // segredo fica cifrado no banco
    const u = await prisma.user.findUniqueOrThrow({ where: { email } });
    expect(u.totpSecretEnc).toMatch(/^v1:/);
    expect(u.recoveryCodes).not.toContain(codes[0]);

    // senha certa → pede código, sem sessão
    const step1 = await request(app).post('/api/auth/login').set(H).send({ email, password: PASS });
    expect(step1.status).toBe(200);
    expect(step1.body.mfaRequired).toBe(true);
    expect(step1.headers['set-cookie']?.join(';') ?? '').not.toContain('mck_sid');
    const bad = await request(app).post('/api/auth/login/mfa').set(H).send({ mfaToken: step1.body.mfaToken, code: '000000' });
    expect(bad.status).toBe(401);
    // código TOTP já usado na ativação não serve de novo: usa o próximo passo
    const ok = await request(app).post('/api/auth/login/mfa').set(H).send({ mfaToken: step1.body.mfaToken, code: totpCode(secret, currentStep() + 1) });
    expect(ok.status).toBe(200);
    expect(ok.body.user.mfaEnabled).toBe(true);
    // token da etapa não pode ser reutilizado
    expect((await request(app).post('/api/auth/login/mfa').set(H).send({ mfaToken: step1.body.mfaToken, code: codes[0] })).status).toBe(401);

    // código de recuperação: funciona uma vez
    const s2 = await request(app).post('/api/auth/login').set(H).send({ email, password: PASS });
    const rec = await request(app).post('/api/auth/login/mfa').set(H).send({ mfaToken: s2.body.mfaToken, code: codes[0].toLowerCase() });
    expect(rec.status).toBe(200);
    const s3 = await request(app).post('/api/auth/login').set(H).send({ email, password: PASS });
    expect((await request(app).post('/api/auth/login/mfa').set(H).send({ mfaToken: s3.body.mfaToken, code: codes[0] })).status).toBe(401);
    const logs = await prisma.auditLog.findMany({ where: { userId: u.id }, select: { action: true } });
    const actions = logs.map((l) => l.action);
    expect(actions).toEqual(expect.arrayContaining(['auth.mfa_enabled', 'auth.mfa_failed', 'auth.mfa_recovery_used', 'auth.login']));

    // desativar exige senha + código
    expect((await c.post('/api/auth/2fa/disable', { password: 'errada123', code: codes[1] })).status).toBe(400);
    expect((await c.post('/api/auth/2fa/disable', { password: PASS, code: codes[1] })).status).toBe(200);
    expect((await c.get('/api/auth/2fa')).body.enabled).toBe(false);
    const plain = await loginClient(email, PASS);
    expect(plain.res.body.mfaRequired).toBeUndefined();
    expect(plain.res.body.csrfToken).toBeTruthy();
  });

  it('2FA é obrigatória para o superadmin no Painel Master e não pode ser desligada', async () => {
    process.env.SUPERADMIN_MFA_REQUIRED = 'true';
    const c = await registerClient();
    await prisma.user.update({ where: { id: c.me.user.id }, data: { isSuperAdmin: true } });
    const blocked = await c.get('/api/master/settings');
    expect(blocked.status).toBe(403);
    expect(blocked.body.details?.code).toBe('MFA_REQUIRED');
    expect((await c.get('/api/auth/me')).body.user.mfaRequired).toBe(true);
    const { codes } = await enableMfa(c);
    expect((await c.get('/api/master/settings')).status).toBe(200);
    const dis = await c.post('/api/auth/2fa/disable', { password: PASS, code: codes[0] });
    expect(dis.status).toBe(400);
    expect(dis.body.error).toMatch(/obrigatória/);
  });

  it('bloqueia a conta após várias senhas erradas (mesmo com a senha certa depois) e avisa por e-mail', async () => {
    process.env.ACCOUNT_LOCK_THRESHOLD = '3';
    const c = await registerClient();
    const email = c.me.user.email;
    for (let i = 0; i < 2; i++) expect((await request(app).post('/api/auth/login').set(H).send({ email, password: 'errada' + i })).status).toBe(401);
    const third = await request(app).post('/api/auth/login').set(H).send({ email, password: 'errada3' });
    expect(third.status).toBe(423);
    expect(third.body.details.code).toBe('ACCOUNT_LOCKED');
    const right = await request(app).post('/api/auth/login').set(H).send({ email, password: PASS });
    expect(right.status).toBe(423);
    expect(await waitMail(email, 'account_locked')).toBeTruthy();
    const actions = (await prisma.auditLog.findMany({ where: { userId: c.me.user.id } })).map((l) => l.action);
    expect(actions).toEqual(expect.arrayContaining(['auth.login_failed', 'auth.account_locked', 'auth.login_locked']));
    // eventos aparecem na Auditoria da organização do dono
    const audit = await c.get('/api/audit');
    expect(audit.body.map((l: any) => l.action)).toContain('auth.account_locked');
    // prazo vencido → volta a entrar e o contador zera
    await prisma.user.update({ where: { email }, data: { lockedUntil: new Date(Date.now() - 1000) } });
    expect((await loginClient(email, PASS)).res.status).toBe(200);
    expect((await prisma.user.findUniqueOrThrow({ where: { email } })).failedLogins).toBe(0);
  });

  it('e-mail ignorado não existente não gera bloqueio nem erro diferente', async () => {
    const r = await request(app).post('/api/auth/login').set(H).send({ email: `${uniq()}@nada.dev`, password: 'x' });
    expect(r.status).toBe(401);
  });

  it('alerta por e-mail em login de aparelho novo (não no mesmo aparelho)', async () => {
    const c = await registerClient(); // cadastro registra o 1º aparelho sem alerta
    const email = c.me.user.email;
    expect(await waitMail(email, 'login_new_device', 300)).toBeNull();
    // mesmo navegador (cookie mck_did) → sem alerta
    await c.post('/api/auth/logout');
    await c.agent.post('/api/auth/login').set(H).send({ email, password: PASS });
    expect(await waitMail(email, 'login_new_device', 300)).toBeNull();
    // outro navegador → alerta + auditoria
    const other = new Client();
    const r = await other.agent.post('/api/auth/login').set(H).set('user-agent', 'Mozilla/5.0 (Linux; Android 14) Chrome/130.0 Mobile Safari/537.36').send({ email, password: PASS });
    expect(r.status).toBe(200);
    const mail = await waitMail(email, 'login_new_device');
    expect(mail?.text).toMatch(/Chrome no Android/);
    expect((await prisma.auditLog.findMany({ where: { userId: c.me.user.id, action: 'auth.login_new_device' } })).length).toBe(1);
  });

  it('Sessões ativas: lista, encerra uma e encerra todas as outras', async () => {
    const c = await registerClient();
    const email = c.me.user.email;
    const b = (await loginClient(email, PASS)).c;
    const d = (await loginClient(email, PASS)).c;
    const list = await c.get('/api/auth/sessions');
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(3);
    expect(list.body.filter((s: any) => s.current)).toHaveLength(1);
    const target = (await b.get('/api/auth/sessions')).body.find((s: any) => s.current);
    expect((await c.del(`/api/auth/sessions/${target.id}`)).status).toBe(200);
    expect((await b.get('/api/auth/me')).status).toBe(401);
    // outro usuário não consegue encerrar sessão alheia
    const intruso = await registerClient();
    const mine = (await d.get('/api/auth/sessions')).body.find((s: any) => s.current);
    expect((await intruso.del(`/api/auth/sessions/${mine.id}`)).status).toBe(404);
    const all = await c.post('/api/auth/sessions/revoke-all', {});
    expect(all.body.count).toBe(1);
    expect((await d.get('/api/auth/me')).status).toBe(401);
    expect((await c.get('/api/auth/me')).status).toBe(200);
    const actions = (await prisma.auditLog.findMany({ where: { userId: c.me.user.id } })).map((l) => l.action);
    expect(actions).toEqual(expect.arrayContaining(['auth.session_revoked', 'auth.sessions_revoked']));
  });

  it('backup: arquivo cifrado com todas as tabelas, recusa repositório público e envia ao privado', async () => {
    const c = await registerClient();
    const { data, rows } = await createBackupFile();
    expect(data.subarray(0, 8).toString()).toBe('MCKBKP1\n');
    expect(data.includes(Buffer.from(c.me.user.email))).toBe(false); // cifrado
    const { header, records } = readBackupFile(data);
    expect(header.format).toBe('mck-backup');
    expect(records.length).toBe(rows);
    expect(records.some((r) => r.m === 'User' && r.r.email === c.me.user.email)).toBe(true);
    expect(restoreOrder().indexOf('User')).toBeLessThan(restoreOrder().indexOf('Session'));

    // sem destino → falha registrada (o Master ainda pode baixar)
    const none = await runBackup('MANUAL');
    expect(none.run.status).toBe('FAILED');
    expect(none.run.error).toMatch(/Nenhum destino/);

    process.env.BACKUP_GITHUB_TOKEN = 'tok';
    process.env.BACKUP_GITHUB_REPO = 'mck/backups';
    let isPrivate = false;
    const puts: string[] = [];
    setFetch(async (input, init) => {
      const url = String(input);
      if (url === 'https://api.github.com/repos/mck/backups') return new Response(JSON.stringify({ private: isPrivate }), { status: 200 });
      if (init?.method === 'PUT') { puts.push(url); return new Response('{}', { status: 201 }); }
      if (url.endsWith('/contents/backups')) return new Response(JSON.stringify([{ name: 'mck-2000-01-01.bkp', path: 'backups/mck-2000-01-01.bkp', sha: 'x' }]), { status: 200 });
      if (init?.method === 'DELETE') return new Response('{}', { status: 200 });
      return new Response('{}', { status: 404 });
    });
    try {
      const pub = await runBackup('MANUAL');
      expect(pub.run.status).toBe('FAILED');
      expect(pub.run.error).toMatch(/PÚBLICO/);
      expect(puts).toHaveLength(0);
      isPrivate = true;
      const ok = await runBackup('MANUAL');
      expect(ok.run.status).toBe('OK');
      expect(puts[0]).toMatch(/contents\/backups\/mck-\d{4}-\d{2}-\d{2}\.bkp$/);
      // o diário automático roda uma vez por dia
      const auto = new Date();
      auto.setUTCHours(15); // 12h em Brasília
      expect(await maybeDailyBackup(auto)).toBe(true);
      expect(await maybeDailyBackup(auto)).toBe(false);
    } finally {
      resetFetch();
      delete process.env.BACKUP_GITHUB_TOKEN; delete process.env.BACKUP_GITHUB_REPO;
    }
    const actions = (await prisma.auditLog.findMany({ where: { entity: 'backup' } })).map((l) => l.action);
    expect(actions).toEqual(expect.arrayContaining(['backup.success', 'backup.failed']));
  });

  it('Master: status e download do backup', async () => {
    const c = await registerClient();
    await prisma.user.update({ where: { id: c.me.user.id }, data: { isSuperAdmin: true } });
    const st = await c.get('/api/master/backups');
    expect(st.status).toBe(200);
    expect(st.body.destinations).toMatchObject({ github: false });
    const dl = await c.agent.get('/api/master/backups/download').buffer(true).parse((res, cb) => { const ch: Buffer[] = []; res.on('data', (d: Buffer) => ch.push(d)); res.on('end', () => cb(null, Buffer.concat(ch))); });
    expect(dl.status).toBe(200);
    expect((dl.body as Buffer).subarray(0, 8).toString()).toBe('MCKBKP1\n');
    const nonAdmin = await registerClient();
    expect((await nonAdmin.get('/api/master/backups')).status).toBe(403);
  });
});
