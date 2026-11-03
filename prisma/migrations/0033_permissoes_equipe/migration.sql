-- Equipe: permissões por módulo e por canal WhatsApp, e controle de envio/reenvio do e-mail de convite.
-- Migração só aditiva: colunas novas anuláveis (ou com padrão). Membros existentes ficam com NULL = acesso de antes (tudo o que o papel permite).
-- AlterTable
ALTER TABLE "Membership" ADD COLUMN "modules" TEXT;
ALTER TABLE "Membership" ADD COLUMN "channelIds" TEXT;
ALTER TABLE "Invitation" ADD COLUMN "modules" TEXT;
ALTER TABLE "Invitation" ADD COLUMN "channelIds" TEXT;
ALTER TABLE "Invitation" ADD COLUMN "lastSentAt" TIMESTAMP(3);
ALTER TABLE "Invitation" ADD COLUMN "sendCount" INTEGER NOT NULL DEFAULT 0;
