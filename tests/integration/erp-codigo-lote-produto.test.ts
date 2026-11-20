/**
 * v1.31.0 — código do produto automático, unidade legível, lote interno automático em toda entrada (+ lote do
 * fabricante), validade obrigatória só para quem controla, e excluir/arquivar produto.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { registerClient, Client, uniq, prisma } from '../helpers.js';
import { montarAlerta } from '../../server/erp/alertas/alertas.js';

const enviar = (c: Client, url: string, csv: string) => c.agent.post(url).set((c as any).h()).set('content-type', 'application/octet-stream').send(Buffer.from(csv, 'utf8'));

describe('ERP · código automático, unidade, lote interno e excluir produto (v1.31.0)', () => {
  let owner: Client; let agente: Client; let orgId: string; let end: string;
  beforeAll(async () => {
    owner = await registerClient();
    end = (await owner.post('/api/erp/estoque/depositos', { nome: 'CD', enderecos: ['A-01'] })).body.enderecos[0].id;
    const inv = await owner.post('/api/team/invites', { email: `${uniq()}@t.dev`, role: 'AGENT' });
    const token = inv.body.link.split('/convite/')[1];
    agente = new Client();
    const r = await agente.agent.post('/api/auth/accept-invite').set('x-requested-with', 'mckbot').send({ token, name: 'Atendente', password: 'senhaMembro123' });
    agente.csrf = r.body.csrfToken; agente.me = r.body;
  });

  it('produto novo sem código ganha P0001, P0002…; segue o padrão que a empresa já usa (MCK0001 → MCK0002)', async () => {
    const a = await owner.post('/api/erp/produtos', { nome: 'Primeiro' });
    expect(a.status).toBe(201);
    orgId = a.body.orgId;
    expect(a.body.sku).toBe('P0001');
    expect((await owner.post('/api/erp/produtos', { nome: 'Segundo', sku: '' })).body.sku).toBe('P0002');

    const outra = await registerClient();
    expect((await outra.post('/api/erp/produtos', { nome: 'Canetack', sku: 'mck0001' })).body.sku).toBe('MCK0001');
    expect((await outra.post('/api/erp/produtos', { nome: 'Caderno' })).body.sku).toBe('MCK0002');
    // código digitado repetido continua recusado
    expect((await outra.post('/api/erp/produtos', { nome: 'Outro', sku: 'MCK0001' })).status).toBe(400);
  });

  it('vários cadastros ao mesmo tempo não repetem código', async () => {
    const c = await registerClient();
    const rs = await Promise.all(Array.from({ length: 6 }, (_, i) => c.post('/api/erp/produtos', { nome: `Simultâneo ${i}` })));
    expect(rs.every((r) => r.status === 201)).toBe(true);
    const skus = rs.map((r) => r.body.sku);
    expect(new Set(skus).size).toBe(6);
    expect([...skus].sort()).toEqual(['P0001', 'P0002', 'P0003', 'P0004', 'P0005', 'P0006']);
  });

  it('editar com código vazio mantém o código; códigos existentes não mudam', async () => {
    const p = (await owner.get('/api/erp/produtos?q=Primeiro')).body.items[0];
    const r = await owner.put(`/api/erp/produtos/${p.id}`, { ...p, sku: '', custosAdicionais: [], custoMedioCents: undefined, nome: 'Primeiro editado' });
    expect(r.status).toBe(200);
    expect(r.body.sku).toBe('P0001');
    expect(r.body.nome).toBe('Primeiro editado');
  });

  it('planilha: linha sem SKU vira produto com código automático', async () => {
    const csv = 'SKU;Nome;Unidade\n;Da planilha A;UN\n;Da planilha B;CX\nP-XYZ;Com código;UN\n';
    const r = await enviar(owner, '/api/erp/io/produtos/importar', csv);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ novos: 3, qtdErros: 0 });
    const ps = (await owner.get('/api/erp/produtos?q=Da planilha')).body.items.map((p: any) => p.sku).sort();
    expect(ps).toEqual(['P0003', 'P0004']);
    expect((await enviar(owner, '/api/erp/io/produtos/importar', 'SKU;Nome;Unidade\n;Ruim;30\n')).body.qtdErros).toBe(1);
  });

  it('unidade: número sozinho é recusado; produto antigo com unidade "30" aparece como "unidades" no alerta', async () => {
    const r = await owner.post('/api/erp/produtos', { nome: 'Unidade errada', unidade: '30' });
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body)).toContain('sigla');
    expect((await owner.post('/api/erp/produtos', { nome: 'Metro quadrado', unidade: 'm2' })).body.unidade).toBe('M2');

    const legado = await prisma.erpProduto.create({ data: { orgId, sku: 'MCK0001', nome: 'Canetack', unidade: '30', estoqueMinimoMil: 20_000, custoMedioCents: 500 } });
    expect((await owner.post('/api/erp/estoque/entrada', { produtoId: legado.id, enderecoId: end, qtdMil: 5_000, custoUnitCents: 500 })).status).toBe(201);
    const cfg = await prisma.erpConfig.findUniqueOrThrow({ where: { orgId } });
    const a = await montarAlerta(orgId, { ...cfg, alertaPagar: false, alertaEstoqueMinimo: true, alertaSemSaidaDias: 0 }, new Date().toISOString().slice(0, 10));
    const t = a!.texto;
    expect(t).toContain('Canetack* (cód. MCK0001)');
    expect(t).toContain('📦 Tem hoje: 5 unidades');
    expect(t).toContain('🎯 Estoque mínimo: 20 unidades');
    expect(t).toContain('🛒 *Comprar: 15 unidades*');
    expect(t).toContain('💲 Preço por unidade: *R$ 5,00* (última entrada no estoque)');
    expect(t).toContain('💰 *Total da compra: R$ 75,00*');
    expect(t).not.toMatch(/\d 30/);
  });

  it('toda entrada gera lote interno sequencial (L + ano/mês + número) e guarda o lote do fabricante', async () => {
    const p = (await owner.post('/api/erp/produtos', { nome: 'Sem lote', custoMedioCents: 100 })).body;
    const e1 = await owner.post('/api/erp/estoque/entrada', { produtoId: p.id, enderecoId: end, qtdMil: 3_000, lote: { fabricante: 'abc123' } });
    const e2 = await owner.post('/api/erp/estoque/entrada', { produtoId: p.id, enderecoId: end, qtdMil: 2_000 });
    expect(e1.status).toBe(201); expect(e2.status).toBe(201);
    expect(e1.body.lote.numero).toMatch(/^L\d{4}-\d{4}$/);
    expect(e1.body.lote.loteFornecedor).toBe('ABC123');
    const n1 = Number(e1.body.lote.numero.slice(-4)); const n2 = Number(e2.body.lote.numero.slice(-4));
    expect(n2).toBe(n1 + 1);
    // saldo total do produto continua somando os lotes; saída segue FIFO normal
    const saldos = (await owner.get(`/api/erp/estoque/saldos?produtoId=${p.id}`)).body;
    expect(saldos.reduce((a: number, s: any) => a + s.fisicoMil, 0)).toBe(5_000);
    const lotes = (await owner.get('/api/erp/estoque/lotes?q=ABC123')).body;
    expect(lotes.map((l: any) => l.numero)).toEqual([e1.body.lote.numero]);
  });

  it('entradas simultâneas nunca repetem o lote interno', async () => {
    const p = (await owner.post('/api/erp/produtos', { nome: 'Corrida' })).body;
    // No Postgres (produção) as 5 entradas vão juntas: o UPDATE do contador trava a linha até o fim da transação.
    // No SQLite dos testes transações simultâneas de escrita não convivem (trava o arquivo), então vão em sequência.
    const uma = () => owner.post('/api/erp/estoque/entrada', { produtoId: p.id, enderecoId: end, qtdMil: 1_000 });
    const rs = process.env.TEST_DB === 'postgres' ? await Promise.all(Array.from({ length: 5 }, uma)) : [await uma(), await uma(), await uma(), await uma(), await uma()];
    expect(rs.every((r) => r.status === 201)).toBe(true);
    const nums = rs.map((r) => r.body.lote.numero);
    expect(new Set(nums).size).toBe(5);
  });

  it('validade: obrigatória só para produto que controla validade', async () => {
    const per = (await owner.post('/api/erp/produtos', { nome: 'Iogurte', controlaLote: true, controlaValidade: true })).body;
    const sem = await owner.post('/api/erp/estoque/entrada', { produtoId: per.id, enderecoId: end, qtdMil: 1_000, lote: { fabricante: 'F1' } });
    expect(sem.status).toBe(400);
    expect(JSON.stringify(sem.body)).toContain('validade');
    const com = await owner.post('/api/erp/estoque/entrada', { produtoId: per.id, enderecoId: end, qtdMil: 1_000, lote: { fabricante: 'F1', validade: '2027-01-10' } });
    expect(com.status).toBe(201);
    expect(com.body.lote.validade.slice(0, 10)).toBe('2027-01-10');
    expect(com.body.lote.numero).toMatch(/^L\d{4}-\d{4}$/);
  });

  it('excluir: nunca usado apaga de vez; usado é arquivado; só Proprietário/Admin; tudo no registro', async () => {
    const novo = (await owner.post('/api/erp/produtos', { nome: 'Nunca usado' })).body;
    const usado = (await owner.post('/api/erp/produtos', { nome: 'Já usado' })).body;
    await owner.post('/api/erp/estoque/entrada', { produtoId: usado.id, enderecoId: end, qtdMil: 1_000 });

    expect((await agente.del(`/api/erp/produtos/${novo.id}`)).status).toBe(403);
    expect((await owner.get(`/api/erp/produtos/${novo.id}/uso`)).body).toEqual({ usado: false, motivos: [] });
    expect((await owner.get(`/api/erp/produtos/${usado.id}/uso`)).body.motivos).toContain('movimentos de estoque');

    const d1 = await owner.del(`/api/erp/produtos/${novo.id}`);
    expect(d1.body).toMatchObject({ acao: 'excluido' });
    expect(await prisma.erpProduto.findUnique({ where: { id: novo.id } })).toBeNull();

    const d2 = await owner.del(`/api/erp/produtos/${usado.id}`);
    expect(d2.body).toMatchObject({ acao: 'arquivado' });
    expect(d2.body.mensagem).toContain('arquivado');
    expect(await prisma.erpProduto.findUnique({ where: { id: usado.id } })).toMatchObject({ ativo: false });
    expect(await prisma.erpMovimento.count({ where: { produtoId: usado.id } })).toBe(1); // histórico intacto

    const logs = await prisma.auditLog.findMany({ where: { orgId, action: { in: ['erp.produto.excluir', 'erp.produto.arquivar'] } } });
    expect(logs.map((l) => l.action).sort()).toEqual(['erp.produto.arquivar', 'erp.produto.excluir']);
    // outra empresa não acha o produto
    const outra = await registerClient();
    expect((await outra.del(`/api/erp/produtos/${usado.id}`)).status).toBe(404);
  });
});
