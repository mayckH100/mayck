-- MCK v1.45.0: aquecimento ATIVO do número QR (conversas automáticas entre os números da própria empresa).
-- Só aditiva: tabelas novas (WarmupConfig, WarmupExtraNumber, WarmupMessage, WarmupExchange) e índices.

-- CreateTable
CREATE TABLE "WarmupConfig" (
    "channelId" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "days" INTEGER NOT NULL DEFAULT 14,
    "startedAt" TIMESTAMP(3),
    "startHour" INTEGER NOT NULL DEFAULT 8,
    "endHour" INTEGER NOT NULL DEFAULT 21,
    "peerChannelIds" TEXT NOT NULL DEFAULT '',
    "allowAsPeer" BOOLEAN NOT NULL DEFAULT true,
    "useAi" BOOLEAN NOT NULL DEFAULT true,
    "useExtras" BOOLEAN NOT NULL DEFAULT true,
    "nextAt" TIMESTAMP(3),
    "pausedReason" TEXT,
    "pausedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WarmupConfig_pkey" PRIMARY KEY ("channelId")
);

-- CreateTable
CREATE TABLE "WarmupExtraNumber" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "label" TEXT,
    "confirmedByUserId" TEXT,
    "confirmedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WarmupExtraNumber_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WarmupMessage" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'text',
    "peerChannelId" TEXT,
    "peerPhone" TEXT,
    "body" TEXT NOT NULL,
    "waMessageId" TEXT,
    "jid" TEXT,
    "exchangeId" TEXT,
    "source" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WarmupMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WarmupExchange" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "initiatorChannelId" TEXT NOT NULL,
    "peerChannelId" TEXT NOT NULL,
    "lines" TEXT NOT NULL,
    "nextIndex" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'PENDENTE',
    "dueAt" TIMESTAMP(3) NOT NULL,
    "claimedAt" TIMESTAMP(3),
    "source" TEXT NOT NULL DEFAULT 'local',
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WarmupExchange_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WarmupConfig_orgId_idx" ON "WarmupConfig"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "WarmupExtraNumber_orgId_phone_key" ON "WarmupExtraNumber"("orgId", "phone");

-- CreateIndex
CREATE INDEX "WarmupMessage_channelId_createdAt_idx" ON "WarmupMessage"("channelId", "createdAt");

-- CreateIndex
CREATE INDEX "WarmupMessage_orgId_waMessageId_idx" ON "WarmupMessage"("orgId", "waMessageId");

-- CreateIndex
CREATE INDEX "WarmupExchange_status_dueAt_idx" ON "WarmupExchange"("status", "dueAt");

-- CreateIndex
CREATE INDEX "WarmupExchange_initiatorChannelId_idx" ON "WarmupExchange"("initiatorChannelId");

-- CreateIndex
CREATE INDEX "WarmupExchange_peerChannelId_idx" ON "WarmupExchange"("peerChannelId");

