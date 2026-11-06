import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { registerClient, loginClient, Client, prisma, uniq } from '../helpers.js';
import { MCK_QUOTA_REASON } from '../../server/ai/mckQuota.js';

const PASS = 'senhaSegura123';

describe('MCK IA: cota diária por plano e painel Master', () => {
  let owner: Client;
  let admin: Client;
  let orgId: string;
  const prev = process.env.MCK_IA_DAILY_TRIAL;

  beforeAll(async () => {
    process.env.MCK_IA_DAILY_TRIAL = '2';
    owner = await registerClient();
    orgId = owner.me.org.id;
    const r = await owner.put('/api/ai/settings', { provider: 'mck', model: 'mck-ia', enabled: true });
    expect(r.status).toBe(200);
    const email = `${uniq('mckmaster')}@teste.dev`;
    const first = await registerClient({ email });
    await prisma.user.update({ where: { id: first.me.user.id }, data: { isSuperAdmin: true } });
    admin = (await loginClient(email, PASS)).c;
  });
  afterAll(() => { if (prev === undefined) delete process.env.MCK_IA_DAILY_TRIAL; else process.env.MCK_IA_DAILY_TRIAL = prev; });

  it('abaixo da cota tenta responder; ao atingir, não chama provedor e mostra o aviso simples ao Proprietário', async () => {
    const under = await owner.post('/api/ai/test', { message: 'Qual o horário?' });
    expect(under.status).toBe(200);
    expect(under.body.reason).not.toBe(MCK_QUOTA_REASON);

    // Duas respostas da MCK IA hoje (gravadas como o serviço grava, com o provedor que respondeu).
    await prisma.aiUsage.createMany({ data: [1, 2].map(() => ({ orgId, provider: 'mck', model: 'mck-ia/gemini:modelo-x', success: true })) });
    const s = await owner.get('/api/ai/settings');
    expect(s.body.mckQuota).toMatchObject({ tier: 'teste', limit: 2, used: 2, reached: true });

    const r = await owner.post('/api/ai/test', { message: 'Qual o horário?' });
    expect(r.body).toMatchObject({ failed: true, handoff: false, reason: MCK_QUOTA_REASON });
    expect(r.body.error).toBeUndefined();
    const last = await prisma.aiUsage.findFirst({ where: { orgId }, orderBy: { createdAt: 'desc' } });
    expect(last).toMatchObject({ provider: 'mck', success: false, error: MCK_QUOTA_REASON });

    const d = await owner.get('/api/dashboard');
    expect(d.body.mckQuota.reached).toBe(true);
  });

  it('cliente nunca vê o provedor que respondeu; o Master vê uso por empresa e provedores', async () => {
    const u = await owner.get('/api/ai/usage');
    const rows = u.body.recent.filter((x: any) => x.provider === 'MCK IA');
    expect(rows.length).toBeGreaterThan(0);
    expect(JSON.stringify(u.body.recent)).not.toMatch(/gemini|modelo-x/i);

    expect((await owner.get('/api/master/mck-ia')).status).toBe(403);
    const m = await admin.get('/api/master/mck-ia');
    expect(m.status).toBe(200);
    const row = m.body.items.find((x: any) => x.orgId === orgId);
    expect(row).toMatchObject({ usesMckIa: true, tier: 'teste', limit: 2 });
    expect(row.today.responses).toBe(2);
    expect(row.today.percent).toBe(100);
    expect(row.today.quotaBlocks).toBeGreaterThanOrEqual(1);
    expect(row.providers).toMatchObject({ gemini: 2 });
    expect(m.body.limits.teste).toBe(2);
  });
});
