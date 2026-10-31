import { describe, it, expect, beforeAll } from 'vitest';
import { registerClient, Client, uniq, prisma } from '../helpers.js';
import { parseCsv, detectDelimiter, sanitizeText, decodeCsv } from '../../server/lib/contacts-import.js';

const sendCsv = (c: Client, url: string, csv: string | Buffer) =>
  c.agent.post(url).set(c.h()).set('content-type', 'text/csv').send(typeof csv === 'string' ? Buffer.from(csv, 'utf8') : csv);

describe('Importação de contatos por planilha (CSV)', () => {
  let owner: Client, agent: Client, admin: Client;
  beforeAll(async () => {
    owner = await registerClient();
    const mk = async (role: 'AGENT' | 'ADMIN') => {
      const inv = await owner.post('/api/team/invites', { email: `${uniq()}@t.dev`, role });
      const token = inv.body.link.split('/convite/')[1];
      const c = new Client();
      const r = await c.agent.post('/api/auth/accept-invite').set('x-requested-with', 'mckbot').send({ token, name: 'Membro', password: 'senhaMembro123' });
      c.csrf = r.body.csrfToken; c.me = r.body;
      return c;
    };
    agent = await mk('AGENT');
    admin = await mk('ADMIN');
    await owner.post('/api/contacts', { phone: '11955550001', name: 'Já Existe', tags: ['VIP'], email: 'antigo@x.com' });
  });

  it('modelo: CSV UTF-8 com BOM, separador ; e linha de exemplo', async () => {
    const r = await owner.get('/api/contacts/import/template').buffer(true).parse((res, cb) => { const b: Buffer[] = []; res.on('data', (d: Buffer) => b.push(d)); res.on('end', () => cb(null, Buffer.concat(b))); });
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/text\/csv/);
    expect(r.headers['content-disposition']).toMatch(/modelo-contatos\.csv/);
    const buf = r.body as Buffer;
    expect([...buf.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const lines = buf.toString('utf8').replace(/^\uFEFF/, '').trim().split('\r\n');
    expect(lines[0]).toBe('nome;telefone;email;empresa;tags;observacoes');
    expect(lines).toHaveLength(2);
    // o próprio modelo é aceito pela prévia
    const p = await sendCsv(owner, '/api/contacts/import/preview', buf);
    expect(p.body).toMatchObject({ total: 1, ok: 1 });
  });

  it('leitor CSV: aspas, aspas escapadas, quebra de linha, detecção de separador, anti-fórmula, Windows-1252', () => {
    expect(detectDelimiter('nome,telefone\n')).toBe(',');
    expect(detectDelimiter('nome;telefone;"a,b,c"\n')).toBe(';');
    expect(parseCsv('a;"b;""c""\nd"\r\ne;f', ';')).toEqual([['a', 'b;"c"\nd'], ['e', 'f']]);
    expect(sanitizeText('=HYPERLINK("x")', 100)).toBe('HYPERLINK("x")');
    expect(sanitizeText(' +-@=cmd', 100)).toBe('cmd');
    expect(sanitizeText('abcdef', 3)).toBe('abc');
    expect(decodeCsv(Buffer.from([0x4a, 0x6f, 0xe3, 0x6f]))).toBe('João'); // latin1/cp1252
  });

  it('prévia: ok / erro / duplicado (na organização e repetido no arquivo), sem gravar nada', async () => {
    const csv = [
      'Nome,Telefone,E-mail,Empresa,Etiquetas,Observações',
      'Ana,(11) 98888-0001,ana@x.com,Acme,"novo, vip",=cmd()',
      ',11988880002,,,,',
      'Sem Fone,,,,,',
      'Fone Ruim,123,,,,',
      'Email Ruim,11988880003,nao-e-email,,,',
      'Repetida,+55 11 98888-0001,,,,',
      'Existente,11955550001,,,,',
    ].join('\n');
    const before = await prisma.contact.count({ where: { orgId: owner.me.org.id } });
    const r = await sendCsv(owner, '/api/contacts/import/preview', csv);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ total: 7, ok: 1, errors: 4, duplicates: 2 });
    const byLine = Object.fromEntries(r.body.rows.map((x: any) => [x.line, x]));
    expect(byLine[2]).toMatchObject({ status: 'ok', phone: '+5511988880001', tags: ['novo', 'VIP'] }); // reaproveita a grafia "VIP"
    expect(byLine[3].messages).toContain('Nome é obrigatório');
    expect(byLine[4].messages).toContain('Telefone é obrigatório');
    expect(byLine[5].messages[0]).toMatch(/Telefone inválido/);
    expect(byLine[6].messages).toContain('E-mail inválido');
    expect(byLine[7]).toMatchObject({ status: 'duplicate' });
    expect(byLine[7].messages[0]).toMatch(/repetido na planilha \(linha 2\)/);
    expect(byLine[8]).toMatchObject({ status: 'duplicate', existing: true });
    expect(await prisma.contact.count({ where: { orgId: owner.me.org.id } })).toBe(before);
  });

  it('valida arquivo: cabeçalho, vazio, limite de linhas e de 2 MB', async () => {
    expect((await sendCsv(owner, '/api/contacts/import/preview', 'foo;bar\n1;2')).body.error).toMatch(/Cabeçalho inválido/);
    expect((await sendCsv(owner, '/api/contacts/import/preview', '')).status).toBe(400);
    expect((await sendCsv(owner, '/api/contacts/import/preview', 'nome;telefone\n')).status).toBe(400);
    const many = 'nome;telefone\n' + Array.from({ length: 5001 }, (_, i) => `N${i};119${String(i).padStart(8, '0')}`).join('\n');
    expect((await sendCsv(owner, '/api/contacts/import/preview', many)).body.error).toMatch(/5000 linhas/);
    const big = 'nome;telefone;observacoes\n' + 'A;11999999999;' + 'x'.repeat(2 * 1024 * 1024);
    expect((await sendCsv(owner, '/api/contacts/import/preview', big)).status).toBe(413);
  });

  it('atendente (AGENT) não pode pré-visualizar nem importar (403); ADMIN pode', async () => {
    const csv = 'nome;telefone\nX;11911112222';
    expect((await sendCsv(agent, '/api/contacts/import/preview', csv)).status).toBe(403);
    expect((await sendCsv(agent, '/api/contacts/import/confirm', csv)).status).toBe(403);
    expect((await sendCsv(admin, '/api/contacts/import/preview', csv)).status).toBe(200);
  });

  it('confirma: cria só as válidas e não duplicadas, empresa/etiquetas/notas saneadas, auditoria só com contagens', async () => {
    const csv = [
      'nome;telefone;email;empresa;tags;observacoes',
      'Ana;(11) 98888-0001;ana@x.com;@Acme;novo|vip;=cmd()',
      'Bia;21977770002;;;;',
      'Erro;123;;;;',
      'Existente Novo Nome;11955550001;novo@x.com;Beta;lead;',
      'Repetida;11988880001;;;;',
    ].join('\r\n');
    const r = await sendCsv(owner, '/api/contacts/import/confirm', csv);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ total: 5, created: 2, updated: 0, skipped: 2, errors: 1 });
    const ana = await prisma.contact.findUniqueOrThrow({ where: { orgId_waId: { orgId: owner.me.org.id, waId: '5511988880001' } } });
    expect(ana).toMatchObject({ name: 'Ana', phone: '+5511988880001', email: 'ana@x.com', notes: 'cmd()' });
    expect(JSON.parse(ana.tags)).toEqual(['novo', 'VIP']);
    expect(JSON.parse(ana.vars)).toEqual({ empresa: 'Acme' });
    const ex = await prisma.contact.findUniqueOrThrow({ where: { orgId_waId: { orgId: owner.me.org.id, waId: '5511955550001' } } });
    expect(ex.name).toBe('Já Existe'); // atualização desligada por padrão
    const log = await prisma.auditLog.findFirstOrThrow({ where: { orgId: owner.me.org.id, action: 'contacts.import' }, orderBy: { createdAt: 'desc' } });
    const meta = JSON.parse(log.meta);
    expect(meta).toMatchObject({ created: 2, updated: 0, errors: 1, updateExisting: false });
    expect(log.meta).not.toMatch(/Ana|5511|ana@x\.com/);
    // lista atualizada
    expect((await owner.get('/api/contacts?q=Bia')).body.items).toHaveLength(1);
  });

  it('confirma com updateExisting=1: atualiza duplicados existentes (soma etiquetas, guarda empresa)', async () => {
    const csv = 'nome;telefone;email;empresa;tags\nExistente Novo Nome;11955550001;novo@x.com;Beta;lead\nNova;31966660003;;;\nNova2;31966660003;;;';
    const r = await sendCsv(owner, '/api/contacts/import/confirm?updateExisting=1', csv);
    expect(r.body).toMatchObject({ created: 1, updated: 1, skipped: 1 });
    const ex = await prisma.contact.findUniqueOrThrow({ where: { orgId_waId: { orgId: owner.me.org.id, waId: '5511955550001' } } });
    expect(ex).toMatchObject({ name: 'Existente Novo Nome', email: 'novo@x.com' });
    expect(JSON.parse(ex.tags)).toEqual(['VIP', 'lead']);
    expect(JSON.parse(ex.vars)).toMatchObject({ empresa: 'Beta' });
  });

  it('isolamento: duplicidade é por organização', async () => {
    const other = await registerClient();
    const r = await sendCsv(other, '/api/contacts/import/preview', 'nome;telefone\nAna;11988880001');
    expect(r.body).toMatchObject({ ok: 1, duplicates: 0 });
  });
});
