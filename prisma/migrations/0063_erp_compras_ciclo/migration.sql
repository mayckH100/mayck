-- MCK v1.36.0: ciclo de vida da ordem de compra (etapas, prazo, linha do tempo e avisos).
-- Só aditiva: colunas com padrão/opcionais e duas tabelas novas. Os status antigos continuam válidos (mesmos valores; só ganharam rótulos novos).

-- AlterTable
ALTER TABLE "ErpConfig" ADD COLUMN     "compraAvisoEquipeWhats" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "compraAvisoFornCanal" TEXT NOT NULL DEFAULT 'EMAIL',
ADD COLUMN     "compraAvisoFornDias" INTEGER NOT NULL DEFAULT 2,
ADD COLUMN     "compraAvisoFornTextoAtraso" TEXT,
ADD COLUMN     "compraAvisoFornTextoLembrete" TEXT,
ADD COLUMN     "compraAvisoFornecedor" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "compraEmBreveDias" INTEGER NOT NULL DEFAULT 2,
ADD COLUMN     "compraQualidadePadrao" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "compraRotinaDia" TEXT;

-- AlterTable
ALTER TABLE "ErpProduto" ADD COLUMN     "exigeQualidade" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "ErpPedidoCompra" ADD COLUMN     "emitidoEm" TIMESTAMP(3),
ADD COLUMN     "entregueEm" TIMESTAMP(3),
ADD COLUMN     "exigeQualidade" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "prazoEntregaDias" INTEGER,
ADD COLUMN     "previsaoManual" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "ErpPedidoCompraHistorico" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "pedidoId" TEXT NOT NULL,
    "de" TEXT,
    "para" TEXT NOT NULL,
    "evento" TEXT NOT NULL,
    "userId" TEXT,
    "userNome" TEXT,
    "observacao" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ErpPedidoCompraHistorico_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ErpAvisoCompra" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "pedidoId" TEXT NOT NULL,
    "tipo" TEXT NOT NULL,
    "dia" TEXT NOT NULL,
    "destino" TEXT NOT NULL DEFAULT 'EQUIPE',
    "titulo" TEXT NOT NULL,
    "texto" TEXT NOT NULL,
    "envio" TEXT,
    "lidoEm" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ErpAvisoCompra_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ErpPedidoCompraHistorico_pedidoId_createdAt_idx" ON "ErpPedidoCompraHistorico"("pedidoId", "createdAt");

-- CreateIndex
CREATE INDEX "ErpAvisoCompra_orgId_createdAt_idx" ON "ErpAvisoCompra"("orgId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ErpAvisoCompra_pedidoId_tipo_dia_key" ON "ErpAvisoCompra"("pedidoId", "tipo", "dia");

-- AddForeignKey
ALTER TABLE "ErpPedidoCompraHistorico" ADD CONSTRAINT "ErpPedidoCompraHistorico_pedidoId_fkey" FOREIGN KEY ("pedidoId") REFERENCES "ErpPedidoCompra"("id") ON DELETE CASCADE ON UPDATE CASCADE;

