-- MCK ERP etapa 2 (produtos, estoque/WMS, vendas/OMS). Só aditiva.
-- CreateTable
CREATE TABLE "ErpConfig" (
    "orgId" TEXT NOT NULL,
    "descontoMaxBp" INTEGER NOT NULL DEFAULT 1000,
    "bloquearSemCredito" BOOLEAN NOT NULL DEFAULT true,
    "validadeOrcamentoDias" INTEGER NOT NULL DEFAULT 15,
    "proximoPedido" INTEGER NOT NULL DEFAULT 1,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ErpConfig_pkey" PRIMARY KEY ("orgId")
);

-- CreateTable
CREATE TABLE "ErpProduto" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "nome" TEXT NOT NULL,
    "descricao" TEXT,
    "codigoBarras" TEXT,
    "unidade" TEXT NOT NULL DEFAULT 'UN',
    "ncm" TEXT,
    "cest" TEXT,
    "origem" INTEGER NOT NULL DEFAULT 0,
    "pesoGramas" INTEGER NOT NULL DEFAULT 0,
    "controlaLote" BOOLEAN NOT NULL DEFAULT false,
    "controlaValidade" BOOLEAN NOT NULL DEFAULT false,
    "regraSaida" TEXT NOT NULL DEFAULT 'FIFO',
    "estoqueMinimoMil" INTEGER NOT NULL DEFAULT 0,
    "pontoPedidoMil" INTEGER NOT NULL DEFAULT 0,
    "precoBaseCents" INTEGER NOT NULL DEFAULT 0,
    "custoMedioCents" INTEGER NOT NULL DEFAULT 0,
    "tipo" TEXT NOT NULL DEFAULT 'REVENDA',
    "ativo" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ErpProduto_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ErpTabelaPreco" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "nome" TEXT NOT NULL,
    "uf" TEXT,
    "ativa" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ErpTabelaPreco_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ErpTabelaPrecoItem" (
    "id" TEXT NOT NULL,
    "tabelaId" TEXT NOT NULL,
    "produtoId" TEXT NOT NULL,
    "qtdMinimaMil" INTEGER NOT NULL DEFAULT 0,
    "precoCents" INTEGER NOT NULL,

    CONSTRAINT "ErpTabelaPrecoItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ErpCondicaoPagamento" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "nome" TEXT NOT NULL,
    "prazos" TEXT NOT NULL DEFAULT '[0]',
    "ativa" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ErpCondicaoPagamento_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ErpDeposito" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "filialId" TEXT,
    "nome" TEXT NOT NULL,
    "ativo" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ErpDeposito_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ErpEnderecoEstoque" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "depositoId" TEXT NOT NULL,
    "codigo" TEXT NOT NULL,
    "ativo" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "ErpEnderecoEstoque_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ErpLote" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "produtoId" TEXT NOT NULL,
    "numero" TEXT NOT NULL,
    "fabricacao" TIMESTAMP(3),
    "validade" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'LIBERADO',
    "origemTipo" TEXT,
    "origemId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ErpLote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ErpSaldo" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "produtoId" TEXT NOT NULL,
    "loteId" TEXT NOT NULL,
    "enderecoId" TEXT NOT NULL,
    "fisicoMil" INTEGER NOT NULL DEFAULT 0,
    "reservadoMil" INTEGER NOT NULL DEFAULT 0,
    "quarentenaMil" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ErpSaldo_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ErpMovimento" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "produtoId" TEXT NOT NULL,
    "loteId" TEXT NOT NULL,
    "enderecoId" TEXT NOT NULL,
    "tipo" TEXT NOT NULL,
    "qtdMil" INTEGER NOT NULL,
    "custoUnitCents" INTEGER NOT NULL DEFAULT 0,
    "saldoAposMil" INTEGER NOT NULL,
    "docTipo" TEXT,
    "docId" TEXT,
    "motivo" TEXT,
    "userId" TEXT,
    "correlationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ErpMovimento_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ErpReserva" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "pedidoItemId" TEXT NOT NULL,
    "saldoId" TEXT NOT NULL,
    "produtoId" TEXT NOT NULL,
    "loteId" TEXT NOT NULL,
    "enderecoId" TEXT NOT NULL,
    "qtdMil" INTEGER NOT NULL,
    "separadoMil" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'ATIVA',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ErpReserva_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ErpPedidoVenda" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "numero" INTEGER NOT NULL,
    "filialId" TEXT,
    "centroCustoId" TEXT,
    "depositoId" TEXT,
    "parceiroId" TEXT NOT NULL,
    "oportunidadeId" TEXT,
    "vendedorId" TEXT,
    "tabelaPrecoId" TEXT,
    "condicaoPagamentoId" TEXT,
    "statusOperacional" TEXT NOT NULL DEFAULT 'RASCUNHO',
    "statusFinanceiro" TEXT NOT NULL DEFAULT 'SEM_TITULO',
    "subtotalCents" INTEGER NOT NULL DEFAULT 0,
    "descontoCents" INTEGER NOT NULL DEFAULT 0,
    "freteCents" INTEGER NOT NULL DEFAULT 0,
    "totalCents" INTEGER NOT NULL DEFAULT 0,
    "descontoMaxItemBp" INTEGER NOT NULL DEFAULT 0,
    "motivoBloqueio" TEXT,
    "aprovadoPorId" TEXT,
    "aprovadoEm" TIMESTAMP(3),
    "validadeOrcamento" TIMESTAMP(3),
    "nfNumero" TEXT,
    "transportadora" TEXT,
    "rastreio" TEXT,
    "entregueEm" TIMESTAMP(3),
    "previsaoEntrega" TIMESTAMP(3),
    "motivoCancelamento" TEXT,
    "observacoes" TEXT,
    "correlationId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ErpPedidoVenda_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ErpPedidoItem" (
    "id" TEXT NOT NULL,
    "pedidoId" TEXT NOT NULL,
    "produtoId" TEXT NOT NULL,
    "descricao" TEXT NOT NULL,
    "qtdMil" INTEGER NOT NULL,
    "precoUnitCents" INTEGER NOT NULL,
    "descontoBp" INTEGER NOT NULL DEFAULT 0,
    "totalCents" INTEGER NOT NULL,
    "reservadoMil" INTEGER NOT NULL DEFAULT 0,
    "separadoMil" INTEGER NOT NULL DEFAULT 0,
    "posicao" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ErpPedidoItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ErpProduto_orgId_nome_idx" ON "ErpProduto"("orgId", "nome");

-- CreateIndex
CREATE INDEX "ErpProduto_orgId_codigoBarras_idx" ON "ErpProduto"("orgId", "codigoBarras");

-- CreateIndex
CREATE UNIQUE INDEX "ErpProduto_orgId_sku_key" ON "ErpProduto"("orgId", "sku");

-- CreateIndex
CREATE INDEX "ErpTabelaPreco_orgId_idx" ON "ErpTabelaPreco"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "ErpTabelaPrecoItem_tabelaId_produtoId_qtdMinimaMil_key" ON "ErpTabelaPrecoItem"("tabelaId", "produtoId", "qtdMinimaMil");

-- CreateIndex
CREATE INDEX "ErpCondicaoPagamento_orgId_idx" ON "ErpCondicaoPagamento"("orgId");

-- CreateIndex
CREATE INDEX "ErpDeposito_orgId_idx" ON "ErpDeposito"("orgId");

-- CreateIndex
CREATE INDEX "ErpEnderecoEstoque_orgId_idx" ON "ErpEnderecoEstoque"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "ErpEnderecoEstoque_depositoId_codigo_key" ON "ErpEnderecoEstoque"("depositoId", "codigo");

-- CreateIndex
CREATE INDEX "ErpLote_orgId_produtoId_validade_idx" ON "ErpLote"("orgId", "produtoId", "validade");

-- CreateIndex
CREATE UNIQUE INDEX "ErpLote_orgId_produtoId_numero_key" ON "ErpLote"("orgId", "produtoId", "numero");

-- CreateIndex
CREATE INDEX "ErpSaldo_orgId_produtoId_idx" ON "ErpSaldo"("orgId", "produtoId");

-- CreateIndex
CREATE UNIQUE INDEX "ErpSaldo_produtoId_loteId_enderecoId_key" ON "ErpSaldo"("produtoId", "loteId", "enderecoId");

-- CreateIndex
CREATE INDEX "ErpMovimento_orgId_produtoId_createdAt_idx" ON "ErpMovimento"("orgId", "produtoId", "createdAt");

-- CreateIndex
CREATE INDEX "ErpMovimento_orgId_docTipo_docId_idx" ON "ErpMovimento"("orgId", "docTipo", "docId");

-- CreateIndex
CREATE INDEX "ErpReserva_orgId_pedidoItemId_idx" ON "ErpReserva"("orgId", "pedidoItemId");

-- CreateIndex
CREATE INDEX "ErpReserva_saldoId_status_idx" ON "ErpReserva"("saldoId", "status");

-- CreateIndex
CREATE INDEX "ErpPedidoVenda_orgId_statusOperacional_idx" ON "ErpPedidoVenda"("orgId", "statusOperacional");

-- CreateIndex
CREATE INDEX "ErpPedidoVenda_orgId_parceiroId_idx" ON "ErpPedidoVenda"("orgId", "parceiroId");

-- CreateIndex
CREATE UNIQUE INDEX "ErpPedidoVenda_orgId_numero_key" ON "ErpPedidoVenda"("orgId", "numero");

-- CreateIndex
CREATE INDEX "ErpPedidoItem_pedidoId_idx" ON "ErpPedidoItem"("pedidoId");

-- CreateIndex
CREATE INDEX "ErpPedidoItem_produtoId_idx" ON "ErpPedidoItem"("produtoId");

-- AddForeignKey
ALTER TABLE "ErpTabelaPrecoItem" ADD CONSTRAINT "ErpTabelaPrecoItem_tabelaId_fkey" FOREIGN KEY ("tabelaId") REFERENCES "ErpTabelaPreco"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ErpEnderecoEstoque" ADD CONSTRAINT "ErpEnderecoEstoque_depositoId_fkey" FOREIGN KEY ("depositoId") REFERENCES "ErpDeposito"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ErpPedidoItem" ADD CONSTRAINT "ErpPedidoItem_pedidoId_fkey" FOREIGN KEY ("pedidoId") REFERENCES "ErpPedidoVenda"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Saldo nunca negativo e reserva nunca maior que o físico (garantia no banco, além do UPDATE condicionado no código).
ALTER TABLE "ErpSaldo" ADD CONSTRAINT "ErpSaldo_nao_negativo" CHECK ("fisicoMil" >= 0 AND "reservadoMil" >= 0 AND "quarentenaMil" >= 0 AND "reservadoMil" + "quarentenaMil" <= "fisicoMil");
ALTER TABLE "ErpReserva" ADD CONSTRAINT "ErpReserva_qtd_valida" CHECK ("qtdMil" > 0 AND "separadoMil" >= 0 AND "separadoMil" <= "qtdMil");
