import { describe, it, expect } from 'vitest';
import {
  erpStockStatus, formatQtdMil, mergeCatalogErp, formatAiItemLine, erpItem, mentionsSku, erpRules, ERP_PUBLIC_SELECT,
  isProductSource, type ErpPublic,
} from '../../server/ai/productSource.js';
import { matchProducts, formatLinesBlock } from '../../server/ai/products.js';

const erp = (o: Partial<ErpPublic> = {}): ErpPublic => ({
  id: 'e1', sku: 'CAM-01', nome: 'Camiseta Básica', descricao: 'Algodão', codigoBarras: '2000000000015', unidade: 'UN',
  tipo: 'REVENDA', estoqueMinimoMil: 0, precoBaseCents: 4990, ...o,
});

describe('v1.24.0 · fonte dos produtos da IA (regras puras)', () => {
  it('situação do estoque: disponível, poucas unidades, sem estoque, sob encomenda', () => {
    expect(erpStockStatus(20_000, { tipo: 'REVENDA' })).toBe('disponivel');
    expect(erpStockStatus(5_000, { tipo: 'REVENDA' })).toBe('poucas');
    expect(erpStockStatus(1, { tipo: 'REVENDA' })).toBe('poucas');
    expect(erpStockStatus(8_000, { tipo: 'REVENDA', estoqueMinimoMil: 10_000 })).toBe('poucas');
    expect(erpStockStatus(0, { tipo: 'REVENDA' })).toBe('sem_estoque');
    expect(erpStockStatus(-3, { tipo: 'REVENDA' })).toBe('sem_estoque');
    expect(erpStockStatus(0, { tipo: 'PRODUZIDO' })).toBe('sob_encomenda');
    expect(erpStockStatus(0, { tipo: 'SERVICO' })).toBe('disponivel');
  });

  it('quantidade em milésimos com unidade', () => {
    expect(formatQtdMil(3_000, 'UN')).toBe('3 UN');
    expect(formatQtdMil(12_500, 'kg')).toBe('12,5 KG');
    expect(formatQtdMil(1_234_000, 'UN')).toBe('1.234 UN');
  });

  it('linha do ERP: só a situação por padrão; quantidade só quando ligada; sem estoque nunca mostra número', () => {
    const it1 = { ...erpItem(erp()), disponivelMil: 12_000 };
    const hidden = formatAiItemLine(it1, false);
    expect(hidden).toContain('Disponível');
    expect(hidden).not.toMatch(/12 UN/);
    expect(hidden).toContain('preço R$ 49,90');
    expect(hidden).toContain('cód. CAM-01');
    expect(formatAiItemLine(it1, true)).toContain('Disponível (12 UN)');
    const zero = formatAiItemLine({ ...erpItem(erp()), disponivelMil: 0 }, true);
    expect(zero).toContain('Sem estoque');
    expect(zero).not.toContain('(0');
    expect(formatAiItemLine({ ...erpItem(erp({ precoBaseCents: 0 })), disponivelMil: 3_000 }, true)).toContain('preço não cadastrado');
  });

  it('"os dois": liga pelo SKU citado ou pelo nome; catálogo dá descrição/promo/link, ERP dá o estoque', () => {
    const catalog = [
      { id: 'c1', name: 'Camiseta Básica Preta', details: 'cód CAM-01; tamanhos P M G', priceCents: 5990, promoCents: 3990, description: 'Linda', link: 'https://loja.com/cam', active: true, stock: 'esgotado' },
      { id: 'c2', name: 'Caneca Azul', details: '', priceCents: null, promoCents: null, description: '', active: true },
      { id: 'c3', name: 'Vaso', details: '', priceCents: 1000, promoCents: null, description: '', active: true, stock: 'sob_encomenda' },
      { id: 'c4', name: 'Desativado', details: '', active: false },
    ];
    const erps = [erp(), erp({ id: 'e2', sku: 'CAN-9', nome: 'caneca  azul', precoBaseCents: 2500, descricao: 'Cerâmica' }), erp({ id: 'e3', sku: 'XYZ', nome: 'Só no ERP', descricao: null })];
    const m = mergeCatalogErp(catalog as any, erps);
    expect(m.map((i) => i.key)).toEqual(['cat:c1', 'cat:c2', 'cat:c3', 'erp:e3']);
    expect(m[0].erp?.id).toBe('e1');
    expect(m[0]).toMatchObject({ priceCents: 5990, promoCents: 3990, description: 'Linda', link: 'https://loja.com/cam' });
    expect(m[1].erp?.id).toBe('e2');
    expect(m[1]).toMatchObject({ priceCents: 2500, description: 'Cerâmica' });
    expect(m[2].erp).toBeUndefined();
    const line = formatAiItemLine({ ...m[0], disponivelMil: 2_000 }, false);
    expect(line).toContain('promoção R$ 39,90 (de R$ 59,90)');
    expect(line).toContain('Poucas unidades');
    expect(line).not.toContain('Esgotado'); // o estoque do catálogo não vale quando ligado ao ERP
    expect(line).toContain('detalhes: cód CAM-01; tamanhos P M G');
    // item só do catálogo continua com a linha do catálogo
    expect(formatAiItemLine(m[2], true)).toContain('Sob encomenda');
  });

  it('SKU só liga como código inteiro (e não com SKU curto)', () => {
    expect(mentionsSku('Camiseta CAM-01 preta', 'cam-01')).toBe(true);
    expect(mentionsSku('Camiseta CAM-012', 'CAM-01')).toBe(false);
    expect(mentionsSku('A1 B2', 'A1')).toBe(false);
  });

  it('busca reaproveita o ranking do catálogo: acha por nome, SKU e código de barras', () => {
    const items = [erpItem(erp()), erpItem(erp({ id: 'e2', sku: 'FON-7', nome: 'Fone Bluetooth', codigoBarras: '7891234567895', descricao: 'sem fio' }))];
    expect(matchProducts('quanto custa a camiseta?', items).map((i) => i.key)).toEqual(['erp:e1']);
    expect(matchProducts('tem o FON-7?', items)[0].key).toBe('erp:e2');
    expect(matchProducts('7891234567895', items)[0].key).toBe('erp:e2');
  });

  it('orçamento de 1800 caracteres e regras sem custo', () => {
    const long = Array.from({ length: 5 }, (_, i) => formatAiItemLine({ ...erpItem(erp({ id: `x${i}`, descricao: 'y'.repeat(600) })), disponivelMil: 9_000 }, false));
    expect(formatLinesBlock('[Produtos do ERP]', long).length).toBeLessThanOrEqual(1800);
    expect(erpRules('erp', false)).toContain('Não informe quantidade');
    expect(erpRules('erp', true)).toContain('Pode informar a quantidade');
    expect(erpRules('ambos', false)).toContain('Nunca informe custo');
    expect(erpRules('erp', false)).toContain('[Produtos do ERP]');
  });

  it('a consulta ao ERP nunca seleciona custo, custos adicionais ou fornecedor', () => {
    const keys = Object.keys(ERP_PUBLIC_SELECT);
    for (const k of ['custoMedioCents', 'custosAdicionais', 'fornecedorPadraoId', 'leadTimeDias']) expect(keys).not.toContain(k);
    expect(isProductSource('ambos')).toBe(true);
    expect(isProductSource('outro')).toBe(false);
  });
});
