import { describe, it, expect, beforeAll } from 'vitest';
import { registerClient, Client, prisma } from '../helpers.js';
import { planoCompletoAtivo } from '../../server/billing/service.js';
import { erpLivreSemPlano } from '../../server/billing/guard.js';
import { tickAlertasErp } from '../../server/erp/alertas/alertas.js';

/**
 * v1.17.0 — MCK ERP só com o Plano Completo (MCKBOT + MCK Mensagens ativos ou em teste).
 * Só um dos dois ativo → 402 (code ERP_PLANO_COMPLETO) na leitura e na escrita; exportar/baixar os dados continua liberado.
 * Superadmin não é afetado.
 */
const DAY = 86400000;
const futuro = () => new Date(Date.now() + 30 * DAY);
const passado = () => new Date(Date.now() - DAY);

async function setSub(orgId: string, product: 'MCKBOT' | 'MCKMENSAGEM', status: 'TRIAL' | 'ATIVA', validUntil: Date, source = status === 'TRIAL' ? 'TRIAL' : 'MP') {
  await prisma.subscription.update({ where: { orgId_product: { orgId, product } }, data: { status, validUntil, source } });
}

describe('MCK ERP só no Plano Completo (v1.17.0)', () => {
  let owner: Client; let orgId: string;
  beforeAll(async () => {
    owner = await registerClient();
    orgId = (await owner.get('/api/auth/me')).body.org.id;
    await owner.get('/api/billing/status'); // cria as duas assinaturas (teste)
  });

  it('em teste do Plano Completo (os dois em teste) o ERP funciona', async () => {
    expect((await owner.get('/api/erp/acesso')).body).toMatchObject({ liberado: true, planoCompleto: true });
    expect((await owner.post('/api/erp/produtos', { sku: 'PC-1', nome: 'Produto PC', precoBaseCents: 100 })).status).toBe(201);
    expect((await owner.get('/api/erp/produtos')).status).toBe(200);
  });

  it('só MCKBOT pago ativo → 402 na escrita e na leitura, com aviso do Plano Completo', async () => {
    await setSub(orgId, 'MCKBOT', 'ATIVA', futuro());
    await setSub(orgId, 'MCKMENSAGEM', 'ATIVA', passado());
    const acesso = await owner.get('/api/erp/acesso');
    expect(acesso.status).toBe(200);
    expect(acesso.body).toMatchObject({ liberado: false, planoCompleto: false });
    expect(acesso.body.motivo).toMatch(/Plano Completo/);
    const w = await owner.post('/api/erp/produtos', { sku: 'PC-2', nome: 'Produto 2', precoBaseCents: 100 });
    expect(w.status).toBe(402);
    expect(w.body.code).toBe('ERP_PLANO_COMPLETO');
    for (const p of ['/api/erp/produtos', '/api/erp/vendas/pedidos', '/api/erp/crm/parceiros', '/api/erp/financeiro/titulos', '/api/erp/bi/resumo', '/api/erp/io/produtos/modelo']) {
      expect((await owner.get(p)).status, p).toBe(402);
    }
  });

  it('sem o Plano Completo, exportar/baixar os próprios dados continua liberado', async () => {
    const csv = await owner.get('/api/erp/io/produtos/exportar');
    expect(csv.status).toBe(200);
    expect(csv.text).toContain('PC-1');
    for (const p of ['/api/erp/io/clientes/exportar', '/api/erp/io/fornecedores/exportar', '/api/erp/bi/exportar?tipo=pedidos', '/api/erp/fiscal/nfe']) {
      expect((await owner.get(p)).status, p).toBe(200);
    }
    // Rota de download aceita só leitura: escrita no mesmo caminho continua barrada.
    expect(erpLivreSemPlano('POST', '/io/produtos/exportar')).toBe(false);
    expect(erpLivreSemPlano('GET', '/fiscal/nfe/abc/xml')).toBe(true);
    expect(erpLivreSemPlano('GET', '/fiscal/config')).toBe(false);
    expect(erpLivreSemPlano('GET', '/io/produtos/importar')).toBe(false);
  });

  it('só MCK Mensagens ativo também bloqueia; os dois pagos (COMBO) liberam', async () => {
    await setSub(orgId, 'MCKBOT', 'ATIVA', passado());
    await setSub(orgId, 'MCKMENSAGEM', 'ATIVA', futuro());
    expect((await owner.get('/api/erp/produtos')).status).toBe(402);
    await setSub(orgId, 'MCKBOT', 'ATIVA', futuro());
    expect((await owner.get('/api/erp/produtos')).status).toBe(200);
    expect((await owner.post('/api/erp/produtos', { sku: 'PC-3', nome: 'Produto 3', precoBaseCents: 100 })).status).toBe(201);
  });

  it('um produto bloqueado pelo Master tira o ERP', async () => {
    await prisma.subscription.update({ where: { orgId_product: { orgId, product: 'MCKMENSAGEM' } }, data: { status: 'BLOQUEADA' } });
    expect((await owner.get('/api/erp/produtos')).status).toBe(402);
    await setSub(orgId, 'MCKMENSAGEM', 'ATIVA', futuro());
  });

  it('superadmin (Master) não é afetado', async () => {
    const adm = await registerClient();
    const admOrg = (await adm.get('/api/auth/me')).body.org.id;
    await adm.get('/api/billing/status');
    await prisma.subscription.updateMany({ where: { orgId: admOrg }, data: { status: 'ATIVA', validUntil: passado() } });
    expect((await adm.get('/api/erp/produtos')).status).toBe(402);
    await prisma.user.update({ where: { id: adm.me.user.id }, data: { isSuperAdmin: true } });
    expect((await adm.get('/api/erp/produtos')).status).toBe(200);
    expect((await adm.get('/api/erp/acesso')).body).toMatchObject({ liberado: true, superAdmin: true, planoCompleto: false });
  });

  it('quem pagou só um produto não ganha "teste" do outro ao abrir o ERP', async () => {
    const c = await registerClient();
    const id = (await c.get('/api/auth/me')).body.org.id;
    await prisma.subscription.deleteMany({ where: { orgId: id } });
    await prisma.subscription.create({ data: { orgId: id, product: 'MCKBOT', status: 'ATIVA', cycle: 'MENSAL', validUntil: futuro(), source: 'MP' } });
    expect(await planoCompletoAtivo(id)).toBe(false);
    expect(await prisma.subscription.count({ where: { orgId: id, product: 'MCKMENSAGEM' } })).toBe(0);
    // Empresa nova, sem assinatura nenhuma: começa o teste dos dois (teste do Plano Completo).
    await prisma.subscription.deleteMany({ where: { orgId: id } });
    expect(await planoCompletoAtivo(id)).toBe(true);
  });

  it('alertas diários do ERP não saem sem o Plano Completo', async () => {
    const c = await registerClient();
    const id = (await c.get('/api/auth/me')).body.org.id;
    await c.get('/api/billing/status');
    await prisma.erpConfig.upsert({ where: { orgId: id }, create: { orgId: id, alertaAtivo: true, alertaTelefones: JSON.stringify(['5511999990000']), alertaHora: 0 }, update: { alertaAtivo: true, alertaTelefones: JSON.stringify(['5511999990000']), alertaHora: 0, alertaUltimoDia: null } });
    await prisma.subscription.update({ where: { orgId_product: { orgId: id, product: 'MCKMENSAGEM' } }, data: { status: 'ATIVA', validUntil: passado() } });
    await tickAlertasErp();
    // Sem o plano, o dia não é "gasto": quando fizer upgrade, o alerta do dia ainda pode sair.
    expect((await prisma.erpConfig.findUnique({ where: { orgId: id } }))?.alertaUltimoDia ?? null).toBeNull();
    // Com o Plano Completo de volta, o alerta do dia é processado.
    await prisma.subscription.update({ where: { orgId_product: { orgId: id, product: 'MCKMENSAGEM' } }, data: { status: 'TRIAL', validUntil: futuro() } });
    await tickAlertasErp();
    expect((await prisma.erpConfig.findUnique({ where: { orgId: id } }))?.alertaUltimoDia).toBeTruthy();
  });
});
