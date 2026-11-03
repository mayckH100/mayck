import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { CADASTRO_META, withPageMeta } from '../../server/lib/siteHtml';

// Cartão de prévia no Facebook/WhatsApp: metas no HTML (o robô do Facebook não roda JavaScript).
const IMG = 'https://mckbot.onrender.com/empresa/assets/img/og.jpg';
const paginas: [string, string][] = [
  ['web/public/empresa/index.html', 'https://mckbot.onrender.com/'],
  ['web/public/empresa/planos.html', 'https://mckbot.onrender.com/empresa/planos.html'],
  ['web/public/empresa/mckbot.html', 'https://mckbot.onrender.com/empresa/mckbot.html'],
  ['web/public/empresa/mck-mensagens.html', 'https://mckbot.onrender.com/empresa/mck-mensagens.html'],
  ['web/public/empresa/novidades.html', 'https://mckbot.onrender.com/empresa/novidades'],
  ['web/index.html', 'https://mckbot.onrender.com/'],
];
const meta = (h: string, k: string) => h.match(new RegExp(`<meta (?:property|name)="${k}" content="([^"]*)"`))?.[1];

describe('cartão de prévia (og:image) nas páginas compartilhadas', () => {
  for (const [f, url] of paginas) {
    it(f, () => {
      const h = readFileSync(f, 'utf8');
      expect(meta(h, 'og:title')).toBeTruthy();
      expect(meta(h, 'og:description')).toBeTruthy();
      expect(meta(h, 'og:image')).toBe(IMG);
      expect(meta(h, 'og:image:width')).toBe('1200');
      expect(meta(h, 'og:image:height')).toBe('630');
      expect(meta(h, 'og:url')).toBe(url);
      expect(meta(h, 'twitter:card')).toBe('summary_large_image');
    });
  }
  it('raiz usa o título do cartão "MCK DESENVOLVIMENTO | Atendimento e vendas no WhatsApp com IA"', () => {
    for (const f of ['web/public/empresa/index.html', 'web/index.html']) expect(meta(readFileSync(f, 'utf8'), 'og:title')).toBe('MCK DESENVOLVIMENTO | Atendimento e vendas no WhatsApp com IA');
  });
  it('a imagem existe e tem 1200x630', () => {
    const b = readFileSync('web/public/empresa/assets/img/og.jpg');
    // procura o marcador SOF0/SOF2 do JPEG e lê altura/largura
    let i = 2, w = 0, hgt = 0;
    while (i < b.length) { const m = b[i + 1]; const len = b.readUInt16BE(i + 2); if (m === 0xc0 || m === 0xc2) { hgt = b.readUInt16BE(i + 5); w = b.readUInt16BE(i + 7); break; } i += 2 + len; }
    expect([w, hgt]).toEqual([1200, 630]);
  });
  it('/cadastro troca og:url, título e descrição e mantém imagem e twitter:card', () => {
    const h = withPageMeta(readFileSync('web/index.html', 'utf8'), CADASTRO_META);
    expect(meta(h, 'og:url')).toBe('https://mckbot.onrender.com/cadastro');
    expect(meta(h, 'og:title')).toBe(CADASTRO_META.title);
    expect(meta(h, 'og:description')).toBe(CADASTRO_META.description);
    expect(meta(h, 'og:image')).toBe(IMG);
    expect(meta(h, 'twitter:card')).toBe('summary_large_image');
  });
});
