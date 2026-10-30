import { describe, it, expect } from 'vitest';
import { normalizePairingPhone, formatPairingCode, maskPhone, pairingPerHour } from '../../server/whatsapp/qr/pairing.js';
import { isPendingPairing } from '../../server/whatsapp/qr/authState.js';

describe('Código de pareamento (Conectar com número de telefone)', () => {
  it('normaliza o número com DDI para só dígitos', () => {
    expect(normalizePairingPhone('+55 (11) 99999-0000')).toEqual({ ok: true, digits: '5511999990000' });
    expect(normalizePairingPhone('55 21 3333-4444')).toEqual({ ok: true, digits: '552133334444' });
    expect(normalizePairingPhone('+1 415 555 0100')).toEqual({ ok: true, digits: '14155550100' });
    expect(normalizePairingPhone('+351 912 345 678')).toEqual({ ok: true, digits: '351912345678' });
  });
  it('recusa números inválidos com motivo claro', () => {
    expect(normalizePairingPhone('').ok).toBe(false);
    expect(normalizePairingPhone('011999990000').ok).toBe(false); // começa com zero
    expect(normalizePairingPhone('12345').ok).toBe(false); // curto
    expect(normalizePairingPhone('1234567890123456').ok).toBe(false); // longo
    expect(normalizePairingPhone('55 11 9999').ok).toBe(false); // BR curto
    expect(normalizePairingPhone('55 10 99999-0000').ok).toBe(false); // DDD inválido
    expect(normalizePairingPhone('55 11 89999-0000').ok).toBe(false); // celular de 9 dígitos sem 9
  });
  it('formata o código como XXXX-XXXX', () => {
    expect(formatPairingCode('abcd1234')).toBe('ABCD-1234');
    expect(formatPairingCode('ABCD-1234')).toBe('ABCD-1234');
  });
  it('mascara o número (Auditoria nunca guarda o número inteiro nem o código)', () => {
    expect(maskPhone('5511999990000')).toBe('+55 11 *****-0000');
    expect(maskPhone('14155550100')).toBe('+14 ****0100');
  });
  it('limite por hora configurável, padrão 5', () => {
    const old = process.env.QR_PAIRING_PER_HOUR;
    delete process.env.QR_PAIRING_PER_HOUR;
    expect(pairingPerHour()).toBe(5);
    process.env.QR_PAIRING_PER_HOUR = 'abc';
    expect(pairingPerHour()).toBe(5);
    process.env.QR_PAIRING_PER_HOUR = '3';
    expect(pairingPerHour()).toBe(3);
    if (old === undefined) delete process.env.QR_PAIRING_PER_HOUR; else process.env.QR_PAIRING_PER_HOUR = old;
  });
  it('pareamento por código não concluído não conta como sessão salva', () => {
    expect(isPendingPairing({ pairingCode: 'ABCD1234', registered: false } as any)).toBe(true);
    expect(isPendingPairing({ pairingCode: 'ABCD1234', registered: true } as any)).toBe(false);
    expect(isPendingPairing({ registered: false } as any)).toBe(false); // QR concluído não marca registered
    expect(isPendingPairing(null)).toBe(false);
  });
});
