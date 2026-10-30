-- WhatsApp QR: trava única por canal (evita duas conexões na mesma sessão durante deploy)
-- e mensagens enviadas completas para reenvio fiel ("Aguardando mensagem"). Aditiva.
ALTER TABLE "Channel" ADD COLUMN "qrLeaseOwner" TEXT;
ALTER TABLE "Channel" ADD COLUMN "qrLeaseUntil" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "WaSentMessage" (
    "id" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "waMessageId" TEXT NOT NULL,
    "dataEnc" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WaSentMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WaSentMessage_channelId_waMessageId_key" ON "WaSentMessage"("channelId", "waMessageId");

-- CreateIndex
CREATE INDEX "WaSentMessage_createdAt_idx" ON "WaSentMessage"("createdAt");
