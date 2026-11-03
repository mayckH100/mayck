import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

// SEO do site institucional /empresa e da raiz do app (etapa 1).
const WEB = path.resolve(__dirname, '../../web');
const EMPRESA = path.join(WEB, 'public/empresa');
const pages = readdirSync(EMPRESA).filter((f) => f.endsWith('.html'));

function jsonLd(html: string): any[] {
  return [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]));
}
function types(html: string): string[] {
  return jsonLd(html).flatMap((d) => (d['@graph'] ?? [d]).flatMap((n: any) => [].concat(n['@type'])));
}

describe('site /empresa: SEO', () => {
  it('tem as 7 páginas', () => expect(pages.sort()).toEqual(['ajuda.html', 'contato.html', 'index.html', 'mck-mensagens.html', 'mckbot.html', 'novidades.html', 'planos.html']));

  for (const f of pages) {
    it(`${f}: title, description, canonical e JSON-LD válido com Organization e WebSite`, () => {
      const html = readFileSync(path.join(EMPRESA, f), 'utf8');
      expect(html).toMatch(/<title>MCK DESENVOLVIMENTO[^<]*<\/title>/);
      expect(html).toMatch(/<meta name="description" content="[^"]{50,}">/);
      expect(html).toMatch(/<link rel="canonical" href="https:\/\/mckbot\.onrender\.com\/(empresa|privacidade|termos|")/);
      const t = types(html);
      expect(t).toContain('Organization');
      expect(t).toContain('WebSite');
      if (f !== 'index.html') expect(t).toContain('BreadcrumbList');
      const org = jsonLd(html)[0]['@graph'].find((n: any) => n['@type'] === 'Organization');
      expect(org.taxID).toBe('58.460.367/0001-78');
      expect(org.sameAs).toContain('https://www.facebook.com/profile.php?id=61596189174050');
      expect(html).toContain('class="social"');
    });
  }

  it('ajuda.html tem FAQPage com as perguntas da página', () => {
    const html = readFileSync(path.join(EMPRESA, 'ajuda.html'), 'utf8');
    const page = jsonLd(html)[0]['@graph'].find((n: any) => [].concat(n['@type']).includes('FAQPage'));
    const qtd = (html.match(/<details><summary>/g) ?? []).length;
    expect(page.mainEntity.length).toBe(qtd);
    expect(qtd).toBeGreaterThan(0);
  });

  it('produtos têm SoftwareApplication com ofertas em BRL', () => {
    for (const f of ['mckbot.html', 'mck-mensagens.html']) {
      const app = jsonLd(readFileSync(path.join(EMPRESA, f), 'utf8'))[0]['@graph'].find((n: any) => n['@type'] === 'SoftwareApplication');
      expect(app.offers.length).toBe(2);
      for (const o of app.offers) { expect(o.priceCurrency).toBe('BRL'); expect(Number(o.price)).toBeGreaterThan(0); }
    }
  });
});

describe('raiz do app: SEO sem quebrar o React', () => {
  it('index.html tem description, canonical para a raiz, verificação do Search Console e o #root com conteúdo estático', () => {
    const html = readFileSync(path.join(WEB, 'index.html'), 'utf8');
    expect(html).toContain('<link rel="canonical" href="https://mckbot.onrender.com/" />');
    expect(html).toContain('<meta name="google-site-verification" content="rdaXqM9TD2Du7cMhAdreVM4lB35CmbSZdb8ZNeJQ12M" />');
    expect(html).toMatch(/<title>MCK DESENVOLVIMENTO/);
    expect(html).toMatch(/<meta name="description" content="[^"]+MCK Desenvolvimento/);
    expect(html).toMatch(/<div id="root">[\s\S]*href="\/empresa\/"[\s\S]*<\/div>/);
    expect(html).toContain('<script type="module" src="/src/main.tsx"></script>');
  });
  it('mensagem.html é noindex,follow', () => {
    expect(readFileSync(path.join(WEB, 'mensagem.html'), 'utf8')).toContain('<meta name="robots" content="noindex,follow" />');
  });
  it('sitemap tem lastmod em todas as URLs e robots aponta para ele', () => {
    const xml = readFileSync(path.join(WEB, 'public/sitemap.xml'), 'utf8');
    expect((xml.match(/<url>/g) ?? []).length).toBe((xml.match(/<lastmod>\d{4}-\d{2}-\d{2}<\/lastmod>/g) ?? []).length);
    expect(readFileSync(path.join(WEB, 'public/robots.txt'), 'utf8')).toContain('Sitemap: https://mckbot.onrender.com/sitemap.xml');
  });
});

describe('raiz "/" = landing da empresa (etapa 2)', () => {
  const landing = readFileSync(path.join(EMPRESA, 'index.html'), 'utf8');
  it('home do site tem canonical na raiz, title e verificação do Search Console', () => {
    expect(landing).toContain('<link rel="canonical" href="https://mckbot.onrender.com/">');
    expect(landing).toContain('<meta name="google-site-verification" content="rdaXqM9TD2Du7cMhAdreVM4lB35CmbSZdb8ZNeJQ12M">');
    expect(landing).toMatch(/<title>MCK DESENVOLVIMENTO · /);
    expect(landing).not.toMatch(/noindex/);
    expect(landing).toContain('href="/login"');
    expect(landing).toContain('58.460.367/0001-78');
  });
  it('sitemap tem a raiz, não tem /empresa/ (canônica é a raiz) e todas as URLs com lastmod', () => {
    const xml = readFileSync(path.join(WEB, 'public/sitemap.xml'), 'utf8');
    expect(xml).toContain('<loc>https://mckbot.onrender.com/</loc>');
    expect(xml).not.toContain('<loc>https://mckbot.onrender.com/empresa/</loc>');
  });
  it('arquivo de chave do IndexNow publicado na raiz', () => {
    const keys = readdirSync(path.join(WEB, 'public')).filter((f) => /^[a-f0-9]{32}\.txt$/.test(f));
    expect(keys.length).toBe(1);
    expect(readFileSync(path.join(WEB, 'public', keys[0]), 'utf8').trim()).toBe(keys[0].slice(0, 32));
  });
  it('service worker não guarda a landing como casca do app', () => {
    expect(readFileSync(path.join(WEB, 'public/sw.js'), 'utf8')).toContain("res.headers.get('X-MCK-Shell') === 'app'");
  });
});
