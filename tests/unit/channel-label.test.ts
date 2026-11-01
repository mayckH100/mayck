import { describe, it, expect } from 'vitest';
import { sanitizeChannelName, isDefaultChannelName, channelLabel, formatChannelPhone, customChannelName } from '../../server/whatsapp/channelLabel.js';

describe('Nome do WhatsApp: rótulo "WhatsApp N · Nome"', () => {
  it('limpa o nome (espaços, invisíveis, < >)', () => {
    expect(sanitizeChannelName('  Mayck  ')).toBe('Mayck');
    expect(sanitizeChannelName('Ama\u200bnda\n\t Silva')).toBe('Amanda Silva');
    expect(sanitizeChannelName('<script>x</script>')).toBe('scriptx/script');
    expect(sanitizeChannelName(null)).toBe('');
  });
  it('nomes padrão não aparecem como nome próprio', () => {
    for (const n of ['', 'WhatsApp', 'WhatsApp principal', 'whatsapp 3', ' WhatsApp  2 ']) expect(isDefaultChannelName(n)).toBe(true);
    for (const n of ['Mayck', 'WhatsApp Vendas', 'Amanda']) expect(isDefaultChannelName(n)).toBe(false);
    expect(customChannelName('WhatsApp principal')).toBe('');
  });
  it('monta o rótulo', () => {
    expect(channelLabel(1, 'Mayck')).toBe('WhatsApp 1 · Mayck');
    expect(channelLabel(2, 'WhatsApp principal')).toBe('WhatsApp 2');
    expect(channelLabel(3, 'WhatsApp 7')).toBe('WhatsApp 3');
  });
  it('formata o telefone', () => {
    expect(formatChannelPhone('+5511987654321')).toBe('11 98765-4321');
    expect(formatChannelPhone('+55 11 3333-4444')).toBe('11 3333-4444');
    expect(formatChannelPhone('+1 555 123 4567')).toBe('+15551234567');
    expect(formatChannelPhone(null)).toBeNull();
  });
});
