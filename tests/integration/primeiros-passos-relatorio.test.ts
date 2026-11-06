import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { registerClient, Client, createTestChannel, prisma } from '../helpers.js';
import { outbox } from '../../server/lib/mailer.js';
import { tickWeeklyReport, previousWeek } from '../../server/lib/weeklyReport.js';

/** Próxima segunda-feira às 09:00 de Brasília (a semana anterior a ela é a semana atual). */
function nextMonday9() {
  const now = new Date();
  const day = now.toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
  const dow = new Date(`${day}T12:00:00Z`).getUTCDay();
  const add = ((8 - dow) % 7) || 7;
  const monday = new Date(new Date(`${day}T12:00:00Z`).getTime() + add * 86_400_000).toISOString().slice(0, 10);
  return new Date(`${monday}T12:00:00Z`); // 09:00 BRT
}

describe('Primeiros passos (conta nova)', () => {
  let owner: Client;
  let orgId: string;
  beforeAll(async () => { owner = await registerClient(); orgId = owner.me.org.id; });

  it('detecta o estado real de cada passo', async () => {
    let r = await owner.get('/api/dashboard/primeiros-passos');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ steps: { whatsapp: false, instrucoes: false, teste: false }, done: false });

    await owner.put('/api/ai/settings', { instructions: 'Somos a [preencha: nome], atendemos em [preencha: cidade].' });
    r = await owner.get('/api/dashboard/primeiros-passos');
    expect(r.body.steps.instrucoes).toBe(false);
    expect(r.body.placeholders).toBe(2);

    await owner.put('/api/ai/settings', { instructions: 'Somos a Loja Teste, atendemos em Carapicuíba das 9 às 18.' });
    await createTestChannel(orgId);
    await prisma.aiUsage.create({ data: { orgId, conversationId: '', provider: 'fake', model: 'fake-1', success: true } });
    r = await owner.get('/api/dashboard/primeiros-passos');
    expect(r.body).toMatchObject({ steps: { whatsapp: true, instrucoes: true, teste: true }, placeholders: 0, done: true });
  });
});

describe('Resumo semanal por e-mail', () => {
  let owner: Client;
  let quiet: Client;
  let off: Client;
  const env = { SMTP_HOST: process.env.SMTP_HOST, MAIL_FROM: process.env.MAIL_FROM };

  async function movimento(c: Client) {
    const orgId = c.me.org.id;
    const n = `5511${Math.floor(900000000 + Math.random() * 99999999)}`;
    const contact = await prisma.contact.create({ data: { orgId, waId: n, phone: `+${n}`, name: 'Cliente' } });
    const conv = await prisma.conversation.create({ data: { orgId, contactId: contact.id } });
    await prisma.message.create({ data: { orgId, conversationId: conv.id, direction: 'OUT', sender: 'ai', body: 'Olá!', status: 'SENT' } });
    await prisma.message.create({ data: { orgId, conversationId: conv.id, direction: 'INTERNAL', sender: 'system', type: 'note', body: 'Transferido para atendimento humano: pediu', status: 'NOTE' } });
    await prisma.aiUsage.create({ data: { orgId, conversationId: conv.id, provider: 'mck', model: 'mck-ia', success: true } });
  }

  beforeAll(async () => {
    process.env.SMTP_HOST = 'smtp.teste.invalid';
    process.env.MAIL_FROM = 'MCK <nao-responda@teste.dev>';
    owner = await registerClient(); quiet = await registerClient(); off = await registerClient();
    await movimento(owner); await movimento(off);
    const r = await off.put('/api/profile/relatorio-semanal', { enabled: false });
    expect(r.body.weeklyReport).toBe(false);
    expect((await off.get('/api/auth/me')).body.user.weeklyReport).toBe(false);
  });
  afterAll(() => {
    for (const [k, v] of Object.entries(env)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });

  it('segunda 9h: envia uma vez ao Proprietário com os números; respeita quem desligou e pula empresa sem movimento', async () => {
    const now = nextMonday9();
    outbox.length = 0;
    await tickWeeklyReport(now);
    const mine = outbox.filter((m) => m.kind === 'weekly_report' && m.to === owner.me.user.email);
    expect(mine).toHaveLength(1);
    expect(mine[0].text).toMatch(/Conversas atendidas: 1/);
    expect(mine[0].text).toMatch(/Respostas da IA: 1/);
    expect(mine[0].text).toMatch(/Transferências para humano: 1/);
    expect(outbox.some((m) => m.to === off.me.user.email)).toBe(false);
    expect(outbox.some((m) => m.to === quiet.me.user.email)).toBe(false);
    const a = await prisma.auditLog.findFirst({ where: { orgId: owner.me.org.id, action: 'report.weekly.sent', entityId: previousWeek(now).key } });
    expect(a).toBeTruthy();

    outbox.length = 0;
    await tickWeeklyReport(new Date(now.getTime() + 15 * 60_000));
    expect(outbox.filter((m) => m.to === owner.me.user.email)).toHaveLength(0); // não repete na mesma semana
  });

  it('fora da janela (terça) ou desligado por variável: não envia', async () => {
    outbox.length = 0;
    const terca = new Date(nextMonday9().getTime() + 86_400_000);
    expect((await tickWeeklyReport(terca)).sent).toBe(0);
    process.env.WEEKLY_REPORT_ENABLED = 'false';
    try { expect((await tickWeeklyReport(new Date(nextMonday9().getTime() + 7 * 86_400_000))).sent).toBe(0); } finally { delete process.env.WEEKLY_REPORT_ENABLED; }
  });
});
