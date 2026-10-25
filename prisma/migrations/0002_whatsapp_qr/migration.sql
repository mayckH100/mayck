-- AlterTable
ALTER TABLE "Channel" ADD COLUMN     "connectedAt" TIMESTAMP(3),
ADD COLUMN     "waJid" TEXT;

-- CreateTable
CREATE TABLE "WaAuthState" (
    "id" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "keyId" TEXT NOT NULL,
    "dataEnc" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WaAuthState_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WaAuthState_channelId_idx" ON "WaAuthState"("channelId");

-- CreateIndex
CREATE UNIQUE INDEX "WaAuthState_channelId_type_keyId_key" ON "WaAuthState"("channelId", "type", "keyId");

