import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { NOVIDADE_BANNER_DIAS, novidadeDismissKey, novidadeHref, novidadeParaBanner } from '../../web/src/novidadeBanner';

const DIA = 86_400_000;
const now = Date.parse('2026-11-03T18:30:00.000Z');
const item = (dias: number, id = 'n1') => ({ id, title: 'Fluxos mais fáceis', publishedAt: new Date(now - dias * DIA).toISOString() });
const nunca = () => false;

describe('banner de atualização (novidade mais recente)', () => {
  it('mostra a novidade mais recente por até 14 dias', () => {
    expect(NOVIDADE_BANNER_DIAS).toBe(14);
    expect(novidadeParaBanner([item(0)], now, nunca)?.id).toBe('n1');
    expect(novidadeParaBanner([item(13.9)], now, nunca)?.id).toBe('n1');
    expect(novidadeParaBanner([item(14.1)], now, nunca)).toBeNull();
  });
  it('usa só o primeiro item (o mais recente)', () => {
    expect(novidadeParaBanner([item(1, 'nova'), item(2, 'velha')], now, nunca)?.id).toBe('nova');
  });
  it('some quando o usuário fecha (por id)', () => {
    expect(novidadeParaBanner([item(1)], now, (id) => id === 'n1')).toBeNull();
    expect(novidadeParaBanner([item(1, 'n2')], now, (id) => id === 'n1')?.id).toBe('n2');
  });
  it('ignora lista vazia, sem data, data inválida ou no futuro distante', () => {
    expect(novidadeParaBanner([], now, nunca)).toBeNull();
    expect(novidadeParaBanner(null, now, nunca)).toBeNull();
    expect(novidadeParaBanner([{ id: 'x', title: 't', publishedAt: null }], now, nunca)).toBeNull();
    expect(novidadeParaBanner([{ id: 'x', title: 't', publishedAt: 'ontem' }], now, nunca)).toBeNull();
    expect(novidadeParaBanner([item(-3)], now, nunca)).toBeNull();
  });
  it('chave do localStorage e link para a novidade', () => {
    expect(novidadeDismissKey('abc')).toBe('mck:novidade:fechada:abc');
    expect(novidadeHref('abc')).toBe('/empresa/novidades#novidade-abc');
    expect(novidadeHref('abc', '/')).toBe('/empresa/novidades#novidade-abc');
  });
  it('o site usa a mesma regra (14 dias, mesma chave, link com âncora) sem tirar conteúdo do HTML', () => {
    const js = readFileSync('web/public/empresa/assets/site.js', 'utf8');
    expect(js).toContain("'mck:novidade:fechada:' + id");
    expect(js).toContain('DIAS = 14');
    expect(js).toContain("'/empresa/novidades#novidade-'");
    expect(js).toContain("'/api/novidades?limit=1'");
    expect(js).toContain('id="novidade-');
  });
});

describe('novidade de 2026-11-03: migração de dados', () => {
  const dir = readdirSync('prisma/migrations').find((d) => /^\d{4}_novidade_2026_11_03$/.test(d));
  const code = readFileSync(`prisma/migrations/${dir}/migration.sql`, 'utf8').split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
  it('é só aditiva e idempotente (um INSERT com id fixo e WHERE NOT EXISTS)', () => {
    expect(dir).toBeTruthy();
    expect(code).not.toMatch(/\b(DROP|DELETE|UPDATE|TRUNCATE|RENAME|ALTER)\b/i);
    expect(code.match(/INSERT INTO/g)).toHaveLength(1);
    expect(code).toMatch(/WHERE NOT EXISTS \(SELECT 1 FROM "SocialPost" WHERE "id" = 'nov-2026-11-03-fluxos-ia-site'\)/);
    expect(code).toContain(`'["site"]'`);
    expect(code).toContain("'published'");
    expect(code).toContain('https://mckbot.onrender.com/cadastro');
  });
});
