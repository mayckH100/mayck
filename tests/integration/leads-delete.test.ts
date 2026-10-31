import { describe, it, expect, beforeAll } from 'vitest';
import { registerClient, Client, createTestChannel, installGraphMock, uniq, prisma } from '../helpers.js';

const API = '/api/mckmensagem';

async function invite(owner: Client, role: 'AGENT' | 'ADMIN') {
  const inv = await owner.post('/api/team/invites', { email: `${uniq()}@t.dev`, role });
  const token = inv.body.link.split('/convite/')[1];
  const c = new Client();
  const r = await c.agent.post('/api/auth/accept-invite').set('x-requested-with', 'mckbot').send({ token, name: 'Membro', password: 'senhaMembro123' });
  c.csrf = r.body.csrfToken;
  c.me = r.body;
  return c;
}

let seq = 0;
const novoLead = async (c: Client, extra: Record<string, unknown> = {}) => {
  const r = await c.post(`${API}/leads`, { phone: `11966${String(100000 + seq++)}`, consentSource: 'MANUAL', ...extra });
  expect(r.status).toBe(201);
  return r.body as { id: string; phone: string };
};
const existe = async (id: string) => !!(await prisma.lead.findUnique({ where: { id } }));

describe('MCK Mensagens — excluir contatos (individual e em massa)', () => {
  let owner: Client, admin: Client, agent: Client, other: Client;
  let channelId: string;

  beforeAll(async () => {
    installGraphMock();
    owner = await registerClient();
    other = await registerClient();
    admin = await invite(owner, 'ADMIN');
    agent = await invite(owner, 'AGENT');
    channelId = (await createTestChannel(owner.me.org.id)).ch.id;
  });

  it('exclusão individual: remove o lead e o histórico de envio; audita sem PII', async () => {
    const camp = (await owner.post(`${API}/campaigns`, { name: 'C1', message: 'Oi', channelId })).body;
    const l = await novoLead(owner, { name: 'Fulano Secreto', campaignId: camp.id });
    await owner.post(`${API}/campaigns/${camp.id}/start`, {});
    expect(await prisma.campaignRecipient.count({ where: { leadId: l.id } })).toBe(1);
    const r = await owner.del(`${API}/leads/${l.id}`);
    expect(r.status).toBe(200);
    expect(await existe(l.id)).toBe(false);
    expect(await prisma.campaignRecipient.count({ where: { leadId: l.id } })).toBe(0);
    expect((await owner.get(`${API}/leads/${l.id}`)).status).toBe(404);
    expect((await owner.del(`${API}/leads/${l.id}`)).status).toBe(404);
    const aud = await prisma.auditLog.findFirst({ where: { orgId: owner.me.org.id, action: 'leads.delete', entityId: l.id } });
    expect(aud).toBeTruthy();
    expect(aud!.userId).toBe(owner.me.user.id);
    expect(JSON.parse(aud!.meta)).toEqual({ count: 1 });
    expect(aud!.meta).not.toContain('Fulano');
    expect(aud!.meta).not.toContain(l.phone);
  });

  it('ADMIN também pode excluir', async () => {
    const l = await novoLead(owner);
    expect((await admin.del(`${API}/leads/${l.id}`)).status).toBe(200);
    expect(await existe(l.id)).toBe(false);
    const ls = [await novoLead(owner), await novoLead(owner)];
    const r = await admin.post(`${API}/leads/bulk-delete`, { ids: ls.map((x) => x.id) });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ requested: 2, deleted: 2 });
  });

  it('exclusão em massa por ids: dedup, histórico removido, auditoria com contagem/ids e lista atualizada', async () => {
    const camp = (await owner.post(`${API}/campaigns`, { name: 'C2', message: 'Oi', channelId })).body;
    const ls = [];
    for (let i = 0; i < 5; i++) ls.push(await novoLead(owner, { name: `Massa ${i}`, campaignId: camp.id }));
    const manter = await novoLead(owner, { name: 'Manter' });
    await owner.post(`${API}/campaigns/${camp.id}/start`, {});
    const ids = ls.map((l) => l.id);
    const antes = (await owner.get(`${API}/leads?pageSize=200`)).body.total;
    const r = await owner.post(`${API}/leads/bulk-delete`, { ids: [...ids, ids[0]] });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ requested: 5, deleted: 5 });
    for (const id of ids) expect(await existe(id)).toBe(false);
    expect(await existe(manter.id)).toBe(true);
    expect(await prisma.campaignRecipient.count({ where: { leadId: { in: ids } } })).toBe(0);
    const depois = (await owner.get(`${API}/leads?pageSize=200`)).body;
    expect(depois.total).toBe(antes - 5);
    expect(depois.items.some((l: any) => ids.includes(l.id))).toBe(false);
    const aud = await prisma.auditLog.findMany({ where: { orgId: owner.me.org.id, action: 'leads.bulk_delete' }, orderBy: { createdAt: 'desc' } });
    const meta = JSON.parse(aud[0].meta);
    expect(meta).toMatchObject({ requested: 5, deleted: 5 });
    expect([...meta.ids].sort()).toEqual([...ids].sort());
    expect(aud[0].meta).not.toContain('Massa');
    expect(aud[0].meta).not.toContain(ls[0].phone);
  });

  it('isolamento entre organizações: ids de outra empresa são ignorados (massa) ou 404 (individual)', async () => {
    const meu = await novoLead(owner);
    const alheio = await novoLead(other);
    expect((await owner.del(`${API}/leads/${alheio.id}`)).status).toBe(404);
    expect(await existe(alheio.id)).toBe(true);
    const r = await owner.post(`${API}/leads/bulk-delete`, { ids: [alheio.id, meu.id] });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ requested: 2, deleted: 1 });
    expect(await existe(alheio.id)).toBe(true);
    expect(await existe(meu.id)).toBe(false);
    const aud = await prisma.auditLog.findFirst({ where: { orgId: owner.me.org.id, action: 'leads.bulk_delete' }, orderBy: { createdAt: 'desc' } });
    expect(JSON.parse(aud!.meta).ids).toEqual([meu.id]);
    // Só ids alheios: nada excluído.
    const r2 = await owner.post(`${API}/leads/bulk-delete`, { ids: [alheio.id] });
    expect(r2.body).toEqual({ requested: 1, deleted: 0 });
    expect(await existe(alheio.id)).toBe(true);
    // A ação em massa antiga também respeita a org.
    await owner.post(`${API}/leads/bulk`, { ids: [alheio.id], action: 'delete' });
    expect(await existe(alheio.id)).toBe(true);
  });

  it('AGENT recebe 403 em todas as formas de exclusão e nada é excluído', async () => {
    const l = await novoLead(owner);
    expect((await agent.del(`${API}/leads/${l.id}`)).status).toBe(403);
    expect((await agent.post(`${API}/leads/bulk-delete`, { ids: [l.id] })).status).toBe(403);
    expect((await agent.post(`${API}/leads/bulk`, { ids: [l.id], action: 'delete' })).status).toBe(403);
    expect((await agent.post(`${API}/leads/bulk`, { filter: {}, action: 'delete' })).status).toBe(403);
    expect(await existe(l.id)).toBe(true);
    expect(await prisma.auditLog.count({ where: { orgId: owner.me.org.id, userId: agent.me.user.id, action: { in: ['leads.delete', 'leads.bulk_delete'] } } })).toBe(0);
  });

  it('validação: ids obrigatório, não vazio, no máximo 500, sem campos extras', async () => {
    const l = await novoLead(owner);
    expect((await owner.post(`${API}/leads/bulk-delete`, {})).status).toBe(400);
    expect((await owner.post(`${API}/leads/bulk-delete`, { ids: [] })).status).toBe(400);
    expect((await owner.post(`${API}/leads/bulk-delete`, { ids: 'abc' })).status).toBe(400);
    expect((await owner.post(`${API}/leads/bulk-delete`, { ids: [''] })).status).toBe(400);
    expect((await owner.post(`${API}/leads/bulk-delete`, { ids: [123] })).status).toBe(400);
    expect((await owner.post(`${API}/leads/bulk-delete`, { ids: [l.id], filter: {} })).status).toBe(400);
    const muitos = Array.from({ length: 501 }, (_, i) => `x${i}`);
    expect((await owner.post(`${API}/leads/bulk-delete`, { ids: [l.id, ...muitos.slice(1)] })).status).toBe(400);
    expect(await existe(l.id)).toBe(true);
    // Exatamente 500 é aceito.
    const ok = await owner.post(`${API}/leads/bulk-delete`, { ids: [l.id, ...muitos.slice(0, 499)] });
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ requested: 500, deleted: 1 });
  });
});
