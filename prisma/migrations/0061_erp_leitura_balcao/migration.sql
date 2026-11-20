-- MCK ERP v1.34.0: venda de balcão por leitura de código (etiqueta do lote) e localizar pedido.
-- Só aditiva: coluna nova opcional no item do pedido (lote lido no balcão) e índices para localizar pedidos.

-- AlterTable
ALTER TABLE "ErpPedidoItem" ADD COLUMN "loteId" TEXT;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ErpPedidoVenda_orgId_nfNumero_idx" ON "ErpPedidoVenda"("orgId", "nfNumero");
