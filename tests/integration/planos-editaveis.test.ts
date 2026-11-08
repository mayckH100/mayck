import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { app, registerClient, loginClient, Client, installGraphMock, graph, prisma, uniq } from '../helpers.js';
import { renew } from '../../server/billing/service.js';
import { erpLiberado } from '../../server/billing/erpAccess.js';
import { productContextFor } from '../../server/ai/productSource.js';

/**
 * v1.25.0 — Planos editáveis no Painel Master: nome/descrição/itens/módulos/preços/"visível para venda".
 * Módulo ERP segue a configuração (rotas /api/erp e a IA com fonte 'erp'); plano oculto não é vendido, mas quem já
 * assina mantém o acesso e renova. A empresa da MCK não é afetada.
 */
const DAY = 86400000;
const futuro = () => new Date(Date.now() + 30 * DAY);
const PASS = 'senhaSegura123';
async function setSub(orgId: string, product: 'MCKBOT' | 'MCKMENSAGEM', status: 'TRIAL' | 'ATIVA', validUntil: Date) {
  await prisma.subscription.update({ where: { orgId_product: { orgId, product } }, data: { status, validUntil, source: status === 'TRIAL' ? 'TRIAL' : 'MP' } });
}

describe('Planos editáveis no Master (v1.25.0)', () => {
  let admin: Client; let adminOrg: string;
  let combo: Client; let comboOrg: string;
  let bot: Client; let botOrg: string;
  let savedPlans: string; let savedPrices: string;
  const prefs: any[] = [];

  beforeAll(async () => {
    const row = await prisma.platformSettings.findUnique({ where: { id: 'default' } });
    savedPlans = (row as any)?.plansJson ?? '{}'; savedPrices = row?.pricesJson ?? '{}';
    installGraphMock();
    process.env.MP_ACCESS_TOKEN = 'TEST-token-mp';
    graph.other = async (url, init) => {
      if (url === 'https://api.mercadopago.com/checkout/preferences' && init?.method === 'POST') {
        prefs.push(JSON.parse(String(init.body)));
        return new Response(JSON.stringify({ id: 'pref-p' + prefs.length, init_point: 'https://www.mercadopago.com.br/checkout/v1/redirect?pref_id=p' + prefs.length }), { status: 201 });
      }
      return null;
    };
    const email = `${uniq('planmaster')}@teste.dev`;
    const first = await registerClient({ email });
    await prisma.user.update({ where: { id: first.me.user.id }, data: { isSuperAdmin: true } });
    admin = (await loginClient(email, PASS)).c;
    adminOrg = first.me.org.id;
    combo = await registerClient(); comboOrg = combo.me.org.id;
    bot = await registerClient(); botOrg = bot.me.org.id;
    await combo.get('/api/billing/status'); await bot.get('/api/billing/status');
    // Empresa com o Plano Completo pago (evento de cobrança COMBO) e outra só com o MCKBOT pago.
    await renew(comboOrg, 'COMBO', 'MENSAL', { source: 'MANUAL' });
    await renew(botOrg, 'MCKBOT', 'MENSAL', { source: 'MANUAL' });
    await setSub(botOrg, 'MCKMENSAGEM', 'ATIVA', new Date(Date.now() - DAY));
  });
  afterAll(async () => {
    await prisma.platformSettings.update({ where: { id: 'default' }, data: { plansJson: savedPlans, pricesJson: savedPrices } as any });
    delete process.env.MP_ACCESS_TOKEN;
    graph.other = null;
  });

  it('padrão: Master recebe os planos de hoje com módulos e assinantes; COMBO com o ERP', async () => {
    const s = await admin.get('/api/master/settings');
    expect(s.status).toBe(200);
    expect(s.body.plans.COMBO).toMatchObject({ name: 'Plano Completo: MCK ERP + MCKBOT + MCK Mensagens', visible: true, modules: { MCKBOT: true, MCKMENSAGEM: true, ERP: true } });
    expect(s.body.plans.MCKMENSAGEM.name).toBe('MCK Mensagens');
    expect(s.body.planStats.COMBO.pagantes).toBeGreaterThanOrEqual(1);
    expect((await combo.get('/api/erp/acesso')).body).toMatchObject({ liberado: true });
    expect((await bot.get('/api/erp/acesso')).body).toMatchObject({ liberado: false });
  });

  it('validação: nome obrigatório, pelo menos um app, preço ≥ 0; só superadmin edita', async () => {
    expect((await combo.put('/api/master/settings', { plans: { COMBO: { name: 'X' } } })).status).toBe(403);
    const r1 = await admin.put('/api/master/settings', { plans: { COMBO: { name: '  ' } } });
    expect(r1.status).toBe(400); expect(r1.body.error).toMatch(/nome/i);
    const r2 = await admin.put('/api/master/settings', { plans: { MCKBOT: { modules: { MCKBOT: false, MCKMENSAGEM: false, ERP: false } } } });
    expect(r2.status).toBe(400); expect(r2.body.error).toMatch(/pelo menos um módulo/);
    expect((await admin.put('/api/master/settings', { plans: { MCKBOT: { modules: { MCKBOT: false, ERP: true } } } })).status).toBe(400);
    expect((await admin.put('/api/master/settings', { prices: { COMBO: { MENSAL: -1 } } })).status).toBe(400);
    // Nada mudou com as tentativas inválidas.
    expect((await admin.get('/api/master/settings')).body.plans.COMBO.name).toBe('Plano Completo: MCK ERP + MCKBOT + MCK Mensagens');
  });

  it('edita nome, descrição, itens e preço: vitrine, status e checkout usam os novos valores', async () => {
    const r = await admin.put('/api/master/settings', { plans: { COMBO: { name: 'Combo Total', desc: 'Tudo junto.', features: ['Item A', 'Item B'] } }, prices: { COMBO: { MENSAL: 3000, ANUAL: 32000 } } });
    expect(r.status).toBe(200);
    expect(r.body.plans.COMBO).toMatchObject({ name: 'Combo Total', desc: 'Tudo junto.', features: ['Item A', 'Item B'] });
    const pub = (await request(app).get('/api/public/plans')).body;
    expect(pub.plans.find((p: any) => p.id === 'COMBO')).toMatchObject({ label: 'Combo Total', desc: 'Tudo junto.', features: ['Item A', 'Item B'], prices: { MENSAL: 3000, ANUAL: 32000 }, modules: ['MCKBOT', 'MCKMENSAGEM', 'ERP'] });
    const st = (await combo.get('/api/billing/status')).body;
    expect(st.plans.find((p: any) => p.id === 'COMBO')).toMatchObject({ name: 'Combo Total', apps: ['MCKBOT', 'MCKMENSAGEM'], visible: true });
    const co = await combo.post('/api/billing/checkout', { product: 'COMBO', cycle: 'MENSAL' });
    expect(co.status).toBe(200);
    expect(co.body.amountCents).toBe(3000);
    expect(prefs[prefs.length - 1].items[0].title).toMatch(/^Combo Total — plano mensal/);
    const log = await prisma.auditLog.findFirst({ where: { action: 'master.settings.update' }, orderBy: { createdAt: 'desc' } });
    expect(log?.meta).toContain('Combo Total');
  });

  it('tirar o ERP do combo: empresa do combo perde o ERP (rotas e IA voltam ao catálogo); MCK não é afetada', async () => {
    expect((await admin.put('/api/master/settings', { plans: { COMBO: { modules: { ERP: false } } } })).status).toBe(200);
    const ac = (await combo.get('/api/erp/acesso')).body;
    expect(ac).toMatchObject({ liberado: false, planoCompleto: false });
    expect(ac.motivo).toMatch(/não está disponível/);
    const w = await combo.get('/api/erp/produtos');
    expect(w.status).toBe(402); expect(w.body.code).toBe('ERP_PLANO_COMPLETO');
    expect(await erpLiberado(comboOrg)).toBe(false);
    const sec = await productContextFor(comboOrg, 'furadeira', { source: 'erp', showQty: false, depositoId: null });
    expect(sec).toMatchObject({ requested: 'erp', source: 'catalogo', fallback: 'sem_plano' });
    expect((await combo.put('/api/ai/products/source', { productSource: 'erp' })).status).toBe(400);
    // Os dois apps continuam: tirar o ERP não mexe nas assinaturas.
    expect((await combo.get('/api/billing/status')).body.subscriptions.every((s: any) => s.active)).toBe(true);
    // Empresa da própria MCK (tem superadmin na equipe) mantém o ERP.
    expect(await erpLiberado(adminOrg)).toBe(true);
    expect((await admin.get('/api/erp/acesso')).body.liberado).toBe(true);
  });

  it('pôr o ERP no plano MCKBOT: quem tem só o MCKBOT ganha o ERP, e a IA pode usar o estoque', async () => {
    expect((await admin.put('/api/master/settings', { plans: { MCKBOT: { modules: { ERP: true } } } })).status).toBe(200);
    expect((await bot.get('/api/erp/acesso')).body).toMatchObject({ liberado: true });
    expect((await bot.get('/api/erp/produtos')).status).toBe(200);
    const sec = await productContextFor(botOrg, 'x', { source: 'erp', showQty: false, depositoId: null });
    expect(sec.fallback).toBeNull();
    expect((await combo.get('/api/erp/acesso')).body.liberado).toBe(true); // combo também tem o MCKBOT ativo
    expect((await admin.put('/api/master/settings', { plans: { MCKBOT: { modules: { ERP: false } }, COMBO: { modules: { ERP: true } } } })).status).toBe(200);
    expect((await bot.get('/api/erp/acesso')).body.liberado).toBe(false);
    expect((await combo.get('/api/erp/acesso')).body.liberado).toBe(true);
  });

  it('plano oculto: some da vitrine e do checkout de quem não assina; assinante mantém acesso e renova', async () => {
    expect((await admin.put('/api/master/settings', { plans: { COMBO: { visible: false } } })).status).toBe(200);
    const pub = (await request(app).get('/api/public/plans')).body;
    expect(pub.plans.map((p: any) => p.id)).toEqual(['MCKBOT', 'MCKMENSAGEM']);
    // Empresa nova (teste): não vê nem compra o combo e o teste não dá o ERP de um plano fora de venda.
    const novo = await registerClient();
    const st = (await novo.get('/api/billing/status')).body;
    expect(st.plans.map((p: any) => p.id)).toEqual(['MCKBOT', 'MCKMENSAGEM']);
    const co = await novo.post('/api/billing/checkout', { product: 'COMBO', cycle: 'MENSAL' });
    expect(co.status).toBe(400); expect(co.body.error).toMatch(/não está mais à venda/);
    expect((await novo.get('/api/erp/acesso')).body.liberado).toBe(false);
    // Bot (pagou só o MCKBOT): também não compra o combo oculto.
    expect((await bot.post('/api/billing/checkout', { product: 'COMBO', cycle: 'MENSAL' })).status).toBe(400);
    // Assinante do combo: vê o plano (marcado como fora de venda), renova e continua com o ERP.
    const cs = (await combo.get('/api/billing/status')).body;
    expect(cs.plans.find((p: any) => p.id === 'COMBO')).toMatchObject({ visible: false });
    expect((await combo.post('/api/billing/checkout', { product: 'COMBO', cycle: 'ANUAL' })).status).toBe(200);
    expect((await combo.get('/api/erp/acesso')).body.liberado).toBe(true);
    const r = await renew(comboOrg, 'COMBO', 'MENSAL', { source: 'MANUAL' });
    expect(r.subscriptions.map((s) => s.product).sort()).toEqual(['MCKBOT', 'MCKMENSAGEM']);
  });

  it('preço 0 deixa o ciclo fora de venda (checkout recusa)', async () => {
    expect((await admin.put('/api/master/settings', { plans: { COMBO: { visible: true } }, prices: { MCKBOT: { ANUAL: 0 } } })).status).toBe(200);
    expect((await admin.get('/api/master/settings')).body.prices.MCKBOT.ANUAL).toBe(0);
    const co = await bot.post('/api/billing/checkout', { product: 'MCKBOT', cycle: 'ANUAL' });
    expect(co.status).toBe(400);
    expect((await bot.post('/api/billing/checkout', { product: 'MCKBOT', cycle: 'MENSAL' })).status).toBe(200);
  });
});
