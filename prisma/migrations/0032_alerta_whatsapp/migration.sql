-- Alerta de WhatsApp desconectado: estado do episódio no canal, opção de e-mail no usuário e dia do resumo diário.
-- Migração só aditiva: colunas novas opcionais ou com padrão; nada existente é alterado.
ALTER TABLE "Channel" ADD COLUMN "waUpSeenAt" TIMESTAMP(3);
ALTER TABLE "Channel" ADD COLUMN "waDownSince" TIMESTAMP(3);
ALTER TABLE "Channel" ADD COLUMN "waDownAlertAt" TIMESTAMP(3);
ALTER TABLE "Channel" ADD COLUMN "waDownReminderAt" TIMESTAMP(3);
ALTER TABLE "Channel" ADD COLUMN "waBackAt" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN "waDownEmail" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "PlatformSettings" ADD COLUMN "waDigestDay" TEXT;
