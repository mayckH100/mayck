/** v1.31.0 — alerta do ERP mais claro: unidade legível, uma informação por linha e nada que o WhatsApp sublinhe. */
import { describe, it, expect } from 'vitest';
import { sugestaoCompra, formatarAlerta, trechosParecemTelefone, motivoQuantidade, textoLotes, type DadosAlerta, type ItemEstoqueBaixo } from '../../server/erp/alertas/formato.js';
import { unidadeLegivel, unidadeValida, nomeUnidade, qtdUn } from '../../server/erp/shared/unidade.js';
import { textoConfirmacao } from '../../server/erp/alertas/aprovacao.js';

const canetack = (o: Partial<ItemEstoqueBaixo> = {}): ItemEstoqueBaixo => ({
  produtoId: 'p1', sku: 'MCK0001', nome: 'Canetack', unidade: '30', saldoMil: 5000, minimoMil: 20_000,
  sugestao: sugestaoCompra({ saldoMil: 5000, minimoMil: 20_000, consumoMil: 0, consumoDias: 30, coberturaDias: 30 }),
  consumoDias: 30, coberturaDias: 30, fornecedorId: null, fornecedorNome: null, custoUnitCents: 500, custoOrigem: 'entrada', ...o,
});
const dados = (o: Partial<DadosAlerta> = {}): DadosAlerta => ({
  empresa: 'MCK DESENVOLVIMENTO', hojeIso: '2026-11-20', ontemIso: '2026-11-19', pagar: null, estoqueBaixo: [canetack()],
  parados: null, validade: null, caixa: null, alteracoes: null, ...o,
});

describe('unidade legível', () => {
  it('unidade numérica, vazia ou estranha vira UN; sigla conhecida fica', () => {
    expect(unidadeLegivel('30')).toBe('UN');
    expect(unidadeLegivel('')).toBe('UN');
    expect(unidadeLegivel(null)).toBe('UN');
    expect(unidadeLegivel(' cx ')).toBe('CX');
    expect(unidadeLegivel('M2')).toBe('M2');
    expect(unidadeLegivel('1,5')).toBe('UN');
    expect(unidadeValida('30')).toBe(false);
    expect(unidadeValida('KG')).toBe(true);
  });
  it('por extenso conforme a quantidade', () => {
    expect(qtdUn(15_000, 'UN')).toBe('15 unidades');
    expect(qtdUn(1000, 'UN')).toBe('1 unidade');
    expect(qtdUn(3000, 'CX')).toBe('3 caixas');
    expect(qtdUn(2500, 'KG')).toBe('2,5 kg');
    expect(qtdUn(5000, '30')).toBe('5 unidades');
    expect(nomeUnidade('ZZZ', 2)).toBe('zzz');
  });
});

describe('alerta claro (exemplo real do Canetack)', () => {
  it('uma informação por linha, com rótulos claros e unidade em palavra', () => {
    const [t] = formatarAlerta(dados({ estoqueBaixo: [canetack({ unidade: '30' })] }), { codigo: 'K7P2', limite: 100_000 });
    expect(t).toContain([
      '*1) Canetack* (cód. MCK0001)',
      '📦 Tem hoje: 5 unidades',
      '🎯 Estoque mínimo: 20 unidades',
      '📉 Nenhuma venda nos últimos 30 dias',
      '🛒 *Comprar: 15 unidades*',
      '   _(para voltar ao estoque mínimo)_',
      '💲 Preço por unidade: *R$ 5,00* (última entrada no estoque)',
      '💰 *Total da compra: R$ 75,00*',
      '🏭 Fornecedor: não cadastrado',
    ].join('\n'));
    expect(t).not.toMatch(/\b30\b(?! dias)/); // a unidade "30" não aparece mais
    expect(t).not.toContain('Saldo:');
  });
  it('com consumo mostra a média por dia, quanto dura e o porquê da quantidade', () => {
    const s = sugestaoCompra({ saldoMil: 5000, minimoMil: 20_000, consumoMil: 60_000, consumoDias: 30, coberturaDias: 30 });
    const [t] = formatarAlerta(dados({ estoqueBaixo: [canetack({ unidade: 'UN', sugestao: s })] }), { limite: 100_000 });
    expect(t).toContain('📉 Vende em média 2 unidades por dia · dura uns 2 dias');
    expect(t).toContain('🛒 *Comprar: 75 unidades*');
    expect(t).toContain('_(para ficar com estoque para 30 dias de vendas e ainda manter o mínimo)_');
  });
  it('lote mínimo explica a quantidade', () => {
    const s = sugestaoCompra({ saldoMil: 5000, minimoMil: 20_000, consumoMil: 0, consumoDias: 30, coberturaDias: 30, loteMinimoMil: 50_000 });
    expect(motivoQuantidade({ sugestao: s, coberturaDias: 30, minimoMil: 20_000, saldoMil: 5000 })).toBe('é o lote mínimo de compra deste produto');
  });
  it('lotes interno e do fabricante', () => {
    expect(textoLotes({ lote: 'L2611-0001', loteFabricante: 'ABC123' })).toBe('Lote interno L2611-0001 · Lote fabricante ABC123');
    expect(textoLotes({ lote: 'L2611-0001', loteFabricante: null })).toBe('Lote interno L2611-0001');
  });
});

describe('nada que o WhatsApp sublinhe como telefone', () => {
  it('a heurística pega o padrão antigo', () => {
    expect(trechosParecemTelefone('Saldo: 5 30 · Mínimo: 20 30')).toEqual(['5 30', '20 30']);
    expect(trechosParecemTelefone('Ligue 11 98888-7777')).toHaveLength(1);
    expect(trechosParecemTelefone('Total *R$ 1.234,56* · 15 unidades · 20/11 às 08:00 · L2611-0001')).toEqual([]);
  });
  it('o alerta completo e a confirmação de compra não têm números lado a lado', () => {
    const s = sugestaoCompra({ saldoMil: 5000, minimoMil: 20_000, consumoMil: 60_000, consumoDias: 30, coberturaDias: 30 });
    const d = dados({
      estoqueBaixo: [canetack(), canetack({ produtoId: 'p2', sku: 'MCK0002', nome: 'Caderno', unidade: 'CX', sugestao: s, fornecedorId: 'f', fornecedorNome: 'Papelaria Boa', custoOrigem: 'compra', custoUnitCents: 123_456 })],
      pagar: [{ quem: 'Luz', descricao: 'Conta de luz', abertoCents: 125_090, vencimento: new Date('2026-11-18T00:00:00Z'), empresa: true }],
      parados: { dias: 15, itens: [{ sku: 'GEL1', nome: 'Geleia', unidade: '12', saldoMil: 12_000, diasParado: 40, ultimaSaida: new Date('2026-10-10T00:00:00Z'), valorCents: 9600 }] },
      validade: { dias: 30, lotes: [{ sku: 'LEI1', nome: 'Leite', unidade: 'UN', lote: 'L2611-0001', loteFabricante: 'ABC123', validade: new Date('2026-11-25T00:00:00Z'), dias: 5, saldoMil: 24_000, valorCents: 10_800 }] },
      caixa: [{ conta: 'Caixa', status: 'FECHADO', abertoPor: 'Ana', abertoEm: '19/11 às 08:02', aberturaCents: 10_000, porForma: { DINHEIRO: { qtd: 12, valorCents: 48_000 } }, totalVendasCents: 48_000, qtdVendas: 12, sangriasCents: 0, suprimentosCents: 0, movimentos: [], fechadoPor: 'Ana', fechadoEm: '19/11 às 18:10', contadoCents: 57_500, esperadoCents: 58_000, diferencaCents: -500, observacao: null }],
      alteracoes: [{ hora: '10:15', dia: '2026-11-19', quem: 'Bruno', acao: 'Entrada manual de estoque', item: 'Canetack (cód. MCK0001)', detalhe: 'Entraram 30 unidades', tipo: 'estoque' }],
    });
    const t = formatarAlerta(d, { codigo: 'K7P2', limite: 100_000 }).join('\n');
    expect(trechosParecemTelefone(t)).toEqual([]);
    expect(t).toContain('Dinheiro parado no estoque (preço de custo)');
    expect(t).toContain('Tem 12 unidades');
    const c = textoConfirmacao('K7P2', [{ tipo: 'pedido', numero: 12, fornecedor: 'Papelaria Boa', totalCents: 7500, itens: [1] } as any], [{ n: 1, produtoId: 'p1', sku: 'MCK0001', nome: 'Canetack', unidade: 'UN', qtdMil: 15_000, fornecedorId: null, fornecedorNome: null, custoUnitCents: 500 } as any], 'https://app.test/erp/compras');
    expect(c).toContain('🛒 Quantidade: 15 unidades');
    expect(trechosParecemTelefone(c)).toEqual([]);
  });
});
