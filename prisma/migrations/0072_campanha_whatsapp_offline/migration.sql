-- v1.46.1: campanha aguarda o WhatsApp reconectar e falha de conexão volta para a fila (só aditiva).
ALTER TABLE "Campaign" ADD COLUMN "offlinePausa" TEXT;
ALTER TABLE "Campaign" ADD COLUMN "offlinePausaEm" TIMESTAMP(3);
ALTER TABLE "CampaignRecipient" ADD COLUMN "tentativas" INTEGER NOT NULL DEFAULT 0;
