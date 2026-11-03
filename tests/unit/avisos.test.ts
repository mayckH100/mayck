import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import {
  announcementState, appMatches, audienceMatches, dayKeySP, detectImageMime, parseSpDateTime, safeLink, toSpLocalInput,
} from '../../server/lib/announcements';
import { shouldHoldAnnouncements, localDismissKey, dayKeySP as webDayKey } from '../../web/src/announcements';
import type { SubscriptionView } from '../../web/src/auth';

describe('avisos: regras do servidor', () => {
  it('detecta PNG/JPEG/WEBP pelos bytes e recusa SVG/GIF/HTML', () => {
    expect(detectImageMime(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]))).toBe('image/png');
    expect(detectImageMime(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xdb]), Buffer.alloc(10)]))).toBe('image/jpeg');
    expect(detectImageMime(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')]))).toBe('image/webp');
    expect(detectImageMime(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBeNull();
    expect(detectImageMime(Buffer.from('GIF89a......'))).toBeNull();
    expect(detectImageMime(Buffer.from('<html><body>oi</body></html>'))).toBeNull();
    expect(detectImageMime(Buffer.from('RIFF....WAVEfmt '))).toBeNull();
    expect(detectImageMime(Buffer.alloc(3))).toBeNull();
  });

  it('datas do formulário em horário de Brasília', () => {
    expect(parseSpDateTime('2026-11-02T22:30')!.toISOString()).toBe('2026-11-03T01:30:00.000Z');
    expect(parseSpDateTime('2026-11-02T22:30:00-03:00')!.toISOString()).toBe('2026-11-03T01:30:00.000Z');
    expect(parseSpDateTime('2026-11-03T01:30:00.000Z')!.toISOString()).toBe('2026-11-03T01:30:00.000Z');
    expect(parseSpDateTime('amanhã')).toBeNull();
    expect(parseSpDateTime('2026-11-02')).toBeNull();
    expect(toSpLocalInput(new Date('2026-11-03T01:30:00.000Z'))).toBe('2026-11-02T22:30');
    expect(dayKeySP(new Date('2026-11-03T01:30:00.000Z'))).toBe('2026-11-02'); // ainda é dia 2 em SP
    expect(webDayKey(new Date('2026-11-03T03:30:00.000Z'))).toBe('2026-11-03');
  });

  it('link só https ou caminho interno', () => {
    expect(safeLink('https://exemplo.com/a?b=1')).toBe('https://exemplo.com/a?b=1');
    expect(safeLink('/plano')).toBe('/plano');
    for (const bad of ['javascript:alert(1)', 'data:text/html,x', '//evil.com', '/\\evil.com', 'http://x.com', 'https://user:pw@x.com', 'ftp://x']) expect(safeLink(bad)).toBeNull();
    expect(safeLink('')).toBeNull();
  });

  it('app e público', () => {
    expect(appMatches('AMBOS', 'MCKBOT')).toBe(true);
    expect(appMatches('MCKMENSAGEM', 'MCKBOT')).toBe(false);
    expect(audienceMatches('TODOS', null)).toBe(true);
    expect(audienceMatches('TRIAL', 'TRIAL')).toBe(true);
    expect(audienceMatches('TRIAL', 'ATIVA')).toBe(false);
    expect(audienceMatches('ATIVOS', 'ATIVA')).toBe(true);
    expect(audienceMatches('VENCIDOS', 'VENCIDA')).toBe(true);
    expect(audienceMatches('VENCIDOS', 'BLOQUEADA')).toBe(true);
    expect(audienceMatches('VENCIDOS', 'TRIAL')).toBe(false);
    expect(audienceMatches('XYZ', 'ATIVA')).toBe(false);
  });

  it('situação para a lista do Master', () => {
    const now = new Date('2026-11-02T12:00:00Z');
    const base = { active: true, startsAt: new Date('2026-11-01T00:00:00Z'), endsAt: new Date('2026-11-05T00:00:00Z'), imageMime: 'image/png' };
    expect(announcementState(base, now)).toBe('NO_AR');
    expect(announcementState({ ...base, imageMime: null }, now)).toBe('SEM_IMAGEM');
    expect(announcementState({ ...base, active: false }, now)).toBe('INATIVO');
    expect(announcementState({ ...base, startsAt: new Date('2026-11-03T00:00:00Z') }, now)).toBe('AGENDADO');
    expect(announcementState({ ...base, endsAt: new Date('2026-11-02T11:00:00Z') }, now)).toBe('ENCERRADO');
  });
});

describe('avisos: regras do navegador', () => {
  const sub = (status: SubscriptionView['status']): SubscriptionView => ({ product: 'MCKBOT', status, source: 'MANUAL', active: status === 'TRIAL' || status === 'ATIVA', cycle: 'MENSAL', validUntil: '2026-12-01T00:00:00Z' });
  const msub = (status: SubscriptionView['status']): SubscriptionView => ({ ...sub(status), product: 'MCKMENSAGEM' });
  it('não aparece no Painel Master nem sem organização', () => {
    expect(shouldHoldAnnouncements({ app: 'mckbot', pathname: '/master', hasOrg: true, role: 'OWNER', isSuperAdmin: true, subscriptions: [sub('ATIVA')] })).toBe(true);
    expect(shouldHoldAnnouncements({ app: 'mckbot', pathname: '/master/clientes/x', hasOrg: true, role: 'OWNER', isSuperAdmin: true })).toBe(true);
    expect(shouldHoldAnnouncements({ app: 'mckbot', pathname: '/', hasOrg: false, role: null })).toBe(true);
    expect(shouldHoldAnnouncements({ app: 'mckbot', pathname: '/', hasOrg: true, role: 'OWNER', subscriptions: [sub('ATIVA')] })).toBe(false);
  });
  it('pop-up de renovação tem prioridade (exceto nas páginas liberadas)', () => {
    expect(shouldHoldAnnouncements({ app: 'mckbot', pathname: '/', hasOrg: true, role: 'OWNER', subscriptions: [sub('VENCIDA')] })).toBe(true);
    expect(shouldHoldAnnouncements({ app: 'mckbot', pathname: '/', hasOrg: true, role: 'OWNER', subscriptions: [sub('ATIVA')], paymentRequired: true })).toBe(false); // ativa: 402 antigo não bloqueia
    expect(shouldHoldAnnouncements({ app: 'mckbot', pathname: '/', hasOrg: true, role: 'OWNER', subscriptions: [], paymentRequired: true })).toBe(true);
    expect(shouldHoldAnnouncements({ app: 'mckbot', pathname: '/plano', hasOrg: true, role: 'OWNER', subscriptions: [sub('VENCIDA')] })).toBe(false);
    expect(shouldHoldAnnouncements({ app: 'mensagem', pathname: '/', hasOrg: true, role: 'OWNER', subscriptions: [msub('BLOQUEADA')] })).toBe(true);
    expect(shouldHoldAnnouncements({ app: 'mensagem', pathname: '/', hasOrg: true, role: 'OWNER', subscriptions: [msub('TRIAL')] })).toBe(false);
  });
  it('chave do localStorage por usuário, aviso e dia', () => {
    expect(localDismissKey('u1', 'a1', '2026-11-02')).toBe('mck:aviso:u1:a1:2026-11-02');
  });
});

describe('avisos: migração', () => {
  const dirs = readdirSync('prisma/migrations').filter((d) => /^\d{4}_/.test(d)).sort();
  const sql = readFileSync('prisma/migrations/0030_avisos/migration.sql', 'utf8');
  it('é a mais nova e só aditiva', () => {
    expect(dirs[dirs.length - 1]).toBe('0030_avisos');
    const code = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
    expect(code).not.toMatch(/\b(DROP|DELETE|UPDATE|TRUNCATE|RENAME)\b/i);
    expect(code).not.toMatch(/ALTER\s+TABLE/i);
    expect(code).toMatch(/CREATE TABLE "Announcement"/);
    expect(code).toMatch(/CREATE TABLE "AnnouncementView"/);
    expect(code).toMatch(/"imageData" BYTEA/);
  });
  it('bate com o schema.prisma (Postgres)', () => {
    const out = execFileSync('npx', ['prisma', 'migrate', 'diff', '--from-empty', '--to-schema-datamodel', 'prisma/schema.prisma', '--script'], { encoding: 'utf8' });
    const blocks = (s: string) => {
      const keep: string[] = [];
      for (const stmt of s.split(';')) {
        const t = stmt.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').replace(/\s+/g, ' ').trim();
        if (/"Announcement(View)?"/.test(t) && /^CREATE/.test(t)) keep.push(t);
      }
      return keep.sort();
    };
    expect(blocks(sql)).toEqual(blocks(out));
    expect(blocks(sql).length).toBe(5);
  }, 60_000);
});
