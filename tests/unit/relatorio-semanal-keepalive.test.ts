import { describe, it, expect } from 'vitest';
import { previousWeek, isSendWindow, weeklyReportEnabled } from '../../server/lib/weeklyReport.js';
import { keepAliveUrl } from '../../server/lib/keepAlive.js';
import { weeklyReportMail } from '../../server/lib/mailer.js';

describe('Relatório semanal (regras puras)', () => {
  it('semana anterior: segunda 00:00 a domingo 23:59 de Brasília', () => {
    const w = previousWeek(new Date('2026-11-09T11:00:00Z')); // segunda 08:00 BRT
    expect(w.key).toBe('2026-11-02');
    expect(w.ini.toISOString()).toBe('2026-11-02T03:00:00.000Z');
    expect(w.fim.toISOString()).toBe('2026-11-09T03:00:00.000Z');
    expect(w.label).toBe('02/11 a 08/11/2026');
    expect(previousWeek(new Date('2026-11-05T23:52:00Z')).key).toBe('2026-10-26'); // quinta → semana anterior
  });
  it('janela de envio: segunda a partir das 8h (Brasília) e antes das 21h', () => {
    expect(isSendWindow(new Date('2026-11-09T10:59:00Z'))).toBe(false); // 07:59
    expect(isSendWindow(new Date('2026-11-09T11:00:00Z'))).toBe(true); // 08:00
    expect(isSendWindow(new Date('2026-11-10T11:00:00Z'))).toBe(false); // terça
    expect(isSendWindow(new Date('2026-11-10T00:30:00Z'))).toBe(false); // segunda 21:30
  });
  it('desligar para todos com WEEKLY_REPORT_ENABLED=false; e-mail sem dados de cliente', () => {
    expect(weeklyReportEnabled({})).toBe(true);
    expect(weeklyReportEnabled({ WEEKLY_REPORT_ENABLED: 'false' })).toBe(false);
    const m = weeklyReportMail({ to: 'dono@teste.dev', name: 'Ana', orgName: 'Loja X', periodLabel: '02/11 a 08/11/2026', conversas: 12, respostasIa: 40, transferencias: 3, leadsQualificados: 2 });
    expect(m.text).toMatch(/Conversas atendidas: 12/);
    expect(m.text).toMatch(/Respostas da IA: 40/);
    expect(m.text).toMatch(/Transferências para humano: 3/);
    expect(m.text).toMatch(/Leads qualificados: 2/);
    expect(m.kind).toBe('weekly_report');
  });
});

describe('App acordado (keep-alive)', () => {
  it('roda em produção sempre que houver URL pública, com ou sem WhatsApp por QR', () => {
    expect(keepAliveUrl({ NODE_ENV: 'production', RENDER_EXTERNAL_URL: 'https://app.exemplo.dev/', ENABLE_WHATSAPP_QR: 'false' })).toBe('https://app.exemplo.dev/api/health');
    expect(keepAliveUrl({ NODE_ENV: 'production', PUBLIC_URL: 'https://a.dev', RENDER_EXTERNAL_URL: 'https://b.dev' })).toBe('https://a.dev/api/health');
    expect(keepAliveUrl({ NODE_ENV: 'production' })).toBeNull();
    expect(keepAliveUrl({ NODE_ENV: 'development', PUBLIC_URL: 'https://a.dev' })).toBeNull();
    expect(keepAliveUrl({ NODE_ENV: 'production', PUBLIC_URL: 'https://a.dev', KEEP_ALIVE: 'false' })).toBeNull();
  });
});
