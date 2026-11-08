-- Planos editáveis no Painel Master (v1.25.0). Só aditiva: uma coluna nova com padrão '{}'.
-- '{}' = planos com os valores de hoje (nomes, descrições, módulos e todos visíveis). Preços continuam em "pricesJson".
-- AlterTable
ALTER TABLE "PlatformSettings" ADD COLUMN     "plansJson" TEXT NOT NULL DEFAULT '{}';
