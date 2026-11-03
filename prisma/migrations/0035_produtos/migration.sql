-- Produtos (catálogo do cliente para a IA). Somente aditivo (tabela e índices novos).
-- CreateTable
CREATE TABLE "Product" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT,
    "priceCents" INTEGER,
    "promoCents" INTEGER,
    "description" TEXT NOT NULL DEFAULT '',
    "details" TEXT NOT NULL DEFAULT '',
    "stock" TEXT NOT NULL DEFAULT 'disponivel',
    "quantity" INTEGER,
    "link" TEXT,
    "imageUrl" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Product_orgId_active_idx" ON "Product"("orgId", "active");

-- CreateIndex
CREATE INDEX "Product_orgId_name_idx" ON "Product"("orgId", "name");

