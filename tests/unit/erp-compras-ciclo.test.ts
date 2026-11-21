import { describe, it, expect } from 'vitest';
import { transicionar, eventosPermitidos } from '../../server/erp/shared/statemachine.js';
import { maquinaCompra, ROTULO_STATUS_COMPRA, ETAPAS_COMPRA, EVENTOS_TELA, type StatusCompra, type EventoCompra, type CtxCompra } from '../../server/erp/compras/compra.machine.js';
import { situacaoPrazo, calcularPrevisao, diaDe, diasEntre, preencherTexto, cobrarFornecedorHoje, TEXTO_FORN_ATRASO, agoraNoFuso } from '../../server/erp/compras/prazo.js';

const ctx: CtxCompra = { itens: 1, totalCents: 10_000, gestor: true, alcadaCents: 500_000, motivo: 'x' };
function caminho(inicio: StatusCompra, eventos: EventoCompra[], c: Partial<CtxCompra> = {}) {
  let s = inicio;
  for (const e of eventos) {
    const r = transicionar(maquinaCompra, s, e, { ...ctx, ...c });
    if (!r.ok) throw new Error(`${s} --${e}--> ${r.erro}`);
    s = r.para;
  }
  return s;
}

describe('ERP · ciclo da ordem de compra (v1.36.0)', () => {
  it('fluxo completo sem qualidade: negociação → aprovação → emitida → chegou → NF → conferência → liberada → em estoque', () => {
    expect(caminho('RASCUNHO', ['ENVIAR', 'APROVAR', 'ENVIAR_FORNECEDOR', 'REGISTRAR_ENTREGA', 'NF_ENTRADA', 'CONCLUIR_CONFERENCIA', 'FINALIZAR'])).toBe('RECEBIDO');
  });
  it('fluxo com qualidade: NF → aguardando qualidade → liberar → conferência; reprovar volta a aguardar entrega', () => {
    expect(caminho('ENVIADO', ['REGISTRAR_ENTREGA', 'NF_ENTRADA_QUALIDADE'])).toBe('AGUARDANDO_QUALIDADE');
    expect(caminho('AGUARDANDO_QUALIDADE', ['LIBERAR_QUALIDADE', 'CONCLUIR_CONFERENCIA'])).toBe('LIBERADA_ESTOQUE');
    expect(caminho('AGUARDANDO_QUALIDADE', ['REPROVAR_QUALIDADE'])).toBe('ENVIADO');
    expect(transicionar(maquinaCompra, 'AGUARDANDO_QUALIDADE', 'REPROVAR_QUALIDADE', { ...ctx, motivo: null })).toMatchObject({ ok: false });
    // NF-e não dá entrada enquanto a qualidade não liberar
    expect(transicionar(maquinaCompra, 'AGUARDANDO_QUALIDADE', 'RECEBER', ctx)).toMatchObject({ ok: false });
  });
  it('NF-e lançada dá entrada de qualquer etapa de recebimento (atalho) e parcial volta a aguardar o restante', () => {
    for (const s of ['APROVADO', 'ENVIADO', 'RECEBIDO_PARCIAL', 'AGUARDANDO_NF', 'EM_CONFERENCIA', 'LIBERADA_ESTOQUE'] as StatusCompra[]) {
      expect(transicionar(maquinaCompra, s, 'RECEBER', ctx)).toMatchObject({ ok: true, para: 'RECEBIDO' });
      expect(transicionar(maquinaCompra, s, 'RECEBER_PARCIAL', ctx)).toMatchObject({ ok: true, para: 'RECEBIDO_PARCIAL' });
    }
  });
  it('cancelar só antes do recebimento e com motivo', () => {
    for (const s of ['RASCUNHO', 'EM_APROVACAO', 'APROVADO', 'ENVIADO'] as StatusCompra[]) expect(transicionar(maquinaCompra, s, 'CANCELAR', ctx)).toMatchObject({ ok: true, para: 'CANCELADO' });
    for (const s of ['RECEBIDO_PARCIAL', 'AGUARDANDO_NF', 'AGUARDANDO_QUALIDADE', 'EM_CONFERENCIA', 'LIBERADA_ESTOQUE', 'RECEBIDO'] as StatusCompra[]) expect(transicionar(maquinaCompra, s, 'CANCELAR', ctx)).toMatchObject({ ok: false });
    expect(transicionar(maquinaCompra, 'ENVIADO', 'CANCELAR', { ...ctx, motivo: '' })).toMatchObject({ ok: false });
  });
  it('aprovar e reprovar: só gestor (o sistema aprova sozinho dentro da alçada)', () => {
    expect(transicionar(maquinaCompra, 'EM_APROVACAO', 'APROVAR', { ...ctx, gestor: false })).toMatchObject({ ok: false });
    expect(transicionar(maquinaCompra, 'EM_APROVACAO', 'APROVAR', { ...ctx, gestor: false, auto: true })).toMatchObject({ ok: true });
    expect(transicionar(maquinaCompra, 'EM_APROVACAO', 'APROVAR', { ...ctx, gestor: false, auto: true, totalCents: 600_000 })).toMatchObject({ ok: false });
    expect(transicionar(maquinaCompra, 'EM_APROVACAO', 'REPROVAR', { ...ctx, gestor: false })).toMatchObject({ ok: false });
  });
  it('finalizar à mão é bloqueado quando há NF-e vinculada pendente', () => {
    expect(transicionar(maquinaCompra, 'LIBERADA_ESTOQUE', 'FINALIZAR', { ...ctx, nfPendente: true })).toMatchObject({ ok: false });
  });
  it('toda etapa tem rótulo em português e a tela só mostra eventos manuais', () => {
    for (const e of ETAPAS_COMPRA) expect(ROTULO_STATUS_COMPRA[e]).toBeTruthy();
    expect(ROTULO_STATUS_COMPRA.RASCUNHO).toBe('OC em negociação');
    expect(ROTULO_STATUS_COMPRA.RECEBIDO).toBe('Em estoque (finalizada)');
    expect(eventosPermitidos(maquinaCompra, 'ENVIADO').filter((e) => EVENTOS_TELA.includes(e))).toEqual(['REGISTRAR_ENTREGA', 'NF_ENTRADA', 'CANCELAR']);
    expect(EVENTOS_TELA).not.toContain('NF_ENTRADA_QUALIDADE');
  });
});

describe('ERP · prazo de entrega da OC', () => {
  it('pedido de refrigerante com entrega prevista 10/11/2026, visto em 20/11: atrasado há 10 dias', () => {
    const s = situacaoPrazo({ status: 'ENVIADO', previsaoEntrega: new Date('2026-11-10T00:00:00Z') }, '2026-11-20');
    expect(s).toMatchObject({ codigo: 'ATRASADO', dias: 10, rotulo: 'Atrasado há 10 dias', cor: 'red', previsaoDia: '2026-11-10' });
  });
  it('no prazo, chega em breve (≤ N dias, configurável), hoje e amanhã', () => {
    const p = (d: string) => ({ status: 'APROVADO', previsaoEntrega: new Date(`${d}T12:00:00Z`) });
    expect(situacaoPrazo(p('2026-11-30'), '2026-11-20')).toMatchObject({ codigo: 'NO_PRAZO', dias: 10, rotulo: 'No prazo · faltam 10 dias' });
    expect(situacaoPrazo(p('2026-11-22'), '2026-11-20')).toMatchObject({ codigo: 'EM_BREVE', dias: 2 });
    expect(situacaoPrazo(p('2026-11-22'), '2026-11-20', 1)).toMatchObject({ codigo: 'NO_PRAZO' });
    expect(situacaoPrazo(p('2026-11-21'), '2026-11-20').rotulo).toBe('Chega amanhã');
    expect(situacaoPrazo(p('2026-11-20'), '2026-11-20').rotulo).toBe('Chega hoje');
    expect(situacaoPrazo(p('2026-11-19'), '2026-11-20')).toMatchObject({ codigo: 'ATRASADO', dias: 1, rotulo: 'Atrasado há 1 dia' });
  });
  it('depois da chegada: entregue no prazo ou com atraso; sem data e cancelada', () => {
    expect(situacaoPrazo({ status: 'EM_CONFERENCIA', previsaoEntrega: new Date('2026-11-10T12:00:00Z'), entregueEm: new Date('2026-11-13T15:00:00Z') }, '2026-11-20')).toMatchObject({ codigo: 'ENTREGUE_ATRASADO', dias: 3 });
    expect(situacaoPrazo({ status: 'RECEBIDO', previsaoEntrega: new Date('2026-11-10T12:00:00Z'), entregueEm: new Date('2026-11-09T15:00:00Z') }, '2026-11-20')).toMatchObject({ codigo: 'ENTREGUE' });
    expect(situacaoPrazo({ status: 'RASCUNHO', previsaoEntrega: null }, '2026-11-20')).toMatchObject({ codigo: 'SEM_DATA' });
    expect(situacaoPrazo({ status: 'CANCELADO', previsaoEntrega: new Date('2026-11-01T12:00:00Z') }, '2026-11-20')).toMatchObject({ codigo: 'NA' });
  });
  it('previsão = dia da emissão (fuso da empresa) + prazo; data de calendário não volta um dia em Brasília', () => {
    // 20/11 23:30 em Brasília = 21/11 02:30 UTC → emissão conta como 20/11
    expect(diaDe(calcularPrevisao(new Date('2026-11-21T02:30:00Z'), 5))).toBe('2026-11-25');
    expect(diaDe(new Date('2026-11-10T00:00:00Z'))).toBe('2026-11-10');
    expect(diaDe(new Date('2026-11-10T02:00:00Z'))).toBe('2026-11-09');
    expect(diasEntre('2026-11-10', '2026-11-20')).toBe(10);
    expect(agoraNoFuso('America/Sao_Paulo', new Date('2026-11-21T02:30:00Z'))).toEqual({ dia: '2026-11-20', hora: 23 });
  });
  it('texto modelo do fornecedor e ritmo da cobrança (1º dia e a cada 3 dias)', () => {
    const t = preencherTexto(TEXTO_FORN_ATRASO, { fornecedor: 'Bebidas Sul', empresa: 'Mercado X', numero: '12', data_prevista: '10/11/2026', dias_atraso: '10', itens: 'Refrigerante 2L (24)' });
    expect(t).toContain('pedido de compra nº 12'); expect(t).toContain('10/11/2026'); expect(t).toContain('atrasado há 10 dia(s)'); expect(t).not.toMatch(/\{\w+\}/);
    expect([1, 2, 3, 4, 7, 10].map(cobrarFornecedorHoje)).toEqual([true, false, false, true, true, true]);
    expect(cobrarFornecedorHoje(0)).toBe(false);
  });
});
