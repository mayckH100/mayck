-- Aviso imediato de atendimento humano (vários números), retentativas e regras da IA. Só aditiva.
ALTER TABLE "Organization" ADD COLUMN "handoffNotifyPhones" TEXT;
ALTER TABLE "Organization" ADD COLUMN "handoffNotifyStatus" TEXT;
ALTER TABLE "Conversation" ADD COLUMN "handoffNotifyAt" TIMESTAMP(3);
ALTER TABLE "Conversation" ADD COLUMN "handoffNotifyTries" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Conversation" ADD COLUMN "handoffAlertTries" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "AiSettings" ADD COLUMN "failureMessage" TEXT NOT NULL DEFAULT '';
ALTER TABLE "AiSettings" ADD COLUMN "competitorNotes" TEXT NOT NULL DEFAULT '';
ALTER TABLE "AiSettings" ADD COLUMN "useMckSite" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "AiSettings" ADD COLUMN "webSearch" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "AiSettings" ADD COLUMN "kanbanAuto" BOOLEAN NOT NULL DEFAULT false;
