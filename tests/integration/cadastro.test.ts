import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { app, registerClient, loginClient, uniq, prisma, signupData, signupCodeFor, fakeCpf, fakeCnpj, fakeCelular, Client } from '../helpers.js';
import { outbox } from '../../server/lib/mailer.js';

const H = { 'x-requested-with': 'mckbot' };
const start = (data: Record<string, unknown>) => request(app).post('/api/auth/register').set(H).send(data);
const confirm = (signupToken: string, code: string | null) => request(app).post('/api/auth/register/confirm').set(H).send({ signupToken, code });
const fmtCpf = (d: string) => `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`;
const fmtCel = (d: string) => `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
const wrong = (code: string) => String((Number(code) + 1) % 1_000_000).padStart(6, '0');

describe('Cadastro com código por e-mail', () => {
  beforeEach(() => { outbox.length = 0; });

  it('pendente → código → conta ativa; documento só em dígitos e mascarado na resposta', async () => {
    const cpf = fakeCpf();
    const cel = fakeCelular();
    const data = signupData({ documento: fmtCpf(cpf), celular: fmtCel(cel) });
    const r1 = await start(data);
    expect(r1.status).toBe(202);
    expect(r1.body.signupToken).toBeTruthy();
    expect(r1.body.resendInSec).toBe(60);
    expect(await prisma.user.findUnique({ where: { email: data.email } })).toBeNull();
    const mail = outbox.find((m) => m.to === data.email && m.kind === 'signup_code')!;
    expect(mail.text).toMatch(/15 minutos/);

    // Pendente não consegue entrar.
    const before = await loginClient(data.email, data.password);
    expect(before.res.status).toBe(401);

    const r2 = await confirm(r1.body.signupToken, signupCodeFor(data.email));
    expect(r2.status).toBe(201);
    expect(r2.body.user.documento).toBe(`***.${cpf.slice(3, 6)}.${cpf.slice(6, 9)}-**`);
    expect(r2.body.user.celular).toMatch(/^\+55 \(11\) 9\*{4}-\d{4}$/);
    expect(r2.body.cadastroPendente).toBeNull();
    const u = await prisma.user.findUniqueOrThrow({ where: { email: data.email } });
    expect(u.documento).toBe(cpf);
    expect(u.celular).toBe(`+55${cel}`);
    expect(u.emailVerifiedAt).toBeTruthy();
    expect(outbox.some((m) => m.to === data.email && m.kind === 'welcome')).toBe(true);
    // Código é de uso único.
    expect((await confirm(r1.body.signupToken, signupCodeFor(data.email))).status).toBe(400);
    // Auditoria nunca guarda o documento.
    const logs = await prisma.auditLog.findMany({ where: { userId: u.id } });
    for (const l of logs) { expect(l.meta).not.toContain(cpf); expect(l.meta).not.toContain(cel); }
    expect(logs.find((l) => l.action === 'auth.register')!.meta).toContain('informado');
  });

  it('código errado conta tentativas e trava na 5ª; código expirado é recusado', async () => {
    const data = signupData();
    const r1 = await start(data);
    const code = signupCodeFor(data.email)!;
    for (let i = 1; i <= 4; i++) {
      const r = await confirm(r1.body.signupToken, wrong(code));
      expect(r.status).toBe(400);
      expect(r.body.error).toMatch(/Código incorreto/);
    }
    const fifth = await confirm(r1.body.signupToken, wrong(code));
    expect(fifth.status).toBe(429);
    // Nem o código certo vale depois do bloqueio.
    expect((await confirm(r1.body.signupToken, code)).status).toBe(429);

    const d2 = signupData();
    const p = await start(d2);
    await prisma.pendingSignup.updateMany({ where: { email: d2.email }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const exp = await confirm(p.body.signupToken, signupCodeFor(d2.email));
    expect(exp.status).toBe(400);
    expect(exp.body.error).toMatch(/expirou/);
    expect(await prisma.user.findUnique({ where: { email: d2.email } })).toBeNull();
  });

  it('reenvio respeita 60 s, gera código novo e zera tentativas', async () => {
    const data = signupData();
    const r1 = await start(data);
    const first = signupCodeFor(data.email)!;
    const early = await request(app).post('/api/auth/register/resend').set(H).send({ signupToken: r1.body.signupToken });
    expect(early.status).toBe(429);
    expect(early.body.error).toMatch(/Aguarde \d+ segundo/);
    await confirm(r1.body.signupToken, wrong(first));
    await prisma.pendingSignup.updateMany({ where: { email: data.email }, data: { lastSentAt: new Date(Date.now() - 61_000) } });
    const ok = await request(app).post('/api/auth/register/resend').set(H).send({ signupToken: r1.body.signupToken });
    expect(ok.status).toBe(200);
    const second = signupCodeFor(data.email)!;
    expect(outbox.filter((m) => m.to === data.email && m.kind === 'signup_code')).toHaveLength(2);
    const p = await prisma.pendingSignup.findFirstOrThrow({ where: { email: data.email } });
    expect(p.attempts).toBe(0);
    if (second !== first) expect((await confirm(r1.body.signupToken, first)).status).toBe(400);
    expect((await confirm(r1.body.signupToken, second)).status).toBe(201);
  });

  it('valida formato, domínio descartável, domínio sem MX e documento/celular', async () => {
    const bad = async (over: Record<string, unknown>, re: RegExp) => {
      const r = await start({ ...signupData(), ...over });
      expect(r.status).toBe(400);
      expect(r.body.error).toMatch(re);
    };
    await bad({ email: `${uniq()}@mailinator.com` }, /temporários ou descartáveis/);
    await bad({ email: `${uniq()}@sub.guerrillamail.com` }, /temporários ou descartáveis/);
    await bad({ email: `${uniq()}@empresa.semmx.dev` }, /não recebe e-mails/);
    await bad({ documento: '000.000.000-00' }, /CPF\/CNPJ inválido/);
    await bad({ documento: '123.456.789-00' }, /CPF\/CNPJ inválido/);
    await bad({ documento: undefined }, /Informe o CPF/);
    await bad({ celular: '(11) 3333-4444' }, /Celular inválido/);
    await bad({ celular: undefined }, /Informe o seu celular/);
    // Falha transitória do DNS: deixa seguir (o código ainda é obrigatório).
    const d = signupData({ email: `${uniq()}@x.dnsfalho.dev` });
    expect((await start(d)).status).toBe(202);
    expect(signupCodeFor(d.email)).toMatch(/^\d{6}$/);
    // CNPJ também é aceito.
    const c = await registerClient({ documento: fakeCnpj() });
    expect(c.me.user.documento).toMatch(/^\*\*\.\d{3}\.\d{3}\/\d{4}-\*\*$/);
  });

  it('e-mail já cadastrado: mesma resposta, sem código; o dono recebe o aviso "você já tem conta"', async () => {
    const c = await registerClient();
    outbox.length = 0;
    const r = await start(signupData({ email: c.me.user.email }));
    expect(r.status).toBe(202);
    expect(Object.keys(r.body).sort()).toEqual(['email', 'expiresInSec', 'message', 'pending', 'resendInSec', 'signupToken']);
    expect(outbox.some((m) => m.to === c.me.user.email && m.kind === 'signup_code')).toBe(false);
    expect(outbox.some((m) => m.to === c.me.user.email && m.kind === 'signup_account_exists')).toBe(true);
    for (let i = 0; i < 3; i++) expect((await confirm(r.body.signupToken, String(100000 + i))).status).toBe(400);
  });

  it('CPF ou celular já usados: bloqueia na confirmação com mensagem genérica', async () => {
    const c = await registerClient();
    const sd = (c as any).signup;
    for (const over of [{ documento: sd.documento }, { celular: sd.celular }]) {
      const data = signupData(over);
      const r1 = await start(data);
      expect(r1.status).toBe(202);
      const r2 = await confirm(r1.body.signupToken, signupCodeFor(data.email));
      expect(r2.status).toBe(409);
      expect(r2.body.error).toBe('Já existe uma conta com este e-mail, CPF/CNPJ ou celular. Entre ou recupere a senha.');
      expect(await prisma.user.findUnique({ where: { email: data.email } })).toBeNull();
    }
  });
});

describe('Login por e-mail, CPF, CNPJ ou celular', () => {
  const login = (identifier: string, password: string) => request(app).post('/api/auth/login').set(H).send({ identifier, password });

  it('entra com cada identificador; erro genérico igual para inexistente e senha errada', async () => {
    const cpf = fakeCpf();
    const cel = fakeCelular();
    const c = await registerClient({ documento: cpf, celular: cel, password: 'senhaLogin123' });
    for (const id of [c.me.user.email, c.me.user.email.toUpperCase(), cpf, fmtCpf(cpf), cel, fmtCel(cel), `+55${cel}`, `55${cel}`]) {
      const r = await login(id, 'senhaLogin123');
      expect(r.status, id).toBe(200);
      expect(r.body.user.id).toBe(c.me.user.id);
    }
    const cnpj = fakeCnpj();
    const pj = await registerClient({ documento: cnpj, password: 'senhaLogin123' });
    const fmtCnpj = `${cnpj.slice(0, 2)}.${cnpj.slice(2, 5)}.${cnpj.slice(5, 8)}/${cnpj.slice(8, 12)}-${cnpj.slice(12)}`;
    for (const id of [cnpj, fmtCnpj]) expect((await login(id, 'senhaLogin123')).body.user?.id).toBe(pj.me.user.id);

    const wrongPass = await login(cpf, 'errada123');
    const unknown = await login(fakeCpf(), 'errada123');
    const unknownCel = await login(fakeCelular(), 'errada123');
    for (const r of [wrongPass, unknown, unknownCel]) {
      expect(r.status).toBe(401);
      expect(r.body.error).toBe('Credenciais inválidas. Confira o e-mail, CPF/CNPJ ou celular e a senha.');
    }
    // Nem o CPF nem o celular digitados vão para a auditoria.
    const logs = await prisma.auditLog.findMany({ where: { action: 'auth.login_failed', createdAt: { gt: new Date(Date.now() - 60_000) } } });
    for (const l of logs) { expect(l.meta).not.toContain(cpf); expect(l.meta).not.toContain(cel); }
  });

  it('11 dígitos: CPF válido tem prioridade; se não houver conta com esse CPF, tenta como celular', async () => {
    // Celular que, por acaso, também é um CPF válido.
    let cel = '';
    for (let n = 0; n < 200000 && !cel; n++) {
      const cand = `119${String(10000000 + Math.floor(Math.random() * 89999999))}`;
      const { isValidCpf } = await import('../../server/lib/documento.js');
      if (isValidCpf(cand) && !(await prisma.user.findFirst({ where: { OR: [{ documento: cand }, { celular: `+55${cand}` }] } }))) cel = cand;
    }
    const a = await registerClient({ celular: cel, password: 'senhaA12345' });
    expect((await login(cel, 'senhaA12345')).body.user?.id).toBe(a.me.user.id); // nenhum CPF igual: cai no celular
    const b = await registerClient({ documento: cel, password: 'senhaB12345' });
    expect((await login(cel, 'senhaB12345')).body.user?.id).toBe(b.me.user.id); // agora o CPF vence
  });

  it('mantém bloqueio por tentativas mesmo usando CPF como identificador', async () => {
    const cpf = fakeCpf();
    const c = await registerClient({ documento: cpf, password: 'senhaLock123' });
    let last: request.Response | null = null;
    for (let i = 0; i < 6; i++) last = await login(cpf, 'errada' + i);
    expect([401, 423, 429]).toContain(last!.status);
    const u = await prisma.user.findUniqueOrThrow({ where: { id: c.me.user.id } });
    expect(u.failedLogins + (u.lockedUntil ? 100 : 0)).toBeGreaterThan(0);
  });

  it('"esqueci a senha" por CPF ou celular envia o link para o e-mail confirmado', async () => {
    const cpf = fakeCpf();
    const cel = fakeCelular();
    const c = await registerClient({ documento: cpf, celular: cel });
    for (const identifier of [cpf, fmtCel(cel)]) {
      outbox.length = 0;
      const r = await request(app).post('/api/auth/forgot').set(H).send({ identifier });
      expect(r.status).toBe(200);
      await new Promise((ok) => setTimeout(ok, 300));
      const m = outbox.find((x) => x.kind === 'reset');
      expect(m?.to).toBe(c.me.user.email);
    }
    // Identificador desconhecido: mesma resposta, nenhum e-mail.
    outbox.length = 0;
    const r = await request(app).post('/api/auth/forgot').set(H).send({ identifier: fakeCpf() });
    expect(r.status).toBe(200);
    await new Promise((ok) => setTimeout(ok, 300));
    expect(outbox.find((x) => x.kind === 'reset')).toBeUndefined();
  });
});

describe('Contas antigas sem CPF/CNPJ ou celular', () => {
  it('titular precisa completar o cadastro antes de usar os apps; depois segue normal', async () => {
    const c = await registerClient();
    await prisma.user.update({ where: { id: c.me.user.id }, data: { documento: null, celular: null } });
    const { c: s, res } = await loginClient(c.me.user.email, 'senhaSegura123');
    expect(res.status).toBe(200);
    expect(res.body.cadastroPendente).toEqual({ documento: true, celular: true });
    const blocked = await s.get('/api/contacts');
    expect(blocked.status).toBe(403);
    expect(blocked.body.details?.code).toBe('CADASTRO_INCOMPLETO');
    expect((await s.get('/api/auth/me')).status).toBe(200);

    // CPF inválido / já usado por outra conta são recusados.
    expect((await s.post('/api/auth/complete-cadastro', { documento: '111.111.111-11', celular: fakeCelular() })).status).toBe(400);
    const other = await registerClient();
    const dup = await s.post('/api/auth/complete-cadastro', { documento: (other as any).signup.documento, celular: fakeCelular() });
    expect(dup.status).toBe(409);
    expect(dup.body.error).toMatch(/CPF\/CNPJ já está vinculado/);

    const cpf = fakeCpf();
    const ok = await s.post('/api/auth/complete-cadastro', { documento: fmtCpf(cpf), celular: fmtCel(fakeCelular()) });
    expect(ok.status).toBe(200);
    expect(ok.body.cadastroPendente).toBeNull();
    expect((await prisma.user.findUniqueOrThrow({ where: { id: c.me.user.id } })).documento).toBe(cpf);
    expect((await s.get('/api/contacts')).status).toBe(200);
    // Uma vez preenchido, não muda por esta rota.
    await s.post('/api/auth/complete-cadastro', { documento: fakeCpf(), celular: fakeCelular() });
    expect((await prisma.user.findUniqueOrThrow({ where: { id: c.me.user.id } })).documento).toBe(cpf);
    const log = await prisma.auditLog.findFirst({ where: { userId: c.me.user.id, action: 'auth.cadastro_completado' } });
    expect(log!.meta).not.toContain(cpf);
  });

  it('só falta o celular: pede apenas o celular', async () => {
    const c = await registerClient();
    await prisma.user.update({ where: { id: c.me.user.id }, data: { celular: null } });
    const { c: s, res } = await loginClient(c.me.user.email, 'senhaSegura123');
    expect(res.body.cadastroPendente).toEqual({ documento: false, celular: true });
    expect((await s.post('/api/auth/complete-cadastro', {})).status).toBe(400);
    expect((await s.post('/api/auth/complete-cadastro', { celular: fakeCelular() })).status).toBe(200);
    expect((await s.get('/api/contacts')).status).toBe(200);
  });

  it('superadmin e membros convidados (não titulares) não são bloqueados', async () => {
    const admin = await registerClient();
    await prisma.user.update({ where: { id: admin.me.user.id }, data: { documento: null, celular: null, isSuperAdmin: true } });
    const { c: sa } = await loginClient(admin.me.user.email, 'senhaSegura123');
    expect(sa.me.cadastroPendente).toBeNull();
    expect((await sa.get('/api/contacts')).status).toBe(200);

    const owner = await registerClient();
    const inv = await owner.post('/api/team/invites', { email: `${uniq()}@teste.dev`, role: 'AGENT' });
    const token = inv.body.link.split('/convite/')[1];
    {
      const m = new Client();
      const r = await m.agent.post('/api/auth/accept-invite').set(H).send({ token, name: 'Membro', password: 'senhaMembro123' });
      expect(r.status).toBe(200);
      m.csrf = r.body.csrfToken;
      expect(r.body.cadastroPendente).toBeNull();
      expect((await m.get('/api/contacts')).status).toBe(200);
    }
  });

  it('isolamento entre organizações continua valendo após o cadastro novo', async () => {
    const a = await registerClient();
    const b = await registerClient();
    const created = await a.post('/api/contacts', { phone: '5511977776666', name: 'Cliente A' });
    expect(created.status).toBe(201);
    const list = await b.get('/api/contacts');
    expect(JSON.stringify(list.body)).not.toContain('Cliente A');
    expect((await b.get(`/api/contacts/${created.body.id}`)).status).toBe(404);
  });
});
