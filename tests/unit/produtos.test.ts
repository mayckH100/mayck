import { describe, it, expect } from 'vitest';
import { formatBRL, parsePriceToCents, matchProducts, formatProductLine, formatProductsContext, readProductsCsv, normalizeStock, filterProducts, productTemplateCsv, PROMPT_MAX_CHARS } from '../../server/ai/products.js';

const catalog = [
  { name: 'Camiseta Básica', category: 'Roupas', priceCents: 4990, promoCents: 3990, description: 'Camiseta 100% algodão', details: 'cores: preta, branca; tamanhos P, M, G', stock: 'disponivel', quantity: 12, link: 'https://loja.com/camiseta', active: true },
  { name: 'Fiat Uno 2015', category: 'Veículos', priceCents: 3290000, promoCents: null, description: 'Revisado, único dono', details: 'ano 2015; 80.000 km; garantia 3 meses', stock: 'sob_encomenda', quantity: null, active: true },
  { name: 'Fone Bluetooth X', category: 'Eletrônicos', priceCents: 19900, description: '', details: 'garantia 1 ano', stock: 'esgotado', quantity: 0, active: true },
  { name: 'Tênis Corrida', category: 'Calçados', priceCents: 29900, description: 'leve', details: '', stock: 'disponivel', active: false },
];

describe('produtos: preço', () => {
  it('formata em R$', () => {
    expect(formatBRL(4990)).toBe('R$ 49,90');
    expect(formatBRL(3290000)).toBe('R$ 32.900,00');
    expect(formatBRL(5)).toBe('R$ 0,05');
  });
  it('lê preço em formatos brasileiros e internacionais', () => {
    expect(parsePriceToCents('49,90')).toBe(4990);
    expect(parsePriceToCents('R$ 1.234,56')).toBe(123456);
    expect(parsePriceToCents('32.900,00')).toBe(3290000);
    expect(parsePriceToCents('1.500')).toBe(150000);
    expect(parsePriceToCents('49.90')).toBe(4990);
    expect(parsePriceToCents('1,234.56')).toBe(123456);
    expect(parsePriceToCents('49')).toBe(4900);
    expect(parsePriceToCents('')).toBeNull();
    expect(parsePriceToCents('abc')).toBeNaN();
    expect(parsePriceToCents('-5')).toBeNaN();
  });
});

describe('produtos: busca para a IA', () => {
  it('acha o produto pelo nome, sem acento e ignorando inativos', () => {
    expect(matchProducts('quanto custa a camiseta?', catalog).map((p) => p.name)).toEqual(['Camiseta Básica']);
    expect(matchProducts('vocês têm uno 2015?', catalog)[0].name).toBe('Fiat Uno 2015');
    expect(matchProducts('tem tenis de corrida?', catalog)).toEqual([]); // inativo
  });
  it('acha pelos detalhes (garantia, km)', () => {
    expect(matchProducts('qual a quilometragem, 80.000 km?', catalog)[0].name).toBe('Fiat Uno 2015');
  });
  it('pergunta genérica sobre produtos lista alguns ativos; sem relação não traz nada', () => {
    expect(matchProducts('quais produtos vocês vendem?', catalog).length).toBe(3);
    expect(matchProducts('bom dia', catalog)).toEqual([]);
  });
  it('limita a 5 resultados', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ name: `Caneca modelo ${i}`, priceCents: 1000 + i, active: true }));
    expect(matchProducts('caneca', many)).toHaveLength(5);
  });
});

describe('produtos: formato compacto', () => {
  it('linha com promoção, disponibilidade, detalhes e link', () => {
    const l = formatProductLine(catalog[0]);
    expect(l).toContain('Camiseta Básica');
    expect(l).toContain('promoção R$ 39,90 (de R$ 49,90)');
    expect(l).toContain('Disponível (12 un.)');
    expect(l).toContain('detalhes: cores: preta');
    expect(l).toContain('link: https://loja.com/camiseta');
  });
  it('esgotado, sob encomenda e sem preço', () => {
    expect(formatProductLine(catalog[2])).toContain('Esgotado');
    expect(formatProductLine(catalog[2])).not.toContain('un.');
    expect(formatProductLine(catalog[1])).toContain('Sob encomenda');
    expect(formatProductLine({ name: 'Sem preço' })).toContain('preço não cadastrado');
  });
  it('bloco respeita o limite de caracteres', () => {
    const big = Array.from({ length: 5 }, (_, i) => ({ name: `Produto ${i}`, priceCents: 100, description: 'x'.repeat(1000), details: 'y'.repeat(1000) }));
    const ctx = formatProductsContext(big);
    expect(ctx.startsWith('[Produtos do catálogo]')).toBe(true);
    expect(ctx.length).toBeLessThanOrEqual(PROMPT_MAX_CHARS);
    expect(formatProductsContext([])).toBe('');
  });
});

describe('produtos: planilha CSV', () => {
  it('lê o modelo (;) com aspas e BOM', () => {
    const r = readProductsCsv(productTemplateCsv());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rows.every((x) => x.ok)).toBe(true);
    const [a, b, c] = r.rows.map((x) => (x.ok ? x.data : null)!);
    expect(a).toMatchObject({ name: 'Camiseta Básica', priceCents: 4990, promoCents: 3990, stock: 'disponivel', link: 'https://minhaloja.com.br/camiseta' });
    expect(b).toMatchObject({ name: 'Fiat Uno 2015', priceCents: 3290000, stock: 'sob_encomenda' });
    expect(c).toMatchObject({ stock: 'esgotado', quantity: 0 });
  });
  it('aceita vírgula como separador e aponta erros por linha', () => {
    const r = readProductsCsv('nome,categoria,preco,descricao,detalhes,estoque,link,imagem\nCaneca,Casa,25.00,,,5,,\n,Casa,1,,,,,\nVaso,Casa,abc,,,,,\nPrato,Casa,10,,,,http://inseguro.com,\nCopo,Casa,10,,,talvez,,');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rows[0]).toMatchObject({ ok: true, data: { name: 'Caneca', priceCents: 2500, stock: 'disponivel', quantity: 5 } });
    expect(r.rows.slice(1).map((x) => x.ok)).toEqual([false, false, false, false]);
  });
  it('exige a coluna nome', () => {
    expect(readProductsCsv('produto_x;valor\nA;1').ok).toBe(false);
    expect(readProductsCsv('').ok).toBe(false);
  });
  it('remove início de fórmula (=, +, @)', () => {
    const r = readProductsCsv('nome;preco\n=HYPERLINK("x");10');
    expect(r.ok && r.rows[0].ok && r.rows[0].data.name).toBe('HYPERLINK("x")');
  });
  it('estoque por texto ou número', () => {
    expect(normalizeStock('Sob encomenda')).toEqual({ stock: 'sob_encomenda', quantity: null });
    expect(normalizeStock('Esgotado')).toEqual({ stock: 'esgotado', quantity: null });
    expect(normalizeStock('3')).toEqual({ stock: 'disponivel', quantity: 3 });
    expect(normalizeStock('xyz')).toBeNull();
  });
});

describe('produtos: busca do painel', () => {
  it('filtra sem acento e por vários termos', () => {
    expect(filterProducts(catalog, 'veiculos').map((p) => p.name)).toEqual(['Fiat Uno 2015']);
    expect(filterProducts(catalog, 'garantia ano').map((p) => p.name)).toEqual(['Fiat Uno 2015', 'Fone Bluetooth X']);
    expect(filterProducts(catalog, '')).toHaveLength(4);
  });
});
