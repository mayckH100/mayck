import { describe, it, expect } from 'vitest';
import { createHash, createVerify, X509Certificate } from 'node:crypto';
import { dvModulo11, chaveAcesso, escolherRegra, tributos, ratear, montarNfe, assinarNfe, lerPfx, infCanonico, REGRA_PADRAO, eventoCancelamento } from '../../server/erp/fiscal/nfe.js';
import { lerRetornoAutorizacao, urlSefaz } from '../../server/erp/fiscal/sefaz.js';
import { pfxTeste } from '../fixtures/certificado-teste.js';

const emit = { cnpj: '12345678000195', razaoSocial: 'Empresa Teste Ltda', ie: '111111111111', crt: 1, uf: 'SP', codMunicipio: '3550308', municipio: 'São Paulo', logradouro: 'Rua A & B', numero: '10', bairro: 'Centro', cep: '01001000' };
const dest = { documento: '11222333000181', nome: 'Cliente <Teste>', ie: '222222222222', uf: 'RJ', codMunicipio: '3304557', municipio: 'Rio de Janeiro', logradouro: 'Av. X', numero: '1', bairro: 'Centro', cep: '20000000' };

describe('ERP · fiscal (NF-e 4.00)', () => {
  it('DV da chave pelo exemplo do manual e chave com 44 dígitos', () => {
    expect(dvModulo11('5206043300991100250655012000000780026730161')).toBe(5);
    const c = chaveAcesso({ uf: 'SP', emissao: new Date('2026-11-03T12:00:00Z'), cnpj: '12345678000195', serie: 1, numero: 42, cNF: 12345678 });
    expect(c).toHaveLength(44); expect(c.slice(0, 6)).toBe('352611'); expect(Number(c[43])).toBe(dvModulo11(c.slice(0, 43)));
  });
  it('regra por produto > NCM mais longo > padrão; tributos por regime; rateio', () => {
    const r = (o: any) => ({ ...REGRA_PADRAO, produtoId: null, ncmPrefixo: null, prioridade: 0, ...o });
    const regras = [r({ cfopDentro: '5101' }), r({ ncmPrefixo: '04', cfopDentro: '5401' }), r({ ncmPrefixo: '0401', cfopDentro: '5405' }), r({ produtoId: 'P1', cfopDentro: '5102' })];
    expect(escolherRegra(regras, 'P2', '04012010').cfopDentro).toBe('5405');
    expect(escolherRegra(regras, 'P1', '04012010').cfopDentro).toBe('5102');
    expect(escolherRegra(regras, 'P3', '22011000').cfopDentro).toBe('5101');
    expect(tributos(10_000, REGRA_PADRAO, 1).vIcms).toBe(0);
    expect(tributos(10_000, { ...REGRA_PADRAO, cstPis: '01', aliqPisBp: 165 }, 3)).toMatchObject({ vBC: 10_000, vIcms: 1800, vPis: 165 });
    expect(ratear(100, [1, 1, 1])).toEqual([33, 33, 34]);
  });
  it('monta, escapa e assina: digest e assinatura conferem com o certificado', () => {
    const m = montarNfe({ emitente: emit, destinatario: dest, serie: 1, numero: 7, cNF: 12345678, emissao: new Date('2026-11-03T15:00:00Z'), ambiente: 2, natOp: 'VENDA', tPag: '15', consumidorFinal: false,
      itens: [{ codigo: 'A1', descricao: 'Leite', ncm: '04012010', unidade: 'UN', qtdMil: 3000, valorUnitCents: 350, descontoCents: 50, freteCents: 100, origem: 0, regra: REGRA_PADRAO }] });
    expect(m.totalCents).toBe(1100);
    expect(m.infNFe).toContain('<dhEmi>2026-11-03T12:00:00-03:00</dhEmi>');
    expect(m.infNFe).toContain('Rua A &amp; B'); expect(m.infNFe).toContain('<idDest>2</idDest>'); expect(m.infNFe).toContain('<CFOP>6102</CFOP>');
    expect(m.infNFe).toContain('SEM VALOR FISCAL');
    const p = pfxTeste();
    const cert = lerPfx(p.pfxBase64, p.senha);
    expect(cert.cnpj).toBe('12345678000195');
    expect(() => lerPfx(p.pfxBase64, 'errada')).toThrow(/senha/);
    const nfe = assinarNfe(m.infNFe, m.chave, cert);
    expect(nfe.startsWith('<NFe xmlns="http://www.portalfiscal.inf.br/nfe"><infNFe Id=')).toBe(true);
    const digest = /<DigestValue>([^<]+)/.exec(nfe)![1];
    expect(createHash('sha1').update(infCanonico(nfe)).digest('base64')).toBe(digest);
    const si = /<SignedInfo>[\s\S]*<\/SignedInfo>/.exec(nfe)![0].replace('<SignedInfo>', '<SignedInfo xmlns="http://www.w3.org/2000/09/xmldsig#">');
    const x509 = new X509Certificate(Buffer.from(cert.certBase64, 'base64'));
    expect(createVerify('RSA-SHA1').update(si).verify(x509.publicKey, /<SignatureValue>([^<]+)/.exec(nfe)![1], 'base64')).toBe(true);
    expect(eventoCancelamento({ chave: m.chave, cnpj: emit.cnpj, protocolo: '135260000000001', justificativa: 'Erro na digitação do pedido', ambiente: 2, quando: new Date() }, cert)).toContain(`Id="ID110111${m.chave}01"`);
  });
  it('lê retorno da SEFAZ e escolhe o endpoint pela UF', () => {
    expect(lerRetornoAutorizacao('<retEnviNFe><cStat>104</cStat><protNFe versao="4.00"><infProt><cStat>100</cStat><xMotivo>Autorizado o uso da NF-e</xMotivo><nProt>135260000000001</nProt></infProt></protNFe></retEnviNFe>')).toMatchObject({ cStat: '100', protocolo: '135260000000001' });
    expect(lerRetornoAutorizacao('<retEnviNFe><cStat>225</cStat><xMotivo>Rejeição: Falha no Schema XML</xMotivo></retEnviNFe>')).toMatchObject({ cStat: '225', protocolo: null });
    expect(urlSefaz('SP', 2, 'autorizacao')).toContain('homologacao.nfe.fazenda.sp.gov.br');
    expect(urlSefaz('RJ', 1, 'status')).toContain('nfe.svrs.rs.gov.br');
    expect(() => urlSefaz('MG', 1, 'status')).toThrow(/MG/);
  });
});
