-- MCK v1.43.0: repescagem automática inteligente das campanhas do MCK Mensagens.
-- Só aditiva: colunas novas com padrão ou nulas. Campanhas existentes ficam com a repescagem DESLIGADA
-- (nada é enviado sozinho depois do deploy); campanhas novas nascem ligadas pela API.
-- Um ADD COLUMN por comando (compatível com PostgreSQL e SQLite).

-- AlterTable
ALTER TABLE "Campaign" ADD COLUMN "repescagemAtiva" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Campaign" ADD COLUMN "repescagemDias" INTEGER NOT NULL DEFAULT 2;
ALTER TABLE "Campaign" ADD COLUMN "repescagemMax" INTEGER NOT NULL DEFAULT 2;
ALTER TABLE "Campaign" ADD COLUMN "repescagemModelo" TEXT NOT NULL DEFAULT '';
ALTER TABLE "Campaign" ADD COLUMN "repescagemPausa" TEXT;
ALTER TABLE "Campaign" ADD COLUMN "repescagemPausaEm" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "CampaignRecipient" ADD COLUMN "messageId" TEXT;
ALTER TABLE "CampaignRecipient" ADD COLUMN "respondeuAt" TIMESTAMP(3);
ALTER TABLE "CampaignRecipient" ADD COLUMN "repescagens" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "CampaignRecipient" ADD COLUMN "ultimaRepescagemAt" TIMESTAMP(3);
ALTER TABLE "CampaignRecipient" ADD COLUMN "ultimaMensagemId" TEXT;
ALTER TABLE "CampaignRecipient" ADD COLUMN "repescagemStatus" TEXT;
ALTER TABLE "CampaignRecipient" ADD COLUMN "repescagemMotivo" TEXT;
ALTER TABLE "CampaignRecipient" ADD COLUMN "repescagemFalhas" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "CampaignRecipient" ADD COLUMN "repescagemAposAt" TIMESTAMP(3);
