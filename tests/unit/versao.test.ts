import { describe, it, expect } from 'vitest';
import { CHANGELOG, APP_VERSION, dataBr, rotuloVersao } from '../../server/changelog.js';
import { versaoInfo } from '../../server/lib/versao.js';

const num = (v: string) => v.split('.').map(Number);
const maior = (a: string, b: string) => { const [x, y] = [num(a), num(b)]; for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i]; return false; };

describe('changelog (histórico de versões)', () => {
  it('versões únicas, no formato 1.N.N, da mais nova para a mais antiga, com data e itens', () => {
    expect(APP_VERSION).toBe(CHANGELOG[0].versao);
    expect(new Set(CHANGELOG.map((e) => e.versao)).size).toBe(CHANGELOG.length);
    for (let i = 0; i < CHANGELOG.length; i++) {
      const e = CHANGELOG[i];
      expect(e.versao).toMatch(/^\d+\.\d+\.\d+$/);
      expect(e.data).toMatch(/^\d{2}\/\d{2}\/\d{4}$/);
      expect(e.titulo.trim()).not.toBe('');
      expect(e.itens.length).toBeGreaterThan(0);
      if (i > 0) expect(maior(CHANGELOG[i - 1].versao, e.versao)).toBe(true);
    }
  });

  it('texto para cliente: sem termos técnicos nem dados sensíveis', () => {
    const texto = JSON.stringify(CHANGELOG);
    expect(texto).not.toMatch(/migra[çc][ãa]o|commit|endpoint|prisma|token|senha:|api_key|@gmail|\.ts\b|\/api\//i);
  });
});

describe('rótulo da versão', () => {
  it('formata dd/mm/aaaa em Brasília e encurta o SHA', () => {
    expect(dataBr('2026-11-04T02:30:00Z')).toBe('03/11/2026');
    expect(dataBr('2026-11-04T12:00:00Z')).toBe('04/11/2026');
    expect(dataBr(null)).toBeNull();
    expect(rotuloVersao('1.12.0', '2cf0b796910d8642f0c6a9ea2bc96318ef9950dc', '04/11/2026')).toBe('Versão 1.12.0 · 2cf0b79 · 04/11/2026');
    expect(rotuloVersao('1.12.0', 'dev', null)).toBe('Versão 1.12.0 · dev');
  });

  it('commit do Render (RENDER_GIT_COMMIT) tem prioridade', () => {
    const v = versaoInfo({ RENDER_GIT_COMMIT: 'abcdef1234567890abcdef1234567890abcdef12' } as NodeJS.ProcessEnv, true);
    expect(v.commit).toBe('abcdef1234567890abcdef1234567890abcdef12');
    expect(v.commitCurto).toBe('abcdef1');
    expect(v.versao).toBe(APP_VERSION);
    expect(v.rotulo.startsWith(`Versão ${APP_VERSION} · abcdef1`)).toBe(true);
  });
});
