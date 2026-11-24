import { describe, it, expect } from 'vitest';
import { ERP_ITENS, abaAtiva, grupoAtivo, subitensDe } from '../../web/src/erp/ErpNav';
import { secaoDaRota, modulosVisiveis, type Acesso } from '../../web/src/modulos';

// Pedido do dono (20/11 17:01, v1.35.0): "Localizar pedido deve ficar dentro da categoria Pedidos" e
// "o leitor deve ser uma subcategoria de Venda no balcão".
describe('ERP · menu com subitens (Pedidos › Localizar, Venda balcão › Ler código)', () => {
  it('Localizar pedido é subitem de Pedidos e Ler código é subitem de Venda balcão', () => {
    const loc = ERP_ITENS.find((i) => i.label === 'Localizar pedido')!;
    expect(loc.to).toBe('/erp/pedidos/localizar');
    expect(loc.pai).toBe('/erp/pedidos');
    const ler = ERP_ITENS.find((i) => /Ler código/.test(i.label))!;
    expect(ler.to).toBe('/erp/balcao/ler');
    expect(ler.pai).toBe('/erp/balcao');
    expect(ler.module).toBe('erp_vendas');
    expect(subitensDe('/erp/pedidos').map((i) => i.to)).toEqual(['/erp/pedidos/localizar']);
    expect(subitensDe('/erp/balcao').map((i) => i.to)).toEqual(['/erp/balcao/ler']);
    // nenhum item solto no topo para essas duas telas
    expect(ERP_ITENS.filter((i) => !i.pai).some((i) => /Localizar|Ler código/.test(i.label))).toBe(false);
  });

  it('aba e grupo ativos', () => {
    expect(abaAtiva('/erp/pedidos/localizar')).toBe('/erp/pedidos/localizar');
    expect(grupoAtivo('/erp/pedidos/localizar')).toBe('/erp/pedidos');
    expect(abaAtiva('/erp/pedidos/9')).toBe('/erp/pedidos');
    expect(grupoAtivo('/erp/pedidos/9')).toBe('/erp/pedidos');
    expect(abaAtiva('/erp/balcao/ler')).toBe('/erp/balcao/ler');
    expect(grupoAtivo('/erp/balcao/ler')).toBe('/erp/balcao');
    expect(grupoAtivo('/erp/balcao')).toBe('/erp/balcao');
    expect(secaoDaRota('/erp/pedidos/localizar')).toBe('Localizar pedido');
    expect(secaoDaRota('/erp/balcao/ler')).toBe('📷 Ler código');
    expect(secaoDaRota('/erp/balcao')).toBe('Venda balcão (PDV)');
  });

  it('Ler código segue a permissão de vendas; Localizar a do ERP', () => {
    const a = (mods: string[]): Acesso => ({ can: () => true, hasModule: (m) => mods.includes(m), superAdmin: false });
    const so = (mods: string[]) => modulosVisiveis(a(mods)).find((m) => m.id === 'erp')?.items.map((i) => i.to) ?? [];
    expect(so(['erp_crm'])).toContain('/erp/pedidos/localizar');
    expect(so(['erp_crm'])).not.toContain('/erp/balcao/ler');
    expect(so(['erp_crm', 'erp_vendas'])).toContain('/erp/balcao/ler');
  });
});
