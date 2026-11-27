-- v1.58.0: etiqueta de balança (EAN-13 que começa com 2). Só aditiva.
ALTER TABLE "ErpConfig" ADD COLUMN "balancaDigitos" INTEGER NOT NULL DEFAULT 4;
ALTER TABLE "ErpConfig" ADD COLUMN "balancaValor" TEXT NOT NULL DEFAULT 'PRECO';
