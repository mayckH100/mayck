import { prisma } from '../db.js';

/**
 * Bootstrap de superadmin sem acesso ao banco: env SUPERADMIN_EMAILS (lista separada por vírgula).
 * Quem estiver na lista recebe isSuperAdmin=true no login e no startup. Nunca remove o acesso de ninguém.
 */
export function superAdminEmails(): string[] {
  return (process.env.SUPERADMIN_EMAILS || '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e.length > 0 && e.includes('@'));
}

export const isBootstrapSuperAdmin = (email: string) => superAdminEmails().includes(email.trim().toLowerCase());

/** Promove (no startup) todos os usuários já existentes cujo e-mail está na lista. Retorna quantos foram promovidos. */
export async function syncSuperAdmins(): Promise<number> {
  const emails = superAdminEmails();
  if (!emails.length) return 0;
  // Só contas com e-mail confirmado: impede que alguém cadastre um e-mail da lista que ainda não tem conta e vire superadmin.
  const r = await prisma.user.updateMany({ where: { email: { in: emails }, isSuperAdmin: false, emailVerifiedAt: { not: null } }, data: { isSuperAdmin: true } });
  return r.count;
}

/** Promove um usuário específico (no login), se estiver na lista. */
export async function ensureSuperAdmin(user: { id: string; email: string; isSuperAdmin: boolean; emailVerifiedAt?: Date | null }): Promise<boolean> {
  if (user.isSuperAdmin || !isBootstrapSuperAdmin(user.email)) return false;
  if (!user.emailVerifiedAt) return false; // e-mail precisa estar confirmado

  await prisma.user.update({ where: { id: user.id }, data: { isSuperAdmin: true } });
  return true;
}
