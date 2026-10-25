import { describe, it, expect, beforeAll } from 'vitest';
import { registerClient, Client, uniq, prisma, loginClient } from '../helpers.js';

describe('Isolamento entre organizações', () => {
  let a: Client, b: Client;
  let contactId: string, flowId: string, docId: string, convId: string, channelId: string;
  beforeAll(async () => {
    a = await registerClient();
    b = await registerClient();
    contactId = (await a.post('/api/contacts', { phone: '5511977776666', name: 'Cliente A' })).body.id;
    flowId = (await a.post('/api/flows', { name: 'Fluxo A' })).body.id;
    docId = (await a.post('/api/ai/knowledge', { title: 'Doc A', content: 'Segredo da empresa A' })).body.id;
    channelId = (await a.post('/api/channels', { name: 'Canal A' })).body.id;
    convId = (await prisma.conversation.create({ data: { orgId: a.me.org.id, contactId } })).id;
  });

  it('organização B não vê listas da A', async () => {
    expect((await b.get('/api/contacts')).body.items).toHaveLength(0);
    expect((await b.get('/api/flows')).body).toHaveLength(0);
    expect((await b.get('/api/ai/knowledge')).body).toHaveLength(0);
    expect((await b.get('/api/conversations?status=all')).body.items).toHaveLength(0);
    expect((await b.get('/api/channels')).body).toHaveLength(0);
  });

  it('organização B recebe 404 ao acessar ou alterar recursos da A por id', async () => {
    expect((await b.get(`/api/contacts/${contactId}`)).status).toBe(404);
    expect((await b.patch(`/api/contacts/${contactId}`, { name: 'Hack' })).status).toBe(404);
    expect((await b.del(`/api/contacts/${contactId}`)).status).toBe(404);
    expect((await b.get(`/api/contacts/${contactId}/export`)).status).toBe(404);
    expect((await b.get(`/api/flows/${flowId}`)).status).toBe(404);
    expect((await b.put(`/api/flows/${flowId}`, { graph: { nodes: [], edges: [] } })).status).toBe(404);
    expect((await b.del(`/api/flows/${flowId}`)).status).toBe(404);
    expect((await b.del(`/api/ai/knowledge/${docId}`)).status).toBe(404);
    expect((await b.get(`/api/conversations/${convId}`)).status).toBe(404);
    expect((await b.post(`/api/conversations/${convId}/messages`, { type: 'text', text: 'oi' })).status).toBe(404);
    expect((await b.patch(`/api/channels/${channelId}`, { name: 'x' })).status).toBe(404);
    expect((await b.post('/api/kanban/move', { contactId, stageId: null })).status).toBe(404);
    expect((await prisma.contact.findUnique({ where: { id: contactId } }))!.name).toBe('Cliente A');
  });

  it('não permite trocar para organização da qual não é membro', async () => {
    expect((await b.post('/api/auth/switch-org', { orgId: a.me.org.id })).status).toBe(404);
  });

  it('não permite mover contato para etapa de outra organização', async () => {
    const stageB = await prisma.kanbanStage.findFirst({ where: { orgId: b.me.org.id } });
    expect((await a.post('/api/kanban/move', { contactId, stageId: stageB!.id })).status).toBe(404);
  });
});

describe('Permissões (RBAC)', () => {
  let owner: Client, agent: Client, admin: Client;
  beforeAll(async () => {
    owner = await registerClient();
    const mk = async (role: 'AGENT' | 'ADMIN') => {
      const inv = await owner.post('/api/team/invites', { email: `${uniq()}@t.dev`, role });
      expect(inv.status).toBe(201);
      const token = inv.body.link.split('/convite/')[1];
      const c = new Client();
      const r = await c.agent.post('/api/auth/accept-invite').set('x-requested-with', 'mckbot').send({ token, name: 'Membro', password: 'senhaMembro123' });
      expect(r.status).toBe(200);
      c.csrf = r.body.csrfToken;
      c.me = r.body;
      return c;
    };
    agent = await mk('AGENT');
    admin = await mk('ADMIN');
  });

  it('atendente usa Inbox/Contatos mas não edita fluxos, IA, canais ou equipe', async () => {
    expect(agent.me.role).toBe('AGENT');
    expect((await agent.get('/api/conversations')).status).toBe(200);
    expect((await agent.post('/api/contacts', { phone: '5511966665555' })).status).toBe(201);
    expect((await agent.get('/api/flows')).status).toBe(200);
    expect((await agent.post('/api/flows', { name: 'x' })).status).toBe(403);
    expect((await agent.put('/api/ai/settings', { enabled: true })).status).toBe(403);
    expect((await agent.post('/api/ai/knowledge', { title: 't', content: 'c' })).status).toBe(403);
    expect((await agent.post('/api/channels', { name: 'x' })).status).toBe(403);
    expect((await agent.post('/api/team/invites', { email: 'x@y.com', role: 'AGENT' })).status).toBe(403);
    expect((await agent.get('/api/audit')).status).toBe(403);
    const c = await prisma.contact.findFirst({ where: { orgId: owner.me.org.id } });
    expect((await agent.del(`/api/contacts/${c!.id}`)).status).toBe(403);
  });

  it('admin edita fluxos mas não altera papéis; dono altera e não pode ser removido', async () => {
    expect((await admin.post('/api/flows', { name: 'Fluxo do admin' })).status).toBe(201);
    const team = await owner.get('/api/team');
    const agentM = team.body.members.find((m: any) => m.role === 'AGENT');
    const ownerM = team.body.members.find((m: any) => m.role === 'OWNER');
    expect((await admin.patch(`/api/team/members/${agentM.id}`, { role: 'ADMIN' })).status).toBe(403);
    expect((await owner.patch(`/api/team/members/${agentM.id}`, { role: 'ADMIN' })).status).toBe(200);
    expect((await owner.patch(`/api/team/members/${agentM.id}`, { role: 'AGENT' })).status).toBe(200);
    expect((await admin.del(`/api/team/members/${ownerM.id}`)).status).toBe(403);
    expect((await owner.del(`/api/team/members/${ownerM.id}`)).status).toBe(403);
  });

  it('membro removido perde o acesso à organização', async () => {
    const team = await owner.get('/api/team');
    const agentM = team.body.members.find((m: any) => m.role === 'AGENT');
    expect((await owner.del(`/api/team/members/${agentM.id}`)).status).toBe(200);
    expect((await agent.get('/api/conversations')).status).toBe(403);
  });

  it('convite: link de uso único e conta existente precisa estar logada', async () => {
    const existing = await registerClient();
    const inv = await owner.post('/api/team/invites', { email: existing.me.user.email, role: 'AGENT' });
    const token = inv.body.link.split('/convite/')[1];
    const anon = new Client();
    expect((await anon.agent.post('/api/auth/accept-invite').set('x-requested-with', 'mckbot').send({ token })).status).toBe(401);
    expect((await existing.post('/api/auth/accept-invite', { token })).status).toBe(200);
    expect((await existing.post('/api/auth/accept-invite', { token })).status).toBe(404);
    const me = await existing.get('/api/auth/me');
    expect(me.body.orgs).toHaveLength(2);
  });

  it('registra logs de auditoria das ações', async () => {
    const logs = await owner.get('/api/audit');
    expect(logs.status).toBe(200);
    const actions = logs.body.map((l: any) => l.action);
    expect(actions).toContain('team.invite');
    expect(actions).toContain('team.role_change');
    expect(actions).toContain('team.remove');
  });
});

describe('Login inexistente', () => {
  it('responde igual para e-mail inexistente', async () => {
    const r = await loginClient(`${uniq()}@naoexiste.dev`, 'qualquer');
    expect(r.res.status).toBe(401);
    expect(r.res.body.error).toBe('E-mail ou senha incorretos');
  });
});
