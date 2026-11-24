-- v1.51.0: campanha com número de envio escolhido pela responsável e "Enviar mesmo assim" com o número em Risco (só aditiva).
ALTER TABLE "Campaign" ADD COLUMN "envioFixo" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Campaign" ADD COLUMN "riscoLiberadoCanalId" TEXT;
ALTER TABLE "Campaign" ADD COLUMN "riscoLiberadoPor" TEXT;
ALTER TABLE "Campaign" ADD COLUMN "riscoLiberadoPorNome" TEXT;
ALTER TABLE "Campaign" ADD COLUMN "riscoLiberadoEm" TIMESTAMP(3);
