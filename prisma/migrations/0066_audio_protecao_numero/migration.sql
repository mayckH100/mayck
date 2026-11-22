-- MCK v1.42.0: IA que entende áudio (limite de duração configurável) e proteção contra bloqueio do número (QR).
-- Só aditiva: duas colunas com padrão, um índice e duas tabelas novas. Sem registro em ChannelProtection = padrões seguros.

-- AlterTable
ALTER TABLE "AiSettings" ADD COLUMN "transcribeMaxSeconds" INTEGER NOT NULL DEFAULT 120;

-- AlterTable
ALTER TABLE "Message" ADD COLUMN "bulk" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "Message_channelId_createdAt_idx" ON "Message"("channelId", "createdAt");

-- CreateTable
CREATE TABLE "ChannelProtection" (
    "channelId" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "hourLimit" INTEGER NOT NULL DEFAULT 60,
    "dayLimit" INTEGER NOT NULL DEFAULT 300,
    "minGapSec" INTEGER NOT NULL DEFAULT 20,
    "maxGapSec" INTEGER NOT NULL DEFAULT 60,
    "warmupEnabled" BOOLEAN NOT NULL DEFAULT true,
    "warmupDays" INTEGER NOT NULL DEFAULT 14,
    "warmupStartedAt" TIMESTAMP(3),
    "typingEnabled" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChannelProtection_pkey" PRIMARY KEY ("channelId")
);

-- CreateTable
CREATE TABLE "ChannelHealthEvent" (
    "id" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "detail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChannelHealthEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ChannelProtection_orgId_idx" ON "ChannelProtection"("orgId");

-- CreateIndex
CREATE INDEX "ChannelHealthEvent_channelId_createdAt_idx" ON "ChannelHealthEvent"("channelId", "createdAt");
