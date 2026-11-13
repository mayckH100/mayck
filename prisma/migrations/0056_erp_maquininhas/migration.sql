-- MCK ERP: maquininhas de cartão no PDV (configuração por empresa + cobranças enviadas ao terminal). Só aditiva.
-- CreateTable
CREATE TABLE "ErpMaquininhaConfig" (
    "orgId" TEXT NOT NULL,
    "provedor" TEXT NOT NULL DEFAULT 'mercadopago_point',
    "ativo" BOOLEAN NOT NULL DEFAULT true,
    "accessTokenEnc" TEXT,
    "terminalPadraoId" TEXT,
    "webhookChave" TEXT NOT NULL,
    "webhookSecretEnc" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ErpMaquininhaConfig_pkey" PRIMARY KEY ("orgId")
);

-- CreateTable
CREATE TABLE "ErpCobrancaCartao" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "provedor" TEXT NOT NULL,
    "terminalId" TEXT NOT NULL,
    "referencia" TEXT NOT NULL,
    "externalId" TEXT,
    "valorCents" INTEGER NOT NULL,
    "tipo" TEXT NOT NULL,
    "parcelas" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'PENDENTE',
    "statusProvedor" TEXT,
    "detalhe" TEXT,
    "cancelamentoSolicitado" BOOLEAN NOT NULL DEFAULT false,
    "venda" TEXT NOT NULL,
    "userId" TEXT,
    "gestor" BOOLEAN NOT NULL DEFAULT false,
    "caixaSessaoId" TEXT NOT NULL,
    "pedidoId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ErpCobrancaCartao_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ErpMaquininhaConfig_webhookChave_key" ON "ErpMaquininhaConfig"("webhookChave");

-- CreateIndex
CREATE UNIQUE INDEX "ErpCobrancaCartao_referencia_key" ON "ErpCobrancaCartao"("referencia");

-- CreateIndex
CREATE UNIQUE INDEX "ErpCobrancaCartao_pedidoId_key" ON "ErpCobrancaCartao"("pedidoId");

-- CreateIndex
CREATE INDEX "ErpCobrancaCartao_orgId_createdAt_idx" ON "ErpCobrancaCartao"("orgId", "createdAt");

-- CreateIndex
CREATE INDEX "ErpCobrancaCartao_orgId_externalId_idx" ON "ErpCobrancaCartao"("orgId", "externalId");
