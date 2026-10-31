-- "Aguardando atendente": conversa transferida para humano (waitingSince/handoffAlertSentAt) e, na organização,
-- número reserva (backupPhone) + minutos até o aviso por WhatsApp (handoffAlertMinutes). Aditiva.
-- AlterTable
ALTER TABLE "Organization" ADD COLUMN     "backupPhone" TEXT,
ADD COLUMN     "handoffAlertMinutes" INTEGER NOT NULL DEFAULT 5;

-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN     "handoffAlertSentAt" TIMESTAMP(3),
ADD COLUMN     "waitingSince" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Conversation_orgId_waitingSince_idx" ON "Conversation"("orgId", "waitingSince");

