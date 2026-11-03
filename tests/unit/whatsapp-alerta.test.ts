import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { decideDown, DOWN_GRACE_MS, REMINDER_MS } from '../../server/whatsapp/downAlerts.js';

const T0 = new Date('2026-11-02T12:00:00Z');
const at = (ms: number) => new Date(T0.getTime() + ms);
const MIN = 60_000;
const base = { status: 'CONNECTED', waUpSeenAt: null, waDownSince: null, waDownAlertAt: null, waDownReminderAt: null, waBackAt: null } as const;
const boot = at(-3600_000);

describe('Alerta de WhatsApp desconectado — regra (decideDown)', () => {
  it('conectado: arma o canal (waUpSeenAt) e não alerta', () => {
    const d = decideDown({ ...base }, T0, boot);
    expect(d.action).toBeNull();
    expect(d.patch.waUpSeenAt).toEqual(T0);
  });

  it('nunca visto conectado (ou desarmado): não marca nem alerta', () => {
    expect(decideDown({ ...base, status: 'QR_PENDING' }, T0, boot)).toEqual({ patch: {}, action: null });
  });

  it('debounce: marca o início, não alerta antes de 5 min, alerta depois', () => {
    const armed = { ...base, waUpSeenAt: at(-MIN) };
    const d1 = decideDown({ ...armed, status: 'NOT_CONNECTED' }, T0, boot);
    expect(d1).toEqual({ patch: { waDownSince: T0 }, action: null });
    const d2 = decideDown({ ...armed, status: 'CONNECTING', waDownSince: T0 }, at(DOWN_GRACE_MS - 1000), boot);
    expect(d2.action).toBeNull();
    const d3 = decideDown({ ...armed, status: 'NOT_CONNECTED', waDownSince: T0 }, at(DOWN_GRACE_MS), boot);
    expect(d3.action).toBe('alert');
    expect(d3.patch.waDownAlertAt).toEqual(at(DOWN_GRACE_MS));
  });

  it('reconexão rápida: limpa o episódio sem alerta e sem "voltou a conectar"', () => {
    const d = decideDown({ ...base, waUpSeenAt: at(-MIN), waDownSince: at(-2 * MIN) }, T0, boot);
    expect(d.action).toBeNull();
    expect(d.patch).toMatchObject({ waDownSince: null, waDownAlertAt: null });
    expect(d.patch.waBackAt).toBeUndefined();
  });

  it('dedup: depois do alerta, nada até 24 h; lembrete único após 24 h', () => {
    const alerted = { ...base, status: 'NOT_CONNECTED', waUpSeenAt: at(-MIN), waDownSince: T0, waDownAlertAt: at(DOWN_GRACE_MS) };
    expect(decideDown(alerted, at(2 * 3600_000), boot).action).toBeNull();
    const r = decideDown(alerted, at(DOWN_GRACE_MS + REMINDER_MS), boot);
    expect(r.action).toBe('reminder');
    expect(decideDown({ ...alerted, waDownReminderAt: at(DOWN_GRACE_MS + REMINDER_MS) }, at(DOWN_GRACE_MS + 3 * REMINDER_MS), boot).action).toBeNull();
  });

  it('voltou depois do alerta: "back" e limpa o episódio', () => {
    const d = decideDown({ ...base, status: 'CONNECTED', waUpSeenAt: at(-MIN), waDownSince: at(-60 * MIN), waDownAlertAt: at(-50 * MIN) }, T0, boot);
    expect(d.action).toBe('back');
    expect(d.patch).toMatchObject({ waDownSince: null, waDownAlertAt: null, waDownReminderAt: null, waBackAt: T0 });
  });

  it('reinício/deploy: episódio iniciado antes do processo subir recomeça a contagem', () => {
    const bootAt = at(-MIN);
    const d = decideDown({ ...base, status: 'CONNECTING', waUpSeenAt: at(-20 * MIN), waDownSince: at(-10 * MIN) }, T0, bootAt);
    expect(d).toEqual({ patch: { waDownSince: T0 }, action: null });
  });

  it('reinício não duplica: episódio já alertado antes do reinício continua sem novo alerta', () => {
    const d = decideDown({ ...base, status: 'NOT_CONNECTED', waUpSeenAt: at(-60 * MIN), waDownSince: at(-40 * MIN), waDownAlertAt: at(-35 * MIN) }, T0, at(-MIN));
    expect(d.action).toBeNull();
  });
});

describe('Alerta de WhatsApp desconectado — migração', () => {
  it('é só aditiva (ADD COLUMN opcional ou com padrão)', () => {
    const dir = readdirSync('prisma/migrations').find((d) => /^\d{4}_alerta_whatsapp$/.test(d));
    expect(dir).toBeTruthy();
    const code = readFileSync(`prisma/migrations/${dir}/migration.sql`, 'utf8').split('\n').filter((l) => l.trim() && !l.trim().startsWith('--'));
    expect(code.length).toBe(7);
    for (const l of code) expect(l).toMatch(/^ALTER TABLE "(Channel|User|PlatformSettings)" ADD COLUMN "\w+" (TIMESTAMP\(3\)|TEXT|BOOLEAN NOT NULL DEFAULT true);$/);
  });
});
