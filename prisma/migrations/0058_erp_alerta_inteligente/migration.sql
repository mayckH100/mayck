-- MCK ERP v1.30.0: alerta diário mais completo (opções em JSON) e aprovação de pedido de compra pelo WhatsApp. Só aditiva.
-- AlterTable
ALTER TABLE "ErpConfig" ADD COLUMN "alertaOpcoes" TEXT;

-- CreateTable
CREATE TABLE "ErpAprovacaoCompra" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "codigo" TEXT NOT NULL,
    "dia" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDENTE',
    "itens" TEXT NOT NULL DEFAULT '[]',
    "telefones" TEXT NOT NULL DEFAULT '[]',
    "estado" TEXT NOT NULL DEFAULT '{}',
    "mensagens" TEXT NOT NULL DEFAULT '[]',
    "versao" INTEGER NOT NULL DEFAULT 0,
    "aprovadoPor" TEXT,
    "aprovadoEm" TIMESTAMP(3),
    "expiraEm" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ErpAprovacaoCompra_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ErpAprovacaoCompra_orgId_codigo_key" ON "ErpAprovacaoCompra"("orgId", "codigo");

-- CreateIndex
CREATE INDEX "ErpAprovacaoCompra_orgId_status_expiraEm_idx" ON "ErpAprovacaoCompra"("orgId", "status", "expiraEm");
