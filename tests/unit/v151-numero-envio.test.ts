import { describe, it, expect } from 'vitest';
import { canaisDaCampanha, riscoLiberado } from '../../server/mckmensagem/campanhaCore.js';

describe('v1.51.0 — número de envio escolhido', () => {
  it('número escolhido = só ele (ignora o rodízio); automático continua igual', () => {
    expect(canaisDaCampanha({ channelId: 'a', rodizio: true, canaisRodizio: '["b","c"]', envioFixo: true })).toEqual(['a']);
    expect(canaisDaCampanha({ channelId: 'a', rodizio: true, canaisRodizio: '["b","c"]', envioFixo: false })).toEqual(['a', 'b', 'c']);
    expect(canaisDaCampanha({ channelId: 'a', rodizio: true, canaisRodizio: '["b"]' })).toEqual(['a', 'b']);
  });
  it('Risco liberado só com número escolhido, confirmação e o mesmo número confirmado', () => {
    const em = new Date();
    expect(riscoLiberado({ envioFixo: true, channelId: 'a', riscoLiberadoCanalId: 'a', riscoLiberadoEm: em })).toBe(true);
    expect(riscoLiberado({ envioFixo: false, channelId: 'a', riscoLiberadoCanalId: 'a', riscoLiberadoEm: em })).toBe(false);
    expect(riscoLiberado({ envioFixo: true, channelId: 'b', riscoLiberadoCanalId: 'a', riscoLiberadoEm: em })).toBe(false);
    expect(riscoLiberado({ envioFixo: true, channelId: 'a', riscoLiberadoCanalId: 'a', riscoLiberadoEm: null })).toBe(false);
    expect(riscoLiberado({ envioFixo: true, channelId: 'a', riscoLiberadoCanalId: null, riscoLiberadoEm: em })).toBe(false);
  });
});
