import { describe, it, expect } from 'vitest';
import { parseLocal, zonedToUtc, toLocalIso, humanPt, zonedParts } from '../../server/agenda/time.js';
import { buildIcs, googleAddLink, publicEventToken, verifyPublicEventToken, icsDate } from '../../server/agenda/ics.js';
import { makeState, readState, authUrl } from '../../server/agenda/google.js';

describe('Agenda: fuso horário', () => {
  it('converte hora local de São Paulo (UTC-3) para UTC e volta', () => {
    const d = parseLocal('2026-11-03T14:00', 'America/Sao_Paulo')!;
    expect(d.toISOString()).toBe('2026-11-03T17:00:00.000Z');
    expect(toLocalIso(d, 'America/Sao_Paulo')).toBe('2026-11-03T14:00');
    expect(humanPt(d, 'America/Sao_Paulo')).toBe('terça, 03/11 às 14:00');
    expect(zonedParts(d, 'America/Sao_Paulo').weekday).toBe(2);
  });
  it('respeita horário de verão em outros fusos (Nova York)', () => {
    expect(zonedToUtc(2026, 7, 1, 9, 0, 'America/New_York').toISOString()).toBe('2026-07-01T13:00:00.000Z');
    expect(zonedToUtc(2026, 12, 1, 9, 0, 'America/New_York').toISOString()).toBe('2026-12-01T14:00:00.000Z');
  });
  it('aceita ISO com fuso e recusa lixo', () => {
    expect(parseLocal('2026-11-03T17:00:00Z', 'America/Sao_Paulo')!.toISOString()).toBe('2026-11-03T17:00:00.000Z');
    expect(parseLocal('amanhã às 3', 'America/Sao_Paulo')).toBeNull();
    expect(parseLocal('2026-13-03T14:00', 'America/Sao_Paulo')).toBeNull();
  });
});

describe('Agenda: iCalendar e links', () => {
  const ev = { id: 'cmabc1234567890', title: 'Reunião, com; vírgula', description: 'Linha 1\nLinha 2', location: 'Rua A, 10', startAt: new Date('2026-11-03T17:00:00Z'), durationMin: 45, reminderMin: 30, status: 'SCHEDULED', sequence: 2, updatedAt: new Date('2026-10-30T12:00:00Z') };
  it('gera .ics válido com alarme, sequência e escapes', () => {
    const ics = buildIcs([ev], { name: 'Agenda Teste' });
    expect(ics).toContain('BEGIN:VCALENDAR\r\n');
    expect(ics).toContain('UID:cmabc1234567890@mckbot');
    expect(ics).toContain('DTSTART:20261103T170000Z');
    expect(ics).toContain('DTEND:20261103T174500Z');
    expect(ics).toContain('SEQUENCE:2');
    expect(ics).toContain('SUMMARY:Reunião\\, com\\; vírgula');
    expect(ics).toContain('DESCRIPTION:Linha 1\\nLinha 2');
    expect(ics).toContain('TRIGGER:-PT30M');
    expect(ics).toContain('X-WR-CALNAME:Agenda Teste');
    for (const line of ics.split('\r\n')) expect(Buffer.byteLength(line)).toBeLessThanOrEqual(75);
  });
  it('evento cancelado sai com STATUS:CANCELLED e sem alarme', () => {
    const ics = buildIcs([{ ...ev, status: 'CANCELLED' }]);
    expect(ics).toContain('STATUS:CANCELLED');
    expect(ics).not.toContain('VALARM');
  });
  it('link do Google Agenda tem datas em UTC', () => {
    const u = new URL(googleAddLink(ev));
    expect(u.hostname).toBe('calendar.google.com');
    expect(u.searchParams.get('dates')).toBe(`${icsDate(ev.startAt)}/20261103T174500Z`);
    expect(u.searchParams.get('text')).toBe(ev.title);
  });
  it('token público do evento é assinado e não aceita adulteração', () => {
    const t = publicEventToken('cmabc1234567890');
    expect(verifyPublicEventToken(t)).toBe('cmabc1234567890');
    expect(verifyPublicEventToken(t.replace('cmabc', 'cmabd'))).toBeNull();
    expect(verifyPublicEventToken('cmabc1234567890.xxxx')).toBeNull();
    expect(verifyPublicEventToken('')).toBeNull();
  });
});

describe('Agenda: OAuth do Google', () => {
  it('state assinado identifica usuário/empresa e rejeita adulteração', () => {
    const s = makeState('user1', 'org1', 'mckbot');
    expect(readState(s)).toMatchObject({ u: 'user1', o: 'org1', a: 'mckbot' });
    const [body, sig] = s.split('.');
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url').toString()), u: 'hacker' })).toString('base64url');
    expect(readState(`${forged}.${sig}`)).toBeNull();
  });
  it('URL de autorização pede acesso offline e só os escopos da agenda', () => {
    process.env.GOOGLE_CLIENT_ID = 'cid.apps.googleusercontent.com';
    const u = new URL(authUrl('st'));
    expect(u.searchParams.get('access_type')).toBe('offline');
    expect(u.searchParams.get('scope')).toContain('calendar.events');
    expect(u.searchParams.get('scope')).toContain('calendar.freebusy');
    expect(u.searchParams.get('scope')).not.toMatch(/auth\/calendar(\s|$)/);
    delete process.env.GOOGLE_CLIENT_ID;
  });
});
