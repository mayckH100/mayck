-- IA de qualificação de leads (aditiva)
ALTER TABLE "Lead" ADD COLUMN "qualifyAttempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Lead" ADD COLUMN "nextAttemptAt" TIMESTAMP(3);
ALTER TABLE "Lead" ADD COLUMN "lastIntent" TEXT;
ALTER TABLE "Lead" ADD COLUMN "aiSummary" TEXT;
ALTER TABLE "Lead" ADD COLUMN "qualifiedAt" TIMESTAMP(3);
CREATE INDEX "Lead_status_nextAttemptAt_idx" ON "Lead"("status", "nextAttemptAt");

CREATE TABLE "LeadAiSettings" (
    "orgId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "instructions" TEXT NOT NULL DEFAULT '',
    "offer" TEXT NOT NULL DEFAULT '',
    "positiveAction" TEXT NOT NULL DEFAULT 'HANDOFF',
    "positiveFlowId" TEXT,
    "retryDays" INTEGER NOT NULL DEFAULT 3,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "retryMessage" TEXT NOT NULL DEFAULT 'Oi {nome}! Passando de novo por aqui 😊 Ainda posso te ajudar? Se quiser, libero um teste grátis pra você conhecer, sem compromisso.',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LeadAiSettings_pkey" PRIMARY KEY ("orgId")
);
