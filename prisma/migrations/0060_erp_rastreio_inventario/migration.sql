-- MCK ERP v1.33.0: rastreabilidade de lote + inventário com relatório Físico x Sistema e aprovação com senha do proprietário.
-- Só aditiva: colunas novas (com padrão) e um UPDATE que dá nome ao lote "sem número" antigo.

-- AlterTable
ALTER TABLE "ErpInventario" ADD COLUMN     "fechadoEm" TIMESTAMP(3);
ALTER TABLE "ErpInventario" ADD COLUMN     "fechadoPorId" TEXT;
ALTER TABLE "ErpInventario" ADD COLUMN     "notificadoEm" TIMESTAMP(3);
ALTER TABLE "ErpInventario" ADD COLUMN     "resumoJson" TEXT;
ALTER TABLE "ErpInventario" ADD COLUMN     "motivoAjuste" TEXT;

-- AlterTable
ALTER TABLE "ErpInventarioContagem" ADD COLUMN     "leituras" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "ErpInventarioContagem" ADD COLUMN     "modo" TEXT;
ALTER TABLE "ErpInventarioContagem" ADD COLUMN     "custoUnitCents" INTEGER NOT NULL DEFAULT 0;

-- Saldos antigos sem lote (antes da v1.31.0 o lote ficava "UNICO"): passam a se chamar L-INICIAL.
-- Mesmo registro (mesmo id): saldos, movimentos, reservas, contagens e etiquetas continuam ligados; nada é apagado.
-- A data de entrada do lote é a do primeiro movimento (que não muda). Pula o produto que já tiver um L-INICIAL.
UPDATE "ErpLote" AS l
SET "numero" = 'L-INICIAL', "origemTipo" = COALESCE(l."origemTipo", 'inicial')
WHERE l."numero" = 'UNICO'
  AND NOT EXISTS (SELECT 1 FROM "ErpLote" x WHERE x."orgId" = l."orgId" AND x."produtoId" = l."produtoId" AND x."numero" = 'L-INICIAL');
