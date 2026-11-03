import { Prisma } from '@prisma/client';
import { crc32, createGzip, gunzipSync } from 'node:zlib';
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { prisma } from '../db.js';
import { getMasterKey } from './crypto.js';
import { httpFetch } from './fetcher.js';
import { sendMailResult, smtpConfigured } from './mailer.js';
import { audit } from './audit.js';

/**
 * Backup diário do banco, 100% gratuito:
 *  - exporta todas as tabelas (via Prisma, sem pg_dump) em NDJSON, compacta (gzip) e CIFRA (AES-256-GCM);
 *  - envia para um repositório PRIVADO do GitHub (BACKUP_GITHUB_TOKEN + BACKUP_GITHUB_REPO) — recusa repositório público;
 *  - e/ou por e-mail (BACKUP_EMAIL, se o e-mail estiver configurado — API do Brevo ou SMTP — e o arquivo for pequeno);
 *  - o superadmin também pode baixar o arquivo cifrado pelo Painel Master.
 * Chave: BACKUP_KEY (32 bytes base64) se definida; senão derivada da MASTER_KEY. Restaurar: scripts/backup-restore.mjs.
 */

export const BACKUP_MAGIC = Buffer.from('MCKBKP1\n');
const FORMAT = 'mck-backup';

function backupKey(): Buffer {
  const raw = process.env.BACKUP_KEY;
  if (raw) {
    const k = Buffer.from(raw, 'base64');
    if (k.length !== 32) throw new Error('BACKUP_KEY deve ter 32 bytes em base64');
    return k;
  }
  return Buffer.from(hkdfSync('sha256', getMasterKey(), Buffer.alloc(0), Buffer.from('mck-backup-v1'), 32));
}

const lowerFirst = (s: string) => s[0].toLowerCase() + s.slice(1);

function models() {
  return Prisma.dmmf.datamodel.models;
}

/** Ordem de inserção respeitando chaves estrangeiras (pais antes dos filhos). */
export function restoreOrder(): string[] {
  const ms = models();
  const deps = new Map<string, Set<string>>();
  for (const m of ms) {
    const d = new Set<string>();
    for (const f of m.fields) if (f.kind === 'object' && f.relationFromFields && f.relationFromFields.length && f.type !== m.name) d.add(f.type);
    deps.set(m.name, d);
  }
  const out: string[] = [];
  const seen = new Set<string>();
  const visit = (n: string, stack: Set<string>) => {
    if (seen.has(n) || stack.has(n)) return;
    stack.add(n);
    for (const d of deps.get(n) ?? []) visit(d, stack);
    stack.delete(n);
    seen.add(n); out.push(n);
  };
  for (const m of ms) visit(m.name, new Set());
  return out;
}

function encodeValue(v: unknown): unknown {
  if (v instanceof Date) return { $d: v.toISOString() };
  if (v instanceof Uint8Array) return { $b: Buffer.from(v).toString('base64') };
  if (typeof v === 'bigint') return { $n: v.toString() };
  return v;
}
function decodeValue(v: unknown): unknown {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const o = v as Record<string, string>;
    if ('$d' in o) return new Date(o.$d);
    if ('$b' in o) return Buffer.from(o.$b, 'base64');
    if ('$n' in o) return BigInt(o.$n);
  }
  return v;
}
const encodeRow = (r: Record<string, unknown>) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, encodeValue(v)]));
export const decodeRow = (r: Record<string, unknown>) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, decodeValue(v)]));

/** Exporta o banco inteiro (NDJSON gzip) e cifra. Lê em páginas para não estourar a memória do plano grátis. */
export async function createBackupFile(): Promise<{ data: Buffer; rows: number; counts: Record<string, number> }> {
  const gz = createGzip({ level: 9 });
  const chunks: Buffer[] = [];
  gz.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<void>((res, rej) => { gz.on('end', () => res()); gz.on('error', rej); });
  const write = (obj: unknown) => new Promise<void>((res) => { if (gz.write(JSON.stringify(obj) + '\n')) res(); else gz.once('drain', () => res()); });
  const order = restoreOrder();
  await write({ format: FORMAT, version: 1, createdAt: new Date().toISOString(), models: order });
  const counts: Record<string, number> = {};
  let rows = 0;
  for (const m of models()) {
    const delegate = (prisma as unknown as Record<string, { findMany: (a: unknown) => Promise<Record<string, unknown>[]> }>)[lowerFirst(m.name)];
    if (!delegate) continue;
    const pk = m.primaryKey?.fields?.length ? m.primaryKey.fields : m.fields.filter((f) => f.isId).map((f) => f.name);
    const orderBy = pk.map((f) => ({ [f]: 'asc' }));
    const hasBytes = m.fields.some((f) => f.type === 'Bytes');
    const take = hasBytes ? 5 : 500;
    let skip = 0;
    counts[m.name] = 0;
    for (;;) {
      const page = await delegate.findMany({ orderBy, skip, take });
      for (const r of page) await write({ m: m.name, r: encodeRow(r) });
      counts[m.name] += page.length; rows += page.length;
      if (page.length < take) break;
      skip += take;
    }
  }
  gz.end();
  await done;
  const plain = Buffer.concat(chunks);
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', backupKey(), iv);
  const enc = Buffer.concat([c.update(plain), c.final()]);
  return { data: Buffer.concat([BACKUP_MAGIC, iv, enc, c.getAuthTag()]), rows, counts };
}

/** Decifra e devolve as linhas do backup (cabeçalho + registros). */
export function readBackupFile(file: Buffer, key: Buffer = backupKey()): { header: any; records: { m: string; r: Record<string, unknown> }[] } {
  if (!file.subarray(0, BACKUP_MAGIC.length).equals(BACKUP_MAGIC)) throw new Error('Arquivo não é um backup MCK');
  const iv = file.subarray(BACKUP_MAGIC.length, BACKUP_MAGIC.length + 12);
  const tag = file.subarray(file.length - 16);
  const body = file.subarray(BACKUP_MAGIC.length + 12, file.length - 16);
  const d = createDecipheriv('aes-256-gcm', key, iv);
  d.setAuthTag(tag);
  const plain = gunzipSync(Buffer.concat([d.update(body), d.final()])).toString('utf8');
  const lines = plain.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const header = lines.shift();
  if (header?.format !== FORMAT) throw new Error('Cabeçalho de backup inválido');
  return { header, records: lines };
}

/** Restaura num banco VAZIO (depois de `prisma migrate deploy`). Insere na ordem das chaves estrangeiras. */
export async function restoreBackupFile(file: Buffer, key?: Buffer): Promise<Record<string, number>> {
  const { records } = readBackupFile(file, key);
  const byModel = new Map<string, Record<string, unknown>[]>();
  for (const rec of records) {
    const list = byModel.get(rec.m) ?? [];
    list.push(decodeRow(rec.r));
    byModel.set(rec.m, list);
  }
  const out: Record<string, number> = {};
  for (const name of restoreOrder()) {
    const rows = byModel.get(name);
    if (!rows?.length) continue;
    const delegate = (prisma as unknown as Record<string, { create: (a: unknown) => Promise<unknown> }>)[lowerFirst(name)];
    for (const r of rows) await delegate.create({ data: r });
    out[name] = rows.length;
  }
  return out;
}

// ---------------- Destinos ----------------
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** Destino do backup por e-mail: BACKUP_EMAIL; se ausente, o próprio SMTP_USER (a conta que envia), quando for um e-mail. */
export function backupEmailTo(): string | null {
  const explicit = (process.env.BACKUP_EMAIL || '').trim();
  if (explicit) return EMAIL_RE.test(explicit) ? explicit : null;
  const smtpUser = (process.env.SMTP_USER || '').trim();
  // O login SMTP do Brevo (xxx@smtp-brevo.com) não é uma caixa de entrada: nunca mandar backup para ele.
  if (/@smtp-brevo\.com$/i.test(smtpUser)) return null;
  return EMAIL_RE.test(smtpUser) ? smtpUser : null;
}

export function backupDestinations() {
  const gh = !!(process.env.BACKUP_GITHUB_TOKEN && process.env.BACKUP_GITHUB_REPO);
  const to = smtpConfigured() ? backupEmailTo() : null;
  return { github: gh, githubRepo: gh ? process.env.BACKUP_GITHUB_REPO! : null, email: !!to, emailTo: to };
}

/** Backup automático: ligado quando ENABLE_BACKUP=true, ou por padrão quando houver destino (SMTP/GitHub). ENABLE_BACKUP=false desliga. */
export function backupAutoEnabled(): boolean {
  const flag = process.env.ENABLE_BACKUP;
  if (flag === 'false') return false;
  if (flag === 'true') return true;
  const d = backupDestinations();
  return d.github || d.email;
}

async function gh(method: string, path: string, body?: unknown) {
  const repo = process.env.BACKUP_GITHUB_REPO!;
  const res = await httpFetch(`https://api.github.com/repos/${repo}${path}`, {
    method,
    headers: { authorization: `Bearer ${process.env.BACKUP_GITHUB_TOKEN}`, accept: 'application/vnd.github+json', 'user-agent': 'mck-backup', 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data: data as any };
}

const RETENTION_DAYS = () => Math.max(3, Number(process.env.BACKUP_RETENTION_DAYS || 30));

async function uploadGithub(name: string, file: Buffer): Promise<string> {
  if (file.length > 90 * 1024 * 1024) throw new Error('Backup maior que 90 MB: grande demais para o GitHub');
  const repo = await gh('GET', '');
  if (repo.status !== 200) throw new Error(`GitHub: repositório inacessível (${repo.status})`);
  // Nunca grava dados de clientes num repositório público.
  if (repo.data.private !== true) throw new Error('GitHub: o repositório de backup é PÚBLICO — envio recusado. Use um repositório privado.');
  const path = `backups/${name}`;
  const existing = await gh('GET', `/contents/${path}`);
  const put = await gh('PUT', `/contents/${path}`, { message: `backup ${name}`, content: file.toString('base64'), ...(existing.status === 200 ? { sha: existing.data.sha } : {}) });
  if (put.status !== 200 && put.status !== 201) throw new Error(`GitHub: falha ao enviar (${put.status}) ${String(put.data?.message ?? '').slice(0, 200)}`);
  // Retenção: apaga arquivos com mais de N dias (continuam no histórico do repositório privado).
  try {
    const list = await gh('GET', '/contents/backups');
    if (Array.isArray(list.data)) {
      const limit = Date.now() - RETENTION_DAYS() * 86400e3;
      for (const f of list.data as { name: string; path: string; sha: string }[]) {
        const m = /^mck-(\d{4}-\d{2}-\d{2})\.bkp$/.exec(f.name);
        if (m && new Date(`${m[1]}T00:00:00Z`).getTime() < limit) await gh('DELETE', `/contents/${f.path}`, { message: `retenção: remove ${f.name}`, sha: f.sha });
      }
    }
  } catch { /* retenção é melhor-esforço */ }
  return `github:${process.env.BACKUP_GITHUB_REPO}/${path}`;
}


/** ZIP mínimo com um único arquivo, sem compressão (método "store"). Abre em qualquer descompactador. */
export function zipStore(name: string, data: Buffer, date = new Date()): Buffer {
  const fname = Buffer.from(name, 'utf8');
  const crc = crc32(data) >>> 0;
  const dosTime = ((date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2)) & 0xffff;
  const dosDate = (((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()) & 0xffff;
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(0, 8);
  local.writeUInt16LE(dosTime, 10); local.writeUInt16LE(dosDate, 12); local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(fname.length, 26); local.writeUInt16LE(0, 28);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x0800, 8); central.writeUInt16LE(0, 10);
  central.writeUInt16LE(dosTime, 12); central.writeUInt16LE(dosDate, 14); central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(fname.length, 28);
  central.writeUInt32LE(0, 42);
  const cdOffset = local.length + fname.length + data.length;
  const cdSize = central.length + fname.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(cdSize, 12); end.writeUInt32LE(cdOffset, 16);
  return Buffer.concat([local, fname, data, central, fname, end]);
}

async function sendEmail(name: string, file: Buffer): Promise<string> {
  const to = backupEmailTo();
  if (!to) throw new Error('E-mail: destino do backup não definido');
  if (file.length > 15 * 1024 * 1024) throw new Error('Backup maior que 15 MB: grande demais para e-mail');
  const r = await sendMailResult({
    to, subject: `Backup MCK ${name}`,
    text: `Backup diário cifrado do banco MCK (${(file.length / 1024).toFixed(0)} KB). Guarde este arquivo. Extraia o .bkp de dentro do .zip; para restaurar, use scripts/backup-restore.mjs com a mesma MASTER_KEY/BACKUP_KEY do servidor.`,
    // A API do Brevo recusa a extensão .bkp ("Unsupported file format"); o arquivo vai dentro de um .zip (sem compressão).
    attachments: [{ filename: `${name}.zip`, content: zipStore(name, file), contentType: 'application/zip' }],
  });
  if (!r.ok) throw new Error(`E-mail: ${r.error}`);
  return `email:${to}`;
}

export const backupFileName = (d = new Date()) => `mck-${d.toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' })}.bkp`;

let running = false;

/** Executa um backup completo e envia aos destinos configurados. Registra em BackupRun e na Auditoria. */
export async function runBackup(trigger: 'AUTO' | 'MANUAL', userId?: string | null) {
  if (running) throw new Error('Já existe um backup em andamento');
  running = true;
  const run = await prisma.backupRun.create({ data: { trigger } });
  try {
    const { data, rows } = await createBackupFile();
    const name = backupFileName();
    const dest = backupDestinations();
    const locations: string[] = [];
    const errors: string[] = [];
    if (dest.github) await uploadGithub(name, data).then((l) => locations.push(l), (e) => errors.push((e as Error).message));
    if (dest.email) await sendEmail(name, data).then((l) => locations.push(l), (e) => errors.push((e as Error).message));
    if (!dest.github && !dest.email) errors.push('Nenhum destino configurado (BACKUP_GITHUB_TOKEN/BACKUP_GITHUB_REPO ou SMTP/BACKUP_EMAIL). O arquivo pode ser baixado no Painel Master.');
    const ok = locations.length > 0;
    const upd = await prisma.backupRun.update({
      where: { id: run.id },
      data: { status: ok ? 'OK' : 'FAILED', finishedAt: new Date(), sizeBytes: data.length, rows, destination: [dest.github ? 'github' : '', dest.email ? 'email' : ''].filter(Boolean).join('+') || null, location: locations.join(' | ') || null, error: errors.join(' | ').slice(0, 1000) || null },
    });
    await audit(null, ok ? 'backup.success' : 'backup.failed', { orgId: null, userId: userId ?? null, entity: 'backup', entityId: run.id, meta: { trigger, sizeBytes: data.length, rows, locations, errors } });
    return { run: upd, data, name };
  } catch (e) {
    const msg = ((e as Error).message || 'erro').slice(0, 1000);
    const upd = await prisma.backupRun.update({ where: { id: run.id }, data: { status: 'FAILED', finishedAt: new Date(), error: msg } });
    await audit(null, 'backup.failed', { orgId: null, userId: userId ?? null, entity: 'backup', entityId: run.id, meta: { trigger, error: msg } });
    return { run: upd, data: null, name: null };
  } finally {
    running = false;
  }
}

/** Chamado periodicamente: faz o backup automático uma vez por dia, a partir das 3h (Brasília). */
export async function maybeDailyBackup(now = new Date()) {
  const hour = Number(now.toLocaleString('en-US', { timeZone: 'America/Sao_Paulo', hour: 'numeric', hour12: false })) % 24;
  if (hour < 3) return false;
  const today = now.toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
  const since = new Date(now.getTime() - 26 * 3600e3);
  const recent = await prisma.backupRun.findMany({ where: { trigger: 'AUTO', startedAt: { gte: since } }, orderBy: { startedAt: 'desc' } });
  const doneToday = recent.some((r) => r.startedAt.toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' }) === today && (r.status === 'OK' || (r.status === 'FAILED' && r.finishedAt && now.getTime() - r.finishedAt.getTime() < 6 * 3600e3) || (r.status === 'RUNNING' && now.getTime() - r.startedAt.getTime() < 3600e3)));
  if (doneToday) return false;
  await runBackup('AUTO');
  return true;
}
