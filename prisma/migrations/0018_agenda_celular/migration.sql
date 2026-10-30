-- WhatsApp QR: não responder automaticamente contatos salvos na agenda do celular (opção por canal,
-- desligada por padrão) e agenda sincronizada do aparelho. Aditiva.
ALTER TABLE "Channel" ADD COLUMN "replySavedContacts" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Channel" ADD COLUMN "addressBookSyncedAt" TIMESTAMP(3);
ALTER TABLE "Contact" ADD COLUMN "savedInPhone" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "WaPhoneContact" (
    "id" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "jidKey" TEXT NOT NULL,
    "saved" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WaPhoneContact_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WaPhoneContact_channelId_jidKey_key" ON "WaPhoneContact"("channelId", "jidKey");

-- CreateIndex
CREATE INDEX "WaPhoneContact_channelId_idx" ON "WaPhoneContact"("channelId");
