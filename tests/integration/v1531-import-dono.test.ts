import { describe, it, expect, beforeAll } from 'vitest';
import { registerClient, Client, prisma } from '../helpers.js';

describe('Importação CSV com dono/empresa/cnpj (v1.53.1)', () => {
  let owner: Client;
  beforeAll(async () => { owner = await registerClient(); });

  it('preenche dono, empresa e cnpj na criação e completa os vazios na atualização', async () => {
    await owner.post('/api/mckmensagem/leads/import', { text: 'telefone,nome\n5511977770002,Antiga' });
    const csv = 'telefone,nome,dono,empresa,cnpj\n5511977770001,Oficina X,Joao,Oficina X,12.345.678/0001-90\n5511977770002,Antiga,=Maria,Studio Y,\n';
    const imp = await owner.post('/api/mckmensagem/leads/import', { text: csv });
    expect(imp.status).toBe(200);
    expect(imp.body).toMatchObject({ created: 1, updated: 1 });
    const a = await prisma.lead.findFirstOrThrow({ where: { orgId: owner.me.org.id, phone: '+5511977770001' } });
    expect(a).toMatchObject({ dono: 'Joao', empresa: 'Oficina X', cnpj: '12345678000190' });
    const b = await prisma.lead.findFirstOrThrow({ where: { orgId: owner.me.org.id, phone: '+5511977770002' } });
    expect(b).toMatchObject({ dono: 'Maria', empresa: 'Studio Y', cnpj: null, name: 'Antiga' });
  });

  it('sem as colunas, nada muda', async () => {
    const imp = await owner.post('/api/mckmensagem/leads/import', { text: 'telefone,nome\n5511977770003,Z' });
    expect(imp.status).toBe(200);
    const c = await prisma.lead.findFirstOrThrow({ where: { orgId: owner.me.org.id, phone: '+5511977770003' } });
    expect(c.dono).toBeNull();
  });
});

describe('v1.53.2: reimportar corrige dono/empresa; variável vazia sem vírgula dupla', () => {
  let owner: Client;
  beforeAll(async () => { owner = await registerClient(); });
  it('valor da planilha substitui o salvo; célula vazia mantém', async () => {
    await owner.post('/api/mckmensagem/leads/import', { text: 'telefone,nome,dono,empresa\n5511977770011,A,Ana,Ana Maria Silva\n' });
    await owner.post('/api/mckmensagem/leads/import', { text: 'telefone,nome,dono,empresa\n5511977770011,A,,sua oficina\n' });
    const l = await prisma.lead.findFirstOrThrow({ where: { orgId: owner.me.org.id, phone: '+5511977770011' } });
    expect(l).toMatchObject({ dono: 'Ana', empresa: 'sua oficina' });
  });
  it('limpa vírgula dupla', async () => {
    const { aplicarVariaveis } = await import('../../server/mckmensagem/variacoes.js');
    expect(aplicarVariaveis('Olá, {dono}, tudo bem? Na {empresa}?', { saudacao: 'Oi' })).toBe('Olá, tudo bem? Na?');
  });
});
