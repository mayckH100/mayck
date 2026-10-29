import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { Prisma } from '@prisma/client';
import { app, registerClient, loginClient, Client, installGraphMock, graph, prisma, uniq } from '../helpers.js';
import { getSettings, DEFAULT_PRICES } from '../../server/billing/service.js';
import { resetMpCheckCache } from '../../server/billing/mercadopago.js';
import { syncSuperAdmins } from '../../server/auth/superadmin.js';

const PASS = 'senhaSegura123';
const TOKEN = 'APP_USR-token-secreto-nao-logar';

// ---------- Mercado Pago simulado com respostas configuráveis ----------
type Reply = { status: number; body?: unknown } | 'network';
const mp = { pref: { status: 201, body: { id: 'pref-1', init_point: 'https://www.mercadopago.com.br/checkout/v1/redirect?pref_id=pref-1' } } as Reply, payment: { status: 404, body: { message: 'not found' } } as Reply, methods: { status: 200, body: [] } as Reply, methodsCalls: 0 };
const respond = (r: Reply) => {
  if (r === 'network') throw new Error('ECONNRESET simulado');
  return new Response(JSON.stringify(r.body ?? {}), { status: r.status });
};

function webhook(id: string) {
  return request(app).post(`/api/billing/mp/webhook?data.id=${id}&type=payment`).set('content-type', 'application/json').send({ type: 'payment', data: { id } });
}

describe('Correções de cobrança, Mercado Pago e superadmin', () => {
  let owner: Client;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeAll(async () => {
    installGraphMock();
    graph.other = async (url, init) => {
      if (url === 'https://api.mercadopago.com/checkout/preferences' && init?.method === 'POST') return respond(mp.pref);
      if (/^https:\/\/api\.mercadopago\.com\/v1\/payments\/\d+$/.test(url)) return respond(mp.payment);
      if (url === 'https://api.mercadopago.com/v1/payment_methods') { mp.methodsCalls++; return respond(mp.methods); }
      return null;
    };
    owner = await registerClient();
  });
  afterAll(() => {
    delete process.env.MP_ACCESS_TOKEN;
    delete process.env.SUPERADMIN_EMAILS;
    graph.other = null;
  });
  beforeEach(() => {
    process.env.MP_ACCESS_TOKEN = TOKEN;
    resetMpCheckCache();
    mp.methodsCalls = 0;
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => { errSpy.mockRestore(); });

  const logged = () => errSpy.mock.calls.map((c) => c.map(String).join(' ')).join('\n');

  // ---------- B1: corrida no getSettings ----------
  it('getSettings em paralelo sem a linha default não falha (P2002 tratado) e cria uma única linha', async () => {
    await prisma.platformSettings.deleteMany({});
    const results = await Promise.all(Array.from({ length: 12 }, () => getSettings()));
    for (const r of results) {
      expect(r.trialDays).toBe(7);
      expect(r.prices).toEqual(DEFAULT_PRICES);
    }
    expect(await prisma.platformSettings.count()).toBe(1);
  });

  it('quem perde a corrida (P2002 ao criar a linha default) relê a linha criada pela outra requisição', async () => {
    await prisma.platformSettings.deleteMany({});
    const delegate = prisma.platformSettings as any;
    // Simula o Postgres: outra requisição grava a linha 'default' no meio do caminho e a nossa recebe P2002.
    const loseRace = async () => {
      await prisma.$executeRawUnsafe(`INSERT INTO "PlatformSettings" ("id","trialDays","pricesJson","updatedAt") VALUES ('default', 7, '${JSON.stringify(DEFAULT_PRICES)}', CURRENT_TIMESTAMP)`);
      throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed on the fields: (`id`)', { code: 'P2002', clientVersion: Prisma.prismaVersion.client });
    };
    // Sobrescrita manual (vi.spyOn + mockRestore quebra o delegate do Prisma).
    const hadOwn = { create: Object.prototype.hasOwnProperty.call(delegate, 'create'), upsert: Object.prototype.hasOwnProperty.call(delegate, 'upsert') };
    const orig = { create: delegate.create, upsert: delegate.upsert };
    let calls = 0;
    const once = (name: 'create' | 'upsert') => (...args: unknown[]) => (calls++ === 0 ? loseRace() : orig[name](...args));
    delegate.create = once('create');
    delegate.upsert = once('upsert');
    try {
      const s = await getSettings();
      expect(s.trialDays).toBe(7);
      expect(s.prices).toEqual(DEFAULT_PRICES);
      expect(await prisma.platformSettings.count()).toBe(1);
      expect(calls).toBeGreaterThan(0);
    } finally {
      for (const k of ['create', 'upsert'] as const) {
        if (hadOwn[k]) delegate[k] = orig[k];
        else delete delegate[k];
      }
    }
    // o delegate continua funcionando depois do teste
    expect(typeof prisma.platformSettings.create).toBe('function');
    expect((await getSettings()).trialDays).toBe(7);
  });

  it('primeiro acesso simultâneo de várias organizações (sem linha default nem assinaturas) não dá 500', async () => {
    // Cadastros em sequência (o SQLite dos testes não aguenta transações interativas em paralelo);
    // depois apagamos a configuração e as assinaturas para reproduzir o primeiro acesso concorrente.
    const clients: Client[] = [];
    for (let i = 0; i < 6; i++) clients.push(await registerClient());
    const orgIds = clients.map((c) => c.me.org.id);
    await prisma.billingEvent.deleteMany({ where: { orgId: { in: orgIds } } });
    await prisma.subscription.deleteMany({ where: { orgId: { in: orgIds } } });
    await prisma.platformSettings.deleteMany({});
    const res = await Promise.all(clients.flatMap((c) => [c.get('/api/billing/status'), c.get('/api/auth/me')]));
    expect(res.map((r) => r.status)).toEqual(Array(12).fill(200));
    for (const r of res.filter((x) => x.body.prices)) expect(r.body.prices).toEqual(DEFAULT_PRICES);
    expect(await prisma.platformSettings.count()).toBe(1);
    expect(await prisma.subscription.count({ where: { orgId: { in: orgIds } } })).toBe(12);
  });

  // ---------- Erros do Mercado Pago ----------
  it('checkout com credencial recusada → 502 com o motivo do MP e log sem token', async () => {
    mp.pref = { status: 401, body: { message: 'Unauthorized use of live credentials', status: 401 } };
    const r = await owner.post('/api/billing/checkout', { product: 'MCKBOT', cycle: 'MENSAL' });
    expect(r.status).toBe(502);
    expect(r.body.error).toBe('Mercado Pago recusou a credencial: Unauthorized use of live credentials');
    expect(logged()).toContain('status=401');
    expect(logged()).toContain('Unauthorized use of live credentials');
    expect(logged()).not.toContain(TOKEN);
  });

  it('checkout com erro 400 do MP → 502 com o motivo', async () => {
    mp.pref = { status: 400, body: { message: 'invalid unit_price' } };
    const r = await owner.post('/api/billing/checkout', { product: 'COMBO', cycle: 'ANUAL' });
    expect(r.status).toBe(502);
    expect(r.body.error).toContain('invalid unit_price');
  });

  it('confirm: 404 do MP → 404; credencial recusada → 502 com motivo', async () => {
    mp.payment = { status: 404, body: { message: 'Payment not found' } };
    const a = await owner.post('/api/billing/confirm', { paymentId: '123456' });
    expect(a.status).toBe(404);
    mp.payment = { status: 401, body: { message: 'Unauthorized use of live credentials' } };
    const b = await owner.post('/api/billing/confirm', { paymentId: '123456' });
    expect(b.status).toBe(502);
    expect(b.body.error).toBe('Mercado Pago recusou a credencial: Unauthorized use of live credentials');
    expect(logged()).not.toContain(TOKEN);
  });

  it('webhook: 400/401/403 do MP → 200 (sem reenvio infinito) e loga; 5xx ou rede → 500', async () => {
    for (const status of [400, 401, 403]) {
      mp.payment = { status, body: { message: `erro ${status}` } };
      const r = await webhook('777001');
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ ignored: true, reason: `mp_${status}` });
    }
    expect(logged()).toContain('status=403');
    mp.payment = { status: 500, body: { message: 'internal' } };
    expect((await webhook('777002')).status).toBe(500);
    mp.payment = 'network';
    expect((await webhook('777003')).status).toBe(500);
    mp.payment = { status: 404, body: { message: 'not found' } };
    expect((await webhook('777004')).status).toBe(200);
    expect(logged()).not.toContain(TOKEN);
  });

  // ---------- SUPERADMIN_EMAILS ----------
  it('SUPERADMIN_EMAILS promove no login só com e-mail confirmado, ignora maiúsculas/espaços e nunca remove', async () => {
    const email = `${uniq('boot')}@teste.dev`;
    delete process.env.SUPERADMIN_EMAILS;
    const c = await registerClient({ email });
    expect(c.me.isSuperAdmin).toBe(false);
    process.env.SUPERADMIN_EMAILS = ` outro@teste.dev , ${email.toUpperCase()} `;
    // E-mail ainda não confirmado: não promove (impede tomar a vaga de um e-mail da lista sem ser dono dele)
    expect((await loginClient(email, PASS)).res.body.isSuperAdmin).toBe(false);
    await prisma.user.update({ where: { email }, data: { emailVerifiedAt: new Date() } });
    const { res } = await loginClient(email, PASS);
    expect(res.status).toBe(200);
    expect(res.body.isSuperAdmin).toBe(true);
    // Tirar da lista não remove o acesso
    process.env.SUPERADMIN_EMAILS = 'outro@teste.dev';
    const again = await loginClient(email, PASS);
    expect(again.res.body.isSuperAdmin).toBe(true);
    // Cadastro novo com e-mail da lista NÃO nasce superadmin (e-mail ainda não confirmado)
    const e2 = `${uniq('boot2')}@teste.dev`;
    process.env.SUPERADMIN_EMAILS = e2;
    expect((await registerClient({ email: e2 })).me.isSuperAdmin).toBe(false);
    expect((await registerClient()).me.isSuperAdmin).toBe(false);
    delete process.env.SUPERADMIN_EMAILS;
  });

  it('syncSuperAdmins (startup) promove usuários existentes da lista e não mexe nos outros', async () => {
    const a = await registerClient();
    const b = await registerClient();
    const pend = await registerClient(); // na lista, mas sem e-mail confirmado: não promove
    await prisma.user.updateMany({ where: { id: { in: [a.me.user.id, b.me.user.id] } }, data: { emailVerifiedAt: new Date() } });
    process.env.SUPERADMIN_EMAILS = `${a.me.user.email},${pend.me.user.email}`;
    expect(await syncSuperAdmins()).toBe(1);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: a.me.user.id } })).isSuperAdmin).toBe(true);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: b.me.user.id } })).isSuperAdmin).toBe(false);
    expect(await syncSuperAdmins()).toBe(0);
    process.env.SUPERADMIN_EMAILS = '';
    expect(await syncSuperAdmins()).toBe(0);
    delete process.env.SUPERADMIN_EMAILS;
  });

  // ---------- mpCheck no /api/master/settings ----------
  it('master/settings traz mpCheck: ok com token aceito (cache 5 min); mensagem quando recusado; sem token', async () => {
    const email = `${uniq('mpchk')}@teste.dev`;
    process.env.SUPERADMIN_EMAILS = email;
    const admin = await registerClient({ email });
    delete process.env.SUPERADMIN_EMAILS;
    await prisma.user.update({ where: { email }, data: { isSuperAdmin: true } });

    mp.methods = { status: 200, body: [{ id: 'pix' }] };
    const ok = await admin.get('/api/master/settings');
    expect(ok.status).toBe(200);
    expect(ok.body.mpCheck).toEqual({ ok: true, message: expect.any(String) });
    await admin.get('/api/master/settings');
    expect(mp.methodsCalls).toBe(1); // cache

    resetMpCheckCache();
    mp.methods = { status: 401, body: { message: 'Unauthorized use of live credentials' } };
    const bad = await admin.get('/api/master/settings');
    expect(bad.body.mpCheck).toEqual({ ok: false, message: 'Mercado Pago recusou a credencial: Unauthorized use of live credentials' });
    expect(JSON.stringify(bad.body)).not.toContain(TOKEN);

    delete process.env.MP_ACCESS_TOKEN;
    const none = await admin.get('/api/master/settings');
    expect(none.body.mpCheck.ok).toBe(false);
    expect(none.body.mpCheck.message).toMatch(/não configurado/);
  });
});
