-- MCK ERP: sessões de caixa do PDV (abertura, sangria, suprimento, fechamento). Só aditiva.
-- CreateTable
CREATE TABLE "ErpCaixaSessao" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "contaFinanceiraId" TEXT NOT NULL,
    "contaAberta" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ABERTO',
    "abertoPorUserId" TEXT,
    "abertoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "valorAberturaCents" INTEGER NOT NULL DEFAULT 0,
    "observacaoAbertura" TEXT,
    "qtdVendas" INTEGER NOT NULL DEFAULT 0,
    "fechadoPorUserId" TEXT,
    "fechadoEm" TIMESTAMP(3),
    "valorContadoCents" INTEGER,
    "valorEsperadoCents" INTEGER,
    "diferencaCents" INTEGER,
    "totalVendasCents" INTEGER,
    "totalSangriasCents" INTEGER,
    "totalSuprimentosCents" INTEGER,
    "totaisPorForma" TEXT,
    "observacaoFechamento" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ErpCaixaSessao_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ErpCaixaMovimento" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "sessaoId" TEXT NOT NULL,
    "tipo" TEXT NOT NULL,
    "valorCents" INTEGER NOT NULL,
    "motivo" TEXT NOT NULL,
    "contaOutraId" TEXT,
    "userId" TEXT,
    "em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ErpCaixaMovimento_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ErpCaixaSessao_contaAberta_key" ON "ErpCaixaSessao"("contaAberta");

-- CreateIndex
CREATE INDEX "ErpCaixaSessao_orgId_abertoEm_idx" ON "ErpCaixaSessao"("orgId", "abertoEm");

-- CreateIndex
CREATE INDEX "ErpCaixaSessao_orgId_status_idx" ON "ErpCaixaSessao"("orgId", "status");

-- CreateIndex
CREATE INDEX "ErpCaixaMovimento_sessaoId_idx" ON "ErpCaixaMovimento"("sessaoId");

-- CreateIndex
CREATE INDEX "ErpCaixaMovimento_orgId_em_idx" ON "ErpCaixaMovimento"("orgId", "em");

-- AlterTable
ALTER TABLE "ErpPedidoVenda" ADD COLUMN "caixaSessaoId" TEXT;

-- AlterTable
ALTER TABLE "ErpBaixa" ADD COLUMN "caixaSessaoId" TEXT;

-- CreateIndex
CREATE INDEX "ErpPedidoVenda_caixaSessaoId_idx" ON "ErpPedidoVenda"("caixaSessaoId");

-- CreateIndex
CREATE INDEX "ErpBaixa_caixaSessaoId_idx" ON "ErpBaixa"("caixaSessaoId");
