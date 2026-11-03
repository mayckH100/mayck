-- Lembrete antes de vencer (teste ou plano pago), por produto: 3 dias e 1 dia antes, por e-mail.
-- Migração só aditiva: uma coluna nova com padrão (ligado) e uma tabela nova; nada existente é alterado.
-- AlterTable
ALTER TABLE "User" ADD COLUMN "renewalReminders" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "RenewalReminder" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "product" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "validUntil" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ENVIANDO',
    "channel" TEXT NOT NULL DEFAULT 'EMAIL',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RenewalReminder_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RenewalReminder_orgId_product_kind_validUntil_key" ON "RenewalReminder"("orgId", "product", "kind", "validUntil");

-- CreateIndex
CREATE INDEX "RenewalReminder_status_updatedAt_idx" ON "RenewalReminder"("status", "updatedAt");
