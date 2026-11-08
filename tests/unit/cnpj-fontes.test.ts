import { describe, it, expect, afterEach } from 'vitest';
import { setFetch, resetFetch } from '../../server/lib/fetcher.js';
import { consultarCnpj, mapearCnpjWs, CnpjErro } from '../../server/erp/crm/cnpj.js';

const CNPJ = '51747475000187';
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });

afterEach(() => resetFetch());

describe('consulta de CNPJ com fontes de reserva', () => {
  it('usa a BrasilAPI quando responde', async () => {
    const urls: string[] = [];
    setFetch(async (i) => { urls.push(String(i)); return json({ cnpj: CNPJ, razao_social: 'AVICULTURA CANTO LINDO LTDA', uf: 'SP' }); });
    const d = await consultarCnpj('51.747.475/0001-87');
    expect(d.nome).toBe('AVICULTURA CANTO LINDO LTDA');
    expect(urls).toHaveLength(1);
  });

  it('cai para a minhareceita quando a BrasilAPI recusa (403)', async () => {
    setFetch(async (i) => String(i).includes('brasilapi') ? json({ message: 'blocked' }, 403) : json({ cnpj: CNPJ, razao_social: 'AVICULTURA CANTO LINDO LTDA', uf: 'SP' }));
    const d = await consultarCnpj(CNPJ);
    expect(d.nome).toBe('AVICULTURA CANTO LINDO LTDA');
  });

  it('cai para a cnpj.ws quando as duas primeiras falham', async () => {
    setFetch(async (i) => {
      const u = String(i);
      if (u.includes('brasilapi')) throw new Error('timeout');
      if (u.includes('minhareceita')) return json({}, 429);
      return json({ razao_social: 'AVICULTURA CANTO LINDO LTDA', estabelecimento: { cnpj: CNPJ, nome_fantasia: 'CANTO LINDO', cep: '02206000', estado: { sigla: 'SP' }, cidade: { nome: 'São Paulo' }, ddd1: '11', telefone1: '22222222' }, simples: { simples: 'Sim', mei: 'Não' } });
    });
    const d = await consultarCnpj(CNPJ);
    expect(d).toMatchObject({ nome: 'AVICULTURA CANTO LINDO LTDA', fantasia: 'CANTO LINDO', uf: 'SP', municipio: 'São Paulo', regimeTributario: 'SIMPLES', telefone: '+551122222222' });
  });

  it('404 em todas as fontes vira "não encontrado"; falha geral vira 502', async () => {
    setFetch(async () => json({}, 404));
    await expect(consultarCnpj(CNPJ)).rejects.toMatchObject({ status: 404 });
    setFetch(async () => json({}, 500));
    const e = await consultarCnpj(CNPJ).catch((x) => x);
    expect(e).toBeInstanceOf(CnpjErro);
    expect(e.status).toBe(502);
  });

  it('mapeia cnpj.ws sem quebrar com campos ausentes', () => {
    expect(mapearCnpjWs({ razao_social: 'X' })).toMatchObject({ nome: 'X', uf: null, regimeTributario: null });
  });
});
