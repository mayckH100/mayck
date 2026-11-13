import { describe, it, expect } from 'vitest';
import { stripVoiceMarkers } from '../../server/ai/voice/preference.js';
import { splitIntoVoiceChunks } from '../../server/ai/voice/send.js';

describe('v1.27.3 voz', () => {
  it('remove variações do marcador de áudio', () => {
    expect(stripVoiceMarkers('[enviado as áudio] Olha, oi')).toBe('Olha, oi');
    expect(stripVoiceMarkers('[enviado em audio] Oi')).toBe('Oi');
    expect(stripVoiceMarkers('[áudio] Oi')).toBe('Oi');
    expect(stripVoiceMarkers('[enviado como áudio] Oi')).toBe('Oi');
  });
  it('divide texto longo sem cortar frases', () => {
    const t = Array.from({ length: 20 }, (_, i) => `Frase número ${i} com algum conteúdo.`).join(' ');
    const parts = splitIntoVoiceChunks(t, 200);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((p) => p.length <= 200)).toBe(true);
    expect(parts.join(' ')).toBe(t);
  });
});
