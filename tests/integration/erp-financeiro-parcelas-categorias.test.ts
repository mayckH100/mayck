import { describe, it, expect, beforeAll } from 'vitest';
import { registerClient, Client, uniq, prisma } from '../helpers.js';

const API = '/api/erp/financeiro';

/** Conta parcelada pela lista explícita (com validação no servidor), categorias/subcategorias e tipos de conta por empresa. */
describe('ERP · financeiro · parcelas e categorias', () => {
  let a: Client; let b: Client; let agente: Client;
  beforeAll(async () => {
    a = await registerClient();
    b = await registerClient();
    const inv = await a.post('/api/team/invites', { email: `${uniq()}@t.dev`, role: 'AGENT' });
    const token = inv.body.link.split('/convite/')[1];
    agente = new Client();
    const r = await agente.agent.post('/api/auth/accept-invite').set('x-requested-with', 'mckbot').send({ token, name: 'Atendente', password: 'senhaMembro123' });
    agente.csrf = r.body.csrfToken; agente.me = r.body;
  });

  it('cria conta a pagar em 3 parcelas mensais pela quantidade (31/01 → 28/02 → 31/03), soma exata', async () => {
    const r = await a.post(`${API}/titulos`, { tipo: 'PAGAR', natureza: 'AGUA', descricao: 'Conta de água', valorCents: 10_000, primeiroVencimento: '2027-01-31', qtdParcelas: 3 });
    expect(r.status).toBe(201);
    expect(r.body.map((t: any) => t.valorCents)).toEqual([3333, 3333, 3334]);
    expect(r.body.map((t: any) => t.vencimento.slice(0, 10))).toEqual(['2027-01-31', '2027-02-28', '2027-03-31']);
    expect(r.body.map((t: any) => t.descricao)).toEqual(['Conta de água (1/3)', 'Conta de água (2/3)', 'Conta de água (3/3)']);
    const cat = await prisma.erpCategoriaFinanceira.findUnique({ where: { id: r.body[0].categoriaId } });
    expect(cat?.codigo).toBe('4.03'); // automática pelo tipo
  });

  it('lista explícita de parcelas editadas: aceita quando a soma bate; recusa soma diferente, data inválida e mais de 120', async () => {
    const ok = await a.post(`${API}/titulos`, { tipo: 'RECEBER', descricao: 'Serviço', valorCents: 1000, primeiroVencimento: '2026-12-10', parcelas: [{ vencimento: '2027-01-15', valorCents: 600 }, { vencimento: '2026-12-10', valorCents: 400 }] });
    expect(ok.status).toBe(201);
    // numeradas pela ordem de vencimento
    expect(ok.body.map((t: any) => [t.parcela, t.vencimento.slice(0, 10), t.valorCents])).toEqual([[1, '2026-12-10', 400], [2, '2027-01-15', 600]]);
    const soma = await a.post(`${API}/titulos`, { tipo: 'RECEBER', descricao: 'Serviço', valorCents: 1000, parcelas: [{ vencimento: '2026-12-10', valorCents: 400 }, { vencimento: '2027-01-10', valorCents: 500 }] });
    expect(soma.status).toBe(400);
    expect(JSON.stringify(soma.body)).toContain('diferente do valor total');
    expect((await a.post(`${API}/titulos`, { tipo: 'RECEBER', descricao: 'Serviço', valorCents: 1000, parcelas: [{ vencimento: '2026-02-30', valorCents: 1000 }] })).status).toBe(400);
    expect((await a.post(`${API}/titulos`, { tipo: 'RECEBER', descricao: 'Serviço', valorCents: 121, parcelas: Array.from({ length: 121 }, () => ({ vencimento: '2026-12-10', valorCents: 1 })) })).status).toBe(400);
    expect((await a.post(`${API}/titulos`, { tipo: 'RECEBER', descricao: 'Serviço', valorCents: 1000, parcelas: [{ vencimento: '2026-12-10', valorCents: 0 }, { vencimento: '2026-12-11', valorCents: 1000 }] })).status).toBe(400);
    const doze = await a.post(`${API}/titulos`, { tipo: 'RECEBER', descricao: 'Mensalidade', valorCents: 120_000, primeiroVencimento: '2026-11-14', qtdParcelas: 12 });
    expect(doze.body).toHaveLength(12);
    expect(doze.body[11].vencimento.slice(0, 10)).toBe('2027-10-14');
  });

  it('legado: lista de dias (prazos) continua funcionando', async () => {
    const r = await a.post(`${API}/titulos`, { tipo: 'PAGAR', descricao: 'Compra antiga', valorCents: 900, primeiroVencimento: '2026-11-01', prazos: [0, 30, 60] });
    expect(r.status).toBe(201);
    expect(r.body.map((t: any) => t.vencimento.slice(0, 10))).toEqual(['2026-11-01', '2026-12-01', '2026-12-31']);
  });

  it('categorias e subcategorias: cria (código automático), renomeia, usa na conta, exclui se não usada e desativa se usada', async () => {
    const cat = (await a.post(`${API}/categorias`, { nome: 'Manutenção', tipo: 'DESPESA' })).body;
    expect(cat).toMatchObject({ nome: 'Manutenção', tipo: 'DESPESA', grupo: 'OPERACIONAL', paiId: null });
    expect(cat.codigo).toMatch(/^4\.\d{2}$/);
    expect((await a.post(`${API}/categorias`, { nome: 'manutencao', tipo: 'DESPESA' })).status).toBe(400); // mesmo nome
    const sub = (await a.post(`${API}/categorias`, { nome: 'Ar-condicionado', tipo: 'DESPESA', paiId: cat.id })).body;
    expect(sub).toMatchObject({ paiId: cat.id, grupo: 'OPERACIONAL', codigo: `${cat.codigo}.01` });
    expect((await a.post(`${API}/categorias`, { nome: 'Neta', tipo: 'DESPESA', paiId: sub.id })).status).toBe(400); // só 2 níveis
    expect((await a.post(`${API}/categorias`, { nome: 'Receita X', tipo: 'RECEITA', paiId: cat.id })).status).toBe(400); // tipo diferente da mãe
    expect((await a.put(`${API}/categorias/${sub.id}`, { nome: 'Ar-condicionado e ventilação' })).body.nome).toBe('Ar-condicionado e ventilação');
    // usa a subcategoria numa conta parcelada
    const t = await a.post(`${API}/titulos`, { tipo: 'PAGAR', natureza: 'OUTRA_CONTA', descricao: 'Revisão do ar', valorCents: 30_000, primeiroVencimento: '2026-12-05', qtdParcelas: 2, categoriaId: sub.id });
    expect(t.body.every((x: any) => x.categoriaId === sub.id)).toBe(true);
    // em uso → desativa; mãe com filha → desativa; sem uso → exclui
    expect((await a.del(`${API}/categorias/${sub.id}`)).body).toMatchObject({ excluida: false, desativada: true });
    expect((await a.del(`${API}/categorias/${cat.id}`)).body).toMatchObject({ excluida: false, desativada: true });
    const livre = (await a.post(`${API}/categorias`, { nome: 'Teste livre', tipo: 'RECEITA' })).body;
    expect(livre.codigo).toMatch(/^1\.\d{2}$/);
    expect((await a.del(`${API}/categorias/${livre.id}`)).body).toMatchObject({ excluida: true });
    const lista = (await a.get(`${API}/categorias`)).body;
    expect(lista.find((c: any) => c.id === livre.id)).toBeUndefined();
    expect(lista.find((c: any) => c.id === sub.id).ativa).toBe(false);
  });

  it('tipos de conta criados pela empresa: viram "outra conta", sugerem a categoria e aparecem com o nome na lista', async () => {
    const cats = (await a.get(`${API}/categorias`)).body;
    const aluguel = cats.find((c: any) => c.codigo === '4.02');
    const tc = (await a.post(`${API}/tipos-conta`, { nome: 'Condomínio', categoriaId: aluguel.id })).body;
    expect((await a.post(`${API}/tipos-conta`, { nome: 'condomínio' })).status).toBe(400);
    expect((await a.post(`${API}/tipos-conta`, { nome: 'Água' })).status).toBe(400); // já é um tipo pronto
    const t = (await a.post(`${API}/titulos`, { tipo: 'PAGAR', natureza: 'OUTRA_CONTA', tipoContaId: tc.id, descricao: 'Condomínio de dezembro', valorCents: 50_000, primeiroVencimento: '2026-12-10' })).body;
    expect(t[0]).toMatchObject({ natureza: 'OUTRA_CONTA', tipoContaId: tc.id, categoriaId: aluguel.id });
    const l = (await a.get(`${API}/titulos?tipo=PAGAR&natureza=CONTAS`)).body;
    expect(l.find((x: any) => x.id === t[0].id).tipoConta).toBe('Condomínio');
    expect((await a.put(`${API}/tipos-conta/${tc.id}`, { nome: 'Condomínio e taxas' })).body.nome).toBe('Condomínio e taxas');
    expect((await a.del(`${API}/tipos-conta/${tc.id}`)).body).toMatchObject({ excluido: false, desativado: true });
    const livre = (await a.post(`${API}/tipos-conta`, { nome: 'Contador' })).body;
    expect((await a.del(`${API}/tipos-conta/${livre.id}`)).body).toMatchObject({ excluido: true });
  });

  it('isolamento entre empresas: B não vê, não altera e não usa categorias e tipos de conta da A', async () => {
    const catA = (await a.post(`${API}/categorias`, { nome: `Só da A ${uniq()}`, tipo: 'DESPESA' })).body;
    const tcA = (await a.post(`${API}/tipos-conta`, { nome: `Tipo da A ${uniq()}` })).body;
    expect((await b.get(`${API}/categorias`)).body.some((c: any) => c.id === catA.id)).toBe(false);
    expect((await b.get(`${API}/tipos-conta`)).body).toHaveLength(0);
    expect((await b.put(`${API}/categorias/${catA.id}`, { nome: 'Invadido' })).status).toBe(404);
    expect((await b.del(`${API}/categorias/${catA.id}`)).status).toBe(404);
    expect((await b.put(`${API}/tipos-conta/${tcA.id}`, { nome: 'Invadido' })).status).toBe(404);
    expect((await b.del(`${API}/tipos-conta/${tcA.id}`)).status).toBe(404);
    expect((await b.post(`${API}/categorias`, { nome: 'Sub invasora', tipo: 'DESPESA', paiId: catA.id })).status).toBe(400);
    expect((await b.post(`${API}/titulos`, { tipo: 'PAGAR', descricao: 'Usa categoria alheia', valorCents: 100, primeiroVencimento: '2026-12-01', categoriaId: catA.id })).status).toBe(400);
    expect((await b.post(`${API}/titulos`, { tipo: 'PAGAR', descricao: 'Usa tipo alheio', valorCents: 100, primeiroVencimento: '2026-12-01', tipoContaId: tcA.id })).status).toBe(400);
    expect((await b.post(`${API}/tipos-conta`, { nome: 'Tipo B', categoriaId: catA.id })).status).toBe(400);
    expect((await prisma.erpCategoriaFinanceira.findUnique({ where: { id: catA.id } }))!.nome).toBe(catA.nome);
    // o mesmo nome pode existir em empresas diferentes
    expect((await b.post(`${API}/categorias`, { nome: catA.nome, tipo: 'DESPESA' })).status).toBe(201);
  });

  it('permissões: atendente não cria, altera nem exclui categoria ou tipo de conta', async () => {
    const catA = (await a.post(`${API}/categorias`, { nome: `Perm ${uniq()}`, tipo: 'DESPESA' })).body;
    expect((await agente.post(`${API}/categorias`, { nome: 'Do atendente', tipo: 'DESPESA' })).status).toBe(403);
    expect((await agente.put(`${API}/categorias/${catA.id}`, { nome: 'X' })).status).toBe(403);
    expect((await agente.del(`${API}/categorias/${catA.id}`)).status).toBe(403);
    expect((await agente.post(`${API}/tipos-conta`, { nome: 'Do atendente' })).status).toBe(403);
  });
});
