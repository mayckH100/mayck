import { describe, it, expect, beforeAll } from 'vitest';
import { registerClient, Client, fakeCnpj, prisma } from '../helpers.js';
import { real } from '../fixtures/nfe-real.js';
import { decodificarXml } from '../../server/erp/estoque/xmlArquivo.js';

/**
 * v1.50.0 — entrada por XML com notas no formato real (nfeProc, várias unidades, SEM GTIN, CFOPs diferentes,
 * produtos não cadastrados, de-para por fornecedor com fator, ISO-8859-1, BOM/bytes nulos, NFC-e, aspas simples).
 */
describe('ERP · entrada por XML (notas reais)', () => {
  let owner: Client; let end: string; const cnpj = fakeCnpj();
  beforeAll(async () => {
    owner = await registerClient();
    end = (await owner.post('/api/erp/estoque/depositos', { nome: 'Loja', enderecos: ['GERAL'] })).body.enderecos[0].id;
  });

  it('importa, cria os produtos pelos itens (CX de 50 = 50 UN), lança e a próxima nota já vem vinculada', async () => {
    const imp = await owner.post('/api/erp/estoque/nfe/importar', { xml: real({ proc: true, cnpj }) });
    expect(imp.status).toBe(201);
    expect(imp.body).toMatchObject({ numero: '45678', itens: 3, modelo: '55', autorizada: true, avisos: [] });
    const n = (await owner.get(`/api/erp/estoque/nfe/${imp.body.id}`)).body;
    expect(n.itens.map((i: any) => [i.unidade, i.ean, i.cfop, i.produtoId])).toEqual([['CX', '7891234567895', '5102', null], ['PCT', null, '5405', null], ['UN', null, '6102', null]]);
    for (const i of n.itens) {
      const v = await owner.put(`/api/erp/estoque/nfe/${n.id}/itens/${i.id}`, { criarProduto: { sku: null }, fatorMil: i.unidade === 'CX' ? 50_000 : 1000 });
      expect(v.status).toBe(200);
    }
    const l = await owner.post(`/api/erp/estoque/nfe/${n.id}/lancar`, { enderecoId: end });
    expect(l.status).toBe(200);
    const saldos = (await owner.get('/api/erp/estoque/saldos')).body;
    expect(saldos.map((s: any) => s.fisicoMil).sort((a: number, b: number) => a - b)).toEqual([1_500, 10_000, 100_000]);
    // mesma empresa, nota nova: de-para por fornecedor (código do fornecedor → produto, com o fator 50)
    const imp2 = await owner.post('/api/erp/estoque/nfe/importar', { xml: real({ proc: true, cnpj, chave: '35251112345678000195550010000456791123456780' }) });
    const n2 = (await owner.get(`/api/erp/estoque/nfe/${imp2.body.id}`)).body;
    expect(n2.itens.every((i: any) => i.produtoId)).toBe(true);
    expect(n2.itens[0].fatorMil).toBe(50_000);
  });

  it('arquivo em ISO-8859-1 (lido pela tela) guarda o fornecedor com acento', async () => {
    const x = real({ proc: true, cnpj: fakeCnpj(), chave: '35251112345678000195550010000456801123456781' }).replace('encoding="UTF-8"', 'encoding="ISO-8859-1"').replace('DISTRIBUIDORA EXEMPLO DE PAPELARIA LTDA', 'PAPELARIA SÃO JOÃO LTDA');
    const { texto } = decodificarXml(Uint8Array.from(Buffer.from(x, 'latin1')));
    const imp = await owner.post('/api/erp/estoque/nfe/importar', { xml: texto });
    expect(imp.status).toBe(201);
    expect(imp.body.emitente).toBe('PAPELARIA SÃO JOÃO LTDA');
  });

  it('BOM, bytes nulos e aspas simples: importa e grava o XML limpo', async () => {
    const x = '\uFEFF' + real({ proc: true, aspas: "'", cnpj: fakeCnpj(), chave: '35251112345678000195550010000456811123456782' }).replace('<nfeProc', '\u0000<nfeProc');
    const imp = await owner.post('/api/erp/estoque/nfe/importar', { xml: x });
    expect(imp.status).toBe(201);
    const salvo = await prisma.erpNfeEntrada.findUniqueOrThrow({ where: { id: imp.body.id } });
    expect(salvo.xml.includes('\u0000')).toBe(false);
    expect(salvo.xml.startsWith('<?xml')).toBe(true);
  });

  it('NFC-e entra com aviso; resumo (resNFe) e PDF explicam o que fazer', async () => {
    const nfce = await owner.post('/api/erp/estoque/nfe/importar', { xml: real({ proc: true, mod: '65', cnpj: fakeCnpj(), chave: '35251112345678000195650010000456821123456783' }) });
    expect(nfce.status).toBe(201);
    expect(nfce.body.avisos.join(' ')).toMatch(/NFC-e/);
    const res = await owner.post('/api/erp/estoque/nfe/importar', { xml: '<?xml version="1.0" encoding="UTF-8"?><resNFe xmlns="http://www.portalfiscal.inf.br/nfe" versao="1.01"><chNFe>35251112345678000195550010000456781123456789</chNFe><CNPJ>12345678000195</CNPJ><xNome>X</xNome><vNF>10.00</vNF></resNFe>' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/RESUMO/);
    const vazio = await owner.post('/api/erp/estoque/nfe/importar', { xml: '' });
    expect(vazio.status).toBe(400);
    expect(vazio.body.error).toMatch(/vazio|incompleto/);
  });

  it('lote digitado sem quantidade (recebimento cego) usa a quantidade do item', async () => {
    const imp = await owner.post('/api/erp/estoque/nfe/importar', { xml: real({ proc: true, cnpj: fakeCnpj(), chave: '35251112345678000195550010000456831123456784' }) });
    const n = (await owner.get(`/api/erp/estoque/nfe/${imp.body.id}`)).body;
    for (const i of n.itens) await owner.put(`/api/erp/estoque/nfe/${n.id}/itens/${i.id}`, { criarProduto: { sku: null, controlaLote: true }, fatorMil: 1000 });
    const lotesManuais = { [n.itens[1].id]: [{ numero: 'forn-77', validade: null }] };
    const l = await owner.post(`/api/erp/estoque/nfe/${n.id}/lancar`, { enderecoId: end, lotesManuais });
    expect(l.status).toBe(200);
    const lote = await prisma.erpLote.findFirstOrThrow({ where: { loteFornecedor: 'FORN-77' } });
    const s = await prisma.erpSaldo.findFirstOrThrow({ where: { loteId: lote.id } });
    expect(s.fisicoMil).toBe(10_000);
  });
});
