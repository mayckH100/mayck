-- v1.48.0: variações do texto, teste A/B, início agendado e dias da semana nas campanhas (só aditiva).
ALTER TABLE "Campaign" ADD COLUMN "variacoes" TEXT NOT NULL DEFAULT '[]';
ALTER TABLE "Campaign" ADD COLUMN "abAutoVencedora" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Campaign" ADD COLUMN "abMinimo" INTEGER NOT NULL DEFAULT 30;
ALTER TABLE "Campaign" ADD COLUMN "abVencedora" INTEGER;
ALTER TABLE "Campaign" ADD COLUMN "abVencedoraEm" TIMESTAMP(3);
ALTER TABLE "Campaign" ADD COLUMN "iniciarEm" TIMESTAMP(3);
ALTER TABLE "Campaign" ADD COLUMN "diasSemana" TEXT NOT NULL DEFAULT '0123456';
ALTER TABLE "CampaignRecipient" ADD COLUMN "variante" INTEGER;
