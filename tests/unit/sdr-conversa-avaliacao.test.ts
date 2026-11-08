import { describe, it, expect } from 'vitest';
import { avaliar, CRITERIOS } from '../fixtures/conversas-avaliacao.js';

/** v1.26.0: avaliação automática da IA conversacional avançada (conversas de teste, sem dados reais). */
describe('Avaliação da IA conversacional (antes × depois)', () => {
  const r = avaliar();
  it('depois: todas as conversas de teste passam em todos os critérios', () => {
    const falhas = r.linhas.flatMap((l) => Object.entries(l.cDepois).filter(([, ok]) => !ok).map(([k]) => `${l.caso.id}: ${k} → "${l.depois.texto}"`));
    expect(falhas).toEqual([]);
  });
  it('nenhum critério piora e o antes falha em vários (a avaliação mede algo)', () => {
    for (const c of r.resumo) expect(c.depois).toBeGreaterThanOrEqual(c.antes);
    expect(r.casosOk.antes).toBeLessThan(r.casosOk.depois);
    expect(r.resumo).toHaveLength(CRITERIOS.length);
  });
});
