-- Números de aviso: alerta quando a IA não consegue responder um cliente (WhatsApp + e-mail). Ligado por padrão. Só aditiva.
ALTER TABLE "Organization" ADD COLUMN "alertAiFailure" BOOLEAN NOT NULL DEFAULT true;
