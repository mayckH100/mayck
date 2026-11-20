import { describe, it, expect } from 'vitest';
import { sugestaoCompra, formatarAlerta, dividirMensagens, acoesSugeridas, blocosAlerta, type DadosAlerta, type ItemEstoqueBaixo } from '../../server/erp/alertas/formato.js';
import { lerOpcoes, OPCOES_PADRAO, semSaidaDiasDe } from '../../server/erp/alertas/opcoes.js';
import { interpretarAprovacao, semPreferencia, lerRespostaIa, casarFornecedor, gerarCodigo, textoConfirmacao } from '../../server/erp/alertas/aprovacao.js';

const item = (o: Partial<ItemEstoqueBaixo> = {}): ItemEstoqueBaixo => ({
  produtoId: 'p1', sku: 'CAF-500', nome: 'Café 500 g', unidade: 'UN', saldoMil: 4000, minimoMil: 10_000,
  sugestao: sugestaoCompra({ saldoMil: 4000, minimoMil: 10_000, consumoMil: 36_000, consumoDias: 30, coberturaDias: 30 }),
  consumoDias: 30, coberturaDias: 30, fornecedorId: 'f1', fornecedorNome: 'Distribuidora Boa Vista', custoUnitCents: 1250, custoOrigem: 'compra', ...o,
});

const dados = (o: Partial<DadosAlerta> = {}): DadosAlerta => ({
  empresa: 'Mercadinho Exemplo', hojeIso: '2026-11-20', ontemIso: '2026-11-19',
  pagar: [{ quem: 'Luz', descricao: 'Conta de luz', abertoCents: 25_000, vencimento: new Date('2026-11-18T00:00:00Z'), empresa: true }],
  estoqueBaixo: [item(), item({ produtoId: 'p2', sku: 'ACU-1', nome: 'Açúcar 1 kg', saldoMil: 0, minimoMil: 5000, sugestao: sugestaoCompra({ saldoMil: 0, minimoMil: 5000, consumoMil: 0, consumoDias: 30, coberturaDias: 30 }), fornecedorId: null, fornecedorNome: null, custoUnitCents: 450, custoOrigem: 'medio' })],
  parados: { dias: 15, itens: [{ sku: 'GEL-1', nome: 'Geleia', unidade: 'UN', saldoMil: 12_000, diasParado: 40, ultimaSaida: new Date('2026-10-11T00:00:00Z'), valorCents: 9600 }] },
  validade: { dias: 30, lotes: [
    { sku: 'IOG-1', nome: 'Iogurte', unidade: 'UN', lote: '261101-1', validade: new Date('2026-11-17T00:00:00Z'), dias: -3, saldoMil: 6000, valorCents: 1800 },
    { sku: 'LEI-1', nome: 'Leite', unidade: 'UN', lote: '261105-2', validade: new Date('2026-11-25T00:00:00Z'), dias: 5, saldoMil: 24_000, valorCents: 10_800 },
  ] },
  caixa: [{ conta: 'Caixa', status: 'FECHADO', abertoPor: 'Ana', abertoEm: '19/11 às 08:02', aberturaCents: 10_000, porForma: { DINHEIRO: { qtd: 12, valorCents: 48_000 }, PIX: { qtd: 8, valorCents: 36_000 }, CARTAO: { qtd: 0, valorCents: 0 } }, totalVendasCents: 84_000, qtdVendas: 20, sangriasCents: 20_000, suprimentosCents: 0, movimentos: [{ tipo: 'SANGRIA', valorCents: 20_000, motivo: 'Depósito no banco', quem: 'Ana', hora: '19/11 às 14:30' }], fechadoPor: 'Ana', fechadoEm: '19/11 às 18:10', contadoCents: 37_500, esperadoCents: 38_000, diferencaCents: -500, observacao: 'Troco errado' }],
  alteracoes: [{ hora: '10:15', dia: '2026-11-19', quem: 'Bruno', acao: 'Preço de venda alterado', item: 'Café 500 g (cód. CAF-500)', detalhe: 'de *R$ 18,90* para *R$ 19,90*', tipo: 'preco' }],
  ...o,
});

describe('alerta diário v1.30.0 · sugestão de compra', () => {
  it('sem consumo: compra o que falta para o mínimo', () => {
    expect(sugestaoCompra({ saldoMil: 4000, minimoMil: 10_000, consumoMil: 0, consumoDias: 30, coberturaDias: 30 })).toMatchObject({ faltaMil: 6000, sugeridaMil: 6000, duraDias: null });
  });
  it('com consumo: cobre os dias escolhidos e ainda fica no mínimo', () => {
    // 1,2/dia × 30 dias = 36 + mínimo 10 − saldo 4 = 42
    const s = sugestaoCompra({ saldoMil: 4000, minimoMil: 10_000, consumoMil: 36_000, consumoDias: 30, coberturaDias: 30 });
    expect(s.sugeridaMil).toBe(42_000);
    expect(s.duraDias).toBe(3);
  });
  it('arredonda para unidade inteira, soma prazo do fornecedor e respeita lote mínimo', () => {
    expect(sugestaoCompra({ saldoMil: 0, minimoMil: 1500, consumoMil: 1000, consumoDias: 30, coberturaDias: 30 }).sugeridaMil).toBe(3000);
    expect(sugestaoCompra({ saldoMil: 0, minimoMil: 1000, consumoMil: 30_000, consumoDias: 30, coberturaDias: 10, leadTimeDias: 5 }).sugeridaMil).toBe(16_000);
    expect(sugestaoCompra({ saldoMil: 0, minimoMil: 1000, consumoMil: 0, consumoDias: 30, coberturaDias: 30, loteMinimoMil: 24_000 }).sugeridaMil).toBe(24_000);
  });
});

describe('alerta diário v1.30.0 · opções', () => {
  it('sem registro usa os padrões; valores fora da faixa são corrigidos', () => {
    expect(lerOpcoes(null)).toEqual(OPCOES_PADRAO);
    expect(lerOpcoes('{lixo')).toEqual(OPCOES_PADRAO);
    expect(lerOpcoes(JSON.stringify({ validade: false, validadeDias: 9999, consumoDias: 1 }))).toMatchObject({ validade: false, validadeDias: 365, consumoDias: 7, caixa: true });
  });
  it('dias sem saída: 0 continua desligado (quem configurou), ausente vira 15', () => {
    expect(semSaidaDiasDe(0)).toBe(0);
    expect(semSaidaDiasDe(undefined)).toBe(15);
    expect(semSaidaDiasDe(30)).toBe(30);
  });
});

describe('alerta diário v1.30.0 · texto', () => {
  it('cabeçalho com empresa e data, seções numeradas, totais e ações sugeridas', () => {
    const [txt] = formatarAlerta(dados(), { codigo: 'K7P2', limite: 100_000 });
    expect(txt).toContain('🏢 *Mercadinho Exemplo*');
    expect(txt).toContain('Sexta-feira, 20 de novembro');
    expect(txt).toMatch(/\*1\. 💰 Contas a pagar\*/);
    expect(txt).toMatch(/\*2\. 📦 Estoque baixo: o que comprar\*/);
    expect(txt).toMatch(/\*3\. ⏳ Validade dos lotes\*/);
    expect(txt).toMatch(/\*4\. 💤 Produtos parados\*/);
    expect(txt).toMatch(/\*5\. 🧾 Caixa de ontem \(19 de novembro\)\*/);
    expect(txt).toMatch(/\*6\. ✏️ Alterações de ontem/);
    expect(txt).toContain('*1) Café 500 g* (cód. CAF-500)\n📦 Tem hoje: 4 unidades\n🎯 Estoque mínimo: 10 unidades');
    expect(txt).toContain('📉 Vende em média 1,2 unidade por dia · dura uns 3 dias');
    expect(txt).toContain('🛒 *Comprar: 42 unidades*\n   _(para ficar com estoque para 30 dias de vendas e ainda manter o mínimo)_');
    expect(txt).toContain('💲 Preço por unidade: *R$ 12,50* (última compra)\n💰 *Total da compra: R$ 525,00*\n🏭 Fornecedor: Distribuidora Boa Vista');
    expect(txt).toContain('🏭 Fornecedor: não cadastrado');
    expect(txt).toContain('_(para voltar ao estoque mínimo)_');
    expect(txt).toContain('Código da aprovação: *K7P2*');
    expect(txt).toContain('*Faltaram R$ 5,00*');
    expect(txt).toContain('Retirada de R$ 200,00 em 19/11 às 14:30 por Ana — Depósito no banco');
    expect(txt).toContain('Venceu em 17/11');
    expect(txt).toContain('Lote interno 261101-1');
    expect(txt).toContain('Dinheiro parado no estoque (preço de custo): *R$ 96,00*');
    expect(txt).toContain('Às 10:15, Bruno: preço de venda alterado — Café 500 g (cód. CAF-500)\n   de *R$ 18,90* para *R$ 19,90*');
    expect(txt).toContain('*✅ O que fazer hoje*');
    expect(txt).toContain('Comprar 2 itens');
    expect(txt).toContain('Conferir a falta de *R$ 5,00* no Caixa (fechado por Ana)');
  });
  it('seção desligada não aparece e os números seguem a ordem', () => {
    const [txt] = formatarAlerta(dados({ pagar: null, validade: null }), { limite: 100_000 });
    expect(txt).toMatch(/\*1\. 📦 Estoque baixo: o que comprar\*/);
    expect(txt).not.toContain('Contas a pagar');
    expect(txt).not.toContain('Validade');
    expect(txt).not.toContain('Código da aprovação'); // envio sem código (compra pelo WhatsApp desligada): sem instrução
    expect(acoesSugeridas(dados(), null).join('\n')).toContain('em ERP › Compras');
  });
  it('texto longo vira várias mensagens com "(parte N/M)" e nenhuma passa do limite', () => {
    const muitos = Array.from({ length: 15 }, (_, i) => item({ produtoId: `p${i}`, sku: `SKU-${i}`, nome: `Produto com nome comprido número ${i}` }));
    const partes = formatarAlerta(dados({ estoqueBaixo: muitos }), { codigo: 'K7P2', limite: 1500 });
    expect(partes.length).toBeGreaterThan(1);
    for (const p of partes) expect(p.length).toBeLessThanOrEqual(1500 + 30);
    expect(partes[1]).toMatch(/^_\(parte 2\/\d+\)_/);
    expect(partes.join('\n')).toContain('*15) Produto com nome comprido número 14* (cód. SKU-14)');
  });
  it('dividirMensagens corta bloco gigante por linha', () => {
    const bloco = Array.from({ length: 100 }, (_, i) => `linha ${i} ${'x'.repeat(40)}`).join('\n');
    const r = dividirMensagens(['cab', bloco], 1000);
    expect(r.length).toBeGreaterThan(4);
    expect(r.join('\n')).toContain('linha 99');
  });
  it('blocos: prévia mostra "(gerado no envio)"', () => {
    expect(blocosAlerta(dados(), { previa: true }).join('\n')).toContain('Código da aprovação: (gerado no envio)');
  });
});

describe('aprovação pelo WhatsApp · entender a resposta', () => {
  it('variações de aprovado (com/sem acento, maiúsculas, emoji de negrito)', () => {
    for (const t of ['APROVADO', 'aprovado', 'Aprovado!', 'ok aprovado', '*Aprovado*', 'pode comprar', 'Pode comprar sim', 'autorizado', 'aprovo', 'aprovado todos'])
      expect(interpretarAprovacao(t, 5)).toEqual({ acao: 'APROVAR', itens: null, codigo: null });
  });
  it('itens escolhidos: "1,3", "1 e 3", "2-4", com código', () => {
    expect(interpretarAprovacao('APROVADO 1,3', 5)).toMatchObject({ acao: 'APROVAR', itens: [1, 3] });
    expect(interpretarAprovacao('aprovado 1 e 3', 5)).toMatchObject({ itens: [1, 3] });
    expect(interpretarAprovacao('pode comprar 2-4', 5)).toMatchObject({ itens: [2, 3, 4] });
    expect(interpretarAprovacao('Aprovado K7P2 2', 5, ['K7P2'])).toEqual({ acao: 'APROVAR', itens: [2], codigo: 'K7P2' });
    expect(interpretarAprovacao('aprovado k7p2', 5, ['K7P2'])).toEqual({ acao: 'APROVAR', itens: null, codigo: 'K7P2' });
  });
  it('item fora da lista avisa; recusa e conversa comum', () => {
    expect(interpretarAprovacao('aprovado 7', 3)).toMatchObject({ acao: 'INVALIDO' });
    expect(interpretarAprovacao('não aprovado', 3)).toMatchObject({ acao: 'RECUSAR' });
    expect(interpretarAprovacao('nao aprovo', 3)).toMatchObject({ acao: 'RECUSAR' });
    expect(interpretarAprovacao('cancelar', 3)).toMatchObject({ acao: 'RECUSAR' });
    expect(interpretarAprovacao('bom dia, tudo bem?', 3)).toBeNull();
    expect(interpretarAprovacao('ok', 3)).toBeNull(); // ambíguo: fica para a IA (ou segue o caminho normal)
  });
  it('"não" na pergunta do fornecedor', () => {
    for (const t of ['NÃO', 'nao', 'Não.', 'sem preferência', 'tanto faz', 'qualquer um']) expect(semPreferencia(t)).toBe(true);
    expect(semPreferencia('Atacadão')).toBe(false);
  });
  it('resposta da IA: só JSON válido conta; itens fora da lista são ignorados', () => {
    expect(lerRespostaIa('{"acao":"APROVAR","itens":[1,9]}', 3)).toEqual({ acao: 'APROVAR', itens: [1], codigo: null });
    expect(lerRespostaIa('Claro! {"acao":"RECUSAR"}', 3)).toMatchObject({ acao: 'RECUSAR' });
    expect(lerRespostaIa('{"acao":"OUTRO"}', 3)).toBeNull();
    expect(lerRespostaIa('não sei', 3)).toBeNull();
  });
  it('casar fornecedor pelo nome (exato vence, senão todas as palavras)', () => {
    const l = [{ id: 'a', nome: 'Atacadão S.A.', fantasia: 'Atacadão' }, { id: 'b', nome: 'Distribuidora Boa Vista LTDA', fantasia: null }, { id: 'c', nome: 'Boa Vista Bebidas', fantasia: null }];
    expect(casarFornecedor(l, 'atacadao').map((x) => x.id)).toEqual(['a']);
    expect(casarFornecedor(l, 'boa vista').map((x) => x.id)).toEqual(['b', 'c']);
    expect(casarFornecedor(l, 'distribuidora boa').map((x) => x.id)).toEqual(['b']);
    expect(casarFornecedor(l, 'xyz')).toEqual([]);
  });
  it('código de 4 caracteres sem letras/números ambíguos', () => {
    for (let i = 0; i < 50; i++) expect(gerarCodigo()).toMatch(/^[A-HJ-NP-Z2-9]{4}$/);
  });
  it('confirmação: número, fornecedor, itens, quantidades, valor e link', () => {
    const t = textoConfirmacao('K7P2', [{ tipo: 'pedido', id: 'x', numero: 12, fornecedor: 'Distribuidora Boa Vista', itens: [1], totalCents: 52_500 }, { tipo: 'solicitacao', id: 'y', numero: 3, fornecedor: null, itens: [2], totalCents: 2250 }],
      [{ n: 1, produtoId: 'p1', sku: 'CAF-500', nome: 'Café 500 g', unidade: 'UN', qtdMil: 42_000, fornecedorId: 'f1', fornecedorNome: 'Distribuidora Boa Vista', custoUnitCents: 1250 }, { n: 2, produtoId: 'p2', sku: 'ACU-1', nome: 'Açúcar 1 kg', unidade: 'UN', qtdMil: 5000, fornecedorId: null, fornecedorNome: null, custoUnitCents: 450 }], 'https://app.test/erp/compras');
    expect(t).toContain('*Pedido de compra nº 12* — Distribuidora Boa Vista');
    expect(t).toContain('*1) Café 500 g* (cód. CAF-500)\n   🛒 Quantidade: 42 unidades\n   💲 Preço por unidade: *R$ 12,50*\n   💰 Total: *R$ 525,00*');
    expect(t).toContain('*Solicitação de compra nº 3* — sem fornecedor');
    expect(t).toContain('Total de tudo: *R$ 547,50*');
    expect(t).toContain('Nada foi enviado ao fornecedor');
    expect(t).toContain('https://app.test/erp/compras');
  });
});
