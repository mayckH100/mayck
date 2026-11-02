-- Pedidos: novo fluxo de status (com exceções), status de pagamento independente, contatos adicionais,
-- motivo de cancelamento e histórico. Migra os status antigos: EM_ANDAMENTO→EM_SEPARACAO, CONCLUIDO→FINALIZADO
-- (NOVO e CANCELADO continuam). Pedidos já existentes ficam com pagamento "Não se aplica" (valor desconhecido).
-- AlterTable
ALTER TABLE "Order" ADD COLUMN "paymentStatus" TEXT NOT NULL DEFAULT 'AGUARDANDO';
ALTER TABLE "Order" ADD COLUMN "extraContacts" TEXT NOT NULL DEFAULT '[]';
ALTER TABLE "Order" ADD COLUMN "cancelReason" TEXT;

-- Migração dos valores antigos
UPDATE "Order" SET "status" = 'EM_SEPARACAO' WHERE "status" = 'EM_ANDAMENTO';
UPDATE "Order" SET "status" = 'FINALIZADO' WHERE "status" = 'CONCLUIDO';
UPDATE "Order" SET "paymentStatus" = 'NAO_SE_APLICA';

-- CreateTable
CREATE TABLE "OrderStatusHistory" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'STATUS',
    "fromValue" TEXT,
    "toValue" TEXT,
    "note" TEXT,
    "userId" TEXT,
    "notified" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderStatusHistory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OrderStatusHistory_orgId_orderId_createdAt_idx" ON "OrderStatusHistory"("orgId", "orderId", "createdAt");
