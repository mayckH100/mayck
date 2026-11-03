import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import bcrypt from 'bcryptjs';
import { registerClient, loginClient, prisma, uniq, createTestChannel, type Client } from '../helpers.js';
import { outbox } from '../../server/lib/mailer.js';
import { tickDownAlerts, maybeDownDigest, BOOT_GRACE_MS, DOWN_GRACE_MS, REMINDER_MS } from '../../server/whatsapp/downAlerts.js';

const MIN = 60_000;
const PASS = 'senhaSegura123';

async function member(orgId: string, role: string, opts: { waDownEmail?: boolean } = {}) {
  const email = `${uniq(role.toLowerCase())}@teste.dev`;
  const u = await prisma.user.create({ data: { email, name: `Membro ${role}`, passwordHash: await bcrypt.hash(PASS, 4), emailVerifiedAt: new Date(), waDownEmail: opts.waDownEmail ?? true } });
  await prisma.membership.create({ data: { userId: u.id, orgId, role } });
  return email;
}
const mailsTo = (email: string, kind?: string) => outbox.filter((m) => m.to === email && (!kind || m.kind === kind));

describe('Alerta de WhatsApp desconectado (integração)', () => {
  let owner: Client & { signup: { email: string } };
  let orgId: string;
  let adminEmail: string, adminOffEmail: string, agentEmail: string;
  let chId: string;
  // Relógio simulado: processo "subiu" há muito tempo (fora da carência de boot).
  const T0 = new Date(Date.now() + 3600_000);
  const at = (ms: number) => new Date(T0.getTime() + ms);
  const boot = { bootAt: new Date(T0.getTime() - 2 * 3600_000) };

  beforeAll(async () => {
    owner = await registerClient();
    orgId = owner.me.org.id;
    adminEmail = await member(orgId, 'ADMIN');
    adminOffEmail = await member(orgId, 'ADMIN', { waDownEmail: false });
    agentEmail = await member(orgId, 'AGENT');
  });

  beforeEach(async () => {
    await prisma.channel.deleteMany({ where: { orgId } }); // cada teste com um único canal
    const { ch } = await createTestChannel(orgId);
    chId = ch.id;
    outbox.length = 0;
  });

  const setStatus = (status: string) => prisma.channel.update({ where: { id: chId }, data: { status } });

  it('alerta uma vez depois de 5 min fora do ar, só para Proprietário/Admin com e-mail ligado', async () => {
    await tickDownAlerts(at(0), boot); // vê conectado: arma
    await setStatus('NOT_CONNECTED');
    await tickDownAlerts(at(MIN), boot); // início do episódio
    await tickDownAlerts(at(MIN + DOWN_GRACE_MS - 1000), boot);
    expect(mailsTo(owner.signup.email, 'wa_down')).toHaveLength(0);
    await tickDownAlerts(at(MIN + DOWN_GRACE_MS), boot);
    await tickDownAlerts(at(MIN + DOWN_GRACE_MS + MIN), boot); // dedup
    await tickDownAlerts(at(3 * 3600_000), boot);
    const own = mailsTo(owner.signup.email, 'wa_down');
    expect(own).toHaveLength(1);
    expect(own[0].subject).toContain('WhatsApp');
    expect(own[0].text).toContain('/canais');
    expect(mailsTo(adminEmail, 'wa_down')).toHaveLength(1);
    expect(mailsTo(adminOffEmail)).toHaveLength(0);
    expect(mailsTo(agentEmail)).toHaveLength(0);
    // Lembrete único após 24 h.
    await tickDownAlerts(at(MIN + DOWN_GRACE_MS + REMINDER_MS), boot);
    await tickDownAlerts(at(MIN + DOWN_GRACE_MS + 3 * REMINDER_MS), boot);
    expect(mailsTo(owner.signup.email, 'wa_down_reminder')).toHaveLength(1);
    // Aviso no app.
    const r = await owner.get('/api/channels/alertas');
    expect(r.status).toBe(200);
    expect(r.body.down.map((d: any) => d.id)).toContain(chId);
    // Volta: "voltou a conectar" só no app, sem e-mail.
    await setStatus('CONNECTED');
    const before = outbox.length;
    await tickDownAlerts(at(2 * REMINDER_MS), boot);
    expect(outbox.length).toBe(before);
    const ch = await prisma.channel.findUniqueOrThrow({ where: { id: chId } });
    expect(ch.waDownAlertAt).toBeNull();
    expect(ch.waBackAt).not.toBeNull();
    const list = await owner.get('/api/channels');
    expect(list.body.find((c: any) => c.id === chId).downAlert.backAt).not.toBeNull();
  });

  it('reconexão rápida não alerta', async () => {
    await tickDownAlerts(at(0), boot);
    await setStatus('CONNECTING');
    await tickDownAlerts(at(MIN), boot);
    await setStatus('CONNECTED');
    await tickDownAlerts(at(3 * MIN), boot);
    await setStatus('NOT_CONNECTED');
    await tickDownAlerts(at(4 * MIN), boot);
    await tickDownAlerts(at(4 * MIN + DOWN_GRACE_MS - 1000), boot);
    expect(mailsTo(owner.signup.email)).toHaveLength(0);
  });

  it('reinício/deploy: carência no boot e episódio herdado recomeça a contagem', async () => {
    await tickDownAlerts(at(0), boot);
    await setStatus('CONNECTING');
    await tickDownAlerts(at(MIN), boot); // processo antigo marcou o início
    // Novo processo sobe em at(4 min): durante a carência não faz nada.
    const novo = { bootAt: at(4 * MIN) };
    await tickDownAlerts(at(4 * MIN + BOOT_GRACE_MS - 1000), novo);
    await tickDownAlerts(at(8 * MIN), novo); // fora da carência: recomeça a contagem (não alerta, apesar de 7 min)
    expect(mailsTo(owner.signup.email)).toHaveLength(0);
    await setStatus('CONNECTED'); // sessão restaurada
    await tickDownAlerts(at(9 * MIN), novo);
    expect(mailsTo(owner.signup.email)).toHaveLength(0);
    const ch = await prisma.channel.findUniqueOrThrow({ where: { id: chId } });
    expect(ch.waDownSince).toBeNull();
    expect(ch.waBackAt).toBeNull();
  });

  it('desconectar de propósito (botão) desarma: não alerta', async () => {
    await tickDownAlerts(at(0), boot);
    const r = await owner.post(`/api/channels/${chId}/disconnect`);
    expect(r.status).toBe(200);
    await tickDownAlerts(at(MIN), boot);
    await tickDownAlerts(at(MIN + DOWN_GRACE_MS + MIN), boot);
    expect(mailsTo(owner.signup.email)).toHaveLength(0);
  });

  it('permissões: /channels/alertas só Proprietário/Administrador; opção no Perfil', async () => {
    const ag = (await loginClient(agentEmail, PASS)).c;
    expect((await ag.get('/api/channels/alertas')).status).toBe(403);
    const ad = (await loginClient(adminEmail, PASS)).c;
    expect((await ad.get('/api/channels/alertas')).status).toBe(200);
    // Outra organização não vê os alertas desta.
    const other = await registerClient();
    const r = await other.get('/api/channels/alertas');
    expect(r.status).toBe(200);
    expect(r.body.down.find((d: any) => d.id === chId)).toBeUndefined();
    // Opt-out no Perfil (padrão ligado).
    expect((await owner.get('/api/auth/me')).body.user.waDownEmail).toBe(true);
    const off = await owner.put('/api/profile/alertas', { waDownEmail: false });
    expect(off.status).toBe(200);
    expect(off.body.waDownEmail).toBe(false);
    await tickDownAlerts(at(0), boot);
    await setStatus('NOT_CONNECTED');
    await tickDownAlerts(at(MIN), boot);
    await tickDownAlerts(at(MIN + DOWN_GRACE_MS), boot);
    expect(mailsTo(owner.signup.email)).toHaveLength(0);
    expect(mailsTo(adminEmail, 'wa_down')).toHaveLength(1);
    await owner.put('/api/profile/alertas', { waDownEmail: true });
  });

  it('resumo diário para SUPERADMIN_EMAILS: canais fora do ar > 1 h, uma vez por dia', async () => {
    const prev = process.env.SUPERADMIN_EMAILS;
    process.env.SUPERADMIN_EMAILS = 'super-resumo@teste.dev';
    try {
      await prisma.channel.update({ where: { id: chId }, data: { status: 'NOT_CONNECTED', waUpSeenAt: new Date(), waDownSince: new Date(Date.now() - 2 * 3600_000), waDownAlertAt: new Date() } });
      await prisma.platformSettings.upsert({ where: { id: 'default' }, create: { id: 'default' }, update: { waDigestDay: null } });
      const noon = new Date('2030-01-15T15:00:00Z'); // 12h em Brasília
      const early = new Date('2030-01-15T09:00:00Z'); // 6h em Brasília
      expect(await maybeDownDigest(early)).toBe(false);
      expect(await maybeDownDigest(noon)).toBe(true);
      expect(await maybeDownDigest(new Date(noon.getTime() + 3600_000))).toBe(false);
      const m = mailsTo('super-resumo@teste.dev', 'wa_down_digest');
      expect(m).toHaveLength(1);
      expect(m[0].text).toContain(owner.me.org.name);
    } finally {
      process.env.SUPERADMIN_EMAILS = prev;
    }
  });
});
