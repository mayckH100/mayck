import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { registerClient, loginClient, Client, prisma, uniq } from '../helpers.js';
import { isProductActive, updateSettings, getWebhookSecret } from '../../server/billing/service.js';

const PASS = 'senhaSegura123';

describe('Painel Master (superadmin)', () => {
  let admin: Client;
  let adminId: string;
  let owner: Client;
  let orgId: string;

  beforeAll(async () => {
    const email = `${uniq('master')}@teste.dev`;
    const first = await registerClient({ email });
    adminId = first.me.user.id;
    await prisma.user.update({ where: { id: adminId }, data: { isSuperAdmin: true } });
    admin = (await loginClient(email, PASS)).c;
    owner = await registerClient();
    orgId = owner.me.org.id;
  });
  afterAll(async () => {
    await updateSettings({ mpWebhookSecret: null });
  });

  it('me traz isSuperAdmin e assinaturas por produto', async () => {
    expect(admin.me.isSuperAdmin).toBe(true);
    expect(owner.me.isSuperAdmin).toBe(false);
    const me = await owner.get('/api/auth/me');
    expect(me.body.isSuperAdmin).toBe(false);
    expect(me.body.subscriptions.map((s: any) => s.product).sort()).toEqual(['MCKBOT', 'MCKMENSAGEM']);
    expect(me.body.subscriptions[0]).toMatchObject({ status: 'TRIAL', active: true });
  });

  it('não-superadmin (inclusive OWNER) recebe 403; sem login, 401', async () => {
    expect(owner.me.role).toBe('OWNER');
    for (const url of ['/api/master/dashboard', '/api/master/clients', `/api/master/clients/${orgId}`, '/api/master/payments', '/api/master/activity', '/api/master/settings']) {
      expect((await owner.get(url)).status).toBe(403);
    }
    expect((await owner.post(`/api/master/clients/${orgId}/actions`, { action: 'block', product: 'MCKBOT' })).status).toBe(403);
    expect((await owner.put('/api/master/settings', { trialDays: 1 })).status).toBe(403);
    expect((await owner.post(`/api/master/users/${owner.me.user.id}`, { isSuperAdmin: true })).status).toBe(403);
    expect((await new Client().get('/api/master/dashboard')).status).toBe(401);
    expect((await admin.get('/api/master/dashboard')).status).toBe(200);
  });

  it('dashboard soma a receita corretamente (só MP com valor)', async () => {
    const before = (await admin.get('/api/master/dashboard')).body;
    await prisma.billingEvent.createMany({
      data: [
        { orgId, product: 'MCKBOT', kind: 'MP', cycle: 'MENSAL', amountCents: 3990, mpPaymentId: uniq('pay') },
        { orgId, product: 'COMBO', kind: 'MP', cycle: 'ANUAL', amountCents: 69900, mpPaymentId: uniq('pay') },
        { orgId, product: 'MCKBOT', kind: 'MANUAL', cycle: 'MENSAL' }, // manual não conta
        { orgId, product: 'MCKBOT', kind: 'MP', cycle: 'MENSAL', amountCents: 1000, mpPaymentId: uniq('pay'), createdAt: new Date(Date.now() - 400 * 86400000) }, // > 12 meses: só no total
      ],
    });
    const after = (await admin.get('/api/master/dashboard')).body;
    expect(after.revenueTotalCents - before.revenueTotalCents).toBe(3990 + 69900 + 1000);
    expect(after.revenueMonthCents - before.revenueMonthCents).toBe(3990 + 69900);
    const sum12 = (d: any) => d.revenueByMonth.reduce((a: number, m: any) => a + m.amountCents, 0);
    expect(after.revenueByMonth).toHaveLength(12);
    expect(sum12(after) - sum12(before)).toBe(3990 + 69900);
    expect(after.lastPayments[0]).toMatchObject({ orgId, kind: 'MP' });
    expect(after.totalClients).toBeGreaterThanOrEqual(2);
    expect(after.byProduct.MCKBOT).toHaveProperty('TRIAL');
  });

  it('ativar/bloquear muda isProductActive e registra eventos/auditoria', async () => {
    const act = (body: any) => admin.post(`/api/master/clients/${orgId}/actions`, body);
    let r = await act({ action: 'deactivate', product: 'COMBO', reason: 'teste' });
    expect(r.status).toBe(200);
    expect(await isProductActive(orgId, 'MCKBOT')).toBe(false);
    expect(await isProductActive(orgId, 'MCKMENSAGEM')).toBe(false);

    r = await act({ action: 'activate', product: 'MCKBOT', cycle: 'MENSAL' });
    expect(r.status).toBe(200);
    expect(await isProductActive(orgId, 'MCKBOT')).toBe(true);
    expect(await isProductActive(orgId, 'MCKMENSAGEM')).toBe(false);
    expect(r.body.subscriptions.find((s: any) => s.product === 'MCKBOT')).toMatchObject({ status: 'ATIVA', source: 'MANUAL' });

    r = await act({ action: 'block', product: 'MCKBOT' });
    expect(await isProductActive(orgId, 'MCKBOT')).toBe(false);
    r = await act({ action: 'unblock', product: 'COMBO' });
    expect(await isProductActive(orgId, 'MCKBOT')).toBe(true);

    r = await act({ action: 'set-date', product: 'MCKMENSAGEM', validUntil: '2020-01-01' });
    expect(r.status).toBe(200);
    expect(await isProductActive(orgId, 'MCKMENSAGEM')).toBe(false);
    r = await act({ action: 'renew', product: 'MCKMENSAGEM', cycle: 'ANUAL' });
    expect(await isProductActive(orgId, 'MCKMENSAGEM')).toBe(true);
    expect((await act({ action: 'set-date', product: 'MCKBOT' })).status).toBe(400);

    const ev = await prisma.billingEvent.findMany({ where: { orgId, actorUserId: adminId } });
    expect(ev.map((e) => e.kind)).toEqual(expect.arrayContaining(['BLOCK', 'UNBLOCK', 'MANUAL']));
    const detail = (await admin.get(`/api/master/clients/${orgId}`)).body;
    expect(detail.owner.email).toBe(owner.me.user.email);
    expect(detail.audit.some((a: any) => a.action === 'master.client.deactivate')).toBe(true);
    expect(detail.billingEvents.length).toBeGreaterThan(3);

    const list = (await admin.get(`/api/master/clients?q=${encodeURIComponent(owner.me.user.email)}`)).body;
    expect(list.items.map((c: any) => c.id)).toContain(orgId);
    expect(list.items[0]).toHaveProperty('channels');
    const blocked = (await admin.get('/api/master/clients?status=BLOQUEADA&product=MCKBOT')).body;
    expect(blocked.items.map((c: any) => c.id)).not.toContain(orgId);
  });

  it('usuário desativado não loga e perde a sessão; não remove o próprio superadmin', async () => {
    const email = `${uniq('vitima')}@teste.dev`;
    const victim = await registerClient({ email });
    const r = await admin.post(`/api/master/users/${victim.me.user.id}`, { disabled: true });
    expect(r.status).toBe(200);
    expect(r.body.disabled).toBe(true);
    expect((await victim.get('/api/auth/me')).status).toBe(401);
    expect((await loginClient(email, PASS)).res.status).toBe(401);
    await admin.post(`/api/master/users/${victim.me.user.id}`, { disabled: false });
    expect((await loginClient(email, PASS)).res.status).toBe(200);

    expect((await admin.post(`/api/master/users/${adminId}`, { isSuperAdmin: false })).status).toBe(400);
    expect((await admin.post(`/api/master/users/${adminId}`, { disabled: true })).status).toBe(400);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: adminId } })).isSuperAdmin).toBe(true);
  });

  it('settings: salva segredo cifrado e devolve mascarado', async () => {
    const r = await admin.put('/api/master/settings', { trialDays: 10, prices: { MCKBOT: { MENSAL: 4990 } }, mpWebhookSecret: 'segredo-super-1234' });
    expect(r.status).toBe(200);
    expect(r.body.mpWebhookSecret).toBe('••••1234');
    expect(JSON.stringify(r.body)).not.toContain('segredo-super');
    expect(r.body).toMatchObject({ trialDays: 10, mpWebhookSecretConfigured: true, mpConfigured: false });
    expect(r.body.prices.MCKBOT.MENSAL).toBe(4990);
    const raw = await prisma.platformSettings.findUniqueOrThrow({ where: { id: 'default' } });
    expect(raw.mpWebhookSecretEnc).toBeTruthy();
    expect(raw.mpWebhookSecretEnc).not.toContain('segredo-super');
    expect(await getWebhookSecret()).toBe('segredo-super-1234');
    expect((await admin.get('/api/master/settings')).body.mpWebhookSecret).toBe('••••1234');
    // restaura padrões
    await admin.put('/api/master/settings', { trialDays: 7, prices: { MCKBOT: { MENSAL: 3990 } }, mpWebhookSecret: null });
    const pays = (await admin.get('/api/master/payments')).body;
    expect(pays).toMatchObject({ page: 1, pageSize: 20 });
    const act = (await admin.get('/api/master/activity')).body;
    expect(act.items.some((a: any) => a.action === 'master.settings.update')).toBe(true);
  });
});
