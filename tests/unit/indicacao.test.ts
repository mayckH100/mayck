import { describe, it, expect } from 'vitest';
import { samePerson, newReferralCode, normalizeReferralCode, validReferralCode, referralRewardText, REFERRAL_DAYS } from '../../server/billing/referrals.js';
import { whatsappShareUrl } from '../../web/src/Indicacao.js';

describe('Indique e ganhe: regras puras', () => {
  it('código: 8 caracteres sem I, O, 0 e 1; normaliza e valida', () => {
    for (let i = 0; i < 200; i++) expect(newReferralCode()).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
    expect(normalizeReferralCode(' ab-12 cd ')).toBe('AB12CD');
    expect(validReferralCode('abc12345')).toBe('ABC12345');
    expect(validReferralCode('abc')).toBeNull();
    expect(validReferralCode('A'.repeat(13))).toBeNull();
    expect(validReferralCode(undefined)).toBeNull();
  });
  it('autoindicação: mesmo e-mail (sem diferenciar maiúsculas), celular ou CPF/CNPJ', () => {
    const a = [{ email: 'Dono@Empresa.com', celular: '+5511912345678', documento: '12345678901' }];
    expect(samePerson(a, [{ email: 'dono@empresa.com' }])).toBe(true);
    expect(samePerson(a, [{ celular: '5511912345678' }])).toBe(true);
    expect(samePerson(a, [{ documento: '12345678901' }])).toBe(true);
    expect(samePerson(a, [{ email: 'outro@x.com', celular: '+5511900000000', documento: '98765432100' }])).toBe(false);
    expect(samePerson(a, [{ email: null, celular: null, documento: null }])).toBe(false);
  });
  it('30 dias por indicação; texto do WhatsApp com link', () => {
    expect(REFERRAL_DAYS).toBe(30);
    const t = referralRewardText({ org: 'Loja X', days: 30, until: '05/12/2026', url: 'https://mckbot.onrender.com/cadastro?indica=ABCD2345' });
    expect(t.split('\n')[0]).toBe('🎁 Você ganhou 1 mês grátis!');
    expect(t).toContain('Loja X');
    expect(t).toContain('05/12/2026');
    expect(t).toContain('/cadastro?indica=ABCD2345');
  });
  it('compartilhar no WhatsApp leva o link', () => {
    const u = whatsappShareUrl('https://mckbot.onrender.com/cadastro?indica=ABCD2345');
    expect(u.startsWith('https://wa.me/?text=')).toBe(true);
    expect(decodeURIComponent(u)).toContain('/cadastro?indica=ABCD2345');
  });
});
