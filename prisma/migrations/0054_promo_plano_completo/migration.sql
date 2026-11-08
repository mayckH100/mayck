-- Promoção de entrada do Plano Completo (v1.27.0). Só aditiva: duas colunas novas com padrão.
-- "introOfferJson" = '{}' usa o padrão do código (ligada, R$ 58,00 nos 2 primeiros meses do COMBO mensal, só cliente nova).
-- "introOffer" marca o pagamento que contou como mês da promoção (os pagamentos antigos ficam false).
-- AlterTable
ALTER TABLE "PlatformSettings" ADD COLUMN     "introOfferJson" TEXT NOT NULL DEFAULT '{}';

-- AlterTable
ALTER TABLE "BillingEvent" ADD COLUMN     "introOffer" BOOLEAN NOT NULL DEFAULT false;
