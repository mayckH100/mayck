import { describe, it, expect } from 'vitest';
import { transicionar } from '../../server/erp/shared/statemachine.js';
import { maquinaCompra, vencedoras, divergenciasRecebimento } from '../../server/erp/compras/compra.machine.js';
import { criaCiclo, necessidadeComponente, custoPadrao, calcularMrp, type ProdutoMrp } from '../../server/erp/producao/mrp.js';

describe('ERP · compras', () => {
  it('alçada: acima do limite só gestor aprova', () => {
    const c = { itens: 1, totalCents: 600_000, alcadaCents: 500_000 };
    expect(transicionar(maquinaCompra, 'EM_APROVACAO', 'APROVAR', { ...c, gestor: false })).toMatchObject({ ok: false });
    expect(transicionar(maquinaCompra, 'EM_APROVACAO', 'APROVAR', { ...c, gestor: true })).toMatchObject({ ok: true, para: 'APROVADO' });
    expect(transicionar(maquinaCompra, 'EM_APROVACAO', 'APROVAR', { ...c, totalCents: 400_000, gestor: false })).toMatchObject({ ok: true });
  });
  it('mapa de cotação: menor preço, empate pelo menor prazo, ignora preço zero', () => {
    const m = vencedoras([
      { itemId: 'i1', parceiroId: 'A', precoUnitCents: 1000, prazoEntregaDias: 10 },
      { itemId: 'i1', parceiroId: 'B', precoUnitCents: 1000, prazoEntregaDias: 3 },
      { itemId: 'i1', parceiroId: 'C', precoUnitCents: 0, prazoEntregaDias: 1 },
      { itemId: 'i2', parceiroId: 'A', precoUnitCents: 500, prazoEntregaDias: 5 },
    ]);
    expect(m.get('i1')?.parceiroId).toBe('B'); expect(m.get('i2')?.parceiroId).toBe('A');
  });
  it('recebimento: acusa preço fora da tolerância, excesso e item fora do pedido', () => {
    const pedido = [{ produtoId: 'p1', qtdMil: 10_000, recebidoMil: 4_000, precoUnitCents: 1000 }];
    expect(divergenciasRecebimento([{ produtoId: 'p1', sku: 'A', qtdMil: 6_000, custoUnitCents: 1015 }], pedido, 200)).toEqual([]);
    const d = divergenciasRecebimento([{ produtoId: 'p1', sku: 'A', qtdMil: 7_000, custoUnitCents: 1100 }, { produtoId: 'p2', sku: 'B', qtdMil: 1000, custoUnitCents: 1 }], pedido, 200);
    expect(d).toHaveLength(3);
  });
});

describe('ERP · produção e MRP', () => {
  const est = [
    { produtoId: 'BOLO', componenteId: 'MASSA', qtdMil: 1000, perdaBp: 0 },
    { produtoId: 'MASSA', componenteId: 'FARINHA', qtdMil: 500, perdaBp: 1000 }, // 0,5 kg + 10% perda
  ];
  it('estrutura sem ciclo e explosão com perda', () => {
    expect(criaCiclo(est, 'FARINHA', 'BOLO')).toBe(true);
    expect(criaCiclo(est, 'BOLO', 'FARINHA')).toBe(false);
    expect(criaCiclo(est, 'X', 'X')).toBe(true);
    expect(necessidadeComponente(10_000, est[1])).toBe(5_500);
  });
  it('custo padrão multinível com operação', () => {
    expect(custoPadrao('BOLO', est, new Map([['FARINHA', 400]]), new Map([['BOLO', 300]]))).toBe(520); // 0,55 × 4,00 + 3,00
  });
  it('MRP multinível: produz o pai e compra o insumo pela demanda dependente', () => {
    const p = (id: string, tipo: string, extra: Partial<ProdutoMrp> = {}): ProdutoMrp => ({ id, sku: id, nome: id, tipo, leadTimeDias: 0, estoqueMinimoMil: 0, pontoPedidoMil: 0, loteMinimoMil: 0, ...extra });
    const s = calcularMrp({
      produtos: [p('FARINHA', 'INSUMO', { loteMinimoMil: 25_000 }), p('BOLO', 'PRODUZIDO'), p('MASSA', 'PRODUZIDO')],
      estrutura: est,
      disponivelMil: new Map([['BOLO', 2_000], ['FARINHA', 1_000]]),
      demandaMil: new Map([['BOLO', 12_000]]),
      dependenteMil: new Map(), programadoMil: new Map(),
    });
    expect(s.map((x) => [x.produtoId, x.acao, x.qtdMil])).toEqual([['BOLO', 'PRODUZIR', 10_000], ['MASSA', 'PRODUZIR', 10_000], ['FARINHA', 'COMPRAR', 25_000]]);
    expect(s[2].necessidadeMil).toBe(4_500); // 5,5 − 1,0 disponível; lote mínimo 25
  });
});
