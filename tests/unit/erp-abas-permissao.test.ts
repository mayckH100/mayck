import { describe, it, expect } from 'vitest';
import { ERP_ITENS, podeAba } from '../../web/src/erp/ErpNav';

const item = (to: string) => ERP_ITENS.find((i) => i.to === to)!;
const mods = (...m: string[]) => (x: string) => m.includes(x);
const todos = () => true;

describe('abas do ERP por área (v1.55.1)', () => {
  it('permissão antiga sem áreas vê tudo', () => {
    expect(podeAba(item('/erp/financeiro'), mods(), todos)).toBe(true);
  });
  it('só vendas: esconde Financeiro, Fiscal, BI e Produção; mostra Pedidos e Produtos', () => {
    const h = mods('erp_vendas');
    for (const to of ['/erp/financeiro', '/erp/fiscal', '/erp/bi', '/erp/alertas', '/erp/producao']) expect(podeAba(item(to), h, todos)).toBe(false);
    for (const to of ['/erp/pedidos', '/erp/produtos', '/erp/estoque', '/erp/clientes']) expect(podeAba(item(to), h, todos)).toBe(true);
  });
  it('só financeiro: mostra Financeiro, Fiscal, Pedidos e Compras; esconde BI e Produção', () => {
    const h = mods('erp_financeiro');
    for (const to of ['/erp/financeiro', '/erp/fiscal', '/erp/pedidos', '/erp/compras']) expect(podeAba(item(to), h, todos)).toBe(true);
    for (const to of ['/erp/bi', '/erp/producao', '/erp/produtos']) expect(podeAba(item(to), h, todos)).toBe(false);
  });
  it('papel continua valendo', () => {
    expect(podeAba(item('/erp/documentos-impressos'), todos, () => false)).toBe(false);
  });
});
