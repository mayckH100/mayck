-- MCK v1.35.0: IA mais inteligente (camada única, qualidade e correções).
-- Só aditiva: colunas opcionais/com padrão e uma tabela nova. Nada é apagado nem alterado.

-- AlterTable
ALTER TABLE "AiSettings" ADD COLUMN "guardValues" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "AiUsage" ADD COLUMN "purpose" TEXT;
ALTER TABLE "AiUsage" ADD COLUMN "promptVersion" TEXT;
ALTER TABLE "AiUsage" ADD COLUMN "quality" TEXT;

-- CreateTable
CREATE TABLE "AiFeedback" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "conversationId" TEXT,
    "messageId" TEXT,
    "question" TEXT NOT NULL,
    "badAnswer" TEXT NOT NULL,
    "correction" TEXT NOT NULL,
    "knowledgeDocId" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiFeedback_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AiFeedback_orgId_createdAt_idx" ON "AiFeedback"("orgId", "createdAt");
