import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { isQuietHours, inReminderWindow, reminderDays, reminderKind, spDateLabel, whenLabel, renewUrl } from '../../server/billing/reminders.js';
import { waLink } from '../../server/routes/master.js';

const DAY = 86_400_000;
// Brasília = UTC-3 (sem horário de verão desde 2019).
const sp = (iso: string) => new Date(`${iso}-03:00`);

describe('Lembrete de vencimento: regras puras', () => {
  it('padrão: um único lembrete 5 dias antes (constante configurável)', () => {
    expect(reminderDays()).toBe(5);
    expect(reminderKind()).toBe('D5');
    expect(reminderKind(3)).toBe('D3');
  });

  it('janela: falta mais que 0 e no máximo N dias', () => {
    const now = sp('2030-01-15T12:00:00');
    expect(inReminderWindow(new Date(now.getTime() + 5 * DAY), now)).toBe(true);
    expect(inReminderWindow(new Date(now.getTime() + 5 * DAY + 60_000), now)).toBe(false);
    expect(inReminderWindow(new Date(now.getTime() + 60_000), now)).toBe(true);
    expect(inReminderWindow(now, now)).toBe(false); // já venceu: tolerância 0, não lembra
    expect(inReminderWindow(new Date(now.getTime() - DAY), now)).toBe(false);
  });

  it('horário silencioso 21h–8h em Brasília (independe do fuso do servidor)', () => {
    expect(isQuietHours(sp('2030-01-15T20:59:00'))).toBe(false);
    expect(isQuietHours(sp('2030-01-15T21:00:00'))).toBe(true);
    expect(isQuietHours(sp('2030-01-16T03:00:00'))).toBe(true);
    expect(isQuietHours(sp('2030-01-16T07:59:00'))).toBe(true);
    expect(isQuietHours(sp('2030-01-16T08:00:00'))).toBe(false);
    // 23h UTC = 20h em Brasília (permitido); 00h UTC = 21h (silêncio)
    expect(isQuietHours(new Date('2030-01-15T23:00:00Z'))).toBe(false);
    expect(isQuietHours(new Date('2030-01-16T00:00:00Z'))).toBe(true);
  });

  it('datas em Brasília: rótulo e dias de calendário', () => {
    expect(spDateLabel(new Date('2030-01-21T02:59:00Z'))).toBe('20/01/2030 às 23:59');
    const now = sp('2030-01-15T12:00:00');
    expect(whenLabel(sp('2030-01-20T23:59:00'), now)).toBe('em 5 dias');
    expect(whenLabel(sp('2030-01-16T01:00:00'), now)).toBe('amanhã');
    expect(whenLabel(sp('2030-01-15T23:00:00'), now)).toBe('hoje');
  });

  it('links de renovação por produto', () => {
    expect(renewUrl('MCKBOT')).toMatch(/\/plano$/);
    expect(renewUrl('MCKMENSAGEM')).toMatch(/\/mensagem\/assinatura$/);
  });

  it('wa.me: DDI 55 para número sem DDI, nulo sem telefone', () => {
    expect(waLink('+55 (11) 91234-5678', 'oi')).toBe('https://wa.me/5511912345678?text=oi');
    expect(waLink('11912345678', 'olá mundo')).toBe('https://wa.me/5511912345678?text=ol%C3%A1%20mundo');
    expect(waLink(null, 'x')).toBeNull();
    expect(waLink('123', 'x')).toBeNull();
  });
});

describe('Lembrete de vencimento: migração', () => {
  const dir = readdirSync('prisma/migrations').find((d) => /^\d{4}_lembretes_vencimento$/.test(d));
  it('existe, é só aditiva e bate com o schema', () => {
    expect(dir).toBeTruthy();
    const code = readFileSync(`prisma/migrations/${dir}/migration.sql`, 'utf8').split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
    expect(code).not.toMatch(/\b(DROP|DELETE|UPDATE|TRUNCATE|RENAME)\b/i);
    expect(code).toMatch(/ALTER TABLE "User" ADD COLUMN "renewalReminders" BOOLEAN NOT NULL DEFAULT true/);
    expect(code).toMatch(/CREATE TABLE "RenewalReminder"/);
    expect(code).toMatch(/UNIQUE INDEX "RenewalReminder_orgId_product_kind_validUntil_key"/);
    const schema = readFileSync('prisma/schema.prisma', 'utf8');
    expect(schema).toMatch(/model RenewalReminder \{/);
    expect(schema).toMatch(/@@unique\(\[orgId, product, kind, validUntil\]\)/);
  });
});
