/** v1.33.0 — regras puras do rastreio de lote e do relatório Físico x Sistema do inventário. */
import { describe, it, expect } from 'vitest';
import { identificarBusca, textoEvento, categoriaMovimento, contaComoRecebido, csvRastreio, numeroLoteLegivel } from '../../server/erp/estoque/rastreio-regras.js';
import { relatorioInventario, resumoDivergencia, csvInventario } from '../../server/erp/estoque/inventario-relatorio.js';

describe('busca única do rastreio', () => {
  it('identifica chave de NF-e, número (pedido/NF), código de barras e texto', () => {
    expect(identificarBusca('3526 1100 0000 0000 0000 5500 1000 0012 3410 0001 2345').tipos).toEqual(['chave_nfe']);
    expect(identificarBusca('nº 12')).toMatchObject({ tipos: ['numero', 'texto'], numero: 12 });
    expect(identificarBusca('PC 7').numero).toBe(7);
    expect(identificarBusca('7891234567895').tipos).toEqual(['codigo_barras', 'numero', 'texto']);
    expect(identificarBusca('L2611-0001')).toMatchObject({ tipos: ['texto'], numero: null });
    expect(identificarBusca('  ').tipos).toEqual([]);
  });
  it('frases da linha do tempo em português simples', () => {
    expect(textoEvento({ tipo: 'ENTRADA', qtdMil: 5000, docTipo: 'nfe_entrada', motivo: null, doc: { rotulo: 'NF-e nº 10/1', fornecedor: 'Forn' }, endereco: 'Loja · A-01' })).toBe('Entrada pela NF-e nº 10/1 de Forn (Loja · A-01)');
    expect(textoEvento({ tipo: 'SAIDA', qtdMil: -1000, docTipo: 'pedido_venda', motivo: null, doc: { rotulo: 'Pedido de venda nº 3', cliente: 'Maria', nf: 'NF nº 9' } })).toBe('Saída: Pedido de venda nº 3 para Maria · NF nº 9');
    expect(textoEvento({ tipo: 'AJUSTE', qtdMil: -1000, docTipo: 'ajuste', motivo: 'Quebra' })).toBe('Baixa manual: Quebra');
    expect(categoriaMovimento({ tipo: 'AJUSTE', qtdMil: 1000, docTipo: 'inicial' })).toBe('entrada');
    expect(contaComoRecebido({ tipo: 'TRANSFERENCIA_ENTRADA', qtdMil: 1000, docTipo: 'transferencia' })).toBe(false);
    expect(contaComoRecebido({ tipo: 'ENTRADA', qtdMil: 1000, docTipo: 'ajuste' })).toBe(true);
    expect(numeroLoteLegivel('UNICO')).toBe('L-INICIAL');
  });
  it('CSV com ; , BOM e sem fórmula', () => {
    const csv = csvRastreio({ lote: { numero: 'L1', loteFornecedor: null, produto: '=HYPERLINK()', fornecedor: null, entradaEm: '', documentoEntrada: 'x;y', validade: '', recebida: '1', saldo: '1', unidade: 'un' }, locais: [], eventos: [], destinos: [], origens: [] });
    expect(csv.startsWith('\uFEFF')).toBe(true);
    expect(csv).toContain("Produto;'=HYPERLINK()");
    expect(csv).toContain('"x;y"');
  });
});

describe('relatório Físico x Sistema', () => {
  const base = { produtoId: 'p', unidade: 'UN', loteFornecedor: null, local: 'Loja · A-01' };
  const r = relatorioInventario([
    { ...base, id: '1', sku: 'A', nome: 'Alfa', loteId: 'l1', lote: 'L1', sistemaMil: 10_000, contadoMil: 8_000, custoUnitCents: 250 },
    { ...base, id: '2', sku: 'B', nome: 'Beta', loteId: 'l2', lote: 'L2', sistemaMil: 5_000, contadoMil: 6_000, custoUnitCents: 1_000 },
    { ...base, id: '3', sku: 'C', nome: 'Gama', loteId: 'l3', lote: 'L3', sistemaMil: 3_000, contadoMil: null, custoUnitCents: 100 },
    { ...base, id: '4', sku: 'D', nome: 'Delta', loteId: 'l4', lote: 'L4', sistemaMil: 2_000, contadoMil: 2_000, custoUnitCents: 100 },
  ]);
  it('diferença em quantidade e R$, não contado = zero, totais e maior divergência', () => {
    expect(r.linhas.find((l) => l.sku === 'A')).toMatchObject({ diferencaMil: -2_000, diferencaCents: -500, situacao: 'falta' });
    expect(r.linhas.find((l) => l.sku === 'C')).toMatchObject({ contadoFinalMil: 0, diferencaMil: -3_000, diferencaCents: -300 });
    expect(r.totais).toMatchObject({ linhas: 4, divergentes: 3, sobras: 1, faltas: 2, sobrasCents: 1_000, faltasCents: 800, liquidoCents: 200 });
    expect(r.totais.maior).toMatchObject({ sku: 'B', diferencaCents: 1_000 });
  });
  it('resumo para o proprietário traz só quantos itens, a maior divergência e o valor', () => {
    const t = resumoDivergencia('Geral', r.totais);
    expect(t).toContain('Itens com diferença: *3* de 4');
    expect(t).toContain('Maior diferença: *Beta* (cód. B), lote L2');
    expect(t).toContain('Valor líquido: *+R$ 2,00*');
    expect(t).not.toContain('Alfa');
    expect(csvInventario('Geral', r)).toContain('Valor líquido (R$);2,00');
  });
});
