import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { registerClient, Client, createTestChannel, installGraphMock, graph, sendInbound, prisma } from '../helpers.js';
import { fakeAi } from '../../server/ai/providers.js';
import { SECOND_FAILURE_TEXT } from '../../server/ai/failurePolicy.js';
import { flushStaffAlerts, resetAiFailureAlerts } from '../../server/whatsapp/staffAlerts.js';
import { outbox } from '../../server/lib/mailer.js';

/**
 * Falha de 2026-11-04 (forza seguros, 13:57/13:59): Gemini sobrecarregado (HTTP 503 "high demand" e timeouts),
 * duas tentativas no MESMO modelo, e o cliente recebeu duas vezes seguidas o mesmo texto de falha, sem ninguém avisado.
 */
const FAIL = 'Desculpe, não consegui responder agora.';
const AVISO = '5511955559001';
const sent = () => graph.calls.filter((c) => c.body?.to).map((c) => ({ to: String(c.body.to), text: String(c.body.text?.body ?? '') }));
const toClient = (p: string) => sent().filter((m) => m.to === p).map((m) => m.text);
const toStaff = () => sent().filter((m) => m.to === AVISO).map((m) => m.text);

describe('IA: modelo reserva, falha sem repetir e alerta ao Proprietário', () => {
  let owner: Client;
  let orgId: string;
  let ctx: Awaited<ReturnType<typeof createTestChannel>>;
  let phone = 5511720000000;
  const nextPhone = () => String(++phone);
  const env = { ...process.env };

  beforeAll(async () => {
    process.env.AI_TIMEOUT_MS = '300';
    process.env.AI_TOTAL_TIMEOUT_MS = '3000';
    process.env.AI_RETRY_BACKOFF_MS = '10';
    process.env.AI_FALLBACK_MODEL = 'fake-reserva';
    installGraphMock();
    owner = await registerClient();
    orgId = owner.me.org.id;
    ctx = await createTestChannel(orgId);
    await prisma.channel.update({ where: { id: ctx.ch.id }, data: { displayPhone: '+5511900009400' } });
    const r = await owner.put('/api/ai/settings', { provider: 'fake', model: 'fake-1', enabled: true, autoReply: true, failureMessage: FAIL });
    expect(r.status).toBe(200);
    const o = await owner.patch('/api/org', { handoffNotifyPhones: [`+${AVISO}`] });
    expect(o.status).toBe(200);
  });
  afterAll(async () => {
    for (const k of ['AI_TIMEOUT_MS', 'AI_TOTAL_TIMEOUT_MS', 'AI_RETRY_BACKOFF_MS', 'AI_FALLBACK_MODEL']) { if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k]; }
    await prisma.organization.update({ where: { id: orgId }, data: { handoffNotifyPhones: '[]', backupPhone: null } });
    await prisma.conversation.updateMany({ where: { orgId }, data: { waitingSince: null, mode: 'BOT', status: 'CLOSED' } });
  });
  beforeEach(() => { graph.reset(); fakeAi.script = []; fakeAi.calls = []; fakeAi.models = []; resetAiFailureAlerts(); });

  it('503 no modelo principal → responde pelo modelo reserva (cliente não vê falha)', async () => {
    fakeAi.script = ['__503__', 'Claro! Explico sim: o seguro cobre…'];
    const p = nextPhone();
    await sendInbound(ctx, p, 'Pode me explicar, por favor');
    expect(toClient(p)).toEqual(['Claro! Explico sim: o seguro cobre…']);
    expect(fakeAi.models).toEqual(['fake-1', 'fake-reserva']);
    const u = await prisma.aiUsage.findFirst({ where: { orgId, success: true }, orderBy: { createdAt: 'desc' } });
    expect(u!.model).toBe('fake-reserva');
  });

  it('timeout no principal e no reserva → 3ª tentativa no principal responde', async () => {
    fakeAi.script = ['__HANG__', '__HANG__', 'Respondendo agora.'];
    const p = nextPhone();
    await sendInbound(ctx, p, 'oi, tudo bem?');
    expect(toClient(p)).toEqual(['Respondendo agora.']);
    expect(fakeAi.models).toEqual(['fake-1', 'fake-reserva', 'fake-1']);
  });

  it('bloqueio (não passageiro) não gasta a 3ª tentativa', async () => {
    fakeAi.script = ['__SAFETY__', '__SAFETY__', 'não deveria chegar aqui'];
    const p = nextPhone();
    await sendInbound(ctx, p, 'oi');
    expect(fakeAi.models).toEqual(['fake-1', 'fake-reserva']);
    expect(toClient(p)).toEqual([FAIL]);
    await flushStaffAlerts();
  });

  it('falhas seguidas: 1ª texto de falha, 2ª texto de instabilidade, 3ª nada; dono avisado 1x (WhatsApp + e-mail)', async () => {
    const p = nextPhone();
    const mails0 = outbox.length;
    fakeAi.script = ['__503__', '__503__', '__503__'];
    await sendInbound(ctx, p, 'Pode me explicar, por favor');
    await flushStaffAlerts();
    fakeAi.script = ['__503__', '__503__', '__503__'];
    await sendInbound(ctx, p, 'Respondi, mas as mensagens automáticas não compreendem');
    await flushStaffAlerts();
    fakeAi.script = ['__503__', '__503__', '__503__'];
    await sendInbound(ctx, p, 'alô?');
    await flushStaffAlerts();
    expect(toClient(p)).toEqual([FAIL, SECOND_FAILURE_TEXT]);

    const staff = toStaff();
    expect(staff).toHaveLength(1);
    expect(staff[0]).toMatch(/^⚠️ A IA não conseguiu responder um cliente/);
    expect(staff[0]).toMatch(new RegExp(`Contato: .*${p.slice(-8)}`));
    expect(staff[0]).toMatch(/Motivo: Falha no provedor de IA \(This model is currently experiencing high demand/);
    expect(staff[0]).toMatch(/Quando: \d{2}\/\d{2}\/\d{4} às \d{2}:\d{2} \(horário de Brasília\)/);
    expect(staff[0]).toMatch(/Abrir conversa: .*\/inbox\//);
    const mails = outbox.slice(mails0).filter((m) => /^Falha da IA/.test(m.subject));
    expect(mails).toHaveLength(1);
    expect(mails[0].to).toBe(owner.me.user.email);

    const c = await prisma.contact.findFirstOrThrow({ where: { orgId, waId: p } });
    const conv = await prisma.conversation.findFirstOrThrow({ where: { contactId: c.id } });
    expect(conv.mode).toBe('BOT'); // não transfere sozinho
    const notes = await prisma.message.findMany({ where: { conversationId: conv.id, direction: 'INTERNAL' }, orderBy: { createdAt: 'asc' } });
    expect(notes.at(-1)!.body).toMatch(/Nada enviado ao cliente/);
  });

  it('opção "Falha da IA" desligada no Perfil → não avisa; religada → avisa', async () => {
    let r = await owner.get('/api/org/handoff-notify');
    expect(r.body.alerts.aiFailure).toBe(true);
    await owner.patch('/api/org', { alertAiFailure: false });
    r = await owner.get('/api/org/handoff-notify');
    expect(r.body.alerts.aiFailure).toBe(false);
    fakeAi.script = ['__503__', '__503__', '__503__'];
    const p = nextPhone();
    await sendInbound(ctx, p, 'oi');
    await flushStaffAlerts();
    expect(toClient(p)).toEqual([FAIL]);
    expect(toStaff()).toHaveLength(0);
    await owner.patch('/api/org', { alertAiFailure: true });
  });

  it('"Testar" no painel da IA não gera alerta nem muda o texto', async () => {
    fakeAi.script = ['__503__', '__503__', '__503__'];
    const r = await owner.post('/api/ai/test', { message: 'oi' });
    await flushStaffAlerts();
    expect(r.body).toMatchObject({ text: FAIL, failed: true });
    expect(toStaff()).toHaveLength(0);
  });
});
