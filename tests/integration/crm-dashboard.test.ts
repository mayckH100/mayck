import { describe, it, expect, beforeAll } from 'vitest';
import { registerClient, Client, createTestChannel, installGraphMock, graph, sendInbound, prisma } from '../helpers.js';

describe('Contatos/CRM, Kanban e LGPD', () => {
  let owner: Client;
  beforeAll(async () => {
    installGraphMock();
    owner = await registerClient();
  });

  it('cria, busca, edita e filtra contatos por etiqueta; normaliza telefone brasileiro', async () => {
    const c = await owner.post('/api/contacts', { phone: '(11) 98888-7777', name: 'Bruna', tags: ['vip'] });
    expect(c.status).toBe(201);
    expect(c.body.waId).toBe('5511988887777');
    expect((await owner.post('/api/contacts', { phone: '5511988887777' })).status).toBe(409);
    expect((await owner.post('/api/contacts', { phone: 'abc12' })).status).toBe(400);
    await owner.post('/api/contacts', { phone: '5521977776666', name: 'Carlos', tags: ['vipouro'] });
    expect((await owner.get('/api/contacts?q=Bru')).body.items).toHaveLength(1);
    expect((await owner.get('/api/contacts?tag=vip')).body.items.map((x: any) => x.name)).toEqual(['Bruna']);
    const e = await owner.patch(`/api/contacts/${c.body.id}`, { notes: 'Cliente desde 2024', email: 'bruna@x.com' });
    expect(e.body.notes).toBe('Cliente desde 2024');
  });

  it('importa contatos em lote (CSV) informando erros por linha', async () => {
    const r = await owner.post('/api/contacts/import', { text: 'telefone;nome;email\n11977771111;Davi;davi@x.com\n5511988887777;Bruna\ninvalido;X' });
    expect(r.body).toMatchObject({ created: 1, updated: 1 });
    expect(r.body.errors[0]).toMatch(/Linha 4/);
  });

  it('Kanban: mover contato entre etapas e gerenciar colunas', async () => {
    const board = await owner.get('/api/kanban');
    expect(board.body.stages.map((s: any) => s.name)).toEqual(['Novo', 'Em atendimento', 'Qualificado', 'Ganho', 'Perdido']);
    const bruna = board.body.contacts.find((c: any) => c.name === 'Bruna');
    const ganho = board.body.stages.find((s: any) => s.name === 'Ganho');
    expect((await owner.post('/api/kanban/move', { contactId: bruna.id, stageId: ganho.id })).status).toBe(200);
    expect((await owner.get('/api/contacts?stageId=' + ganho.id)).body.items[0].name).toBe('Bruna');
    const st = await owner.post('/api/kanban/stages', { name: 'Pós-venda', color: '#123456' });
    expect(st.status).toBe(201);
    expect((await owner.patch(`/api/kanban/stages/${st.body.id}`, { name: 'Pós venda' })).body.name).toBe('Pós venda');
    expect((await owner.del(`/api/kanban/stages/${ganho.id}`)).status).toBe(200);
    expect((await prisma.contact.findUnique({ where: { id: bruna.id } }))!.stageId).toBeNull();
  });

  it('LGPD: exporta todos os dados do contato e apaga definitivamente', async () => {
    const ctx = await createTestChannel(owner.me.org.id);
    await sendInbound(ctx, '5511912340000', 'Olá, meu CPF é 000');
    const c = await prisma.contact.findFirstOrThrow({ where: { orgId: owner.me.org.id, waId: '5511912340000' } });
    const exp = await owner.get(`/api/contacts/${c.id}/export`);
    expect(exp.status).toBe(200);
    expect(exp.headers['content-disposition']).toMatch(/attachment/);
    expect(exp.body.messages[0].body).toBe('Olá, meu CPF é 000');
    expect(exp.body.conversations).toHaveLength(1);
    const del = await owner.del(`/api/contacts/${c.id}`);
    expect(del.body.deletedConversations).toBe(1);
    expect(await prisma.contact.findUnique({ where: { id: c.id } })).toBeNull();
    expect(await prisma.message.count({ where: { body: 'Olá, meu CPF é 000' } })).toBe(0);
    const logs = (await owner.get('/api/audit')).body.map((l: any) => l.action);
    expect(logs).toEqual(expect.arrayContaining(['lgpd.export', 'lgpd.delete']));
  });
});

describe('Painel e relatórios com dados reais do banco', () => {
  it('indicadores refletem exatamente o que aconteceu', async () => {
    installGraphMock();
    graph.reset();
    const owner = await registerClient();
    const empty = await owner.get('/api/dashboard');
    expect(empty.body.conversations).toEqual({ open: 0, pending: 0, closed: 0 });
    expect(empty.body.runs7d.successRate).toBeNull();
    expect(empty.body.integrations.whatsapp).toEqual([]);

    const ctx = await createTestChannel(owner.me.org.id);
    const f = await owner.post('/api/flows', { name: 'Oi', graph: { nodes: [{ id: 's', type: 'start', position: { x: 0, y: 0 }, data: { triggers: [{ type: 'keyword', value: 'oi', match: 'equals' }] } }, { id: 'a', type: 'send_text', position: { x: 0, y: 0 }, data: { text: 'Olá!' } }], edges: [{ id: 'e', source: 's', target: 'a', sourceHandle: 'next' }] } });
    await owner.post(`/api/flows/${f.body.id}/status`, { status: 'ACTIVE' });
    await sendInbound(ctx, '5511900000001', 'oi');
    await sendInbound(ctx, '5511900000002', 'oi');
    await sendInbound(ctx, '5511900000003', 'outra coisa');
    graph.failNext = [400];
    await sendInbound(ctx, '5511900000004', 'oi'); // envio falha → execução FAILED
    const conv = await prisma.conversation.findFirstOrThrow({ where: { orgId: owner.me.org.id, contactId: (await prisma.contact.findFirstOrThrow({ where: { orgId: owner.me.org.id, waId: '5511900000003' } })).id } });
    await owner.post(`/api/conversations/${conv.id}/action`, { action: 'close' });

    const d = (await owner.get('/api/dashboard')).body;
    expect(d.conversations).toEqual({ open: 3, pending: 0, closed: 1 });
    expect(d.messages.receivedToday).toBe(4);
    expect(d.messages.sentToday).toBe(2);
    expect(d.messages.failed7d).toBe(1);
    expect(d.flows).toEqual({ active: 1, total: 1 });
    expect(d.runs7d).toMatchObject({ completed: 2, failed: 1, successRate: 66.7 });
    expect(d.recentFailures.runs[0].flowName).toBe('Oi');
    expect(d.integrations.whatsapp[0].status).toBe('CONNECTED');
    expect(d.contacts).toBe(4);
    expect(d.avgFirstResponseSeconds).not.toBeNull();

    const r = (await owner.get('/api/reports?days=7')).body;
    expect(r.series).toHaveLength(7);
    expect(r.totals).toMatchObject({ received: 4, sent: 2, failed: 1, sentByBot: 2, newConversations: 4, closedConversations: 1 });
    expect(r.flows[0]).toMatchObject({ name: 'Oi', total: 3, completed: 2, failed: 1, successRate: 66.7 });
    const today = r.series[r.series.length - 1];
    expect(today.received).toBe(4);
    expect((await owner.get('/api/reports?days=5')).status).toBe(400);
  });

  it('plano e uso', async () => {
    const owner = await registerClient();
    const p = (await owner.get('/api/plans')).body;
    expect(p.current).toBe('gratis');
    expect(p.billingConfigured).toBe(false);
    expect(p.usage.members).toBe(1);
  });
});
