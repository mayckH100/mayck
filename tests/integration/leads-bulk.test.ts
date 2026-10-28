import { describe, it, expect, beforeAll } from 'vitest';
import { registerClient, Client, createTestChannel, installGraphMock, uniq, prisma } from '../helpers.js';
import { block, unblock } from '../../server/billing/service.js';

const API = '/api/mckmensagem';

describe('MCK Mensagens — ações em massa nos contatos', () => {
  let owner: Client, other: Client;
  let channelId: string;
  const leads = async (c: Client, q = '') => (await c.get(`${API}/leads?pageSize=200${q}`)).body;
  const novoLead = async (c: Client, phone: string, extra: Record<string, unknown> = {}) => {
    const r = await c.post(`${API}/leads`, { phone, consentSource: 'MANUAL', ...extra });
    expect(r.status).toBe(201);
    return r.body;
  };

  beforeAll(async () => {
    installGraphMock();
    owner = await registerClient();
    other = await registerClient();
    channelId = (await createTestChannel(owner.me.org.id)).ch.id;
    for (let i = 0; i < 12; i++) await novoLead(owner, `11977${String(100000 + i)}`, { name: `Lead ${i}`, tags: i < 6 ? ['vip'] : ['frio'] });
  });

  it('vincula/remove campanha por ids e por filtro ("todos que atendem ao filtro"), com auditoria', async () => {
    const camp = (await owner.post(`${API}/campaigns`, { name: 'Black Friday', message: 'Oi {nome}', channelId })).body;
    const vip = await leads(owner, '&tag=vip');
    expect(vip.total).toBe(6);
    // Por filtro: todos os VIP de uma vez.
    const r = await owner.post(`${API}/leads/bulk`, { filter: { tag: 'vip' }, action: 'setCampaign', campaignId: camp.id });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ matched: 6, updated: 6, queued: 0 }); // rascunho: entra na fila só ao iniciar
    expect((await leads(owner, `&campaignId=${camp.id}`)).total).toBe(6);
    expect((await leads(owner, '&campaignId=none')).total).toBe(6);
    // Por ids: dois "frios" a mais.
    const frios = (await leads(owner, '&tag=frio')).items.slice(0, 2).map((l: any) => l.id);
    expect((await owner.post(`${API}/leads/bulk`, { ids: frios, action: 'setCampaign', campaignId: camp.id })).body.updated).toBe(2);
    // Iniciar usa os vinculados.
    const st = await owner.post(`${API}/campaigns/${camp.id}/start`, {});
    expect(st.body.pending).toBe(8);
    // Campanha em andamento: novos vinculados entram direto na fila (sem duplicar).
    const mais = (await leads(owner, '&campaignId=none')).items.slice(0, 3).map((l: any) => l.id);
    const add = await owner.post(`${API}/leads/bulk`, { ids: [...mais, frios[0]], action: 'setCampaign', campaignId: camp.id });
    expect(add.body).toMatchObject({ updated: 4, queued: 3 });
    expect(await prisma.campaignRecipient.count({ where: { campaignId: camp.id, status: 'PENDENTE' } })).toBe(11);
    // Remover desta campanha: tira o vínculo e a fila pendente; histórico enviado seria mantido.
    const rem = await owner.post(`${API}/leads/bulk`, { filter: { campaignId: camp.id, tag: 'frio' }, action: 'removeCampaign', campaignId: camp.id });
    expect(rem.body.updated).toBe(5);
    expect(await prisma.campaignRecipient.count({ where: { campaignId: camp.id, status: 'PENDENTE' } })).toBe(6);
    // Picker: contatos que ainda não estão na campanha.
    expect((await leads(owner, `&notCampaignId=${camp.id}`)).total).toBe(6);
    const aud = await prisma.auditLog.findMany({ where: { orgId: owner.me.org.id, action: 'mckmensagem.lead.bulk' } });
    expect(aud.length).toBeGreaterThanOrEqual(4);
    expect(aud.some((a) => { const m = JSON.parse(a.meta); return m.action === 'setCampaign' && m.por === 'filtro' && m.matched === 6 && a.userId === owner.me.user.id; })).toBe(true);
  });

  it('etiquetas, status, opt-out/reativar e exclusão em massa; opt-out não entra na fila', async () => {
    const all = (await leads(owner)).items.map((l: any) => l.id);
    const tres = all.slice(0, 3);
    expect((await owner.post(`${API}/leads/bulk`, { ids: tres, action: 'addTags', tags: ['promo', 'vip'] })).body.updated).toBe(3);
    const l0 = (await owner.get(`${API}/leads/${tres[0]}`)).body;
    expect(l0.tags).toEqual(expect.arrayContaining(['promo']));
    expect(new Set(l0.tags).size).toBe(l0.tags.length);
    expect((await owner.post(`${API}/leads/bulk`, { filter: { tag: 'promo' }, action: 'removeTags', tags: ['promo'] })).body.updated).toBe(3);
    expect((await leads(owner, '&tag=promo')).total).toBe(0);
    expect((await owner.post(`${API}/leads/bulk`, { ids: tres, action: 'setStatus', status: 'CONVERTIDO' })).body.updated).toBe(3);
    expect((await leads(owner, '&status=CONVERTIDO')).total).toBe(3);
    expect((await owner.post(`${API}/leads/bulk`, { ids: tres, action: 'optOut' })).body.updated).toBe(3);
    expect((await owner.post(`${API}/leads/bulk`, { ids: tres, action: 'optOut' })).body.updated).toBe(0); // idempotente
    expect((await leads(owner, '&optOut=sim')).total).toBe(3);
    // Opt-out vinculado a campanha em andamento não entra na fila.
    const camp = (await owner.post(`${API}/campaigns`, { name: 'Em andamento', message: 'Oi', channelId })).body;
    await owner.post(`${API}/leads/bulk`, { ids: [all[5]], action: 'setCampaign', campaignId: camp.id });
    await owner.post(`${API}/campaigns/${camp.id}/start`, {});
    const r = await owner.post(`${API}/leads/bulk`, { ids: tres, action: 'setCampaign', campaignId: camp.id });
    expect(r.body).toMatchObject({ updated: 3, queued: 0 });
    expect((await owner.post(`${API}/leads/bulk`, { ids: tres, action: 'optIn' })).body.updated).toBe(3);
    // Exclusão em massa.
    const del = await owner.post(`${API}/leads/bulk`, { ids: tres, action: 'delete' });
    expect(del.body.updated).toBe(3);
    expect((await leads(owner)).total).toBe(9);
    expect(await prisma.campaignRecipient.count({ where: { leadId: { in: tres } } })).toBe(0);
  });

  it('validação, limite, isolamento entre organizações e regra 402', async () => {
    expect((await owner.post(`${API}/leads/bulk`, { action: 'optOut' })).status).toBe(400); // sem ids nem filtro
    expect((await owner.post(`${API}/leads/bulk`, { ids: ['x'], filter: {}, action: 'optOut' })).status).toBe(400); // os dois
    expect((await owner.post(`${API}/leads/bulk`, { ids: ['x'], action: 'setCampaign' })).status).toBe(400);
    expect((await owner.post(`${API}/leads/bulk`, { ids: ['x'], action: 'addTags', tags: [] })).status).toBe(400);
    expect((await owner.post(`${API}/leads/bulk`, { ids: Array.from({ length: 10001 }, (_, i) => `id${i}`), action: 'optOut' })).status).toBe(400);
    // Outra organização: ids de cá não são afetados; campanha de lá é inválida aqui.
    const meus = (await leads(owner)).items.map((l: any) => l.id);
    const r = await other.post(`${API}/leads/bulk`, { ids: meus, action: 'delete' });
    expect(r.body).toMatchObject({ matched: 0, updated: 0 });
    expect((await leads(owner)).total).toBe(meus.length);
    const campOutra = (await other.post(`${API}/campaigns`, { name: 'Outra', message: 'x', channelId: (await createTestChannel(other.me.org.id)).ch.id })).body;
    expect((await owner.post(`${API}/leads/bulk`, { ids: meus, action: 'setCampaign', campaignId: campOutra.id })).status).toBe(404);
    // Filtro vazio = todos da organização (só os meus).
    const tudo = await other.post(`${API}/leads/bulk`, { filter: {}, action: 'addTags', tags: [uniq('t')] });
    expect(tudo.body.matched).toBe(0);
    // Assinatura inativa: 402.
    await block(owner.me.org.id, 'MCKMENSAGEM');
    try {
      const b = await owner.post(`${API}/leads/bulk`, { filter: {}, action: 'optOut' });
      expect(b.status).toBe(402);
      expect(b.body.error).toBe('Assinatura MCK Mensagens inativa');
    } finally {
      await unblock(owner.me.org.id, 'MCKMENSAGEM');
    }
  });
});
