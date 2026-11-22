import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

// Blog do site /empresa (v1.39.0): gerado por scripts/site-blog.py a partir de content/blog/*.md.
const ROOT = path.resolve(__dirname, '../..');
const EMPRESA = path.join(ROOT, 'web/public/empresa');
const BLOG = path.join(EMPRESA, 'blog');
const BASE = 'https://mckbot.onrender.com';
const artigos = readdirSync(path.join(ROOT, 'content/blog')).filter((f) => f.endsWith('.md')).map((f) => f.replace(/\.md$/, ''));

function graph(html: string): any[] {
  return [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].flatMap((m) => {
    const d = JSON.parse(m[1]);
    return d['@graph'] ?? [d];
  });
}
const tipos = (html: string) => graph(html).flatMap((n) => [].concat(n['@type']));
const texto = (html: string) => (html.match(/<article class="post">([\s\S]*?)<\/article>/)?.[1] ?? '').replace(/<[^>]+>/g, ' ').split(/\s+/).filter(Boolean).length;

describe('blog /empresa/blog', () => {
  it('tem 8 artigos e o índice', () => {
    expect(artigos.length).toBeGreaterThanOrEqual(8);
    const gerados = readdirSync(BLOG).filter((f) => f.endsWith('.html'));
    expect(gerados.sort()).toEqual(['index.html', ...artigos.map((s) => `${s}.html`)].sort());
  });

  for (const slug of artigos) {
    it(`${slug}: SEO, JSON-LD, FAQ, CTA e links internos`, () => {
      const html = readFileSync(path.join(BLOG, `${slug}.html`), 'utf8');
      const url = `${BASE}/empresa/blog/${slug}.html`;
      expect(html).toContain(`<link rel="canonical" href="${url}">`);
      expect(html).toContain(`<meta property="og:url" content="${url}">`);
      expect(html).toMatch(/<title>[^<]{20,} \| MCK Desenvolvimento<\/title>/);
      expect(html).toMatch(/<meta name="description" content="[^"]{80,170}">/);
      expect(html.match(/<h1[ >]/g)?.length).toBe(1);
      expect(html.match(/<h2 id=/g)?.length ?? 0).toBeGreaterThanOrEqual(4);
      const t = tipos(html);
      for (const tipo of ['Organization', 'WebSite', 'BreadcrumbList', 'BlogPosting', 'FAQPage']) expect(t, tipo).toContain(tipo);
      const post = graph(html).find((n) => n['@type'] === 'BlogPosting');
      expect(post.author.name).toBe('Equipe MCK Desenvolvimento');
      expect(post.datePublished).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      const faq = graph(html).find((n) => n['@type'] === 'FAQPage');
      expect(faq.mainEntity.length).toBeGreaterThanOrEqual(3);
      expect(html.match(/<details><summary>/g)?.length).toBe(faq.mainEntity.length);
      const crumbs = graph(html).find((n) => n['@type'] === 'BreadcrumbList').itemListElement.map((i: any) => i.item);
      expect(crumbs).toEqual([`${BASE}/`, `${BASE}/empresa/blog/`, url]);
      expect(html).toContain('href="/cadastro">Teste grátis 7 dias</a>');
      for (const link of ['/empresa/mckbot.html', '/empresa/planos.html']) expect(html, link).toContain(`href="${link}"`);
      expect(html).toMatch(/href="\/empresa\/blog\/[a-z0-9-]+\.html"/);
      const n = texto(html);
      expect(n, 'palavras').toBeGreaterThanOrEqual(1000);
      expect(n, 'palavras').toBeLessThanOrEqual(2200);
      // mesmo visual do site: topo e rodapé do molde, menu com Blog
      expect(html).toContain('<header class="site">');
      expect(html).toContain('<a href="/empresa/blog/">Blog</a>');
      expect(html).toContain('<footer class="site">');
    });
  }

  it('índice: CollectionPage com a lista de todos os artigos', () => {
    const html = readFileSync(path.join(BLOG, 'index.html'), 'utf8');
    expect(html).toContain(`<link rel="canonical" href="${BASE}/empresa/blog/">`);
    expect(tipos(html)).toEqual(expect.arrayContaining(['Blog', 'CollectionPage', 'BreadcrumbList', 'Organization']));
    for (const slug of artigos) expect(html).toContain(`href="/empresa/blog/${slug}.html"`);
  });

  it('sitemap tem o blog e os artigos; menu e rodapé do site com Blog', () => {
    const sm = readFileSync(path.join(ROOT, 'web/public/sitemap.xml'), 'utf8');
    expect(sm).toContain(`<loc>${BASE}/empresa/blog/</loc>`);
    for (const slug of artigos) expect(sm).toContain(`<loc>${BASE}/empresa/blog/${slug}.html</loc>`);
    for (const f of readdirSync(EMPRESA).filter((x) => x.endsWith('.html'))) {
      const h = readFileSync(path.join(EMPRESA, f), 'utf8');
      expect(h, f).toContain('<a href="/empresa/blog/">Blog</a>');
      expect(h, f).toContain('class="ft-blog" href="/empresa/blog/"');
    }
  });

  it('páginas por segmento apontam para artigos relacionados', () => {
    for (const f of readdirSync(EMPRESA).filter((x) => x.startsWith('whatsapp-para-'))) {
      const h = readFileSync(path.join(EMPRESA, f), 'utf8');
      expect(h, f).toMatch(/<!-- blog-links:start -->[\s\S]*href="\/empresa\/blog\/[a-z0-9-]+\.html"[\s\S]*<!-- blog-links:end -->/);
    }
  });
});

describe('migração 0064: corrige a novidade de 03/11 (IA só transfere quando o cliente pede)', () => {
  const dir = readdirSync(path.join(ROOT, 'prisma/migrations')).find((d) => /^\d{4}_corrige_novidade_2026_11_03$/.test(d));
  it('só troca a frase da publicação de id fixo, sem apagar nada', () => {
    expect(dir).toBeTruthy();
    const code = readFileSync(path.join(ROOT, 'prisma/migrations', dir!, 'migration.sql'), 'utf8').split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
    expect(code).not.toMatch(/\b(DROP|DELETE|TRUNCATE|ALTER|INSERT)\b/i);
    expect(code).toMatch(/UPDATE "SocialPost"/);
    expect(code).toMatch(/WHERE "id" = 'nov-2026-11-03-fluxos-ia-site'/);
    expect(code).toMatch(/AND "body" LIKE '%Quando a IA não sabe responder, ela passa a conversa para uma pessoa da sua equipe.%'/);
    expect(code).toContain('Se o cliente pedir para falar com uma pessoa, a conversa vai para a sua equipe.');
  });
});
