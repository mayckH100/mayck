// Gera prisma/sqlite/schema.prisma a partir do schema PostgreSQL (dev e testes automatizados).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
const src = readFileSync('prisma/schema.prisma', 'utf8');
const out = src
  .replace('provider = "postgresql"', 'provider = "sqlite"')
  .replace('url      = env("DATABASE_URL")', 'url      = env("SQLITE_URL")');
mkdirSync('prisma/sqlite', { recursive: true });
writeFileSync('prisma/sqlite/schema.prisma', '// ARQUIVO GERADO — não edite. Fonte: prisma/schema.prisma\n' + out);
console.log('prisma/sqlite/schema.prisma gerado');
