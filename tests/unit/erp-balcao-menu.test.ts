import { describe, it, expect } from 'vitest';
import { ERP_ITENS } from '../../web/src/erp/ErpNav';
import { contem } from '../../server/lib/busca';

// Relato do dono (04/11, v1.13.1): "no ERP não está aparecendo venda no balcão".
// A venda balcão só existia como um botão dentro de Pedidos; o menu do ERP não tinha a entrada.
describe('ERP · venda balcão visível no menu', () => {
  it('o menu do MCK ERP tem "Venda balcão (PDV)" com a área de vendas', () => {
    const item = ERP_ITENS.find((i) => i.to === '/erp/balcao');
    expect(item).toBeTruthy();
    expect(item!.label).toMatch(/Venda balcão/);
    expect(item!.module).toBe('erp_vendas');
    // v1.37.0 (menu em áreas): primeira subcategoria de Vendas, e Vendas logo depois do Início, para o cliente achar
    expect(item!.pai).toBe('/erp/vendas');
    expect(ERP_ITENS.filter((i) => i.pai === '/erp/vendas')[0].to).toBe('/erp/balcao');
    expect(ERP_ITENS.filter((i) => !i.pai).map((i) => i.to).indexOf('/erp/vendas')).toBe(1);
  });
});

describe('Busca sem diferenciar maiúsculas (PostgreSQL)', () => {
  it('no Postgres usa mode insensitive; no SQLite não (o SQLite não aceita "mode")', () => {
    expect(contem('caneta', true)).toEqual({ contains: 'caneta', mode: 'insensitive' });
    expect(contem('caneta', false)).toEqual({ contains: 'caneta' });
  });
});
