import { prisma } from '../db.js';

export const DEFAULT_STAGES = [
  { name: 'Novo', color: '#3b82f6' },
  { name: 'Em atendimento', color: '#f59e0b' },
  { name: 'Qualificado', color: '#8b5cf6' },
  { name: 'Ganho', color: '#10b981' },
  { name: 'Perdido', color: '#ef4444' },
];

export async function createOrganization(userId: string, name: string) {
  return prisma.$transaction(async (tx) => {
    const org = await tx.organization.create({ data: { name } });
    await tx.membership.create({ data: { userId, orgId: org.id, role: 'OWNER' } });
    await tx.kanbanStage.createMany({ data: DEFAULT_STAGES.map((s, i) => ({ ...s, orgId: org.id, position: i })) });
    await tx.aiSettings.create({ data: { orgId: org.id } });
    return org;
  });
}
