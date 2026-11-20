import { describe, it, expect } from 'vitest';
import {
  fatorDe, temEmbalagem, embalagensParaBase, baseParaEmbalagens, precoPorBase, precoPorEmbalagem, arredondarCompra,
  qtdComEmbalagem, linhaCompra, descricaoEmbalagem, aceitaDecimal, lerQtdMil,
} from '../../server/erp/shared/embalagem.js';

const pacote10 = { unidade: 'PC', unidadeCompra: 'PCT', fatorCompraMil: 10_000 };

describe('unidade de compra × unidade de estoque (v1.32.0)', () => {
  it('5 pacotes × 10 peças = 50 peças, e volta', () => {
    expect(embalagensParaBase(5000, 10_000)).toBe(50_000);
    expect(baseParaEmbalagens(50_000, 10_000)).toBe(5000);
    expect(baseParaEmbalagens(55_000, 10_000)).toBe(5500); // 5,5 pacotes
  });

  it('preço por pacote ↔ preço por peça (o total é o mesmo)', () => {
    expect(precoPorBase(2000, 10_000)).toBe(200); // R$ 20,00 o pacote = R$ 2,00 a peça
    expect(precoPorEmbalagem(200, 10_000)).toBe(2000);
    expect(5 * 2000).toBe(50 * 200);
  });

  it('linha completa: "5 pacotes (50 peças) · R$ 20,00/pacote · R$ 2,00/peça · Total R$ 100,00"', () => {
    const l = linhaCompra(50_000, 200, pacote10);
    expect(l.texto).toBe('5 pacotes (50 peças) · R$ 20,00/pacote · R$ 2,00/peça · Total R$ 100,00');
    expect(l.totalCents).toBe(10_000);
  });

  it('preço por peça quebrado (R$ 20,00 / 3): o total bate com o pedido de compra (quantidade × preço por unidade)', () => {
    const p = { unidade: 'UN', unidadeCompra: 'CX', fatorCompraMil: 3000 };
    expect(precoPorBase(2000, 3000)).toBe(667);
    const l = linhaCompra(6000, 667, p);
    expect(l.totalCents).toBe(Math.round((6000 * 667) / 1000)); // mesmo cálculo do item do pedido de compra
    expect(l.quantidade).toBe('2 caixas (6 unidades)');
  });

  it('quilo aceita decimal: 2,5 kg, saco com 2,5 kg', () => {
    expect(aceitaDecimal('KG')).toBe(true);
    expect(aceitaDecimal('UN')).toBe(false);
    expect(lerQtdMil('2,5')).toBe(2500);
    const saco = { unidade: 'KG', unidadeCompra: 'SC', fatorCompraMil: 2500 };
    expect(descricaoEmbalagem(saco)).toBe('saco com 2,5 kg');
    expect(qtdComEmbalagem(10_000, saco)).toBe('4 sacos (10 kg)');
    expect(linhaCompra(2500, 1000, { unidade: 'KG' }).texto).toBe('2,5 kg · R$ 10,00/kg · Total R$ 25,00');
  });

  it('sugestão arredonda para embalagem inteira; sem embalagem, unidade inteira ou 0,1 kg', () => {
    expect(arredondarCompra(41_000, pacote10)).toBe(50_000);
    expect(arredondarCompra(40_000, pacote10)).toBe(40_000);
    expect(arredondarCompra(4300, { unidade: 'UN' })).toBe(5000);
    expect(arredondarCompra(2_430, { unidade: 'KG' })).toBe(2_500);
    expect(arredondarCompra(0, pacote10)).toBe(0);
  });

  it('produto antigo (sem embalagem, fator 1000) não muda nada', () => {
    const antigo = { unidade: 'UN', unidadeCompra: null, fatorCompraMil: 1000 };
    expect(temEmbalagem(antigo)).toBe(false);
    expect(qtdComEmbalagem(15_000, antigo)).toBe('15 unidades');
    expect(linhaCompra(15_000, 500, antigo).texto).toBe('15 unidades · R$ 5,00/unidade · Total R$ 75,00');
  });

  it('fator inválido vira 1 por 1; unidade numérica legada vira "unidades"', () => {
    expect(fatorDe({ fatorCompraMil: 0 })).toBe(1000);
    expect(fatorDe({ fatorCompraMil: -5 })).toBe(1000);
    expect(fatorDe({ fatorCompraMil: null })).toBe(1000);
    expect(qtdComEmbalagem(5000, { unidade: '30' })).toBe('5 unidades');
  });
});
