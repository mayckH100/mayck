import { describe, it, expect, beforeAll } from 'vitest';
import { registerClient, Client, fakeCnpj } from '../helpers.js';
import { montarAlerta } from '../../server/erp/alertas/alertas.js';

describe('ERP · alertas, contas da empresa, clientes × fornecedores, produto', () => {
  let owner: Client; let orgId: string;
  beforeAll(async () => {
    owner = await registerClient();
    const end = (await owner.post('/api/erp/estoque/depositos', { nome: 'CD', enderecos: ['A-01'] })).body.enderecos[0].id;
    const p1 = (await owner.post('/api/erp/produtos', { sku: 'AL-1', nome: 'Abaixo', estoqueMinimoMil: 50_000, custoMedioCents: 300, custosAdicionais: [{ nome: 'Embalagem', valorCents: 50 }] })).body;
    orgId = p1.orgId;
    await owner.post('/api/erp/estoque/entrada', { produtoId: p1.id, enderecoId: end, qtdMil: 10_000, custoUnitCents: 300 });
  });

  it('produto: código de barras interno gerado, custo e custos adicionais salvos', async () => {
    const p = (await owner.get('/api/erp/produtos?q=AL-1')).body;
    const item = (p.items ?? p)[0];
    expect(item.codigoBarras).toMatch(/^2\d{12}$/);
    expect(JSON.parse(item.custosAdicionais)).toEqual([{ nome: 'Embalagem', valorCents: 50 }]);
  });

  it('cliente e fornecedor separados; mesmo CNPJ ganha o segundo papel', async () => {
    const doc = fakeCnpj();
    const c = await owner.post('/api/erp/crm/parceiros', { documento: doc, nome: 'Dupla LTDA', ehCliente: true, ehFornecedor: false });
    expect(c.status).toBe(201);
    const f = await owner.post('/api/erp/crm/parceiros', { documento: doc, nome: 'Dupla LTDA', ehCliente: false, ehFornecedor: true });
    expect(f.status).toBe(200);
    expect(f.body).toMatchObject({ jaExistia: true, ehCliente: true, ehFornecedor: true });
    expect((await owner.post('/api/erp/crm/parceiros', { documento: doc, nome: 'Dupla LTDA', ehCliente: false, ehFornecedor: true })).status).toBe(400);
  });

  it('contas a pagar: fornecedor × conta da empresa; alerta monta os blocos', async () => {
    const hoje = new Date().toISOString().slice(0, 10);
    await owner.post('/api/erp/financeiro/titulos', { tipo: 'PAGAR', descricao: 'Conta de luz', valorCents: 25_000, primeiroVencimento: hoje, natureza: 'LUZ' });
    await owner.post('/api/erp/financeiro/titulos', { tipo: 'PAGAR', descricao: 'Boleto insumos', valorCents: 90_000, primeiroVencimento: hoje });
    const contas = (await owner.get('/api/erp/financeiro/titulos?tipo=PAGAR&natureza=CONTAS')).body;
    const forn = (await owner.get('/api/erp/financeiro/titulos?tipo=PAGAR&natureza=FORNECEDOR')).body;
    expect(contas.map((t: any) => t.descricao)).toEqual(['Conta de luz']);
    expect(forn.map((t: any) => t.descricao)).toEqual(['Boleto insumos']);
    const a = await montarAlerta(orgId, { alertaDiasAntes: 3, alertaPagar: true, alertaEstoqueMinimo: true, alertaSemSaidaDias: 15 }, hoje);
    expect(a?.texto).toContain('*Fornecedores a pagar* (1');
    expect(a?.texto).toContain('*Contas da empresa* (1');
    expect(a?.texto).toContain('Luz: Conta de luz');
    expect(a?.texto).toContain('*Abaixo do estoque mínimo* (1)');
    // produto acabou de ser criado: ainda não conta como parado
    expect(a?.texto).not.toContain('Sem saída');
    const parado = await montarAlerta(orgId, { alertaDiasAntes: 3, alertaPagar: false, alertaEstoqueMinimo: false, alertaSemSaidaDias: 15 }, hoje, new Date(Date.now() + 20 * 86_400_000));
    expect(parado?.texto).toContain('AL-1 Abaixo: 10 UN em estoque, nunca saiu');
  });

  it('config de alertas: só com número; prévia', async () => {
    expect((await owner.put('/api/erp/alertas', { alertaAtivo: true, telefones: [], alertaHora: 8, alertaDiasAntes: 3, alertaPagar: true, alertaEstoqueMinimo: true, alertaSemSaidaDias: 15 })).status).toBe(400);
    const r = await owner.put('/api/erp/alertas', { alertaAtivo: true, telefones: ['11 98888-7777'], alertaHora: 8, alertaDiasAntes: 3, alertaPagar: true, alertaEstoqueMinimo: true, alertaSemSaidaDias: 15 });
    expect(r.body.telefones).toEqual(['+5511988887777']);
    expect((await owner.get('/api/erp/alertas/previa')).body.texto).toContain('MCK ERP');
  });
});
