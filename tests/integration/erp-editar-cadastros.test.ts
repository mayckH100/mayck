/**
 * v1.33.0 — edição completa de cliente, fornecedor e produto: todos os campos, validação, permissões
 * (limite/status e código só Proprietário/Admin), AuditLog com antes → depois e campos travados com o porquê.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { registerClient, Client, fakeCnpj, fakeCpf, uniq, prisma } from '../helpers.js';

describe('ERP · editar cadastros (v1.33.0)', () => {
  let owner: Client; let agente: Client; let orgId: string;
  beforeAll(async () => {
    owner = await registerClient();
    const inv = await owner.post('/api/team/invites', { email: `${uniq()}@t.dev`, role: 'AGENT' });
    agente = new Client();
    const r = await agente.agent.post('/api/auth/accept-invite').set('x-requested-with', 'mckbot').send({ token: inv.body.link.split('/convite/')[1], name: 'Vendedor', password: 'senhaMembro123' });
    agente.csrf = r.body.csrfToken; agente.me = r.body;
  });

  it('cliente: edita dados cadastrais, fiscais, endereço e condições comerciais; AuditLog com antes → depois', async () => {
    const cond = (await owner.post('/api/erp/produtos/condicoes', { nome: '30/60', prazos: [30, 60] })).body;
    const c = (await owner.post('/api/erp/crm/parceiros', { documento: fakeCnpj(), nome: 'Cliente Antigo LTDA' })).body;
    orgId = c.orgId;
    const novo = { ...c, nome: 'Cliente Novo LTDA', inscricaoEstadual: '123456', inscricaoMunicipal: '9988', cep: '06365-210', logradouro: 'Rua X', numero: '10', complemento: 'Sala 2', bairro: 'Centro', municipio: 'Carapicuíba', codigoMunicipio: '3510609', uf: 'sp', email: 'Compras@Cliente.com', condicaoPagamentoId: cond.id ?? null };
    const r = await agente.put(`/api/erp/crm/parceiros/${c.id}`, novo);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ nome: 'Cliente Novo LTDA', inscricaoMunicipal: '9988', cep: '06365210', complemento: 'Sala 2', codigoMunicipio: '3510609', uf: 'SP', email: 'compras@cliente.com' });
    const log = await prisma.auditLog.findFirst({ where: { orgId, action: 'erp.parceiro.editar', entityId: c.id }, orderBy: { createdAt: 'desc' } });
    const meta = JSON.parse(String(log!.meta));
    expect(meta.antes.nome).toBe('Cliente Antigo LTDA');
    expect(meta.depois.nome).toBe('Cliente Novo LTDA');
    expect(meta.depois.campos).toEqual(expect.arrayContaining(['nome', 'inscricaoEstadual', 'logradouro']));
    // validação
    expect((await owner.put(`/api/erp/crm/parceiros/${c.id}`, { ...r.body, documento: '123' })).status).toBe(400);
    expect((await owner.put(`/api/erp/crm/parceiros/${c.id}`, { ...r.body, condicaoPagamentoId: 'nao-existe' })).status).toBe(400);
  });

  it('limite de crédito e status só Proprietário/Admin; o vendedor edita o resto', async () => {
    const c = (await owner.post('/api/erp/crm/parceiros', { documento: fakeCpf(), nome: 'Maria Cliente' })).body;
    expect((await agente.put(`/api/erp/crm/parceiros/${c.id}`, { ...c, limiteCreditoCents: 50_000 })).status).toBe(403);
    expect((await agente.put(`/api/erp/crm/parceiros/${c.id}`, { ...c, status: 'BLOQUEADO' })).status).toBe(403);
    expect((await owner.put(`/api/erp/crm/parceiros/${c.id}`, { ...c, limiteCreditoCents: 50_000, status: 'BLOQUEADO' })).body).toMatchObject({ limiteCreditoCents: 50_000, status: 'BLOQUEADO' });
    expect((await agente.get(`/api/erp/crm/parceiros/${c.id}/travas`)).body.comercial).toMatch(/Proprietário ou o Administrador/);
  });

  it('fornecedor: prazo de entrega e contatos (criar, editar, excluir) com AuditLog', async () => {
    const f = (await owner.post('/api/erp/crm/parceiros', { documento: fakeCnpj(), nome: 'Fornecedor X', ehCliente: false, ehFornecedor: true })).body;
    expect((await owner.put(`/api/erp/crm/parceiros/${f.id}`, { ...f, prazoEntregaDias: 7 })).body.prazoEntregaDias).toBe(7);
    // tela antiga sem o campo não apaga o prazo
    const { prazoEntregaDias: _x, ...semPrazo } = f;
    expect((await owner.put(`/api/erp/crm/parceiros/${f.id}`, { ...semPrazo, nome: 'Fornecedor X2' })).body.prazoEntregaDias).toBe(7);
    expect((await owner.put(`/api/erp/crm/parceiros/${f.id}`, { ...f, prazoEntregaDias: -1 })).status).toBe(400);
    const ct = (await owner.post(`/api/erp/crm/parceiros/${f.id}/contatos`, { nome: 'João', email: 'joao@forn.com', principal: true })).body;
    expect((await owner.post(`/api/erp/crm/parceiros/${f.id}/contatos`, { nome: 'Ana', email: 'email-ruim' })).status).toBe(400);
    const ed = await owner.put(`/api/erp/crm/parceiros/${f.id}/contatos/${ct.id}`, { nome: 'João Silva', cargo: 'Vendas', email: 'joao@forn.com', telefone: '11999990000', principal: true });
    expect(ed.body).toMatchObject({ nome: 'João Silva', cargo: 'Vendas' });
    expect((await owner.del(`/api/erp/crm/parceiros/${f.id}/contatos/${ct.id}`)).status).toBe(200);
    const acoes = (await prisma.auditLog.findMany({ where: { orgId, entityId: f.id }, select: { action: true } })).map((a) => a.action);
    expect(acoes).toEqual(expect.arrayContaining(['erp.parceiro.contato_criar', 'erp.parceiro.contato_editar', 'erp.parceiro.contato_excluir']));
  });

  it('CPF/CNPJ trava depois de aparecer em NF-e (com explicação)', async () => {
    const f = (await owner.post('/api/erp/crm/parceiros', { documento: fakeCnpj(), nome: 'Fornecedor com nota', ehCliente: false, ehFornecedor: true })).body;
    await prisma.erpNfeEntrada.create({ data: { orgId, chave: `352611${Date.now()}`.padEnd(44, '0'), numero: '555', serie: '1', parceiroId: f.id, emitenteCnpj: f.documento, emitenteNome: f.nome, valorTotalCents: 100, xml: '<x/>' } });
    const t = (await owner.get(`/api/erp/crm/parceiros/${f.id}/travas`)).body;
    expect(t.documento).toMatch(/NF-e nº 555/);
    const r = await owner.put(`/api/erp/crm/parceiros/${f.id}`, { ...f, documento: fakeCnpj() });
    expect(r.status).toBe(400);
    expect(r.body.error ?? r.body.message).toMatch(/não pode mudar/);
    // o resto continua editável
    expect((await owner.put(`/api/erp/crm/parceiros/${f.id}`, { ...f, fantasia: 'Nota & Cia' })).status).toBe(200);
  });

  it('produto: edita todos os campos; código só gestor; unidade trava com estoque (com porquê); AuditLog com antes → depois', async () => {
    const dep = (await owner.post('/api/erp/estoque/depositos', { nome: 'CD', enderecos: ['A'] })).body;
    const p = (await owner.post('/api/erp/produtos', { nome: 'Caneta azul', unidade: 'UN' })).body;
    const base = { ...p, custosAdicionais: [], custoMedioCents: undefined };
    const r = await agente.put(`/api/erp/produtos/${p.id}`, { ...base, sku: '', nome: 'Caneta azul fina', estoqueMinimoMil: 10_000, precoBaseCents: 350, controlaLote: true, controlaValidade: true, unidadeCompra: 'CX', fatorCompraMil: 12_000, leadTimeDias: 5, ncm: '96081000' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ nome: 'Caneta azul fina', estoqueMinimoMil: 10_000, precoBaseCents: 350, controlaValidade: true, unidadeCompra: 'CX', fatorCompraMil: 12_000, leadTimeDias: 5, ncm: '96081000', sku: p.sku });
    expect((await agente.put(`/api/erp/produtos/${p.id}`, { ...base, ...r.body, custosAdicionais: [], custoMedioCents: undefined, sku: 'OUTRO1' })).status).toBe(403);
    const log = await prisma.auditLog.findFirst({ where: { orgId, action: 'erp.produto.editar', entityId: p.id }, orderBy: { createdAt: 'desc' } });
    const meta = JSON.parse(String(log!.meta));
    expect(meta.antes.nome).toBe('Caneta azul');
    expect(meta.depois.campos).toEqual(expect.arrayContaining(['nome', 'estoqueMinimoMil', 'unidadeCompra', 'leadTimeDias']));
    // com estoque: unidade trava
    await owner.post('/api/erp/estoque/entrada', { produtoId: p.id, enderecoId: dep.enderecos[0].id, qtdMil: 1_000, lote: { validade: '2030-01-01' } });
    const t = (await owner.get(`/api/erp/produtos/${p.id}/travas`)).body;
    expect(t.unidade).toMatch(/não muda/);
    expect(t.controlaLote).toBeTruthy();
    const atual = (await owner.get(`/api/erp/produtos?q=Caneta azul fina`)).body.items[0];
    const u = await owner.put(`/api/erp/produtos/${p.id}`, { ...atual, custosAdicionais: [], custoMedioCents: undefined, unidade: 'CX' });
    expect(u.status).toBe(400);
    expect(u.body.error ?? u.body.message).toMatch(/Unidade de compra/);
    // dono troca o código enquanto não saiu em nota
    expect((await owner.put(`/api/erp/produtos/${p.id}`, { ...atual, custosAdicionais: [], custoMedioCents: undefined, sku: 'CAN-AZ' })).body.sku).toBe('CAN-AZ');
  });

  it('pedido novo usa a condição de pagamento e a tabela do cadastro do cliente', async () => {
    const cond = (await owner.post('/api/erp/produtos/condicoes', { nome: '28 dias', prazos: [28] })).body;
    const c = (await owner.post('/api/erp/crm/parceiros', { documento: fakeCnpj(), nome: 'Cliente com condição', condicaoPagamentoId: cond.id })).body;
    expect(c.condicaoPagamentoId).toBe(cond.id);
    const prod = (await owner.post('/api/erp/produtos', { nome: 'Serviço X', tipo: 'SERVICO', precoBaseCents: 1000 })).body;
    const ped = (await owner.post('/api/erp/vendas/pedidos', { parceiroId: c.id, itens: [{ produtoId: prod.id, qtdMil: 1000 }] })).body;
    expect(ped.condicaoPagamentoId).toBe(cond.id);
  });
});
