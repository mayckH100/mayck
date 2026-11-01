import { describe, it, expect, beforeAll } from 'vitest';
import { registerClient, Client, createTestChannel, installGraphMock, sendInbound, uniq, prisma } from '../helpers.js';
import { block, unblock } from '../../server/billing/service.js';
import { backfillContactsToLeads } from '../../server/mckmensagem/contactSync.js';
import { LEADS_TEMPLATE_CSV } from '../../server/mckmensagem/routes.js';
import { nameKey } from '../../server/lib/same-client.js';

const MM = '/api/mckmensagem';
const sendCsv = (c: Client, url: string, csv: string) => c.agent.post(url).set(c.h()).set('content-type', 'text/csv').send(Buffer.from(csv, 'utf8'));

async function invite(owner: Client, role: 'AGENT' | 'ADMIN') {
  const inv = await owner.post('/api/team/invites', { email: `${uniq()}@t.dev`, role });
  const token = inv.body.link.split('/convite/')[1];
  const c = new Client();
  const r = await c.agent.post('/api/auth/accept-invite').set('x-requested-with', 'mckbot').send({ token, name: 'Membro', password: 'senhaMembro123' });
  c.csrf = r.body.csrfToken; c.me = r.body;
  return c;
}
const leadsOf = (orgId: string, phone: string) => prisma.lead.findMany({ where: { orgId, phone } });
const mmList = async (c: Client, q = '') => (await c.get(`${MM}/leads?pageSize=200${q}`)).body.items as any[];

describe('Contatos do MCKBOT aparecem no MCK Mensagens (mesma pessoa, sem duplicar)', () => {
  let owner: Client, other: Client, agent: Client;
  let org: string;
  beforeAll(async () => {
    installGraphMock();
    owner = await registerClient();
    other = await registerClient();
    agent = await invite(owner, 'AGENT');
    org = owner.me.org.id;
  });

  it('importação CSV no MCKBOT → contatos visíveis no MCK Mensagens com consentimento pendente; com a declaração, já liberados', async () => {
    const csv = 'nome;telefone;email;empresa;tags\nCarla Importada;11970000001;carla@x.com;Acme;vip\nDiego Importado;11970000002;;;';
    const r = await sendCsv(owner, '/api/contacts/import/confirm', csv);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ created: 2, mckMensagens: { created: 2 } });
    const items = await mmList(owner, '&q=Importad');
    expect(items).toHaveLength(2);
    const carla = items.find((l) => l.phone === '+5511970000001');
    expect(carla).toMatchObject({ name: 'Carla Importada', tags: ['vip'], fromMckbot: true, consentPending: true, consentSource: 'MCKBOT', consentAt: null });
    const contact = await prisma.contact.findUniqueOrThrow({ where: { orgId_waId: { orgId: org, waId: '5511970000001' } } });
    expect(carla.contactId).toBe(contact.id);
    // Filtro "consentimento pendente"
    expect((await mmList(owner, '&consent=nao&q=Importad')).length).toBe(2);

    // Com ?consent=1 os importados já entram com consentimento (IMPORTACAO)
    const r2 = await sendCsv(owner, '/api/contacts/import/confirm?consent=1', 'nome;telefone\nElza Autorizou;11970000003');
    expect(r2.status).toBe(200);
    const [elza] = await leadsOf(org, '+5511970000003');
    expect(elza.consentAt).toBeTruthy();
    expect(elza.consentSource).toBe('IMPORTACAO');
  });

  it('sem duplicar: telefone que já era lead do MCK Mensagens é vinculado e mesclado; reimportar não cria outro', async () => {
    const lead = await owner.post(`${MM}/leads`, { phone: '11970000010', name: 'Já Era Lead', consentSource: 'FORMULARIO', tags: ['site'] });
    expect(lead.status).toBe(201);
    expect(lead.body.contactId).toBeNull();
    const imp = await sendCsv(owner, '/api/contacts/import/confirm', 'nome;telefone;tags\nNome Do MCKBOT;(11) 97000-0010;cliente');
    expect(imp.body).toMatchObject({ created: 1, mckMensagens: { created: 0, linked: 1 } });
    const leads = await leadsOf(org, '+5511970000010');
    expect(leads).toHaveLength(1);
    expect(leads[0].contactId).toBeTruthy();
    expect(leads[0].name).toBe('Já Era Lead'); // nome do lead preservado
    expect(JSON.parse(leads[0].tags)).toEqual(['site', 'cliente']);
    expect(leads[0].consentSource).toBe('FORMULARIO'); // consentimento existente mantido
    // Reimportar com atualização: continua um só
    await sendCsv(owner, '/api/contacts/import/confirm?updateExisting=1', 'nome;telefone\nNome Do MCKBOT;5511970000010');
    expect(await leadsOf(org, '+5511970000010')).toHaveLength(1);
    // Lead criado no MCK Mensagens para um contato que já existe no MCKBOT nasce vinculado
    await owner.post('/api/contacts', { phone: '11970000011', name: 'Contato Antes' });
    await prisma.lead.deleteMany({ where: { orgId: org, phone: '+5511970000011' } });
    const l2 = await owner.post(`${MM}/leads`, { phone: '11970000011', consentSource: 'MANUAL' });
    expect(l2.body.contactId).toBeTruthy();
  });

  it('cadastro manual, edição e exclusão LGPD no MCKBOT ficam sincronizados; opt-out vale nos dois sentidos', async () => {
    const c = (await owner.post('/api/contacts', { phone: '11970000020', name: 'Fábio Manual', tags: ['a'] })).body;
    let [lead] = await leadsOf(org, '+5511970000020');
    expect(lead).toMatchObject({ contactId: c.id, name: 'Fábio Manual', consentAt: null });
    await owner.patch(`/api/contacts/${c.id}`, { name: 'Fábio Editado', tags: ['b'], optOut: true });
    [lead] = await leadsOf(org, '+5511970000020');
    expect(lead.name).toBe('Fábio Editado');
    expect(JSON.parse(lead.tags)).toEqual(['b']);
    expect(lead.optOutAt).toBeTruthy();
    // Opt-in pelo MCK Mensagens volta no MCKBOT
    await owner.patch(`${MM}/leads/${lead.id}`, { optOut: false });
    expect((await prisma.contact.findUniqueOrThrow({ where: { id: c.id } })).optOut).toBe(false);
    await owner.post(`${MM}/leads/bulk`, { ids: [lead.id], action: 'optOut' });
    expect((await prisma.contact.findUniqueOrThrow({ where: { id: c.id } })).optOut).toBe(true);
    // Troca de telefone acompanha
    await owner.patch(`/api/contacts/${c.id}`, { phone: '11970000021' });
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } })).phone).toBe('+5511970000021');
    // Exclusão LGPD no MCKBOT apaga o lead e o histórico de envio
    const del = await owner.del(`/api/contacts/${c.id}`);
    expect(del.status).toBe(200);
    expect(await prisma.lead.findUnique({ where: { id: lead.id } })).toBeNull();
  });

  it('excluir no MCK Mensagens (regras de 8074b47) remove só a ficha de lá; editar o contato depois não a recria', async () => {
    const c = (await owner.post('/api/contacts', { phone: '11970000030', name: 'Gil' })).body;
    const [lead] = await leadsOf(org, '+5511970000030');
    expect((await agent.del(`${MM}/leads/${lead.id}`)).status).toBe(403); // AGENT não exclui
    expect((await owner.del(`${MM}/leads/${lead.id}`)).status).toBe(200);
    expect(await prisma.contact.findUnique({ where: { id: c.id } })).toBeTruthy(); // continua no MCKBOT
    await owner.patch(`/api/contacts/${c.id}`, { name: 'Gil Editado' });
    expect(await leadsOf(org, '+5511970000030')).toHaveLength(0);
  });

  it('backfill: contatos que já existiam viram leads uma vez, mesclando por telefone e respeitando opt-out', async () => {
    const o = await registerClient();
    const oid = o.me.org.id;
    await prisma.contact.createMany({ data: [
      { orgId: oid, waId: '5511970000040', phone: '+5511970000040', name: 'Antigo 1', tags: '["x"]' },
      { orgId: oid, waId: '5511970000041', phone: '+5511970000041', name: 'Antigo Saiu', optOut: true },
      { orgId: oid, waId: '120363000000000000@g.us', phone: '120363000000000000@g.us', name: 'Grupo' },
    ] });
    await prisma.lead.create({ data: { orgId: oid, phone: '+5511970000040', name: 'Lead Antigo', consentSource: 'MANUAL', consentAt: new Date() } });
    const r1 = await backfillContactsToLeads(oid);
    expect(r1).toEqual({ created: 1, linked: 1 });
    expect(await prisma.lead.count({ where: { orgId: oid } })).toBe(2); // grupo fica de fora, sem duplicar
    expect((await leadsOf(oid, '+5511970000041'))[0].optOutAt).toBeTruthy();
    expect(await backfillContactsToLeads(oid)).toEqual({ created: 0, linked: 0 }); // idempotente
  });

  it('isolamento: contatos de uma organização nunca aparecem em outra; mesmo número em duas orgs são registros separados', async () => {
    await owner.post('/api/contacts', { phone: '11970000050', name: 'Só Da Org A' });
    await other.post('/api/contacts', { phone: '11970000050', name: 'Só Da Org B' });
    const a = await mmList(owner, '&q=Org');
    const b = await mmList(other, '&q=Org');
    expect(a.map((l) => l.name)).toContain('Só Da Org A');
    expect(a.map((l) => l.name)).not.toContain('Só Da Org B');
    expect(b.map((l) => l.name)).toEqual(['Só Da Org B']);
    const lb = b[0];
    expect((await owner.get(`${MM}/leads/${lb.id}`)).status).toBe(404);
    expect((await owner.post(`${MM}/leads/bulk`, { ids: [lb.id], action: 'registerConsent', consentDeclared: true })).body.updated).toBe(0);
  });

  it('campanhas: consentimento pendente não entra na fila; "Registrar consentimento" (com declaração) libera', async () => {
    const ch = await createTestChannel(org);
    await owner.post('/api/contacts', { phone: '11970000060', name: 'Hugo Campanha' });
    const [lead] = await leadsOf(org, '+5511970000060');
    const camp = (await owner.post(`${MM}/campaigns`, { name: 'Camp MCKBOT', message: 'Oi {nome}', channelId: ch.ch.id })).body;
    const s1 = await owner.post(`${MM}/campaigns/${camp.id}/start`, { leadIds: [lead.id] });
    expect(s1.status).toBe(400);
    expect(s1.body.error).toMatch(/consentimento pendente/);
    expect((await owner.post(`${MM}/leads/bulk`, { ids: [lead.id], action: 'registerConsent' })).status).toBe(400); // sem declaração
    const reg = await owner.post(`${MM}/leads/bulk`, { ids: [lead.id], action: 'registerConsent', consentDeclared: true, consentSource: 'MANUAL' });
    expect(reg.body.updated).toBe(1);
    const s2 = await owner.post(`${MM}/campaigns/${camp.id}/start`, { leadIds: [lead.id] });
    expect(s2.status).toBe(200);
    expect(s2.body.added).toBe(1);
  });

  it('cobrança/automações: contatos viram clientes vinculados ao contato/telefone; sem duplicar; só OWNER/ADMIN', async () => {
    await owner.post('/api/contacts', { phone: '11970000070', name: 'Iris Cliente', email: 'IRIS@x.com' });
    const [lead] = await leadsOf(org, '+5511970000070');
    expect((await agent.post(`${MM}/leads/bulk`, { ids: [lead.id], action: 'addToClientes' })).status).toBe(403);
    const r = await owner.post(`${MM}/leads/bulk`, { ids: [lead.id], action: 'addToClientes' });
    expect(r.body.updated).toBe(1);
    const cli = await prisma.cliente.findFirstOrThrow({ where: { orgId: org, whatsapp: '+5511970000070' } });
    expect(cli).toMatchObject({ nome: 'Iris Cliente', email: 'iris@x.com', contactId: lead.contactId, consentimentoAt: null });
    await owner.post(`${MM}/leads/bulk`, { ids: [lead.id], action: 'addToClientes' });
    expect(await prisma.cliente.count({ where: { orgId: org, whatsapp: '+5511970000070' } })).toBe(1);
  });

  it('WhatsApp: quem escreve pela primeira vez também aparece no MCK Mensagens (consentimento pendente)', async () => {
    const ch = await createTestChannel(org);
    await sendInbound(ch, '5511970000080', 'Olá');
    let lead = null;
    for (let i = 0; i < 30 && !lead; i++) { lead = (await leadsOf(org, '+5511970000080'))[0] ?? null; if (!lead) await new Promise((r) => setTimeout(r, 100)); }
    expect(lead).toBeTruthy();
    expect(lead!.consentAt).toBeNull();
  });

  it('sem acesso ao MCK Mensagens: o MCKBOT continua funcionando (cadastro e importação), o MCK Mensagens só bloqueia escrita', async () => {
    const o = await registerClient();
    const oid = o.me.org.id;
    await block(oid, 'MCKMENSAGEM');
    try {
      expect((await o.post('/api/contacts', { phone: '11970000090', name: 'Sem MM' })).status).toBe(201);
      expect((await sendCsv(o, '/api/contacts/import/confirm', 'nome;telefone\nSem MM 2;11970000091')).status).toBe(200);
      expect((await o.get(`${MM}/leads`)).status).toBe(200);
      expect((await o.post(`${MM}/leads/bulk`, { ids: ['x'], action: 'registerConsent', consentDeclared: true })).status).toBe(402);
    } finally {
      await unblock(oid, 'MCKMENSAGEM');
    }
  });
});

describe('Cliente com mais de um número (Contato 1..4) — cada número é um contato, agrupados pelo nome', () => {
  let owner: Client, org: string;
  beforeAll(async () => {
    owner = await registerClient();
    org = owner.me.org.id;
    await owner.post('/api/contacts', { phone: '11971000009', name: 'JOSÉ da Silva' }); // já cadastrado, mesmo cliente
  });

  it('nameKey ignora acento, maiúsculas e espaços', () => {
    expect(nameKey('  José  da   Silva ')).toBe(nameKey('JOSE DA SILVA'));
    expect(nameKey('')).toBeNull();
  });

  it('modelo novo: uma linha com vários contatos vira vários contatos; prévia mostra o cliente com os números', async () => {
    const csv = [
      'Nome;Contato 1;Contato 2;Contato 3;Contato 4;E-mail;Etiquetas',
      'José da Silva;11971000001;11971000002;;;jose@x.com;vip',
      'Loja Três;11971000003;11971000004;11971000005;11971000006;;',
      'Fone Ruim;11971000007;123;;;;',
      'Repete Na Linha;11971000008;(11) 97100-0008;;;;',
    ].join('\n');
    const p = await sendCsv(owner, '/api/contacts/import/preview', csv);
    expect(p.status).toBe(200);
    expect(p.body).toMatchObject({ clients: 4, total: 10, ok: 8, errors: 1, duplicates: 1 });
    const jose1 = p.body.rows.find((r: any) => r.phone === '+5511971000001');
    expect(jose1).toMatchObject({ line: 2, contato: 1, status: 'ok' });
    expect(jose1.sameClient.map((x: any) => x.phone).sort()).toEqual(['+5511971000002', '+5511971000009']);
    expect(jose1.sameClient.find((x: any) => x.phone === '+5511971000009').existing).toBe(true);
    const ruim = p.body.rows.find((r: any) => r.line === 4 && r.contato === 2);
    expect(ruim.status).toBe('error');
    expect(p.body.rows.find((r: any) => r.line === 4 && r.contato === 1).status).toBe('ok'); // o número bom da linha entra
    expect(p.body.rows.find((r: any) => r.line === 5 && r.contato === 2).messages[0]).toMatch(/repetido na mesma linha/);

    const c = await sendCsv(owner, '/api/contacts/import/confirm', csv);
    expect(c.body).toMatchObject({ created: 8 });
    const lojas = await prisma.contact.findMany({ where: { orgId: org, name: 'Loja Três' } });
    expect(lojas).toHaveLength(4);
    // Detalhe do contato mostra os outros números do mesmo cliente; lista mostra quantos
    const det = await owner.get(`/api/contacts/${lojas[0].id}`);
    expect(det.body.sameClient).toHaveLength(3);
    const list = await owner.get('/api/contacts?q=Loja');
    expect(list.body.items.every((x: any) => x.otherNumbers === 3)).toBe(true);
    // No MCK Mensagens, cada número é um contato e aparece o agrupamento
    const mm = (await owner.get(`${MM}/leads?q=Loja&pageSize=50`)).body.items;
    expect(mm).toHaveLength(4);
    expect(mm[0].otherNumbers).toBe(3);
    const mmDet = await owner.get(`${MM}/leads/${mm[0].id}`);
    expect(mmDet.body.sameClient).toHaveLength(3);
  });

  it('modelo antigo: mesmo nome com telefones diferentes não é erro nem duplicado; mesmo telefone com outro nome é duplicado', async () => {
    const csv = 'nome;telefone\nMarta Souza;11971000020\nmarta souza;11971000021\nOutro Nome;11971000020';
    const p = await sendCsv(owner, '/api/contacts/import/preview', csv);
    expect(p.body).toMatchObject({ total: 3, ok: 2, duplicates: 1, errors: 0 });
    expect(p.body.rows[0].sameClient.map((x: any) => x.phone)).toEqual(['+5511971000021']);
    expect(p.body.rows[2]).toMatchObject({ status: 'duplicate' });
    const c = await sendCsv(owner, '/api/contacts/import/confirm', csv);
    expect(c.body.created).toBe(2);
    const a = await prisma.contact.findUniqueOrThrow({ where: { orgId_waId: { orgId: org, waId: '5511971000020' } } });
    expect(a.name).toBe('Marta Souza'); // não foi sobrescrito
  });

  it('cobrança: dois contatos com o mesmo nome viram dois clientes, cada um preso ao seu telefone/contato (sem cobrar duas vezes o mesmo)', async () => {
    const leads = await prisma.lead.findMany({ where: { orgId: org, phone: { in: ['+5511971000020', '+5511971000021'] } } });
    expect(leads).toHaveLength(2);
    const r = await owner.post(`${MM}/leads/bulk`, { ids: leads.map((l) => l.id), action: 'addToClientes' });
    expect(r.status).toBe(200);
    const clis = await prisma.cliente.findMany({ where: { orgId: org, whatsapp: { in: ['+5511971000020', '+5511971000021'] } } });
    expect(clis).toHaveLength(2);
    expect(new Set(clis.map((c) => c.contactId)).size).toBe(2);
    expect(new Set(clis.map((c) => c.contactId))).toEqual(new Set(leads.map((l) => l.contactId)));
  });

  it('importação do MCK Mensagens: modelo novo (Contato 1..4) e modelo baixável aceitos; um lead por número', async () => {
    const t = await owner.get(`${MM}/leads/import/template`);
    expect(t.status).toBe(200);
    expect(t.text.replace(/^\uFEFF/, '').split('\r\n')[0]).toBe('Nome;Contato 1;Contato 2;Contato 3;Contato 4;Etiquetas');
    expect(t.text).not.toMatch(/mayck/i);
    const o = await registerClient();
    const r = await o.post(`${MM}/leads/import`, { text: LEADS_TEMPLATE_CSV, consentDeclared: true });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ created: 6, updated: 0, sameClient: 2, errors: [] });
    const maria = await prisma.lead.findMany({ where: { orgId: o.me.org.id, name: 'Maria Silva' } });
    expect(maria.map((l) => l.phone).sort()).toEqual(['+5511988880002', '+5511999990001']);
    expect(JSON.parse(maria[0].tags)).toEqual(['cliente', 'vip']);
    // Reimportar não duplica
    const r2 = await o.post(`${MM}/leads/import`, { text: LEADS_TEMPLATE_CSV, consentDeclared: true });
    expect(r2.body).toMatchObject({ created: 0, updated: 6 });
    // Mesmo nome, número diferente em outra linha: novo lead (não sobrescreve)
    const r3 = await o.post(`${MM}/leads/import`, { text: 'Nome;Contato 1\nmaria silva;11977776666', consentDeclared: true });
    expect(r3.body.created).toBe(1);
    expect(await prisma.lead.count({ where: { orgId: o.me.org.id, phone: { in: ['+5511988880002', '+5511999990001'] }, name: 'Maria Silva' } })).toBe(2);
  });
});
