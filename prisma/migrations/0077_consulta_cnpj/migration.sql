-- v1.53.0: Consulta CNPJ / Prospecção no MCK Mensagens (só aditiva).
ALTER TABLE "Lead" ADD COLUMN "cnpj" TEXT;
ALTER TABLE "Lead" ADD COLUMN "empresa" TEXT;
ALTER TABLE "Lead" ADD COLUMN "dono" TEXT;
ALTER TABLE "Lead" ADD COLUMN "origemDado" TEXT;

CREATE TABLE "CnpjCache" (
    "cnpj" TEXT NOT NULL,
    "fonte" TEXT NOT NULL,
    "dados" TEXT NOT NULL,
    "consultadoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CnpjCache_pkey" PRIMARY KEY ("cnpj")
);

CREATE TABLE "CnpjUso" (
    "orgId" TEXT NOT NULL,
    "dia" TEXT NOT NULL,
    "consultas" INTEGER NOT NULL DEFAULT 0,
    "fonte" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "CnpjUso_pkey" PRIMARY KEY ("orgId","dia")
);
