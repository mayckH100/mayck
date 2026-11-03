import { describe, it, expect } from 'vitest';
import { transicionar, eventosPermitidos } from '../../server/erp/shared/statemachine.js';
import { maquinaOportunidade } from '../../server/erp/crm/oportunidade.machine.js';
import { calcularKpis, funil } from '../../server/erp/crm/kpis.js';
import { mapearBrasilApi } from '../../server/erp/crm/cnpj.js';
import { backoffMs } from '../../server/erp/shared/events.js';

const ctx = { valorCents: 1000, parceiroStatus: 'ATIVO' };

describe('ERP · máquina de estados da oportunidade', () => {
  it('ganha só com valor e cliente liberado', () => {
    expect(transicionar(maquinaOportunidade, 'ABERTA', 'GANHAR', ctx)).toMatchObject({ ok: true, para: 'GANHA', emite: ['crm.oportunidade.ganha'] });
    expect(transicionar(maquinaOportunidade, 'ABERTA', 'GANHAR', { ...ctx, valorCents: 0 }).ok).toBe(false);
    expect(transicionar(maquinaOportunidade, 'ABERTA', 'GANHAR', { ...ctx, parceiroStatus: 'BLOQUEADO' }).ok).toBe(false);
  });
  it('perder exige motivo; cancelada é final', () => {
    expect(transicionar(maquinaOportunidade, 'ABERTA', 'PERDER', ctx).ok).toBe(false);
    expect(transicionar(maquinaOportunidade, 'ABERTA', 'PERDER', { ...ctx, motivoPerda: 'Preço' })).toMatchObject({ ok: true, para: 'PERDIDA' });
    expect(transicionar(maquinaOportunidade, 'CANCELADA', 'REABRIR', ctx).ok).toBe(false);
    expect(transicionar(maquinaOportunidade, 'GANHA', 'MOVER', ctx).ok).toBe(false);
    expect(eventosPermitidos(maquinaOportunidade, 'GANHA')).toEqual(['REABRIR']);
  });
});

describe('ERP · KPIs do CRM', () => {
  it('conversão, ticket médio, CAC e funil', () => {
    const d = (n: number) => new Date(2026, 0, n);
    const ops = [
      { status: 'GANHA', valorCents: 10000, custoAquisicaoCents: 1000, parceiroId: 'a', createdAt: d(1), fechadaEm: d(11), etapaId: 'e1' },
      { status: 'GANHA', valorCents: 30000, custoAquisicaoCents: 1000, parceiroId: 'b', createdAt: d(1), fechadaEm: d(21), etapaId: 'e1' },
      { status: 'PERDIDA', valorCents: 5000, custoAquisicaoCents: 0, parceiroId: 'c', createdAt: d(1), fechadaEm: d(2), etapaId: 'e1' },
      { status: 'ABERTA', valorCents: 7000, custoAquisicaoCents: 0, parceiroId: 'c', createdAt: d(1), fechadaEm: null, etapaId: 'e2' },
    ];
    const k = calcularKpis([{ id: 'a', status: 'ATIVO', ehCliente: true }, { id: 'c', status: 'INATIVO', ehCliente: true }], ops);
    expect(k).toMatchObject({ clientesAtivos: 1, clientesInativos: 1, taxaConversao: 66.7, ticketMedioCents: 20000, cacCents: 1000, cicloMedioDias: 15, pipelineCents: 7000 });
    expect(funil([{ id: 'e2', nome: 'B', posicao: 1 }, { id: 'e1', nome: 'A', posicao: 0 }], ops)).toEqual([
      { etapaId: 'e1', nome: 'A', quantidade: 0, valorCents: 0 }, { etapaId: 'e2', nome: 'B', quantidade: 1, valorCents: 7000 },
    ]);
  });
});

describe('ERP · CNPJ e eventos', () => {
  it('mapeia a resposta da BrasilAPI', () => {
    const m = mapearBrasilApi({ cnpj: '19131243000197', razao_social: 'EMPRESA X LTDA', descricao_situacao_cadastral: 'ATIVA', cnae_fiscal: 6201501, cnae_fiscal_descricao: 'Desenvolvimento de software', opcao_pelo_simples: true, opcao_pelo_mei: false, cep: '06365210', descricao_tipo_de_logradouro: 'RUA', logradouro: 'A', municipio: 'CARAPICUIBA', uf: 'SP', ddd_telefone_1: '1133334444' });
    expect(m).toMatchObject({ documento: '19131243000197', regimeTributario: 'SIMPLES', cnae: '6201501', logradouro: 'RUA A', telefone: '+551133334444', uf: 'SP' });
  });
  it('backoff cresce e tem teto de 1 hora', () => {
    expect(backoffMs(1)).toBe(15_000);
    expect(backoffMs(3)).toBe(60_000);
    expect(backoffMs(50)).toBe(3_600_000);
  });
});
