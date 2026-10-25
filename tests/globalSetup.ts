import { execSync } from 'node:child_process';
import { rmSync } from 'node:fs';

/**
 * Prepara o banco de testes.
 *  - padrão: SQLite descartável (prisma/sqlite/test.db);
 *  - TEST_DB=postgres: aplica as migrações reais (prisma/migrations) em DATABASE_URL, após limpar o schema.
 */
export default function setup() {
  if (process.env.TEST_DB === 'postgres') {
    if (!process.env.DATABASE_URL) throw new Error('Defina DATABASE_URL para TEST_DB=postgres');
    execSync('npx prisma migrate reset --force --skip-generate --skip-seed --schema prisma/schema.prisma', { stdio: 'pipe', env: process.env });
    return;
  }
  for (const f of ['prisma/sqlite/test.db', 'prisma/sqlite/test.db-journal']) rmSync(f, { force: true });
  execSync('npx prisma db push --schema prisma/sqlite/schema.prisma --skip-generate --accept-data-loss', {
    stdio: 'pipe',
    env: { ...process.env, SQLITE_URL: 'file:./test.db' },
  });
}
