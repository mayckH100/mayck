import { describe, it, expect } from 'vitest';
import { paginaHtml } from '../../web/src/erp/impressao/modelo';
import { htmlRelatorioDia, htmlListaProdutos, htmlFichaProduto, geradoEmSP } from '../../web/src/erp/impressao/relatorios';
import { RODAPE_DOCUMENTO } from '../../server/erp/shared/documento';

const agora = new Date('2026-11-26T14:05:00Z'); // 11:05 em São Paulo
const XSS = '<script>alert(1)</script>';
const pagina = (d: { titulo: string; corpo: string; css?: string }) => paginaHtml({ ...d, config: { nomeExibicao: 'Loja Teste' } as any });

describe('impressão de relatórios e produtos (v1.54.1)', () => {
  it('data de geração no fuso de São Paulo', () => {
    expect(geradoEmSP(agora)).toBe('26/11/2026 11:05');
  });

  it('relatório do dia: título, período, geração, indicadores, rodapé e escape', () => {
    const r = { vendas: { totalCents: 12345, pedidos: 3, balcao: 1 }, recebidoCents: 10000, pagoCents: 2500, cmvCents: 4000,
      porForma: { PIX: { receber: 10000, pagar: 0 } }, alteracoes: [{ hora: '10:00', quem: XSS, acao: 'Preço', antes: '{"a":1}', depois: '"><img src=x onerror=1>' }] };
    const d = htmlRelatorioDia(r, '2026-11-25', agora);
    expect(d.titulo).toBe('Relatório do dia 25/11/2026');
    const h = pagina(d);
    expect(h).toContain('<div class="mck-cab-titulo">Relatório do dia 25/11/2026</div>'); // v1.55.0: título na faixa do cabeçalho
    expect(h).toContain('Período: 25/11/2026');
    expect(h).toContain('Gerado em 26/11/2026 11:05');
    expect(h).toContain('3 pedido(s) · 1 no balcão');
    expect(h).toContain('PIX');
    expect(h).toContain('Loja Teste');
    expect(h).toContain(RODAPE_DOCUMENTO);
    expect(h).not.toContain('<script>');
    expect(h).not.toContain('<img src=x');
    expect(h).toContain('&lt;script&gt;');
    expect(pagina(htmlRelatorioDia({ vendas: {}, porForma: {}, alteracoes: [] }, '2026-11-25', agora))).toContain('Nenhuma alteração sensível');
  });

  it('lista de produtos: filtro da busca, colunas, estoque só para quem não é serviço, rodapé e escape', () => {
    const itens = [
      { sku: '0001', nome: XSS, unidade: 'KG', precoBaseCents: 1990, tipo: 'REVENDA', ativo: true, saldo: { disponivelMil: 2500 }, abaixoMinimo: true },
      { sku: '0002', nome: 'Instalação', unidade: 'UN', precoBaseCents: 5000, tipo: 'SERVICO', ativo: false },
    ];
    const d = htmlListaProdutos(itens, { busca: '<b>cola</b>' }, agora);
    const h = pagina(d);
    expect(d.titulo).toBe('Lista de produtos');
    expect(h).toContain('Busca: “&lt;b&gt;cola&lt;/b&gt;”');
    expect(h).toContain('2 produto(s)');
    expect(h).toContain('Gerado em 26/11/2026 11:05');
    for (const c of ['Código', 'Produto', 'Unidade', 'Preço', 'Estoque disponível']) expect(h).toContain(`>${c}</th>`);
    expect(h).toContain('2,5 ⚠');
    expect(h).toContain('(arquivado)');
    expect(h).toContain(RODAPE_DOCUMENTO);
    expect(h).not.toContain('<script>');
    expect(pagina(htmlListaProdutos([], {}, agora))).toContain('Todos os produtos');
  });

  it('ficha do produto: título com código e nome, campos preenchidos, rodapé e escape', () => {
    const p = { sku: '0007', nome: 'Parafuso "M6"', tipo: 'INSUMO', unidade: 'UN', precoBaseCents: 50, custoMedioCents: 20, ncm: '73181500', descricao: `linha 1\n${XSS}`,
      custosAdicionais: JSON.stringify([{ nome: 'Embalagem', valorCents: 5 }]), estoqueMinimoMil: 100000, pontoPedidoMil: 0, leadTimeDias: 3, ativo: true, saldo: { disponivelMil: 1000, reservadoMil: 0 } };
    const d = htmlFichaProduto(p, { custoTotalCents: 25, fornecedor: 'Fornecedor <X>' }, agora);
    expect(d.titulo).toBe('Ficha do produto 0007 · Parafuso "M6"');
    const h = pagina(d);
    expect(h).toContain('<title>Ficha do produto 0007 · Parafuso &quot;M6&quot;</title>');
    expect(h).toContain('Gerado em 26/11/2026 11:05');
    expect(h).toContain('73181500');
    expect(h).toContain('Insumo / matéria-prima');
    expect(h).toContain('Fornecedor &lt;X&gt;');
    expect(h).toContain('Embalagem');
    expect(h).toContain('linha 1<br>');
    expect(h).toContain('3 dia(s)');
    expect(h).toContain(RODAPE_DOCUMENTO);
    expect(h).not.toContain('<script>');
    expect(h.indexOf('<footer class="mck-rodape"')).toBeGreaterThan(h.indexOf('73181500'));
  });
});
