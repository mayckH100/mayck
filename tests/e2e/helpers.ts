import { expect, type APIRequestContext, type Page } from '@playwright/test';
import { deflateSync } from 'node:zlib';
import { PrismaClient } from '@prisma/client';

/** Banco SQLite do servidor de teste (mesmo arquivo do webServer do playwright.config.ts). */
export const db = new PrismaClient({ datasources: { db: { url: `file:${process.cwd()}/prisma/sqlite/e2e.db` } } });

let seq = Math.floor(Math.random() * 1e6);
export const uniq = (p = 'e2e') => `${p}${Date.now().toString(36)}${(seq++).toString(36)}`;

/** CPF válido aleatório. */
export function fakeCpf(): string {
  const b = Array.from({ length: 9 }, (_, i) => (i === 0 ? 1 + Math.floor(Math.random() * 9) : Math.floor(Math.random() * 10)));
  const dv = (a: number[]) => { const s = a.reduce((t, n, i) => t + n * (a.length + 1 - i), 0); const r = (s * 10) % 11; return r === 10 ? 0 : r; };
  const d1 = dv(b); const d2 = dv([...b, d1]);
  return [...b, d1, d2].join('');
}

/** CNPJ alfanumérico válido aleatório (12 caracteres A-Z/0-9 + 2 DVs; valor = ASCII − 48). */
export function fakeCnpjAlfa(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789';
  const base = Array.from({ length: 8 }, () => chars[Math.floor(Math.random() * chars.length)]).join('') + '0001';
  const dv = (s: string) => { const w = s.length === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]; const r = [...s].reduce((t, c, i) => t + (c.charCodeAt(0) - 48) * w[i], 0) % 11; return r < 2 ? 0 : 11 - r; };
  const d1 = dv(base); const d2 = dv(base + d1);
  return `${base}${d1}${d2}`;
}

export const fakeCelular = () => `119${String(10000000 + Math.floor(Math.random() * 89999999))}`;

export interface Conta { email: string; password: string; documento: string; celular: string }

/**
 * Cadastro pela tela: dados → código de 6 dígitos "enviado" por e-mail → painel.
 * O código é lido no gancho de teste GET /api/__e2e__/signup-code (só existe com E2E_TEST_HOOKS=1 fora de produção).
 */
export async function signup(page: Page, request: APIRequestContext, opts: Partial<Conta> & { name?: string; org?: string } = {}): Promise<Conta> {
  const conta: Conta = {
    email: opts.email ?? `${uniq()}@teste.dev`, password: opts.password ?? 'senhaE2E12345',
    documento: opts.documento ?? fakeCpf(), celular: opts.celular ?? fakeCelular(),
  };
  await page.goto('/cadastro');
  await page.getByLabel('Seu nome').fill(opts.name ?? 'Carlos Teste');
  await page.getByLabel('E-mail').fill(conta.email);
  await page.getByLabel('CPF ou CNPJ').fill(conta.documento);
  await page.getByLabel('Celular').fill(conta.celular);
  await page.getByLabel('Senha').fill(conta.password);
  await page.getByLabel('Nome da empresa').fill(opts.org ?? 'Loja E2E');
  await page.getByRole('button', { name: 'Continuar' }).click();
  await expect(page.getByRole('heading', { name: 'Confirme seu e-mail' })).toBeVisible();
  let code = '';
  await expect.poll(async () => {
    const r = await request.get(`/api/__e2e__/signup-code?email=${encodeURIComponent(conta.email)}`);
    code = r.ok() ? (await r.json()).code : '';
    return code;
  }, { timeout: 10_000 }).toMatch(/^\d{6}$/);
  await page.getByLabel('Código de confirmação').fill(code);
  await page.getByRole('button', { name: 'Confirmar e criar conta' }).click();
  await expect(page.getByRole('heading', { name: 'Visão geral' })).toBeVisible();
  return conta;
}

export async function login(page: Page, identifier: string, password: string) {
  await page.goto('/login');
  await page.getByLabel('E-mail').fill(identifier);
  await page.getByLabel('Senha').fill(password);
  await page.getByRole('button', { name: 'Entrar' }).click();
}

/** PNG sólido (w×h) gerado na hora, sem arquivo no repositório. */
export function pngSolido(w = 64, h = 32, rgb: [number, number, number] = [37, 99, 235]): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type: string, data: Buffer) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: w }, () => rgb).flat())]);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
