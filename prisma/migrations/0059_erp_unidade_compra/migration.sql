-- MCK ERP v1.32.0: unidade de compra (embalagem) e quantidade por embalagem. Só aditiva.
-- Produtos existentes ficam com 1 por embalagem (fator 1000 = 1,000) e sem unidade de compra: nada muda para eles.
-- AlterTable
ALTER TABLE "ErpProduto" ADD COLUMN     "unidadeCompra" TEXT;
ALTER TABLE "ErpProduto" ADD COLUMN     "fatorCompraMil" INTEGER NOT NULL DEFAULT 1000;
