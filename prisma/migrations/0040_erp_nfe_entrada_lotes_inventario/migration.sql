-- MCK ERP: entrada por XML de NF-e, de-para produto x fornecedor, lote interno/fornecedor, etiquetas e inventário. Só aditiva.
-- AlterTable
ALTER TABLE "ErpConfig" ADD COLUMN     "etiquetaAlturaMm" INTEGER NOT NULL DEFAULT 50,
ADD COLUMN     "etiquetaDpi" INTEGER NOT NULL DEFAULT 203,
ADD COLUMN     "etiquetaLarguraMm" INTEGER NOT NULL DEFAULT 100,
ADD COLUMN     "formatoLote" TEXT NOT NULL DEFAULT '{AA}{MM}{DD}-{SEQ}',
ADD COLUMN     "proximoLoteInterno" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "ErpLote" ADD COLUMN     "fornecedorId" TEXT,
ADD COLUMN     "loteFornecedor" TEXT;

-- CreateTable
CREATE TABLE "ErpProdutoFornecedor" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "parceiroId" TEXT NOT NULL,
    "codigoFornecedor" TEXT NOT NULL,
    "produtoId" TEXT NOT NULL,
    "fatorMil" INTEGER NOT NULL DEFAULT 1000,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ErpProdutoFornecedor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ErpNfeEntrada" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "chave" TEXT NOT NULL,
    "numero" TEXT NOT NULL,
    "serie" TEXT NOT NULL,
    "dataEmissao" TIMESTAMP(3),
    "parceiroId" TEXT NOT NULL,
    "emitenteCnpj" TEXT NOT NULL,
    "emitenteNome" TEXT NOT NULL,
    "valorTotalCents" INTEGER NOT NULL,
    "autorizada" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'PENDENTE',
    "xml" TEXT NOT NULL,
    "lancadaEm" TIMESTAMP(3),
    "lancadaPorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ErpNfeEntrada_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ErpNfeEntradaItem" (
    "id" TEXT NOT NULL,
    "nfeId" TEXT NOT NULL,
    "nItem" INTEGER NOT NULL,
    "codigo" TEXT NOT NULL,
    "descricao" TEXT NOT NULL,
    "ean" TEXT,
    "ncm" TEXT,
    "cfop" TEXT,
    "unidade" TEXT NOT NULL,
    "qtdMil" INTEGER NOT NULL,
    "valorUnitCents" INTEGER NOT NULL,
    "custoTotalCents" INTEGER NOT NULL,
    "lotes" TEXT NOT NULL DEFAULT '[]',
    "produtoId" TEXT,
    "fatorMil" INTEGER NOT NULL DEFAULT 1000,
    "lotesGerados" TEXT NOT NULL DEFAULT '[]',

    CONSTRAINT "ErpNfeEntradaItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ErpInventario" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "descricao" TEXT NOT NULL,
    "depositoId" TEXT,
    "cego" BOOLEAN NOT NULL DEFAULT true,
    "status" TEXT NOT NULL DEFAULT 'CONTANDO',
    "criadoPorId" TEXT,
    "aprovadoPorId" TEXT,
    "concluidoEm" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ErpInventario_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ErpInventarioContagem" (
    "id" TEXT NOT NULL,
    "inventarioId" TEXT NOT NULL,
    "produtoId" TEXT NOT NULL,
    "loteId" TEXT NOT NULL,
    "enderecoId" TEXT NOT NULL,
    "sistemaMil" INTEGER NOT NULL,
    "contadoMil" INTEGER,
    "contadoPorId" TEXT,
    "contadoEm" TIMESTAMP(3),

    CONSTRAINT "ErpInventarioContagem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ErpProdutoFornecedor_orgId_produtoId_idx" ON "ErpProdutoFornecedor"("orgId", "produtoId");

-- CreateIndex
CREATE UNIQUE INDEX "ErpProdutoFornecedor_orgId_parceiroId_codigoFornecedor_key" ON "ErpProdutoFornecedor"("orgId", "parceiroId", "codigoFornecedor");

-- CreateIndex
CREATE INDEX "ErpNfeEntrada_orgId_status_idx" ON "ErpNfeEntrada"("orgId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ErpNfeEntrada_orgId_chave_key" ON "ErpNfeEntrada"("orgId", "chave");

-- CreateIndex
CREATE INDEX "ErpInventario_orgId_status_idx" ON "ErpInventario"("orgId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ErpInventarioContagem_inventarioId_produtoId_loteId_enderec_key" ON "ErpInventarioContagem"("inventarioId", "produtoId", "loteId", "enderecoId");

-- AddForeignKey
ALTER TABLE "ErpNfeEntradaItem" ADD CONSTRAINT "ErpNfeEntradaItem_nfeId_fkey" FOREIGN KEY ("nfeId") REFERENCES "ErpNfeEntrada"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ErpInventarioContagem" ADD CONSTRAINT "ErpInventarioContagem_inventarioId_fkey" FOREIGN KEY ("inventarioId") REFERENCES "ErpInventario"("id") ON DELETE CASCADE ON UPDATE CASCADE;

