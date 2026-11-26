-- v1.54.0: identidade dos documentos impressos do MCK ERP (só aditiva).
CREATE TABLE "ErpDocumentoConfig" (
    "orgId" TEXT NOT NULL,
    "nomeExibicao" TEXT NOT NULL DEFAULT '',
    "cnpj" TEXT NOT NULL DEFAULT '',
    "ie" TEXT NOT NULL DEFAULT '',
    "logradouro" TEXT NOT NULL DEFAULT '',
    "numero" TEXT NOT NULL DEFAULT '',
    "bairro" TEXT NOT NULL DEFAULT '',
    "cidade" TEXT NOT NULL DEFAULT '',
    "uf" TEXT NOT NULL DEFAULT '',
    "cep" TEXT NOT NULL DEFAULT '',
    "telefone" TEXT NOT NULL DEFAULT '',
    "whatsapp" TEXT NOT NULL DEFAULT '',
    "email" TEXT NOT NULL DEFAULT '',
    "site" TEXT NOT NULL DEFAULT '',
    "textoLivre" TEXT NOT NULL DEFAULT '',
    "logo" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ErpDocumentoConfig_pkey" PRIMARY KEY ("orgId")
);
