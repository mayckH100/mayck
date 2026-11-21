import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { rotaPai, ROTAS_ANTIGAS, ERP_ITENS } from '../../web/src/erp/ErpNav';
import { destinoVoltar } from '../../web/src/erp/Voltar';

// v1.37.1 — dono: "coloca uma seta para voltar tela por tela" e "o BI saiu, não estou achando".
describe('ERP · seta voltar um nível', () => {
  it('rota pai: subcategoria → área; detalhe → lista; área → Início; Início sem seta', () => {
    expect(rotaPai('/erp')).toBeNull();
    expect(rotaPai('/erp/')).toBeNull();
    expect(rotaPai('/inbox')).toBeNull();
    expect(rotaPai('/erp/compras')).toBe('/erp');
    expect(rotaPai('/erp/configuracoes')).toBe('/erp');
    expect(rotaPai('/erp/compras/ordens')).toBe('/erp/compras');
    expect(rotaPai('/erp/estoque/saldos')).toBe('/erp/estoque');
    expect(rotaPai('/erp/produtos')).toBe('/erp/estoque');
    expect(rotaPai('/erp/bi')).toBe('/erp');
    expect(rotaPai('/erp/relatorios')).toBe('/erp');
    expect(rotaPai('/erp/pedidos/localizar')).toBe('/erp/vendas');
    expect(rotaPai('/erp/balcao/ler')).toBe('/erp/vendas');
    expect(rotaPai('/erp/pedidos/abc123')).toBe('/erp/pedidos');
    expect(rotaPai('/erp/clientes/x')).toBe('/erp/clientes');
    expect(rotaPai('/erp/fornecedores/x')).toBe('/erp/fornecedores');
    expect(rotaPai('/erp/caixa/c1')).toBe('/erp/balcao');
    expect(rotaPai('/erp/funcionarios')).toBe('/erp/configuracoes');
  });

  it('usa o histórico (-1) só quando a tela anterior é o destino certo', () => {
    expect(destinoVoltar('/erp', '/erp/compras')).toBeNull();
    expect(destinoVoltar('/erp/compras/ordens', '/erp/compras')).toEqual({ voltar: true });
    expect(destinoVoltar('/erp/compras/ordens', '/erp/estoque/saldos')).toEqual({ ir: '/erp/compras' });
    expect(destinoVoltar('/erp/compras/ordens', null)).toEqual({ ir: '/erp/compras' });
    expect(destinoVoltar('/erp/compras', '/erp')).toEqual({ voltar: true });
    // detalhe: volta para a tela do ERP de onde veio (Localizar, Início, cliente…)
    expect(destinoVoltar('/erp/pedidos/1', '/erp/pedidos/localizar')).toEqual({ voltar: true });
    expect(destinoVoltar('/erp/pedidos/1', '/erp')).toEqual({ voltar: true });
    expect(destinoVoltar('/erp/pedidos/1', '/inbox')).toEqual({ ir: '/erp/pedidos' });
    expect(destinoVoltar('/erp/pedidos/1', null)).toEqual({ ir: '/erp/pedidos' });
  });

  it('a seta está no cabeçalho padrão e nas telas com cabeçalho próprio', () => {
    expect(readFileSync('web/src/erp/pagina.tsx', 'utf8')).toContain('<Voltar /><h1>');
    for (const f of ['bi/Bi.tsx', 'vendas/Pedido.tsx', 'crm/Cliente360.tsx', 'produtos/Produtos.tsx', 'estoque/Rastreio.tsx', 'vendas/Localizar.tsx', 'vendas/Caixa.tsx', 'alertas/Alertas.tsx'])
      expect(readFileSync(`web/src/erp/${f}`, 'utf8'), f).toContain('<Voltar />');
  });

  it('modal fecha com o botão voltar', () => {
    const ui = readFileSync('web/src/ui.tsx', 'utf8');
    expect(ui).toContain('useVoltarFechaModal(onClose)');
    expect(ui).toContain("addEventListener('popstate'");
  });
});

describe('ERP · Indicadores (BI) fácil de achar', () => {
  it('nome no menu e no Início; rotas antigas levam ao BI', () => {
    expect(ERP_ITENS.find((i) => i.to === '/erp/bi')?.label).toBe('Indicadores (BI)');
    for (const r of ['/erp/bi/painel', '/erp/indicadores', '/erp/inicio/indicadores', '/erp/painel-bi']) expect(ROTAS_ANTIGAS[r], r).toBe('/erp/bi');
    const inicio = readFileSync('web/src/erp/inicio/Resumos.tsx', 'utf8');
    expect(inicio).toContain('<BiNoInicio />');
    expect(inicio).toContain('Ver todos os indicadores (BI)');
    expect(inicio).toContain('Avisos de compras');
    expect(ERP_ITENS.find((i) => i.to === '/erp/compras/avisos')?.label).toBe('Avisos de compras');
  });
});
