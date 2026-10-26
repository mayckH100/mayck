import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { app, registerClient, Client, prisma } from '../helpers.js';
import { renew, block } from '../../server/billing/service.js';

/** Regra: só assinatura PAGA ativa (ATIVA) do app assiste; teste grátis, vencida, bloqueada e sem login não; combo libera os dois; superadmin sempre. */
describe('Tutoriais em vídeo — regra de acesso', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'tut-'));
  const VIDEO = Buffer.alloc(5000, 7);
  for (let i = 0; i < VIDEO.length; i++) VIDEO[i] = i % 251;
  const prev = process.env.TUTORIALS_DIR;

  beforeAll(() => {
    process.env.TUTORIALS_DIR = dir;
    for (const a of ['mckbot', 'mck-mensagens']) {
      writeFileSync(path.join(dir, `${a}.mp4`), VIDEO);
      writeFileSync(path.join(dir, `${a}.vtt`), 'WEBVTT\n\n00:00.000 --> 00:02.000\nOlá\n');
      writeFileSync(path.join(dir, `${a}.json`), JSON.stringify({ title: a, duration: 10, chapters: [{ title: 'Abertura', start: 0 }, { title: 'Parte 1', start: 4 }] }));
    }
  });
  afterAll(() => { rmSync(dir, { recursive: true, force: true }); if (prev === undefined) delete process.env.TUTORIALS_DIR; else process.env.TUTORIALS_DIR = prev; });

  const status = async (c: Client, a: string) => (await c.get(`/api/tutorials/${a}/video`)).status;

  it('sem login: 401 no vídeo, nas legendas e nas informações', async () => {
    for (const p of ['/api/tutorials/mckbot/video', '/api/tutorials/mckbot/captions.vtt', '/api/tutorials/mck-mensagens', '/api/tutorials/mck-mensagens/video']) {
      expect((await request(app).get(p)).status, p).toBe(401);
    }
  });

  it('teste grátis (TRIAL) bloqueia e mostra o motivo; os capítulos aparecem para o aviso', async () => {
    const c = await registerClient();
    const info = await c.get('/api/tutorials/mckbot');
    expect(info.status).toBe(200);
    expect(info.body).toMatchObject({ allowed: false, reason: 'teste_gratis', available: true });
    expect(info.body.chapters).toHaveLength(2);
    expect(await status(c, 'mckbot')).toBe(403);
    expect((await c.get('/api/tutorials/mckbot/captions.vtt')).status).toBe(403);
    expect(await status(c, 'mck-mensagens')).toBe(403);
  });

  it('plano pago libera só o app pago; Range devolve 206 com o pedaço certo', async () => {
    const c = await registerClient();
    await renew(c.me.org.id, 'MCKBOT', 'MENSAL', { source: 'MP', mpPaymentId: `tut-${Date.now()}`, amountCents: 3990 });
    expect((await c.get('/api/tutorials/mckbot')).body).toMatchObject({ allowed: true, reason: 'pago' });
    const full = await c.get('/api/tutorials/mckbot/video').buffer(true).parse((res, cb) => { const ch: Buffer[] = []; res.on('data', (d: Buffer) => ch.push(d)); res.on('end', () => cb(null, Buffer.concat(ch))); });
    expect(full.status).toBe(200);
    expect(full.headers['accept-ranges']).toBe('bytes');
    expect(full.headers['content-type']).toBe('video/mp4');
    expect((full.body as Buffer).length).toBe(VIDEO.length);
    const part = await c.agent.get('/api/tutorials/mckbot/video').set('Range', 'bytes=100-199').buffer(true).parse((res, cb) => { const ch: Buffer[] = []; res.on('data', (d: Buffer) => ch.push(d)); res.on('end', () => cb(null, Buffer.concat(ch))); });
    expect(part.status).toBe(206);
    expect(part.headers['content-range']).toBe(`bytes 100-199/${VIDEO.length}`);
    expect((part.body as Buffer).equals(VIDEO.subarray(100, 200))).toBe(true);
    expect((await c.agent.get('/api/tutorials/mckbot/video').set('Range', 'bytes=99999-')).status).toBe(416);
    const vtt = await c.get('/api/tutorials/mckbot/captions.vtt');
    expect(vtt.status).toBe(200);
    expect(vtt.text).toContain('WEBVTT');
    // o outro app continua em teste: bloqueado
    expect(await status(c, 'mck-mensagens')).toBe(403);
  });

  it('pago do MCK Mensagens não libera o MCKBOT', async () => {
    const c = await registerClient();
    await renew(c.me.org.id, 'MCKMENSAGEM', 'ANUAL', { source: 'MANUAL' });
    expect(await status(c, 'mck-mensagens')).toBe(200);
    expect(await status(c, 'mckbot')).toBe(403);
  });

  it('combo libera os dois', async () => {
    const c = await registerClient();
    await renew(c.me.org.id, 'COMBO', 'MENSAL', { source: 'MP', mpPaymentId: `tutc-${Date.now()}`, amountCents: 6990 });
    expect(await status(c, 'mckbot')).toBe(200);
    expect(await status(c, 'mck-mensagens')).toBe(200);
  });

  it('vencida e bloqueada voltam a bloquear', async () => {
    const c = await registerClient();
    const orgId = c.me.org.id;
    await renew(orgId, 'COMBO', 'MENSAL', { source: 'MANUAL' });
    expect(await status(c, 'mckbot')).toBe(200);
    await prisma.subscription.updateMany({ where: { orgId, product: 'MCKBOT' }, data: { validUntil: new Date(Date.now() - 1000) } });
    expect((await c.get('/api/tutorials/mckbot')).body).toMatchObject({ allowed: false, reason: 'vencida' });
    expect(await status(c, 'mckbot')).toBe(403);
    await block(orgId, 'MCKMENSAGEM');
    expect((await c.get('/api/tutorials/mck-mensagens')).body).toMatchObject({ allowed: false, reason: 'bloqueada' });
    expect(await status(c, 'mck-mensagens')).toBe(403);
  });

  it('superadmin sempre assiste, mesmo com a própria organização em teste', async () => {
    const c = await registerClient();
    await prisma.user.update({ where: { id: c.me.user.id }, data: { isSuperAdmin: true } });
    expect((await c.get('/api/tutorials/mckbot')).body).toMatchObject({ allowed: true, reason: 'superadmin' });
    expect(await status(c, 'mckbot')).toBe(200);
    expect(await status(c, 'mck-mensagens')).toBe(200);
  });

  it('app desconhecido: 404', async () => {
    const c = await registerClient();
    expect((await c.get('/api/tutorials/outro/video')).status).toBe(404);
    expect((await c.get('/api/tutorials/..%2F..%2Fpackage.json/video')).status).toBe(404);
  });
});
