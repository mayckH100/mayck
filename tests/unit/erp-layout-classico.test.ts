import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { ERP_ITENS, ROTAS_ANTIGAS, ROTAS_V137, abaAtiva, grupoAtivo } from '../../web/src/erp/ErpNav';

/**
 * v1.50.0 — dono (23/11): "quero layout ERP das primeiras versões, ficou muito confuso o novo". Volta o layout de
 * abas da v1.36.0 (antes das áreas/telas-resumo da v1.37.0), sem perder nenhuma tela nem endereço.
 */
const app = readFileSync('web/src/App.tsx', 'utf8');
const rotasApp = new Set([...app.matchAll(/<Route path="(\/erp[^"]*)"/g)].map((m) => m[1]));

describe('MCK ERP · layout clássico (abas da v1.36.0)', () => {
  it('abas de cima na ordem das primeiras versões, com o Resumo logo depois da Venda balcão', () => {
    expect(ERP_ITENS.filter((i) => !i.pai).map((i) => i.label)).toEqual(['Painel CRM', 'Venda balcão (PDV)', 'Resumo', 'Funil de vendas', 'Clientes', 'Fornecedores', 'Pedidos', 'Produtos', 'Estoque', 'Rastreio de lote', 'Compras', 'Produção', 'Financeiro', 'Fiscal', 'Maquininhas', 'BI', 'Alertas']);
    expect(app).not.toMatch(/Resumos'.*VendasResumo|itensDoMenu/);
    expect(app).toMatch(/<ErpAbas \/>/);
  });
  it('toda aba tem tela', () => {
    for (const i of ERP_ITENS) expect(rotasApp.has(i.to), i.to).toBe(true);
  });
  it('os endereços da v1.37 (subcategorias) continuam e caem na aba certa', () => {
    const v137: [string, string][] = [
      ['/erp/compras/o-que-comprar', '/erp/compras'], ['/erp/compras/ordens', '/erp/compras'], ['/erp/compras/avisos', '/erp/compras'], ['/erp/compras/configuracoes', '/erp/compras'],
      ['/erp/estoque/saldos', '/erp/estoque'], ['/erp/estoque/lotes', '/erp/estoque'], ['/erp/estoque/entrada-xml', '/erp/estoque'], ['/erp/estoque/etiquetas', '/erp/estoque'], ['/erp/estoque/inventario', '/erp/estoque'], ['/erp/estoque/movimentacoes', '/erp/estoque'], ['/erp/estoque/depositos', '/erp/estoque'],
      ['/erp/producao/ordens', '/erp/producao'], ['/erp/producao/mrp', '/erp/producao'], ['/erp/financeiro/pagar', '/erp/financeiro'], ['/erp/financeiro/receber', '/erp/financeiro'], ['/erp/financeiro/dre', '/erp/financeiro'],
      ['/erp/fiscal/notas', '/erp/fiscal'], ['/erp/fiscal/emitente', '/erp/fiscal'], ['/erp/fiscal/regras', '/erp/fiscal'], ['/erp/pedidos/123', '/erp/pedidos'], ['/erp/balcao/ler', '/erp/balcao'],
    ];
    for (const [rota, aba] of v137) { expect(rotasApp.has(rota) || rota === '/erp/pedidos/123', rota).toBe(true); expect(grupoAtivo(rota), rota).toBe(aba); }
    expect(app).toMatch(/path="\/erp\/estoque\/entrada-xml" element={<ErpEstoque key="xml" aba="xml" \/>}/);
  });
  it('telas que só existiam na v1.37 e sinônimos redirecionam para uma tela que existe', () => {
    expect(ROTAS_V137['/erp/vendas']).toBe('/erp/pedidos');
    expect(ROTAS_V137['/erp/configuracoes']).toBe('/erp/alertas');
    for (const [de, para] of Object.entries(ROTAS_ANTIGAS)) {
      expect(rotasApp.has(de), `${de} sem rota de redirecionamento`).toBe(false); // vem do map de ROTAS_ANTIGAS
      expect(rotasApp.has(para.split('?')[0]), `${de} → ${para}`).toBe(true);
    }
    expect(app).toMatch(/Object\.keys\(ROTAS_ANTIGAS\)\.map/);
  });
  it('Funcionários e Relatórios seguem no menu lateral do ERP; aba ativa de tela fora das abas é nula', async () => {
    const { MODULOS } = await import('../../web/src/modulos');
    const erp = MODULOS.find((m) => m.id === 'erp')!;
    expect(erp.items.map((i) => i.to)).toEqual(expect.arrayContaining(['/erp/funcionarios', '/erp/relatorios', '/erp/resumo']));
    expect(abaAtiva('/erp/relatorios')).toBeNull();
  });
});
