-- MCK ERP Etapa 3: compras (solicitação, cotação, pedido com alçada, recebimento x NF-e) e produção (estrutura, roteiro, OP, MRP). Só aditiva.
-- AlterTable
ALTER TABLE "ErpConfig" ADD COLUMN     "alcadaCompraCents" INTEGER NOT NULL DEFAULT 500000,
ADD COLUMN     "proximaCotacao" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "proximaOp" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "proximaSolicitacao" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "proximoPedidoCompra" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "recebimentoCego" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "toleranciaPrecoBp" INTEGER NOT NULL DEFAULT 200;

-- AlterTable
ALTER TABLE "ErpProduto" ADD COLUMN     "fornecedorPadraoId" TEXT,
ADD COLUMN     "leadTimeDias" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "loteMinimoMil" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "ErpReserva" ADD COLUMN     "origemTipo" TEXT NOT NULL DEFAULT 'pedido_venda';

-- AlterTable
ALTER TABLE "ErpNfeEntrada" ADD COLUMN     "pedidoCompraId" TEXT;

-- AlterTable
ALTER TABLE "ErpNfeEntradaItem" ADD COLUMN     "conferidoMil" INTEGER;

-- CreateTable
CREATE TABLE "ErpSolicitacaoCompra" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "numero" INTEGER NOT NULL,
    "solicitanteId" TEXT,
    "centroCustoId" TEXT,
    "justificativa" TEXT,
    "origem" TEXT NOT NULL DEFAULT 'MANUAL',
    "necessidadeEm" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'RASCUNHO',
    "aprovadoPorId" TEXT,
    "motivo" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ErpSolicitacaoCompra_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ErpSolicitacaoItem" (
    "id" TEXT NOT NULL,
    "solicitacaoId" TEXT NOT NULL,
    "produtoId" TEXT NOT NULL,
    "qtdMil" INTEGER NOT NULL,
    "atendidoMil" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ErpSolicitacaoItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ErpCotacao" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "numero" INTEGER NOT NULL,
    "solicitacaoId" TEXT,
    "prazoResposta" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'ABERTA',
    "fornecedores" TEXT NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ErpCotacao_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ErpCotacaoItem" (
    "id" TEXT NOT NULL,
    "cotacaoId" TEXT NOT NULL,
    "produtoId" TEXT NOT NULL,
    "qtdMil" INTEGER NOT NULL,
    "solicitacaoItemId" TEXT,

    CONSTRAINT "ErpCotacaoItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ErpCotacaoResposta" (
    "id" TEXT NOT NULL,
    "cotacaoId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "parceiroId" TEXT NOT NULL,
    "precoUnitCents" INTEGER NOT NULL,
    "prazoEntregaDias" INTEGER NOT NULL DEFAULT 0,
    "condicao" TEXT,
    "vencedora" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "ErpCotacaoResposta_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ErpPedidoCompra" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "numero" INTEGER NOT NULL,
    "parceiroId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'RASCUNHO',
    "totalCents" INTEGER NOT NULL DEFAULT 0,
    "freteCents" INTEGER NOT NULL DEFAULT 0,
    "previsaoEntrega" TIMESTAMP(3),
    "condicao" TEXT,
    "observacoes" TEXT,
    "cotacaoId" TEXT,
    "centroCustoId" TEXT,
    "aprovadoPorId" TEXT,
    "motivo" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ErpPedidoCompra_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ErpPedidoCompraItem" (
    "id" TEXT NOT NULL,
    "pedidoId" TEXT NOT NULL,
    "produtoId" TEXT NOT NULL,
    "descricao" TEXT NOT NULL,
    "qtdMil" INTEGER NOT NULL,
    "precoUnitCents" INTEGER NOT NULL,
    "totalCents" INTEGER NOT NULL,
    "recebidoMil" INTEGER NOT NULL DEFAULT 0,
    "solicitacaoItemId" TEXT,

    CONSTRAINT "ErpPedidoCompraItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ErpEstruturaItem" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "produtoId" TEXT NOT NULL,
    "componenteId" TEXT NOT NULL,
    "qtdMil" INTEGER NOT NULL,
    "perdaBp" INTEGER NOT NULL DEFAULT 0,
    "posicao" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ErpEstruturaItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ErpOperacao" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "produtoId" TEXT NOT NULL,
    "sequencia" INTEGER NOT NULL,
    "descricao" TEXT NOT NULL,
    "centroTrabalho" TEXT NOT NULL,
    "segundosPorUn" INTEGER NOT NULL DEFAULT 0,
    "setupMinutos" INTEGER NOT NULL DEFAULT 0,
    "custoHoraCents" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ErpOperacao_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ErpOrdemProducao" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "numero" INTEGER NOT NULL,
    "produtoId" TEXT NOT NULL,
    "qtdPlanejadaMil" INTEGER NOT NULL,
    "qtdProduzidaMil" INTEGER NOT NULL DEFAULT 0,
    "qtdRefugoMil" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'PLANEJADA',
    "origem" TEXT NOT NULL DEFAULT 'MANUAL',
    "pedidoVendaId" TEXT,
    "depositoId" TEXT,
    "inicioPrevisto" TIMESTAMP(3),
    "fimPrevisto" TIMESTAMP(3),
    "custoMaterialCents" INTEGER NOT NULL DEFAULT 0,
    "custoOperacaoCents" INTEGER NOT NULL DEFAULT 0,
    "motivo" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ErpOrdemProducao_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ErpOpComponente" (
    "id" TEXT NOT NULL,
    "opId" TEXT NOT NULL,
    "produtoId" TEXT NOT NULL,
    "qtdPrevistaMil" INTEGER NOT NULL,
    "qtdReservadaMil" INTEGER NOT NULL DEFAULT 0,
    "qtdConsumidaMil" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ErpOpComponente_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ErpOpApontamento" (
    "id" TEXT NOT NULL,
    "opId" TEXT NOT NULL,
    "qtdBoaMil" INTEGER NOT NULL,
    "qtdRefugoMil" INTEGER NOT NULL DEFAULT 0,
    "loteId" TEXT,
    "custoUnitCents" INTEGER NOT NULL DEFAULT 0,
    "userId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ErpOpApontamento_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ErpSolicitacaoCompra_orgId_status_idx" ON "ErpSolicitacaoCompra"("orgId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ErpSolicitacaoCompra_orgId_numero_key" ON "ErpSolicitacaoCompra"("orgId", "numero");

-- CreateIndex
CREATE INDEX "ErpCotacao_orgId_status_idx" ON "ErpCotacao"("orgId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ErpCotacao_orgId_numero_key" ON "ErpCotacao"("orgId", "numero");

-- CreateIndex
CREATE UNIQUE INDEX "ErpCotacaoResposta_itemId_parceiroId_key" ON "ErpCotacaoResposta"("itemId", "parceiroId");

-- CreateIndex
CREATE INDEX "ErpPedidoCompra_orgId_status_idx" ON "ErpPedidoCompra"("orgId", "status");

-- CreateIndex
CREATE INDEX "ErpPedidoCompra_orgId_parceiroId_idx" ON "ErpPedidoCompra"("orgId", "parceiroId");

-- CreateIndex
CREATE UNIQUE INDEX "ErpPedidoCompra_orgId_numero_key" ON "ErpPedidoCompra"("orgId", "numero");

-- CreateIndex
CREATE INDEX "ErpEstruturaItem_orgId_componenteId_idx" ON "ErpEstruturaItem"("orgId", "componenteId");

-- CreateIndex
CREATE UNIQUE INDEX "ErpEstruturaItem_produtoId_componenteId_key" ON "ErpEstruturaItem"("produtoId", "componenteId");

-- CreateIndex
CREATE INDEX "ErpOperacao_orgId_produtoId_idx" ON "ErpOperacao"("orgId", "produtoId");

-- CreateIndex
CREATE INDEX "ErpOrdemProducao_orgId_status_idx" ON "ErpOrdemProducao"("orgId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ErpOrdemProducao_orgId_numero_key" ON "ErpOrdemProducao"("orgId", "numero");

-- AddForeignKey
ALTER TABLE "ErpSolicitacaoItem" ADD CONSTRAINT "ErpSolicitacaoItem_solicitacaoId_fkey" FOREIGN KEY ("solicitacaoId") REFERENCES "ErpSolicitacaoCompra"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ErpCotacaoItem" ADD CONSTRAINT "ErpCotacaoItem_cotacaoId_fkey" FOREIGN KEY ("cotacaoId") REFERENCES "ErpCotacao"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ErpCotacaoResposta" ADD CONSTRAINT "ErpCotacaoResposta_cotacaoId_fkey" FOREIGN KEY ("cotacaoId") REFERENCES "ErpCotacao"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ErpPedidoCompraItem" ADD CONSTRAINT "ErpPedidoCompraItem_pedidoId_fkey" FOREIGN KEY ("pedidoId") REFERENCES "ErpPedidoCompra"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ErpOpComponente" ADD CONSTRAINT "ErpOpComponente_opId_fkey" FOREIGN KEY ("opId") REFERENCES "ErpOrdemProducao"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ErpOpApontamento" ADD CONSTRAINT "ErpOpApontamento_opId_fkey" FOREIGN KEY ("opId") REFERENCES "ErpOrdemProducao"("id") ON DELETE CASCADE ON UPDATE CASCADE;

