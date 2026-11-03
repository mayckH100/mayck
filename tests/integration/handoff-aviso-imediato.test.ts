import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { registerClient, Client, createTestChannel, installGraphMock, graph, sendInbound, prisma } from '../helpers.js';
import { flushHandoffNotifies } from '../../server/whatsapp/handoffNotify.js';
import { tickHandoffAlerts } from '../../server/whatsapp/handoffAlerts.js';
import { outbox } from '../../server/lib/mailer.js';

/** Aviso NO MOMENTO da transferência para os números de aviso (bug: "não recebo mensagem quando vai para humano"). */
describe('Aviso imediato de atendimento humano (números de aviso)', () => {
  let owner: Client;
  let ctx: Awaited<ReturnType<typeof createTestChannel>>;
  let phone = 5511720000000;
  const nextPhone = () => String(++phone);
  const toStaff = () => graph.calls.filter((c) => c.body?.to === '5511988880001' || c.body?.to === '5511988880002');
  const convOf = async (p: string) => {
    const c = await prisma.contact.findFirstOrThrow({ where: { orgId: owner.me.org.id, waId: p } });
    return prisma.conversation.findFirstOrThrow({ where: { contactId: c.id } });
  };

  beforeAll(async () => {
    installGraphMock();
    owner = await registerClient();
    ctx = await createTestChannel(owner.me.org.id);
    await prisma.channel.update({ where: { id: ctx.ch.id }, data: { displayPhone: '+5511900005300' } });
    expect((await owner.put('/api/ai/settings', { provider: 'fake', model: 'fake-1', enabled: true, autoReply: true })).status).toBe(200);
  });
  beforeEach(() => graph.reset());

  it('sem número configurado: ninguém é avisado, o status no Perfil explica e o /me mostra lista vazia', async () => {
    const p = nextPhone();
    await sendInbound(ctx, p, 'quero falar com um atendente');
    await flushHandoffNotifies();
    expect((await convOf(p)).mode).toBe('HUMAN');
    expect(toStaff()).toHaveLength(0);
    const g = await owner.get('/api/org/handoff-notify');
    expect(g.status).toBe(200);
    expect(g.body.phones).toEqual([]);
    expect(g.body.status.detail).toMatch(/nenhum número de aviso configurado/i);
    expect((await owner.get('/api/auth/me')).body.org.handoffNotifyPhones).toEqual([]);
  });

  it('salva vários números (valida, sem repetidos, backupPhone = 1º)', async () => {
    expect((await owner.patch('/api/org', { handoffNotifyPhones: ['11988880001'] })).status).toBe(400);
    const r = await owner.patch('/api/org', { handoffNotifyPhones: ['+55 (11) 98888-0001', '+5511988880002', '+5511988880001', ''] });
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body.handoffNotifyPhones)).toEqual(['+5511988880001', '+5511988880002']);
    expect(r.body.backupPhone).toBe('+5511988880001');
    expect((await owner.get('/api/auth/me')).body.org.handoffNotifyPhones).toEqual(['+5511988880001', '+5511988880002']);
    expect((await owner.patch('/api/org', { handoffNotifyPhones: Array(6).fill('+5511988880001') })).status).toBe(400);
  });

  it('cliente pede atendente → os dois números recebem NA HORA nome, telefone, motivo, WhatsApp e link; nota na conversa', async () => {
    const p = nextPhone();
    await sendInbound(ctx, p, 'quero falar com um atendente');
    await flushHandoffNotifies();
    const sent = toStaff();
    expect(sent.map((c) => c.body.to).sort()).toEqual(['5511988880001', '5511988880002']);
    const text = sent[0].body.text.body as string;
    expect(text).toMatch(/^🔔 Novo atendimento humano/);
    expect(text).toContain(`Contato: `);
    expect(text).toContain(p.slice(-4));
    expect(text).toContain('Motivo: Contato pediu atendimento humano');
    expect(text).toContain('WhatsApp: WhatsApp 1 · Teste');
    const conv = await convOf(p);
    expect(text).toContain(`/inbox/${conv.id}`);
    expect(conv.handoffNotifyAt).toBeInstanceOf(Date);
    const n = await prisma.message.findFirst({ where: { conversationId: conv.id, body: { startsWith: 'Aviso de atendimento enviado' } } });
    expect(n).toBeTruthy();
    // Nova mensagem do contato na mesma espera não repete o aviso.
    graph.reset();
    await sendInbound(ctx, p, 'alguém aí?');
    await flushHandoffNotifies();
    expect(toStaff()).toHaveLength(0);
  });

  it('transferência por bloco de fluxo também avisa na hora', async () => {
    const f = await owner.post('/api/flows', { name: 'Suporte humano', graph: {
      nodes: [
        { id: 's', type: 'start', position: { x: 0, y: 0 }, data: { triggers: [{ type: 'keyword', value: 'suporte', match: 'equals' }] } },
        { id: 'h', type: 'handoff', position: { x: 0, y: 0 }, data: { message: 'Já chamo alguém.', reason: 'Pediu suporte no menu' } },
      ],
      edges: [{ id: 'a', source: 's', target: 'h', sourceHandle: 'next' }],
    } });
    expect((await owner.post(`/api/flows/${f.body.id}/status`, { status: 'ACTIVE' })).status).toBe(200);
    const p = nextPhone();
    await sendInbound(ctx, p, 'suporte');
    await flushHandoffNotifies();
    const sent = toStaff();
    expect(sent).toHaveLength(2);
    expect(sent[0].body.text.body).toContain('Motivo: Pediu suporte no menu');
    await owner.post(`/api/flows/${f.body.id}/status`, { status: 'INACTIVE' });
  });

  it('falha no envio: nota visível na conversa, status no Perfil, nova tentativa pelo tick que entrega', async () => {
    await owner.patch('/api/org', { handoffNotifyPhones: ['+5511988880001'] });
    const p = nextPhone();
    graph.reset();
    // A resposta ao cliente sai (1ª chamada); o aviso falha (2ª).
    graph.failNext = [0, 400];
    await sendInbound(ctx, p, 'quero falar com um atendente');
    await flushHandoffNotifies();
    let conv = await convOf(p);
    expect(conv.handoffNotifyAt).toBeNull();
    expect(conv.handoffNotifyTries).toBe(1);
    const n = await prisma.message.findFirst({ where: { conversationId: conv.id, body: { contains: 'NÃO entregue' } } });
    expect(n!.body).toMatch(/Erro simulado 400/);
    const g = await owner.get('/api/org/handoff-notify');
    expect(g.body.status.ok).toBe(false);
    graph.reset();
    expect(await tickHandoffAlerts(new Date(Date.now() + 3 * 60_000))).toBeGreaterThanOrEqual(1);
    conv = await convOf(p);
    expect(conv.handoffNotifyAt).toBeInstanceOf(Date);
    expect(toStaff().length).toBeGreaterThanOrEqual(1);
    expect(toStaff()[0].body.text.body).toContain('Motivo: Contato pediu atendimento humano');
  });

  it('"Enviar teste": envia aos números da tela e devolve o resultado por número', async () => {
    const r = await owner.post('/api/org/handoff-notify/test', { phones: ['+5511988880002'] });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.results).toEqual([expect.objectContaining({ phone: '+5511988880002', ok: true, via: 'WhatsApp 1 · Teste' })]);
    expect(toStaff()[0].body.text.body).toMatch(/Teste do aviso de atendimento/);
    expect((await owner.post('/api/org/handoff-notify/test', { phones: ['123'] })).status).toBe(400);
  });

  it('número do próprio WhatsApp conectado: explica que não dá para avisar a si mesmo e manda e-mail ao Proprietário', async () => {
    outbox.length = 0;
    const r = await owner.post('/api/org/handoff-notify/test', { phones: ['+55 11 90000-5300'] });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(false);
    expect(r.body.results[0].self).toBe(true);
    expect(r.body.results[0].error).toMatch(/próprio WhatsApp conectado/);
    expect(r.body.emailed).toBe(1);
    expect(outbox.some((m) => m.kind === 'handoff_alert' && m.to === owner.me.user.email)).toBe(true);
    expect(toStaff()).toHaveLength(0);
    // Mesmo número sem o 9 (contas antigas do WhatsApp) também é reconhecido como o próprio canal.
    const r2 = await owner.post('/api/org/handoff-notify/test', { phones: ['+551100005300'] });
    expect(r2.body.results[0].self).toBe(true);
  });

});
