import { describe, it, expect } from 'vitest';
import { gscToken, withGsc, rootWantsApp, SESSION_COOKIE_NAME } from '../../server/lib/siteHtml.js';
import { COOKIE } from '../../server/auth/session.js';

describe('raiz "/": quem recebe o app e quem recebe a landing', () => {
  it('nome do cookie igual ao da sessão', () => expect(SESSION_COOKIE_NAME).toBe(COOKIE));
  it('visitante / robô (sem cookie) → landing', () => {
    expect(rootWantsApp({}, {})).toBe(false);
    expect(rootWantsApp(undefined, undefined)).toBe(false);
    expect(rootWantsApp({ [COOKIE]: '' }, {})).toBe(false);
    expect(rootWantsApp({}, { utm_source: 'google' })).toBe(false);
  });
  it('logado, PWA, retorno de pagamento/Agenda ou ?app → app', () => {
    expect(rootWantsApp({ [COOKIE]: 'tok' }, {})).toBe(true);
    expect(rootWantsApp({}, { source: 'pwa' })).toBe(true);
    expect(rootWantsApp({}, { billing: 'success' })).toBe(true);
    expect(rootWantsApp({}, { google: 'ok' })).toBe(true);
    expect(rootWantsApp({}, { app: '1' })).toBe(true);
  });
});

describe('verificação do Search Console', () => {
  it('aceita o token ou a tag inteira e recusa lixo', () => {
    expect(gscToken('rdaXqM9TD2Du7cMhAdreVM4lB35CmbSZdb8ZNeJQ12M')).toBe('rdaXqM9TD2Du7cMhAdreVM4lB35CmbSZdb8ZNeJQ12M');
    expect(gscToken('<meta name="google-site-verification" content="abcDEF123_-xyz" />')).toBe('abcDEF123_-xyz');
    expect(gscToken('"><script>alert(1)</script>')).toBeNull();
    expect(gscToken(undefined)).toBeNull();
  });
  it('injeta no <head> só quando o token ainda não está no HTML', () => {
    const html = '<html><head><title>x</title></head><body></body></html>';
    expect(withGsc(html, 'abcDEF123_-xyz')).toContain('<meta name="google-site-verification" content="abcDEF123_-xyz"></head>');
    const ja = withGsc(html, 'abcDEF123_-xyz');
    expect(withGsc(ja, 'abcDEF123_-xyz')).toBe(ja);
    expect(withGsc(html, '')).toBe(html);
  });
});
