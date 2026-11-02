-- Pedidos pela IA no painel da Agenda: o que a IA atende (Reunião/Pedido/Os dois), tipo de pedido,
-- "Solicitar dados de entrega", classificação da conversa e tabela de pedidos. Aditiva.
-- AlterTable
ALTER TABLE "AgendaSettings" ADD COLUMN "aiHandles" TEXT NOT NULL DEFAULT 'REUNIAO';
ALTER TABLE "AgendaSettings" ADD COLUMN "orderType" TEXT NOT NULL DEFAULT 'FISICO';
ALTER TABLE "AgendaSettings" ADD COLUMN "orderAskDelivery" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN "aiIntent" TEXT;

-- CreateTable
CREATE TABLE "Order" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'FISICO',
    "items" TEXT NOT NULL DEFAULT '[]',
    "description" TEXT,
    "delivery" TEXT,
    "status" TEXT NOT NULL DEFAULT 'NOVO',
    "source" TEXT NOT NULL DEFAULT 'AI',
    "notes" TEXT,
    "fingerprint" TEXT,
    "contactId" TEXT,
    "conversationId" TEXT,
    "channelId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Order_orgId_createdAt_idx" ON "Order"("orgId", "createdAt");
CREATE INDEX "Order_orgId_status_idx" ON "Order"("orgId", "status");
CREATE INDEX "Order_orgId_contactId_idx" ON "Order"("orgId", "contactId");
