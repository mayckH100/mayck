import { describe, it, expect } from 'vitest';
import { ERP_ITENS, abaAtiva, grupoAtivo, subitensDe } from '../../web/src/erp/ErpNav';
import { secaoDaRota, modulosVisiveis, type Acesso } from '../../web/src/modulos';

// Pedido do dono (20/11 17:01, v1.35.0): "Localizar pedido deve ficar dentro da categoria Pedidos" e
// "o leitor deve ser uma subcategoria de Venda no balcão". v1.37.0 (menu em áreas): as duas telas ficam na
// área Vendas, junto de Pedidos e Venda balcão, e continuam fora do primeiro nível do menu.
describe('ERP · Localizar pedido e Ler código dentro de Vendas', () => {
  it('Localizar pedido e Ler código são subcategorias de Vendas', () => {
    const loc = ERP_ITENS.find((i) => i.label === 'Localizar pedido')!;
    expect(loc.to).toBe('/erp/pedidos/localizar');
    expect(loc.pai).toBe('/erp/vendas');
    const ler = ERP_ITENS.find((i) => /Ler código/.test(i.label))!;
    expect(ler.to).toBe('/erp/balcao/ler');
    expect(ler.pai).toBe('/erp/vendas');
    expect(ler.module).toBe('erp_vendas');
    const vendas = subitensDe('/erp/vendas').map((i) => i.to);
    expect(vendas).toEqual(expect.arrayContaining(['/erp/balcao', '/erp/pedidos', '/erp/pedidos/localizar', '/erp/balcao/ler']));
    // nenhum item solto no primeiro nível para essas telas
    expect(ERP_ITENS.filter((i) => !i.pai).some((i) => /Localizar|Ler código|Pedidos/.test(i.label))).toBe(false);
  });

  it('aba e área ativas', () => {
    expect(abaAtiva('/erp/pedidos/localizar')).toBe('/erp/pedidos/localizar');
    expect(grupoAtivo('/erp/pedidos/localizar')).toBe('/erp/vendas');
    expect(abaAtiva('/erp/pedidos/9')).toBe('/erp/pedidos');
    expect(grupoAtivo('/erp/pedidos/9')).toBe('/erp/vendas');
    expect(abaAtiva('/erp/balcao/ler')).toBe('/erp/balcao/ler');
    expect(grupoAtivo('/erp/balcao/ler')).toBe('/erp/vendas');
    expect(grupoAtivo('/erp/balcao')).toBe('/erp/vendas');
    expect(secaoDaRota('/erp/pedidos/localizar')).toBe('Vendas › Localizar pedido');
    expect(secaoDaRota('/erp/balcao/ler')).toBe('Vendas › Ler código');
  });

  it('Ler código segue a permissão de vendas; Localizar a do ERP', () => {
    const a = (mods: string[]): Acesso => ({ can: () => true, hasModule: (m) => mods.includes(m), superAdmin: false });
    const so = (mods: string[]) => modulosVisiveis(a(mods)).find((m) => m.id === 'erp')?.items.map((i) => i.to) ?? [];
    expect(so(['erp_crm'])).toContain('/erp/pedidos/localizar');
    expect(so(['erp_crm'])).not.toContain('/erp/balcao/ler');
    expect(so(['erp_crm', 'erp_vendas'])).toContain('/erp/balcao/ler');
  });
});
