import { describe, it, expect, beforeAll } from 'vitest';
import { registerClient, loginClient, Client, prisma, uniq } from '../helpers.js';
import { outbox } from '../../server/lib/mailer.js';
import { tickRenewalReminders } from '../../server/billing/reminders.js';

const DAY = 86_400_000;
const PASS = 'senhaSegura123';
// "Agora" fixo no futuro (meio-dia em Brasília) para não esbarrar nas assinaturas dos outros testes.
const NOW = new Date('2031-03-10T15:00:00Z');
const mailsTo = (email: string) => outbox.filter((m) => m.to === email && m.kind === 'renewal_reminder');

async function setSub(orgId: string, product: 'MCKBOT' | 'MCKMENSAGEM', validUntil: Date, status = 'TRIAL') {
  await prisma.subscription.update({ where: { orgId_product: { orgId, product } }, data: { validUntil, status } });
}

describe('Lembrete antes de vencer (teste/plano)', () => {
  let owner: Client; let email: string; let orgId: string;

  beforeAll(async () => {
    email = `${uniq('lemb')}@teste.dev`;
    owner = await registerClient({ email });
    orgId = owner.me.org.id;
    // Fora da janela por padrão (nenhum dos dois produtos perto de vencer).
    await setSub(orgId, 'MCKBOT', new Date(NOW.getTime() + 30 * DAY));
    await setSub(orgId, 'MCKMENSAGEM', new Date(NOW.getTime() + 30 * DAY));
  });

  it('fora da janela de 5 dias não envia', async () => {
    await setSub(orgId, 'MCKBOT', new Date(NOW.getTime() + 6 * DAY));
    await tickRenewalReminders(NOW);
    expect(mailsTo(email)).toHaveLength(0);
  });

  it('teste grátis do MCKBOT: envia 1 e-mail 5 dias antes, com link /plano, e nunca repete', async () => {
    const vu = new Date(NOW.getTime() + 5 * DAY - 60_000);
    await setSub(orgId, 'MCKBOT', vu);
    await tickRenewalReminders(NOW);
    const m = mailsTo(email);
    expect(m).toHaveLength(1);
    expect(m[0].subject).toMatch(/teste grátis do MCKBOT termina em 5 dias/);
    expect(m[0].text).toMatch(/\/plano\b/);
    expect(m[0].text).toMatch(/Brasília/);
    // Próximas rodadas (inclusive mais perto do vencimento) não repetem.
    await tickRenewalReminders(new Date(NOW.getTime() + 15 * 60_000));
    await tickRenewalReminders(new Date(NOW.getTime() + 2 * DAY));
    expect(mailsTo(email)).toHaveLength(1);
    const rows = await prisma.renewalReminder.findMany({ where: { orgId, product: 'MCKBOT' } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'D5', status: 'ENVIADO', channel: 'EMAIL' });
    // Auditoria sem dado pessoal.
    const a = await prisma.auditLog.findFirst({ where: { orgId, action: 'billing.renewal_reminder.sent' } });
    expect(a).toBeTruthy();
    expect(a!.meta).not.toContain(email);
    expect(a!.meta).toContain('MCKBOT');
  });

  it('renovou (novo vencimento): o novo período ganha o seu próprio lembrete', async () => {
    const before = mailsTo(email).length;
    await setSub(orgId, 'MCKBOT', new Date(NOW.getTime() + 35 * DAY), 'ATIVA');
    await tickRenewalReminders(NOW);
    expect(mailsTo(email).length).toBe(before);
    const later = new Date(NOW.getTime() + 31 * DAY);
    await tickRenewalReminders(later);
    const m = mailsTo(email);
    expect(m.length).toBe(before + 1);
    expect(m[m.length - 1].subject).toMatch(/plano do MCKBOT vence em 4 dias/);
    await setSub(orgId, 'MCKBOT', new Date(NOW.getTime() + 300 * DAY), 'ATIVA');
  });

  it('MCK Mensagens: lembrete próprio com link /mensagem/assinatura', async () => {
    await setSub(orgId, 'MCKMENSAGEM', new Date(NOW.getTime() + 3 * DAY), 'ATIVA');
    await tickRenewalReminders(NOW);
    const m = mailsTo(email).filter((x) => /MCK Mensagens/.test(x.subject));
    expect(m).toHaveLength(1);
    expect(m[0].text).toMatch(/\/mensagem\/assinatura/);
    await setSub(orgId, 'MCKMENSAGEM', new Date(NOW.getTime() + 300 * DAY), 'ATIVA');
  });

  it('horário silencioso (21h–8h Brasília): não envia; envia na rodada das 8h', async () => {
    const before = mailsTo(email).length;
    const night = new Date('2031-03-11T01:30:00Z'); // 22h30 em Brasília
    await setSub(orgId, 'MCKBOT', new Date(night.getTime() + 2 * DAY));
    const r = await tickRenewalReminders(night);
    expect(r.quiet).toBe(true);
    await tickRenewalReminders(new Date('2031-03-11T09:00:00Z')); // 6h em Brasília
    expect(mailsTo(email).length).toBe(before);
    await tickRenewalReminders(new Date('2031-03-11T11:00:00Z')); // 8h em Brasília
    expect(mailsTo(email).length).toBe(before + 1);
    await setSub(orgId, 'MCKBOT', new Date(NOW.getTime() + 300 * DAY), 'ATIVA');
  });

  it('vencida ou bloqueada não recebe lembrete', async () => {
    const before = mailsTo(email).length;
    await setSub(orgId, 'MCKBOT', new Date(NOW.getTime() + 2 * DAY), 'BLOQUEADA');
    await setSub(orgId, 'MCKMENSAGEM', new Date(NOW.getTime() - DAY), 'ATIVA');
    await tickRenewalReminders(NOW);
    expect(mailsTo(email).length).toBe(before);
    await setSub(orgId, 'MCKBOT', new Date(NOW.getTime() + 300 * DAY), 'ATIVA');
    await setSub(orgId, 'MCKMENSAGEM', new Date(NOW.getTime() + 300 * DAY), 'ATIVA');
  });

  it('titular desliga no Perfil (padrão ligado) e não recebe; religa e recebe', async () => {
    const me = await owner.get('/api/auth/me');
    expect(me.body.user.renewalReminders).toBe(true);
    expect((await owner.put('/api/profile/reminders', { enabled: false })).status).toBe(200);
    expect((await owner.get('/api/auth/me')).body.user.renewalReminders).toBe(false);
    const before = mailsTo(email).length;
    await setSub(orgId, 'MCKBOT', new Date(NOW.getTime() + 2 * DAY + 7 * 60_000));
    await tickRenewalReminders(NOW);
    expect(mailsTo(email).length).toBe(before);
    expect((await owner.put('/api/profile/reminders', { enabled: true })).status).toBe(200);
    await tickRenewalReminders(NOW);
    expect(mailsTo(email).length).toBe(before + 1);
    expect((await owner.put('/api/profile/reminders', { enabled: 'x' })).status).toBe(400);
    await setSub(orgId, 'MCKBOT', new Date(NOW.getTime() + 300 * DAY), 'ATIVA');
  });

  it('envio que falhou é tentado de novo (máx. 3) e depois para', async () => {
    const vu = new Date(NOW.getTime() + 2 * DAY + 11 * 60_000);
    await prisma.renewalReminder.create({ data: { orgId, product: 'MCKBOT', kind: 'D5', validUntil: vu, status: 'FALHOU', attempts: 1, updatedAt: new Date(NOW.getTime() - 2 * 3600e3) } });
    await setSub(orgId, 'MCKBOT', vu);
    const before = mailsTo(email).length;
    await tickRenewalReminders(NOW);
    expect(mailsTo(email).length).toBe(before + 1);
    const row = await prisma.renewalReminder.findFirstOrThrow({ where: { orgId, product: 'MCKBOT', validUntil: vu } });
    expect(row).toMatchObject({ status: 'ENVIADO', attempts: 2 });
    const vu2 = new Date(vu.getTime() + 60_000);
    await prisma.renewalReminder.create({ data: { orgId, product: 'MCKBOT', kind: 'D5', validUntil: vu2, status: 'FALHOU', attempts: 3 } });
    await setSub(orgId, 'MCKBOT', vu2);
    await tickRenewalReminders(new Date(NOW.getTime() + 3 * 3600e3));
    expect(mailsTo(email).length).toBe(before + 1);
    await setSub(orgId, 'MCKBOT', new Date(NOW.getTime() + 300 * DAY), 'ATIVA');
  });
});

describe('Master → Vencimentos (superadmin)', () => {
  let admin: Client; let owner: Client; let orgId: string; let ownerEmail: string;
  beforeAll(async () => {
    const email = `${uniq('mvenc')}@teste.dev`;
    const first = await registerClient({ email });
    await prisma.user.update({ where: { id: first.me.user.id }, data: { isSuperAdmin: true } });
    admin = (await loginClient(email, PASS)).c;
    ownerEmail = `${uniq('venc')}@teste.dev`;
    owner = await registerClient({ email: ownerEmail, celular: '11987650001' });
    orgId = owner.me.org.id;
  });

  it('só superadmin: OWNER comum recebe 403, sem login 401', async () => {
    expect((await owner.get('/api/master/renewals')).status).toBe(403);
    expect((await new Client().get('/api/master/renewals')).status).toBe(401);
    expect((await admin.get('/api/master/renewals')).status).toBe(200);
  });

  it('cards por produto e listas com contato rápido por WhatsApp', async () => {
    await setSub(orgId, 'MCKBOT', new Date(Date.now() + 100 * DAY), 'ATIVA');
    await setSub(orgId, 'MCKMENSAGEM', new Date(Date.now() + 100 * DAY), 'ATIVA');
    const base = (await admin.get('/api/master/renewals')).body;
    await setSub(orgId, 'MCKBOT', new Date(Date.now() + 3 * DAY), 'ATIVA');
    await setSub(orgId, 'MCKMENSAGEM', new Date(Date.now() - 2 * DAY), 'ATIVA');
    const d = (await admin.get('/api/master/renewals')).body;
    expect(d.counts.MCKBOT.vencendo7d).toBe(base.counts.MCKBOT.vencendo7d + 1);
    expect(d.counts.MCKMENSAGEM.vencidas).toBe(base.counts.MCKMENSAGEM.vencidas + 1);
    for (const k of ['ativas', 'emTeste', 'vencendo7d', 'vencidas', 'bloqueadas']) expect(typeof d.counts.MCKBOT[k]).toBe('number');
    const soon = d.expiringThisWeek.find((x: any) => x.orgId === orgId);
    expect(soon).toMatchObject({ product: 'MCKBOT', status: 'ATIVA', ownerEmail });
    expect(soon.orgName).toBeTruthy();
    expect(soon.whatsappUrl).toMatch(/^https:\/\/wa\.me\/55\d{10,11}\?text=/);
    const past = d.expiredLast7Days.find((x: any) => x.orgId === orgId);
    expect(past).toMatchObject({ product: 'MCKMENSAGEM', status: 'VENCIDA', ownerEmail });
    expect(decodeURIComponent(past.whatsappUrl)).toMatch(/venceu em/);
    // Bloqueada conta no card de bloqueadas.
    await setSub(orgId, 'MCKMENSAGEM', new Date(Date.now() + 100 * DAY), 'BLOQUEADA');
    const d2 = (await admin.get('/api/master/renewals')).body;
    expect(d2.counts.MCKMENSAGEM.bloqueadas).toBe(base.counts.MCKMENSAGEM.bloqueadas + 1);
  });
});
