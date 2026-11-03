import { describe, it, expect, beforeAll } from 'vitest';
import { registerClient, loginClient, Client, prisma, uniq } from '../helpers.js';
import { dayKeySP } from '../../server/lib/announcements.js';

const PASS = 'senhaSegura123';
// Imagens mínimas (só o cabeçalho importa para a validação por "magic bytes").
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('0000000dIHDR-teste-png')]);
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('JFIF-teste-jpeg-bytes')]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x20, 0, 0, 0]), Buffer.from('WEBPVP8 teste')]);
const SVG = Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
const GIF = Buffer.from('GIF89a-teste-gif-bytes');

const iso = (msFromNow: number) => new Date(Date.now() + msFromNow).toISOString();
const H = 3600_000;

function sendImage(c: Client, id: string, buf: Buffer, type = 'application/octet-stream') {
  return c.agent.post(`/api/master/announcements/${id}/image`).set(c.h()).set('content-type', type).send(buf);
}

describe('Avisos do Painel Master (pop-up com imagem)', () => {
  let admin: Client;
  let owner: Client & { signup: { email: string } };
  let orgId: string;
  let agent2: Client; // outro cliente (outra organização) para contar visualizações

  async function createAnn(body: Record<string, unknown> = {}, img: Buffer | null = PNG) {
    const r = await admin.post('/api/master/announcements', { title: uniq('Aviso '), startsAt: iso(-H), endsAt: iso(24 * H), ...body });
    expect(r.status).toBe(201);
    if (img) expect((await sendImage(admin, r.body.id, img)).status).toBe(200);
    return r.body.id as string;
  }
  const activeIds = async (c: Client, app = 'MCKBOT') => {
    const r = await c.get(`/api/announcements/active?app=${app}`);
    expect(r.status).toBe(200);
    return (r.body.items as any[]).map((a) => a.id);
  };
  const setStatus = (status: string, validUntil: Date) => prisma.subscription.updateMany({ where: { orgId, product: 'MCKBOT' }, data: { status, validUntil } });

  beforeAll(async () => {
    // Avisos de outros testes não atrapalham as contas abaixo.
    await prisma.announcementView.deleteMany({});
    await prisma.announcement.deleteMany({});
    const email = `${uniq('avisos')}@teste.dev`;
    const first = await registerClient({ email });
    await prisma.user.update({ where: { id: first.me.user.id }, data: { isSuperAdmin: true } });
    admin = (await loginClient(email, PASS)).c;
    owner = await registerClient();
    orgId = owner.me.org.id;
    agent2 = await registerClient();
    await owner.get('/api/auth/me'); // cria as assinaturas (TRIAL)
  });

  it('só superadmin cria/edita/exclui (403 para OWNER, 401 sem login)', async () => {
    const id = await createAnn();
    expect((await owner.get('/api/master/announcements')).status).toBe(403);
    expect((await owner.post('/api/master/announcements', { startsAt: iso(0), endsAt: iso(H) })).status).toBe(403);
    expect((await owner.put(`/api/master/announcements/${id}`, { startsAt: iso(0), endsAt: iso(H) })).status).toBe(403);
    expect((await owner.post(`/api/master/announcements/${id}/active`, { active: false })).status).toBe(403);
    expect((await owner.del(`/api/master/announcements/${id}`)).status).toBe(403);
    expect((await sendImage(owner, id, PNG)).status).toBe(403);
    const anon = new Client();
    expect((await anon.get('/api/master/announcements')).status).toBe(401);
    expect((await anon.get('/api/announcements/active?app=MCKBOT')).status).toBe(401);
    expect((await anon.get(`/api/announcements/${id}/image`)).status).toBe(401);
    expect((await admin.get('/api/master/announcements')).status).toBe(200);
  });

  it('origem de outro site é recusada (CSRF/Origin)', async () => {
    const r = await admin.agent.post('/api/master/announcements').set(admin.h()).set('origin', 'https://site-malicioso.example')
      .send({ startsAt: iso(0), endsAt: iso(H) });
    expect(r.status).toBe(403);
    const r2 = await admin.agent.post('/api/master/announcements').set('x-requested-with', 'mckbot').send({ startsAt: iso(0), endsAt: iso(H) });
    expect(r2.status).toBe(403); // sem token CSRF
  });

  it('valida a imagem pelos bytes: PNG/JPG/WEBP aceitos; SVG, GIF, vazio e > 2 MB recusados', async () => {
    const id = await createAnn({}, null);
    for (const [buf, mime] of [[PNG, 'image/png'], [JPG, 'image/jpeg'], [WEBP, 'image/webp']] as const) {
      const r = await sendImage(admin, id, buf);
      expect(r.status).toBe(200);
      expect(r.body.imageMime).toBe(mime);
    }
    // SVG disfarçado de PNG (extensão/content-type mentindo) continua recusado.
    expect((await sendImage(admin, id, SVG, 'image/png')).status).toBe(415);
    expect((await sendImage(admin, id, SVG, 'image/svg+xml')).status).toBe(415);
    expect((await sendImage(admin, id, GIF)).status).toBe(415);
    expect((await sendImage(admin, id, Buffer.alloc(0))).status).toBe(400);
    const big = Buffer.concat([PNG, Buffer.alloc(2 * 1024 * 1024)]);
    const r = await sendImage(admin, id, big);
    expect(r.status).toBe(413);
    expect(r.body.error).toMatch(/2 MB/);
    // A última imagem válida (WEBP) ficou.
    const row = await prisma.announcement.findUnique({ where: { id } });
    expect(row!.imageMime).toBe('image/webp');
    expect(row!.imageSize).toBe(WEBP.length);
  });

  it('valida campos: datas, fim depois do início, link só https ou caminho interno, JSON grande', async () => {
    const base = { startsAt: iso(0), endsAt: iso(H) };
    expect((await admin.post('/api/master/announcements', { ...base, endsAt: iso(-H) })).status).toBe(400);
    expect((await admin.post('/api/master/announcements', { ...base, startsAt: 'ontem' })).status).toBe(400);
    expect((await admin.post('/api/master/announcements', { ...base, linkUrl: 'javascript:alert(1)' })).status).toBe(400);
    expect((await admin.post('/api/master/announcements', { ...base, linkUrl: '//evil.example' })).status).toBe(400);
    expect((await admin.post('/api/master/announcements', { ...base, linkUrl: 'http://inseguro.example' })).status).toBe(400);
    expect((await admin.post('/api/master/announcements', { ...base, app: 'OUTRO' })).status).toBe(400);
    expect((await admin.post('/api/master/announcements', { ...base, title: 'x'.repeat(121) })).status).toBe(400);
    expect((await admin.post('/api/master/announcements', { ...base, extra: 1 })).status).toBe(400);
    expect((await admin.post('/api/master/announcements', { ...base, body: 'x'.repeat(1_100_000) })).status).toBe(413);
    const ok = await admin.post('/api/master/announcements', { ...base, linkUrl: 'https://mckbot.onrender.com/empresa', linkLabel: '' });
    expect(ok.status).toBe(201);
    expect(ok.body.linkLabel).toBe('Saiba mais');
    const intern = await admin.post('/api/master/announcements', { ...base, linkUrl: '/plano' });
    expect(intern.status).toBe(201);
    // Hora local do formulário = horário de Brasília (UTC-3).
    const local = await admin.post('/api/master/announcements', { startsAt: '2030-01-10T09:00', endsAt: '2030-01-10T18:30' });
    expect(local.status).toBe(201);
    expect(local.body.startsAt).toBe('2030-01-10T12:00:00.000Z');
    expect(local.body.startsAtLocal).toBe('2030-01-10T09:00');
    expect(local.body.endsAt).toBe('2030-01-10T21:30:00.000Z');
  });

  it('filtra por período, ativo, imagem e app', async () => {
    const live = await createAnn({ app: 'AMBOS' });
    const onlyBot = await createAnn({ app: 'MCKBOT' });
    const onlyMsg = await createAnn({ app: 'MCKMENSAGEM' });
    const future = await createAnn({ startsAt: iso(2 * H), endsAt: iso(5 * H) });
    const past = await createAnn({ startsAt: iso(-5 * H), endsAt: iso(-H) });
    const inactive = await createAnn({ active: false });
    const noImage = await createAnn({}, null);
    const bot = await activeIds(owner, 'MCKBOT');
    expect(bot).toEqual(expect.arrayContaining([live, onlyBot]));
    for (const x of [onlyMsg, future, past, inactive, noImage]) expect(bot).not.toContain(x);
    const msg = await activeIds(owner, 'MCKMENSAGEM');
    expect(msg).toEqual(expect.arrayContaining([live, onlyMsg]));
    expect(msg).not.toContain(onlyBot);
    expect((await owner.get('/api/announcements/active?app=OUTRO')).status).toBe(400);
    // Desativar tira do ar; ativar volta.
    expect((await admin.post(`/api/master/announcements/${live}/active`, { active: false })).body.state).toBe('INATIVO');
    expect(await activeIds(owner)).not.toContain(live);
    expect((await admin.post(`/api/master/announcements/${live}/active`, { active: true })).body.state).toBe('NO_AR');
    expect(await activeIds(owner)).toContain(live);
    const item = (await owner.get('/api/announcements/active?app=MCKBOT')).body.items.find((a: any) => a.id === live);
    expect(item.imageUrl).toMatch(new RegExp(`^/api/announcements/${live}/image\\?v=`));
    expect(item).not.toHaveProperty('imageData');
    await prisma.announcement.deleteMany({ where: { id: { in: [live, onlyBot, onlyMsg, future, past, inactive, noImage] } } });
  });

  it('filtra pelo público: todos / teste grátis / assinantes ativos / vencidos', async () => {
    const todos = await createAnn({ audience: 'TODOS', app: 'MCKBOT' });
    const trial = await createAnn({ audience: 'TRIAL', app: 'MCKBOT' });
    const ativos = await createAnn({ audience: 'ATIVOS', app: 'MCKBOT' });
    const vencidos = await createAnn({ audience: 'VENCIDOS', app: 'MCKBOT' });
    const pick = async () => (await activeIds(owner)).filter((x) => [todos, trial, ativos, vencidos].includes(x)).sort();
    await setStatus('TRIAL', new Date(Date.now() + 3 * 24 * H));
    expect(await pick()).toEqual([todos, trial].sort());
    await setStatus('ATIVA', new Date(Date.now() + 30 * 24 * H));
    expect(await pick()).toEqual([todos, ativos].sort());
    await setStatus('ATIVA', new Date(Date.now() - H)); // venceu
    expect(await pick()).toEqual([todos, vencidos].sort());
    await setStatus('BLOQUEADA', new Date(Date.now() + 30 * 24 * H));
    expect(await pick()).toEqual([todos, vencidos].sort());
    await setStatus('TRIAL', new Date(Date.now() + 3 * 24 * H));
    await prisma.announcement.deleteMany({ where: { id: { in: [todos, trial, ativos, vencidos] } } });
  });

  it('fechado aparece no máximo uma vez por dia por usuário; contagem no Master', async () => {
    const id = await createAnn();
    expect(await activeIds(owner)).toContain(id);
    expect((await owner.post(`/api/announcements/${id}/seen`, { action: 'view' })).status).toBe(200);
    expect(await activeIds(owner)).toContain(id); // só visto (ex.: recarregou a página) ainda aparece
    const d = await owner.post(`/api/announcements/${id}/seen`, { action: 'dismiss' });
    expect(d.status).toBe(200);
    expect(d.body.day).toBe(dayKeySP());
    expect(await activeIds(owner)).not.toContain(id);
    // Fechar de novo (outra aba) não duplica.
    expect((await owner.post(`/api/announcements/${id}/seen`, { action: 'dismiss' })).status).toBe(200);
    expect(await prisma.announcementView.count({ where: { announcementId: id } })).toBe(1);
    // Outro usuário ainda vê.
    expect(await activeIds(agent2)).toContain(id);
    await agent2.post(`/api/announcements/${id}/seen`, { action: 'view' });
    // No dia seguinte volta a aparecer.
    await prisma.announcementView.updateMany({ where: { announcementId: id, userId: owner.me.user.id }, data: { day: '2000-01-01' } });
    expect(await activeIds(owner)).toContain(id);
    const list = (await admin.get('/api/master/announcements')).body.items;
    const row = list.find((a: any) => a.id === id);
    expect(row.stats).toEqual({ views: 2, viewers: 2, dismissals: 1 });
    expect((await owner.post(`/api/announcements/${id}/seen`, { action: 'outra' })).status).toBe(400);
    expect((await owner.post(`/api/announcements/naoexiste/seen`, { action: 'view' })).status).toBe(404);
  });

  it('serve a imagem com tipo certo, nosniff e cache; aviso inativo só para o superadmin', async () => {
    const id = await createAnn({}, JPG);
    const r = await owner.get(`/api/announcements/${id}/image`);
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toBe('image/jpeg');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['cache-control']).toMatch(/max-age=\d+/);
    expect(r.headers['content-security-policy']).toMatch(/default-src 'none'/);
    expect(Buffer.compare(Buffer.from(r.body), JPG)).toBe(0);
    const etag = r.headers.etag;
    expect(etag).toBeTruthy();
    expect((await owner.agent.get(`/api/announcements/${id}/image`).set('if-none-match', etag)).status).toBe(304);
    await admin.post(`/api/master/announcements/${id}/active`, { active: false });
    expect((await owner.get(`/api/announcements/${id}/image`)).status).toBe(404);
    expect((await admin.get(`/api/announcements/${id}/image`)).status).toBe(200); // prévia no Master
    expect((await owner.get('/api/announcements/naoexiste/image')).status).toBe(404);
  });

  it('editar, excluir (com visualizações) e auditoria sem o conteúdo da imagem', async () => {
    const id = await createAnn({ title: 'Original' });
    await owner.post(`/api/announcements/${id}/seen`, { action: 'dismiss' });
    const e = await admin.put(`/api/master/announcements/${id}`, { title: 'Editado', audience: 'TRIAL', app: 'MCKMENSAGEM', startsAt: iso(-H), endsAt: iso(H), active: true });
    expect(e.status).toBe(200);
    expect(e.body).toMatchObject({ title: 'Editado', audience: 'TRIAL', app: 'MCKMENSAGEM', state: 'NO_AR' });
    expect(e.body.imageUrl).toBeTruthy(); // editar não apaga a imagem
    expect((await admin.del(`/api/master/announcements/${id}`)).status).toBe(200);
    expect(await prisma.announcement.count({ where: { id } })).toBe(0);
    expect(await prisma.announcementView.count({ where: { announcementId: id } })).toBe(0);
    expect((await admin.del(`/api/master/announcements/${id}`)).status).toBe(404);
    const logs = await prisma.auditLog.findMany({ where: { entity: 'announcement', entityId: id }, orderBy: { createdAt: 'asc' } });
    expect(logs.map((l) => l.action)).toEqual(expect.arrayContaining(['master.announcement.create', 'master.announcement.image', 'master.announcement.update', 'master.announcement.delete']));
    const img = logs.find((l) => l.action === 'master.announcement.image')!;
    const meta = JSON.parse(img.meta);
    expect(meta).toMatchObject({ mime: 'image/png', size: PNG.length });
    expect(img.meta.length).toBeLessThan(300);
    expect(img.meta).not.toContain(PNG.toString('base64'));
  });

  it('superadmin sem organização não recebe avisos (lista vazia)', async () => {
    await createAnn();
    const me = await admin.get('/api/auth/me');
    if (!me.body.org) expect((await admin.get('/api/announcements/active?app=MCKBOT')).body.items).toEqual([]);
    else expect((await admin.get('/api/announcements/active?app=MCKBOT')).status).toBe(200);
  });
});
