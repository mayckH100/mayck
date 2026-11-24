-- v1.49.0: imagem/PDF, repetição, público gravado e rodízio de números nas campanhas (só aditiva).
ALTER TABLE "Campaign" ADD COLUMN "midias" TEXT NOT NULL DEFAULT '[]';
ALTER TABLE "Campaign" ADD COLUMN "recorrencia" TEXT NOT NULL DEFAULT '';
ALTER TABLE "Campaign" ADD COLUMN "recorrenciaFim" TIMESTAMP(3);
ALTER TABLE "Campaign" ADD COLUMN "recorrenciaProxima" TIMESTAMP(3);
ALTER TABLE "Campaign" ADD COLUMN "recorrenciaOrigemId" TEXT;
ALTER TABLE "Campaign" ADD COLUMN "recorrenciaExecucao" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Campaign" ADD COLUMN "publico" TEXT;
ALTER TABLE "Campaign" ADD COLUMN "rodizio" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Campaign" ADD COLUMN "canaisRodizio" TEXT NOT NULL DEFAULT '[]';
ALTER TABLE "CampaignRecipient" ADD COLUMN "channelId" TEXT;
CREATE INDEX "Campaign_recorrenciaOrigemId_idx" ON "Campaign"("recorrenciaOrigemId");
