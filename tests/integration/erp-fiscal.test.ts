import { describe, it, expect, beforeAll } from 'vitest';
import { registerClient, Client, fakeCnpj } from '../helpers.js';
import { pfxTeste } from '../fixtures/certificado-teste.js';

/** Emissão a partir do pedido separado: configuração, certificado cifrado, numeração e XML assinado (sem transmitir). */
describe('ERP · fiscal', () => {
  let owner: Client; let ped: any;
  beforeAll(async () => {
    owner = await registerClient();
    const end = (await owner.post('/api/erp/estoque/depositos', { nome: 'CD', enderecos: ['A-01'] })).body.enderecos[0].id;
    const prod = (await owner.post('/api/erp/produtos', { sku: 'QJ', nome: 'Queijo', ncm: '04069020', precoBaseCents: 2000 })).body;
    await owner.post('/api/erp/estoque/entrada', { produtoId: prod.id, enderecoId: end, qtdMil: 10_000, custoUnitCents: 1000 });
    const cli = (await owner.post('/api/erp/crm/parceiros', { documento: fakeCnpj(), nome: 'Mercado Fiscal LTDA', inscricaoEstadual: '123456789', uf: 'SP', municipio: 'Campinas', codigoMunicipio: '3509502', logradouro: 'Rua Um', numero: '5', bairro: 'Centro', cep: '13010000' })).body;
    ped = (await owner.post('/api/erp/vendas/pedidos', { parceiroId: cli.id, freteCents: 500, itens: [{ produtoId: prod.id, qtdMil: 2_000 }] })).body;
    for (const ev of ['ENVIAR', 'SEPARAR']) await owner.post(`/api/erp/vendas/pedidos/${ped.id}/acao`, { evento: ev });
    await owner.post(`/api/erp/vendas/pedidos/${ped.id}/conferencia`, { codigo: 'QJ', qtdMil: 2_000 });
    await owner.post(`/api/erp/vendas/pedidos/${ped.id}/acao`, { evento: 'CONFERIR' });
  });

  it('exige configuração e certificado; emite com numeração sequencial e XML assinado', async () => {
    expect((await owner.post(`/api/erp/fiscal/nfe/pedido/${ped.id}`, {})).status).toBe(400);
    expect((await owner.put('/api/erp/fiscal/config', { razaoSocial: 'Empresa Teste Ltda', cnpj: '12.345.678/0001-95', ie: '111111111111', crt: 1, uf: 'SP', codMunicipio: '3550308', municipio: 'São Paulo', logradouro: 'Rua A', numero: '10', bairro: 'Centro', cep: '01001-000', ambiente: 2, serie: 1, proximoNumero: 100 })).status).toBe(200);
    expect((await owner.post('/api/erp/fiscal/certificado', pfxTeste('99999999000191'))).body.error).toMatch(/outro CNPJ/);
    const cfg = (await owner.post('/api/erp/fiscal/certificado', pfxTeste())).body;
    expect(cfg).toMatchObject({ temCertificado: true }); expect(cfg.certPfx).toBeUndefined();
    const nf = await owner.post(`/api/erp/fiscal/nfe/pedido/${ped.id}`, {});
    expect(nf.status).toBe(201);
    expect(nf.body).toMatchObject({ numero: 100, status: 'ASSINADA', totalCents: 4500 });
    expect((await owner.post(`/api/erp/fiscal/nfe/pedido/${ped.id}`, {})).status).toBe(400); // uma NF-e viva por pedido
    const xml = await owner.get(`/api/erp/fiscal/nfe/${nf.body.id}/xml`);
    expect(xml.text).toContain('<Signature xmlns="http://www.w3.org/2000/09/xmldsig#">');
    expect(xml.text).toContain('<idDest>1</idDest>');
    expect((await owner.get('/api/erp/fiscal/config')).body.proximoNumero).toBe(101);
  });
});
