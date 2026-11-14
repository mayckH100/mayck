-- MCK ERP · Financeiro: subcategorias (categoria-mãe) e tipos de conta a pagar criados pela empresa. Só aditiva.
-- AlterTable
ALTER TABLE "ErpCategoriaFinanceira" ADD COLUMN     "paiId" TEXT;

-- AlterTable
ALTER TABLE "ErpTitulo" ADD COLUMN     "tipoContaId" TEXT;

-- CreateTable
CREATE TABLE "ErpTipoConta" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "nome" TEXT NOT NULL,
    "categoriaId" TEXT,
    "ativo" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ErpTipoConta_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ErpTipoConta_orgId_idx" ON "ErpTipoConta"("orgId");

-- CreateIndex
CREATE INDEX "ErpCategoriaFinanceira_orgId_paiId_idx" ON "ErpCategoriaFinanceira"("orgId", "paiId");

