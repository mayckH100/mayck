// Restaura ou inspeciona um backup MCK (arquivo .bkp cifrado).
// Pré-requisitos: `npm run build` e as MESMAS variáveis do servidor (MASTER_KEY ou BACKUP_KEY).
//
//   Inspecionar (só conta registros):  MASTER_KEY=... node scripts/backup-restore.mjs info mck-2026-10-30.bkp
//   Exportar em texto (NDJSON):        MASTER_KEY=... node scripts/backup-restore.mjs ndjson mck-2026-10-30.bkp > dump.ndjson
//   Restaurar num banco NOVO e VAZIO:  DATABASE_URL=... MASTER_KEY=... npx prisma migrate deploy --schema prisma/schema.prisma
//                                      DATABASE_URL=... MASTER_KEY=... node scripts/backup-restore.mjs restore mck-2026-10-30.bkp
import { readFileSync } from 'node:fs';

const [cmd, file] = process.argv.slice(2);
if (!cmd || !file) {
  console.error('Uso: node scripts/backup-restore.mjs <info|ndjson|restore> <arquivo.bkp>');
  process.exit(1);
}
const { readBackupFile, restoreBackupFile } = await import('../dist/server/lib/backup.js');
const buf = readFileSync(file);
if (cmd === 'info') {
  const { header, records } = readBackupFile(buf);
  const counts = {};
  for (const r of records) counts[r.m] = (counts[r.m] ?? 0) + 1;
  console.log(JSON.stringify({ criadoEm: header.createdAt, total: records.length, tabelas: counts }, null, 2));
} else if (cmd === 'ndjson') {
  const { header, records } = readBackupFile(buf);
  process.stdout.write(JSON.stringify(header) + '\n');
  for (const r of records) process.stdout.write(JSON.stringify(r) + '\n');
} else if (cmd === 'restore') {
  const out = await restoreBackupFile(buf);
  console.log('Restaurado:', JSON.stringify(out, null, 2));
  const { prisma } = await import('../dist/server/db.js');
  await prisma.$disconnect();
} else {
  console.error('Comando desconhecido:', cmd);
  process.exit(1);
}
