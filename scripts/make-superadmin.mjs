// Promove um usuário a superadmin da plataforma (painel Master).
// Uso: DATABASE_URL=postgres://... node scripts/make-superadmin.mjs email@exemplo.com
//      (para revogar: node scripts/make-superadmin.mjs email@exemplo.com --revoke)
import { PrismaClient } from '@prisma/client';

const email = String(process.argv[2] ?? '').trim().toLowerCase();
const revoke = process.argv.includes('--revoke');
if (!email || !email.includes('@')) {
  console.error('Uso: node scripts/make-superadmin.mjs <email> [--revoke]');
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error('Defina DATABASE_URL (string de conexão do PostgreSQL).');
  process.exit(1);
}
const prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
try {
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    console.error(`Usuário não encontrado: ${email}. Crie a conta pelo cadastro do app primeiro.`);
    process.exit(2);
  }
  await prisma.user.update({ where: { id: user.id }, data: { isSuperAdmin: !revoke } });
  await prisma.auditLog.create({ data: { userId: user.id, action: revoke ? 'master.superadmin.revoke_cli' : 'master.superadmin.grant_cli', entity: 'user', entityId: user.id, meta: JSON.stringify({ email }) } });
  console.log(`${email}: isSuperAdmin = ${!revoke}`);
} finally {
  await prisma.$disconnect();
}
