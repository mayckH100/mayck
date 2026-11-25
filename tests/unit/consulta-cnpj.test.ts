import { describe, it, expect } from 'vitest';
import { fichaDeBrasilApi, fichaDeCnpjWs, fichaDeReceitaWs, telefoneCadastro, extrairCnpjs, normalizarCnpj, donoDaFicha, nomeEmpresa, origemDoDado, dataIso } from '../../server/mckmensagem/cnpjConsulta.js';
import { aplicarVariaveis, variaveisDesconhecidas } from '../../server/mckmensagem/variacoes.js';
import { brasilApi, cnpjWs, CNPJ_OK } from '../fixtures/cnpj.js';

describe('v1.53.0 — Consulta CNPJ (ficha)', () => {
  it('BrasilAPI vira ficha completa, sem CPF de sócio', () => {
    const f = fichaDeBrasilApi(brasilApi(), 'BrasilAPI', new Date('2026-11-25T13:00:00Z'));
    expect(f.razaoSocial).toBe('PADARIA EXEMPLO LTDA');
    expect(f.fantasia).toBe('PADARIA PAO BOM');
    expect(f.ativa).toBe(true);
    expect(f.abertura).toBe('2015-03-10');
    expect(f.porte).toBe('MICRO EMPRESA');
    expect(f.simples).toBe('SIMPLES');
    expect(f.cnaePrincipal).toEqual({ codigo: '1091102', descricao: 'Fabricação de produtos de padaria' });
    expect(f.cnaesSecundarios).toHaveLength(1);
    expect(f.telefones.map((t) => [t.e164, t.celular, t.whatsapp])).toEqual([
      ['+5511987654321', true, 'https://wa.me/5511987654321'],
      ['+551140028922', false, null],
    ]);
    expect(f.email).toBe('contato@padariaexemplo.com.br');
    expect(f.socios).toEqual([
      { nome: 'MARIA DA SILVA EXEMPLO', qualificacao: 'Sócio-Administrador', desde: '2015-03-10' },
      { nome: 'JOAO EXEMPLO', qualificacao: 'Sócio', desde: '2018-01-02' },
    ]);
    const json = JSON.stringify(f);
    expect(json).not.toMatch(/\*\*\*|cpf|faixa/i);
    expect(f.mapsUrl).toContain('https://www.google.com/maps/search/?api=1&query=');
    expect(f.enderecoTexto).toContain('RUA DAS FLORES, 100 LOJA 2');
    expect(f.enderecoTexto).toContain('CEP 06300-000');
    expect(origemDoDado(f)).toBe('Cadastro CNPJ – BrasilAPI – 25/11/2026');
  });

  it('situação baixada não é ativa; "INATIVA" também não', () => {
    expect(fichaDeBrasilApi(brasilApi(CNPJ_OK, { descricao_situacao_cadastral: 'BAIXADA' }), 'x').ativa).toBe(false);
    expect(fichaDeBrasilApi(brasilApi(CNPJ_OK, { descricao_situacao_cadastral: 'INATIVA' }), 'x').ativa).toBe(false);
  });

  it('CNPJ.ws e ReceitaWS também mapeiam, sem CPF', () => {
    const w = fichaDeCnpjWs(cnpjWs());
    expect(w.razaoSocial).toBe('PADARIA EXEMPLO LTDA');
    expect(w.porte).toBe('Micro Empresa');
    expect(w.telefones[0].celular).toBe(true);
    expect(w.socios[0]).toEqual({ nome: 'MARIA DA SILVA EXEMPLO', qualificacao: 'Sócio-Administrador', desde: '2015-03-10' });
    expect(JSON.stringify(w)).not.toContain('***');
    const r = fichaDeReceitaWs({ cnpj: '11.222.333/0001-81', nome: 'X LTDA', situacao: 'ATIVA', abertura: '10/03/2015', telefone: '(11) 98765-4321 / (11) 4002-8922', qsa: [{ nome: 'FULANO', qual: '49-Sócio-Administrador' }], atividade_principal: [{ code: '10.91-1-02', text: 'Padaria' }] });
    expect(r.abertura).toBe('2015-03-10');
    expect(r.telefones).toHaveLength(2);
    expect(r.cnaePrincipal?.codigo).toBe('1091102');
  });

  it('telefone: celular só com 9 dígitos começando em 9', () => {
    expect(telefoneCadastro('11987654321')?.celular).toBe(true);
    expect(telefoneCadastro('1140028922')?.celular).toBe(false);
    expect(telefoneCadastro('(11) 9876-5432')?.celular).toBe(false);
    expect(telefoneCadastro('123')).toBeNull();
    expect(telefoneCadastro('11887654321')).toBeNull();
  });

  it('extrai CNPJs com e sem máscara, sem repetir; normaliza', () => {
    const r = extrairCnpjs('cnpj;nome\n11.222.333/0001-81;A\n11222333000181;A de novo\n11444777000161\n11.111.111/1111-11\n');
    expect(r.cnpjs).toEqual(['11222333000181', '11444777000161']);
    expect(r.invalidos).toBe(1);
    expect(normalizarCnpj('11.222.333/0001-81')).toBe('11222333000181');
    expect(normalizarCnpj('191')).toBeNull();
    expect(normalizarCnpj('000000000191')).toBe('00000000000191');
  });

  it('dono prefere administrador; nome da empresa usa fantasia', () => {
    const f = fichaDeBrasilApi(brasilApi(), 'BrasilAPI');
    expect(donoDaFicha(f)).toBe('Maria da Silva Exemplo');
    expect(nomeEmpresa(f)).toBe('PADARIA PAO BOM');
    expect(dataIso('31/12/2020')).toBe('2020-12-31');
  });

  it('variáveis {dono}, {dono_completo} e {empresa} na mensagem', () => {
    expect(aplicarVariaveis('Oi {dono}, tudo bem na {empresa}? ({dono_completo})', { saudacao: 'Bom dia', dono: 'Maria da Silva', empresa: 'Padaria' })).toBe('Oi Maria, tudo bem na Padaria? (Maria da Silva)');
    expect(aplicarVariaveis('Oi {dono}, tudo bem?', { saudacao: 'Bom dia' })).toBe('Oi, tudo bem?');
    expect(variaveisDesconhecidas('{dono} {empresa} {dono_completo} {xyz}')).toEqual(['{xyz}']);
  });
});
