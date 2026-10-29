import { describe, it, expect, afterEach } from 'vitest';
import { isPrivateAddress, assertPublicUrl, safeFetch, setResolver } from '../../server/lib/ssrf.js';
import { setFetch, resetFetch } from '../../server/lib/fetcher.js';

describe('Proteção SSRF reforçada', () => {
  afterEach(() => { setResolver(null); resetFetch(); });

  it('bloqueia IPv4 interno escrito como IPv6 (inclusive hexadecimal), NAT64, 6to4 e faixas reservadas', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '169.254.169.254', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:a9fe:a9fe', '64:ff9b::a9fe:a9fe', '2002:7f00:1::1', '::1', '::', 'fd00::1', 'fe80::1', '198.18.0.1', '224.0.0.1', '255.255.255.255', '0.0.0.0'])
      expect(isPrivateAddress(ip), ip).toBe(true);
    for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '::ffff:808:808'])
      expect(isPrivateAddress(ip), ip).toBe(false);
  });

  it('recusa URL com credenciais embutidas e hosts .local', async () => {
    await expect(assertPublicUrl('http://user:pass@example.com/')).rejects.toThrow(/usuário\/senha/);
    await expect(assertPublicUrl('http://impressora.local/')).rejects.toThrow(/interno/);
    await expect(assertPublicUrl('http://[::ffff:7f00:1]/')).rejects.toThrow(/interno/);
  });

  it('segue redirecionamento só para endereço público e não repassa autenticação para outro domínio', async () => {
    setResolver(async (h) => (h === 'interno.exemplo' ? ['10.0.0.5'] : ['93.184.216.34']));
    const calls: { url: string; headers: Record<string, string> }[] = [];
    setFetch(async (input, init) => {
      const url = String(input);
      const headers: Record<string, string> = {};
      new Headers(init?.headers).forEach((v, k) => { headers[k] = v; });
      calls.push({ url, headers });
      if (url.startsWith('https://a.exemplo/ruim')) return new Response(null, { status: 302, headers: { location: 'http://interno.exemplo/admin' } });
      if (url.startsWith('https://a.exemplo/meta')) return new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data/' } });
      if (url.startsWith('https://a.exemplo/bom')) return new Response(null, { status: 301, headers: { location: 'https://b.exemplo/fim' } });
      return new Response('{"ok":true}', { status: 200 });
    });
    await expect(safeFetch('https://a.exemplo/ruim')).rejects.toThrow(/interno/);
    await expect(safeFetch('https://a.exemplo/meta')).rejects.toThrow(/interno/);
    const r = await safeFetch('https://a.exemplo/bom', { headers: { Authorization: 'Bearer segredo', 'X-Api-Key': 'k', 'Content-Type': 'application/json' } });
    expect(r.status).toBe(200);
    const last = calls[calls.length - 1];
    expect(last.url).toBe('https://b.exemplo/fim');
    expect(last.headers.authorization).toBeUndefined();
    expect(last.headers['x-api-key']).toBeUndefined();
    expect(last.headers['content-type']).toBe('application/json');
  });
});
