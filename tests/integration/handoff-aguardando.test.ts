import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { registerClient, Client, createTestChannel, installGraphMock, graph, sendInbound, prisma, uniq } from '../helpers.js';
import { tickHandoffAlerts } from '../../server/whatsapp/handoffAlerts.js';

const N = (id: string, type: string, data: any = {}) => ({ id, type, position: { x: 0, y: 0 }, data });
const E = (source: string, target: string, sourceHandle = 'next') => ({ id: `${source}-${sourceHandle}-${target}`, source, target, sourceHandle });

async function invite(owner: Client, role: 'AGENT' | 'ADMIN') {
  const inv = await owner.post('/api/team/invites', { email: `${uniq()}@t.dev`, role });
  const token = inv.body.link.split('/convite/')[1];
  const c = new Client();
  const r = await c.agent.post('/api/auth/accept-invite').set('x-requested-with', 'mckbot').send({ token, name: 'Membro', password: 'senhaMembro123' });
  c.csrf = r.body.csrfToken;
  c.me = r.body;
  return c;
}

describe('"Aguardando atendente": transferência para humano, Kanban, aviso e configurações', () => {
  let owner: Client;
  let ctx: Awaited<ReturnType<typeof createTestChannel>>;
  let phone = 5511733000000;
  const nextPhone = () => String(++phone);
  const convOf = async (p: string) => {
    const contact = await prisma.contact.findUniqueOrThrow({ where: { orgId_waId: { orgId: owner.me.org.id, waId: p } } });
    const conv = await prisma.conversation.findFirstOrThrow({ where: { contactId: contact.id }, orderBy: { createdAt: 'desc' } });
    return { contact, conv };
  };
  const stageName = async (stageId: string | null) => (stageId ? (await prisma.kanbanStage.findUnique({ where: { id: stageId } }))?.name : null);

  beforeAll(async () => {
    installGraphMock();
    owner = await registerClient();
    ctx = await createTestChannel(owner.me.org.id);
    const f = await owner.post('/api/flows', {
      name: 'Transferir',
      graph: { nodes: [N('s', 'start', { triggers: [{ type: 'keyword', value: 'humano', match: 'contains' }] }), N('h', 'handoff', { reason: 'Cliente pediu' })], edges: [E('s', 'h')] },
    });
    expect((await owner.post(`/api/flows/${f.body.id}/status`, { status: 'ACTIVE' })).status).toBe(200);
  });
  beforeEach(() => graph.reset());

  it('transferência do fluxo marca waitingSince, cria a etapa "Aguardando atendente" no fim e move o contato', async () => {
    const before = await prisma.kanbanStage.findMany({ where: { orgId: owner.me.org.id }, orderBy: { position: 'asc' } });
    expect(before.some((s) => s.name === 'Aguardando atendente')).toBe(false);
    const p = nextPhone();
    await sendInbound(ctx, p, 'quero falar com um humano');
    const { contact, conv } = await convOf(p);
    expect(conv.mode).toBe('HUMAN');
    expect(conv.status).toBe('PENDING');
    expect(conv.waitingSince).toBeInstanceOf(Date);
    expect(conv.handoffAlertSentAt).toBeNull();
    expect(await stageName(contact.stageId)).toBe('Aguardando atendente');
    const stages = await prisma.kanbanStage.findMany({ where: { orgId: owner.me.org.id }, orderBy: { position: 'asc' } });
    expect(stages.at(-1)!.name).toBe('Aguardando atendente');
    expect(stages.filter((s) => s.name === 'Aguardando atendente')).toHaveLength(1);

    // Segunda transferência não duplica a etapa nem reinicia a espera.
    const p2 = nextPhone();
    await sendInbound(ctx, p2, 'humano por favor');
    expect(await prisma.kanbanStage.count({ where: { orgId: owner.me.org.id, name: 'Aguardando atendente' } })).toBe(1);

    const w = await owner.get('/api/conversations/waiting');
    expect(w.status).toBe(200);
    const item = w.body.items.find((i: any) => i.id === conv.id);
    expect(item.label).toBe('Aguardando atendente');
    expect(item.contact.phone).toBeTruthy();
    const list = await owner.get('/api/conversations?status=pending');
    expect(list.body.items.find((i: any) => i.id === conv.id).waitingLabel).toBe('Aguardando atendente');

    // Isolamento: outra organização não vê.
    const other = await registerClient();
    const wo = await other.get('/api/conversations/waiting');
    expect(wo.body.items.some((i: any) => i.id === conv.id)).toBe(false);
  });

  it('transferência pela IA (palavra de transferência) também marca "Aguardando atendente"', async () => {
    expect((await owner.put('/api/ai/settings', { provider: 'fake', model: 'fake-1', enabled: true, autoReply: true, handoffKeywords: ['atendente'] })).status).toBe(200);
    const p = nextPhone();
    await sendInbound(ctx, p, 'preciso de um atendente');
    const { contact, conv } = await convOf(p);
    expect(conv.mode).toBe('HUMAN');
    expect(conv.waitingSince).toBeInstanceOf(Date);
    expect(await stageName(contact.stageId)).toBe('Aguardando atendente');
  });

  it('resposta do atendente limpa a espera e move para "Em atendimento"', async () => {
    const p = nextPhone();
    await sendInbound(ctx, p, 'humano');
    const { conv } = await convOf(p);
    const r = await owner.post(`/api/conversations/${conv.id}/messages`, { type: 'text', text: 'Olá, sou o atendente!' });
    expect(r.status).toBe(201);
    const after = await convOf(p);
    expect(after.conv.waitingSince).toBeNull();
    expect(await stageName(after.contact.stageId)).toBe('Em atendimento');
    const w = await owner.get('/api/conversations/waiting');
    expect(w.body.items.some((i: any) => i.id === conv.id)).toBe(false);
  });

  it('aviso ao número reserva: enviado uma única vez após handoffAlertMinutes, e só com backupPhone', async () => {
    const orgId = owner.me.org.id;
    await prisma.conversation.updateMany({ where: { orgId, waitingSince: { not: null } }, data: { waitingSince: null } });
    const p = nextPhone();
    await sendInbound(ctx, p, 'humano');
    const { conv } = await convOf(p);
    await prisma.contact.update({ where: { id: conv.contactId }, data: { name: 'Maria Teste' } });
    await prisma.conversation.update({ where: { id: conv.id }, data: { waitingSince: new Date(Date.now() - 10 * 60_000) } });
    graph.reset();

    // Sem número reserva: nada é enviado.
    await prisma.organization.update({ where: { id: orgId }, data: { backupPhone: null, handoffAlertMinutes: 5 } });
    await tickHandoffAlerts();
    expect(graph.calls.filter((c) => c.body)).toHaveLength(0);
    expect((await prisma.conversation.findUniqueOrThrow({ where: { id: conv.id } })).handoffAlertSentAt).toBeNull();

    // Limite maior que a espera: ainda não avisa.
    await prisma.organization.update({ where: { id: orgId }, data: { backupPhone: '+5511988887777', handoffAlertMinutes: 30 } });
    await tickHandoffAlerts();
    expect(graph.calls.filter((c) => c.body)).toHaveLength(0);

    await prisma.organization.update({ where: { id: orgId }, data: { handoffAlertMinutes: 5 } });
    expect(await tickHandoffAlerts()).toBe(1);
    const sent = graph.calls.filter((c) => c.body);
    expect(sent).toHaveLength(1);
    expect(sent[0].body.to).toBe('5511988887777');
    expect(sent[0].body.text.body).toMatch(/^⚠️ Atendimento aguardando: Maria Teste \(.+\) espera um atendente há 10 min\.$/);
    expect((await prisma.conversation.findUniqueOrThrow({ where: { id: conv.id } })).handoffAlertSentAt).toBeInstanceOf(Date);

    // Ciclos seguintes não repetem.
    await tickHandoffAlerts();
    await tickHandoffAlerts();
    expect(graph.calls.filter((c) => c.body)).toHaveLength(1);
  });

  it('falha no envio do aviso é registrada sem derrubar o ciclo (e não repete)', async () => {
    const orgId = owner.me.org.id;
    await prisma.conversation.updateMany({ where: { orgId, waitingSince: { not: null } }, data: { waitingSince: null } });
    const p = nextPhone();
    await sendInbound(ctx, p, 'humano');
    const { conv } = await convOf(p);
    await prisma.conversation.update({ where: { id: conv.id }, data: { waitingSince: new Date(Date.now() - 6 * 60_000) } });
    graph.reset();
    graph.failNext = [400];
    await expect(tickHandoffAlerts()).resolves.toBe(0);
    expect((await prisma.conversation.findUniqueOrThrow({ where: { id: conv.id } })).handoffAlertSentAt).toBeInstanceOf(Date);
  });

  it('configurações: só OWNER/ADMIN alteram (AGENT 403), validação de telefone e minutos, auditado', async () => {
    const agent = await invite(owner, 'AGENT');
    expect((await agent.patch('/api/org', { backupPhone: '+5511977776666' })).status).toBe(403);
    expect((await agent.patch('/api/org', { handoffAlertMinutes: 10 })).status).toBe(403);

    expect((await owner.patch('/api/org', { backupPhone: '11977776666' })).status).toBe(400);
    expect((await owner.patch('/api/org', { backupPhone: '+1 202 555 0100' })).status).toBe(400);
    expect((await owner.patch('/api/org', { handoffAlertMinutes: 0 })).status).toBe(400);
    expect((await owner.patch('/api/org', { handoffAlertMinutes: 121 })).status).toBe(400);
    expect((await owner.patch('/api/org', { handoffAlertMinutes: 2.5 })).status).toBe(400);

    const ok = await owner.patch('/api/org', { backupPhone: '+55 (11) 97777-6666', handoffAlertMinutes: 15 });
    expect(ok.status).toBe(200);
    expect(ok.body.backupPhone).toBe('+5511977776666');
    expect(ok.body.handoffAlertMinutes).toBe(15);
    const me = await owner.get('/api/auth/me');
    expect(me.body.org.backupPhone).toBe('+5511977776666');
    expect(me.body.org.handoffAlertMinutes).toBe(15);

    const admin = await invite(owner, 'ADMIN');
    expect((await admin.patch('/api/org', { backupPhone: '' })).status).toBe(200);
    expect((await prisma.organization.findUniqueOrThrow({ where: { id: owner.me.org.id } })).backupPhone).toBeNull();

    const logs = await prisma.auditLog.findMany({ where: { orgId: owner.me.org.id, action: 'org.update' } });
    expect(logs.length).toBeGreaterThanOrEqual(2);
  });
});
