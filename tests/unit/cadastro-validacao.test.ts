import { describe, it, expect, afterEach } from 'vitest';
import { isValidCpf, isValidCnpj, parseDocumento, maskDocumento, normalizeCelular, maskCelular } from '../../server/lib/documento.js';
import { isDisposableDomain, emailDomain, domainAcceptsMail, checkSignupEmail, setDnsResolver, type DnsResolver } from '../../server/lib/emailCheck.js';

describe('CPF / CNPJ', () => {
  it('aceita CPF válido com ou sem máscara e recusa dígitos errados e repetidos', () => {
    expect(isValidCpf('529.982.247-25')).toBe(true);
    expect(isValidCpf('52998224725')).toBe(true);
    expect(isValidCpf('529.982.247-24')).toBe(false);
    expect(isValidCpf('000.000.000-00')).toBe(false);
    expect(isValidCpf('111.111.111-11')).toBe(false);
    expect(isValidCpf('1234567890')).toBe(false);
  });
  it('aceita CNPJ válido e recusa inválido/repetido', () => {
    expect(isValidCnpj('11.222.333/0001-81')).toBe(true);
    expect(isValidCnpj('11222333000181')).toBe(true);
    expect(isValidCnpj('11.222.333/0001-80')).toBe(false);
    expect(isValidCnpj('00.000.000/0000-00')).toBe(false);
    expect(isValidCnpj('58.460.367/0001-78')).toBe(true);
  });
  it('aceita CNPJ alfanumérico (exemplo oficial Receita/Serpro 12.ABC.345/01DE-35)', () => {
    expect(isValidCnpj('12.ABC.345/01DE-35')).toBe(true);
    expect(isValidCnpj('12ABC34501DE35')).toBe(true);
    expect(isValidCnpj('12abc34501de35')).toBe(true); // minúsculas são normalizadas
    expect(isValidCnpj('12ABC34501DE36')).toBe(false); // 2º DV errado
    expect(isValidCnpj('12ABC34501DE45')).toBe(false); // 1º DV errado
    expect(isValidCnpj('12ABC34501DEA5')).toBe(false); // DV precisa ser numérico
    expect(isValidCnpj('AAAAAAAAAAAAAA')).toBe(false);
    expect(isValidCnpj('12ABC34501D35')).toBe(false); // 13 caracteres
  });
  it('web: mesma validação e máscara com letras em maiúsculas', async () => {
    const w = await import('../../web/src/lib/documento.js');
    expect(w.isValidCnpj('12.abc.345/01de-35')).toBe(true);
    expect(w.isValidCnpj('11.222.333/0001-81')).toBe(true);
    expect(w.isValidDocumento('529.982.247-25')).toBe(true);
    expect(w.isValidDocumento('529a98224725')).toBe(false);
    expect(w.isValidDocumento('12ABC34501DE36')).toBe(false);
    expect(w.maskDocumento('12abc34501de35')).toBe('12.ABC.345/01DE-35');
    expect(w.maskDocumento('12abc34501deXY')).toBe('12.ABC.345/01DE');
    expect(w.maskDocumento('11222333000181')).toBe('11.222.333/0001-81');
    expect(w.maskDocumento('52998224725')).toBe('529.982.247-25');
  });
  it('parseDocumento normaliza CNPJ alfanumérico para maiúsculas sem máscara', () => {
    expect(parseDocumento('12.abc.345/01de-35')).toEqual({ tipo: 'CNPJ', digits: '12ABC34501DE35' });
    expect(parseDocumento('12ABC34501DE36')).toBeNull();
    expect(parseDocumento('12ABC34501DE35!')).toBeNull();
    expect(maskDocumento('12ABC34501DE35')).toBe('**.ABC.345/01DE-**');
  });
  it('parseDocumento devolve só dígitos e o tipo; recusa letras', () => {
    expect(parseDocumento('529.982.247-25')).toEqual({ tipo: 'CPF', digits: '52998224725' });
    expect(parseDocumento('11.222.333/0001-81')).toEqual({ tipo: 'CNPJ', digits: '11222333000181' });
    expect(parseDocumento('529a98224725')).toBeNull();
    expect(parseDocumento(undefined)).toBeNull();
  });
  it('mascara documento e celular', () => {
    expect(maskDocumento('52998224725')).toBe('***.982.247-**');
    expect(maskDocumento('11222333000181')).toBe('**.222.333/0001-**');
    expect(maskCelular('+5511987654321')).toBe('+55 (11) 9****-4321');
  });
});

describe('Celular', () => {
  it('normaliza celular brasileiro para E.164', () => {
    for (const v of ['(11) 98765-4321', '11987654321', '+55 11 98765-4321', '5511987654321', '011987654321']) expect(normalizeCelular(v), v).toBe('+5511987654321');
  });
  it('recusa fixo, DDD inválido e lixo; aceita internacional com +', () => {
    expect(normalizeCelular('(11) 3333-4444')).toBeNull();
    expect(normalizeCelular('(01) 98765-4321')).toBeNull();
    expect(normalizeCelular('abc')).toBeNull();
    expect(normalizeCelular('11999999999')).toBeNull();
    expect(normalizeCelular('+1 415 555 0100')).toBe('+14155550100');
  });
});

describe('E-mail do cadastro', () => {
  afterEach(() => setDnsResolver(null));
  const mock = (over: Partial<DnsResolver>): DnsResolver => ({
    mx: async () => [{ exchange: 'mx.exemplo.com', priority: 10 }], a: async () => ['1.2.3.4'], aaaa: async () => [], ...over,
  });
  const err = (code: string) => Object.assign(new Error(code), { code });

  it('formato do e-mail', () => {
    expect(emailDomain('ana@empresa.com.br')).toBe('empresa.com.br');
    expect(emailDomain('ana@@empresa.com')).toBeNull();
    expect(emailDomain('ana..b@empresa.com')).toBeNull();
    expect(emailDomain('ana@empresa')).toBeNull();
  });
  it('domínios descartáveis (inclusive subdomínios) e comuns liberados', () => {
    expect(isDisposableDomain('mailinator.com')).toBe(true);
    expect(isDisposableDomain('x.mailinator.com')).toBe(true);
    expect(isDisposableDomain('10minutemail.com')).toBe(true);
    for (const d of ['gmail.com', 'hotmail.com', 'outlook.com', 'yahoo.com.br', 'uol.com.br', 'bol.com.br', 'icloud.com']) expect(isDisposableDomain(d), d).toBe(false);
  });
  it('MX: ok, inexistente, null MX, só A, falha transitória e timeout', async () => {
    setDnsResolver(mock({}));
    expect(await domainAcceptsMail('ok.com')).toBe('ok');
    setDnsResolver(mock({ mx: async () => { throw err('ENOTFOUND'); }, a: async () => { throw err('ENOTFOUND'); }, aaaa: async () => { throw err('ENOTFOUND'); } }));
    expect(await domainAcceptsMail('nao.com')).toBe('none');
    setDnsResolver(mock({ mx: async () => [{ exchange: '', priority: 0 }] }));
    expect(await domainAcceptsMail('nullmx.com')).toBe('none');
    setDnsResolver(mock({ mx: async () => { throw err('ENODATA'); } }));
    expect(await domainAcceptsMail('soA.com')).toBe('ok');
    setDnsResolver(mock({ mx: async () => { throw err('ESERVFAIL'); } }));
    expect(await domainAcceptsMail('falha.com')).toBe('unknown');
    setDnsResolver(mock({ mx: () => new Promise(() => undefined) }));
    const t0 = Date.now();
    expect(await domainAcceptsMail('lento.com')).toBe('unknown');
    expect(Date.now() - t0).toBeLessThan(4000);
  });
  it('checkSignupEmail com mensagens em português', async () => {
    setDnsResolver(mock({}));
    expect(await checkSignupEmail('ana@empresa.com.br')).toEqual({ ok: true });
    expect(await checkSignupEmail('ana@mailinator.com')).toMatchObject({ ok: false, error: expect.stringMatching(/descartáveis/) });
    expect(await checkSignupEmail('ana@')).toMatchObject({ ok: false, error: expect.stringMatching(/E-mail inválido/) });
    setDnsResolver(mock({ mx: async () => { throw err('ENOTFOUND'); }, a: async () => { throw err('ENOTFOUND'); }, aaaa: async () => { throw err('ENOTFOUND'); } }));
    expect(await checkSignupEmail('ana@dominio-inexistente.com.br')).toMatchObject({ ok: false, error: expect.stringMatching(/não recebe e-mails/) });
  });
});
