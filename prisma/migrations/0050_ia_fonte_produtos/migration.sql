-- De onde a IA consulta os produtos (v1.24.0). Só aditiva: três colunas novas com padrão.
-- Nenhum dado existente muda; todas as empresas continuam em 'catalogo' (comportamento atual: só Produtos).
-- AlterTable
ALTER TABLE "AiSettings" ADD COLUMN     "productSource" TEXT NOT NULL DEFAULT 'catalogo',
ADD COLUMN     "erpShowQuantity" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "erpDepositoId" TEXT;
