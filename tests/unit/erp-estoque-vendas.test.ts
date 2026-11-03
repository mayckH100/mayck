import { describe, it, expect } from 'vitest';
import { planejarAlocacao, novoCustoMedio, disponivel } from '../../server/erp/estoque/saldo.js';
import { totalizar, precoPorVolume, motivosBloqueio } from '../../server/erp/vendas/calculo.js';
import { transicionar } from '../../server/erp/shared/statemachine.js';
import { maquinaPedido, financeiroApos } from '../../server/erp/vendas/pedido.machine.js';

const s = (id: string, fisico: number, validade: string | null, extra: Partial<{ reservado: number; quarentena: number; status: string; criado: string }> = {}) => ({
  id, loteId: `l${id}`, enderecoId: 'e', fisicoMil: fisico, reservadoMil: extra.reservado ?? 0, quarentenaMil: extra.quarentena ?? 0,
  lote: { numero: id, status: extra.status ?? 'LIBERADO', validade: validade ? new Date(validade) : null, createdAt: new Date(extra.criado ?? '2026-01-01') },
});

describe('ERP · saldo e alocação', () => {
  const hoje = new Date('2026-11-03');
  it('FEFO pega o que vence antes; ignora vencido, quarentena e reservado', () => {
    const r = planejarAlocacao([s('B', 5000, '2027-05-01'), s('A', 3000, '2027-01-01', { reservado: 1000 }), s('V', 9000, '2026-10-01'), s('Q', 9000, '2026-12-01', { status: 'QUARENTENA' })], 6000, 'FEFO', hoje);
    expect(r.alocacoes.map((a) => [a.saldoId, a.qtdMil])).toEqual([['A', 2000], ['B', 4000]]);
    expect(r.faltaMil).toBe(0);
  });
  it('FIFO pelo lote mais antigo e informa a falta', () => {
    const r = planejarAlocacao([s('N', 1000, null, { criado: '2026-06-01' }), s('O', 1000, null, { criado: '2026-02-01' })], 2500, 'FIFO', hoje);
    expect(r.alocacoes.map((a) => a.saldoId)).toEqual(['O', 'N']);
    expect(r.faltaMil).toBe(500);
  });
  it('disponível nunca negativo e custo médio ponderado', () => {
    expect(disponivel({ fisicoMil: 1000, reservadoMil: 800, quarentenaMil: 500 })).toBe(0);
    expect(novoCustoMedio(10_000, 300, 5_000, 360)).toBe(320);
    expect(novoCustoMedio(-5, 300, 1_000, 400)).toBe(400);
  });
});

describe('ERP · cálculo e máquina do pedido', () => {
  it('totaliza com desconto por item, desconto geral e frete', () => {
    expect(totalizar([{ qtdMil: 2500, precoUnitCents: 1000, descontoBp: 1000 }], 250, 1000)).toEqual({ subtotalCents: 2500, descontoCents: 500, totalCents: 3000, descontoEfetivoBp: 2000 });
    expect(precoPorVolume([{ qtdMinimaMil: 0, precoCents: 100 }, { qtdMinimaMil: 10_000, precoCents: 90 }], 12_000, 120)).toBe(90);
    expect(precoPorVolume([], 1000, 120)).toBe(120);
  });
  it('bloqueia por alçada, crédito e cliente bloqueado', () => {
    const regras = { descontoMaxBp: 1000, bloquearSemCredito: true };
    expect(motivosBloqueio({ descontoEfetivoBp: 500, totalCents: 100 }, regras, { status: 'ATIVO', limiteCreditoCents: 0, emAbertoCents: 9e9 })).toEqual([]);
    expect(motivosBloqueio({ descontoEfetivoBp: 1500, totalCents: 600 }, regras, { status: 'BLOQUEADO', limiteCreditoCents: 1000, emAbertoCents: 500 })).toHaveLength(3);
  });
  it('não fatura sem NF, não cancela depois de faturado, financeiro acompanha', () => {
    const c = { itens: 1, totalCents: 100 };
    expect(transicionar(maquinaPedido, 'RASCUNHO', 'ENVIAR', { itens: 0, totalCents: 0 }).ok).toBe(false);
    expect(transicionar(maquinaPedido, 'SEPARADO', 'FATURAR', c).ok).toBe(false);
    expect(transicionar(maquinaPedido, 'FATURADO', 'CANCELAR', { ...c, motivo: 'x' }).ok).toBe(false);
    expect(transicionar(maquinaPedido, 'RESERVADO', 'CANCELAR', c).ok).toBe(false);
    expect(transicionar(maquinaPedido, 'EM_SEPARACAO', 'CONFERIR', { ...c, tudoSeparado: true })).toMatchObject({ ok: true, para: 'SEPARADO' });
    expect(financeiroApos('APROVADO', 'SEM_TITULO')).toBe('PROVISIONADO');
    expect(financeiroApos('FATURADO', 'PROVISIONADO')).toBe('EM_ABERTO');
  });
});

import { lerNfe, numeroLoteInterno, repartirLotes } from '../../server/erp/estoque/nfe-xml.js';
import { zpl } from '../../server/erp/estoque/etiquetas.js';
import { nfeXml } from '../fixtures/nfe-exemplo.js';

describe('ERP · XML de NF-e, lote interno e etiqueta', () => {
  it('lê emitente, item com custo completo e rastro de lotes', () => {
    const n = lerNfe(nfeXml('12345678000195'));
    expect(n).toMatchObject({ numero: '1234', serie: '1', autorizada: true, valorTotalCents: 13200, emitente: { cnpj: '12345678000195', nome: 'Laticínios Exemplo & Cia LTDA', uf: 'SP' } });
    expect(n.itens[0]).toMatchObject({ codigo: 'LT-CX12', ean: null, unidade: 'CX', qtdMil: 2000, custoTotalCents: 13200 });
    expect(n.itens[0].lotes.map((l) => l.numero)).toEqual(['ABC123', 'ABC124']);
    expect(() => lerNfe('<xml>nada</xml>'.padEnd(200))).toThrow(/não é um XML de NF-e/);
  });
  it('gera lote interno pelo formato e reparte quantidade pelo rastro', () => {
    expect(numeroLoteInterno('{AA}{MM}{DD}-{SEQ}', 7, 'X', new Date(2026, 10, 3))).toBe('261103-00007');
    expect(numeroLoteInterno('{SKU}-{SEQ}', 1, 'leite1')).toBe('LEITE1-00001');
    expect(repartirLotes(30_000, [{ numero: 'A', qtdMil: 12_000, fabricacao: null, validade: null }]).map((p) => [p.numero, p.qtdMil])).toEqual([['A', 12_000], [null, 18_000]]);
  });
  it('ZPL com QR, tamanho e cópias', () => {
    const z = zpl({ qr: '261103-00001', sku: 'LEITE1', nome: 'Leite Ação', unidade: 'UN', lote: '261103-00001', loteFornecedor: 'ABC123', validade: '20/01/2027', fabricacao: null, fornecedor: null }, { larguraMm: 100, alturaMm: 50, dpi: 203, copias: 3 });
    expect(z).toMatch(/^\^XA/); expect(z).toContain('^PW800'); expect(z).toContain('^FDLA,261103-00001'); expect(z).toContain('LOTE FORN. ABC123'); expect(z).toContain('Leite Acao'); expect(z).toContain('^PQ3');
  });
});
