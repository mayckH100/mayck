-- Números de aviso (WhatsApp): o que avisar. Tudo ligado por padrão. Só aditiva.
ALTER TABLE "Organization" ADD COLUMN "alertHandoff" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Organization" ADD COLUMN "alertMeeting" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Organization" ADD COLUMN "alertTask" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Organization" ADD COLUMN "alertOrder" BOOLEAN NOT NULL DEFAULT true;
