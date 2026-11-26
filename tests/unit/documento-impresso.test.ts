import { describe, it, expect } from 'vitest';
import { cabecalhoHtml, paginaHtml, rodapeHtml, tituloPedido, cssDocumento } from '../../web/src/erp/impressao/modelo';
import { RODAPE_DOCUMENTO } from '../../server/erp/shared/documento';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

describe('documento impresso · modelo (v1.54.0)', () => {
  it('rodapé é sempre o da MCK, em A4 e no recibo, mesmo sem configuração', () => {
    expect(RODAPE_DOCUMENTO).toBe('Gerado pelo MCK ERP · MCK DESENVOLVIMENTO · mckbot.onrender.com/empresa');
    for (const formato of ['a4', 'recibo'] as const) {
      const h = paginaHtml({ titulo: 't', corpo: '<p>x</p>', config: null, formato });
      expect(h).toContain(RODAPE_DOCUMENTO);
      expect(h.indexOf('<footer class="mck-rodape"')).toBeGreaterThan(h.indexOf('<p>x</p>'));
    }
    expect(rodapeHtml()).toContain(RODAPE_DOCUMENTO);
    const css = cssDocumento('a4'); const print = css.slice(css.indexOf('@media print'));
    expect(print).toContain('.mck-espaco{height:9mm}'); expect(print).toContain('.mck-rodape{position:fixed;left:0;right:0;bottom:0');
  });
  it('cabeçalho escapa texto e só aceita logo em data URL de imagem', () => {
    const h = cabecalhoHtml({ nomeExibicao: '<script>alert(1)</script>', cnpj: '12345678000195', cidade: 'Osasco', uf: 'SP', site: '"><img src=x onerror=alert(1)>', logo: PNG });
    expect(h).not.toContain('<script>');
    expect(h).not.toContain('<img src=x');
    expect(h).toContain('&lt;script&gt;');
    expect(h).toContain('CNPJ 12.345.678/0001-95');
    expect(h).toContain('Osasco/SP');
    expect(h).toContain(`src="${PNG}"`);
    const ruim = cabecalhoHtml({ nomeExibicao: 'A', logo: 'javascript:alert(1)' as any });
    expect(ruim).not.toContain('<img');
    const svg = cabecalhoHtml({ nomeExibicao: 'A', logo: 'data:image/svg+xml;base64,PHN2Zz4=' });
    expect(svg).not.toContain('<img');
  });
  it('título: rascunho = Orçamento; romaneio continua romaneio', () => {
    expect(tituloPedido('pedido', { numero: 12, orcamento: true })).toBe('Orçamento nº 12');
    expect(tituloPedido('pedido', { numero: 12, orcamento: false })).toBe('Pedido de venda nº 12');
    expect(tituloPedido('recibo', { numero: 3 })).toBe('Recibo de venda nº 3');
    expect(tituloPedido('romaneio', { numero: 12, orcamento: true })).toBe('Romaneio de separação / entrega nº 12');
  });
});
