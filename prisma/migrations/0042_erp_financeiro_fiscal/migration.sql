-- MCK ERP Etapa 4: financeiro (contas, plano de contas, títulos, baixas, lançamentos, extrato OFX) e fiscal (emitente, certificado cifrado, regras, NF-e de saída). Só aditiva.
-- AlterTable
ALTER TABLE "ErpConfig" ADD COLUMN     "jurosMesBp" INTEGER NOT NULL DEFAULT 100,
ADD COLUMN     "multaAtrasoBp" INTEGER NOT NULL DEFAULT 200;

-- CreateTable
CREATE TABLE "ErpContaFinanceira" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "nome" TEXT NOT NULL,
    "tipo" TEXT NOT NULL DEFAULT 'BANCO',
    "banco" TEXT,
    "agencia" TEXT,
    "conta" TEXT,
    "chavePix" TEXT,
    "saldoInicialCents" INTEGER NOT NULL DEFAULT 0,
    "ativa" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ErpContaFinanceira_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ErpCategoriaFinanceira" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "codigo" TEXT NOT NULL,
    "nome" TEXT NOT NULL,
    "tipo" TEXT NOT NULL,
    "grupo" TEXT NOT NULL DEFAULT 'OPERACIONAL',
    "ativa" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "ErpCategoriaFinanceira_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ErpTitulo" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "tipo" TEXT NOT NULL,
    "parceiroId" TEXT,
    "descricao" TEXT NOT NULL,
    "docTipo" TEXT,
    "docId" TEXT,
    "parcela" INTEGER NOT NULL DEFAULT 1,
    "parcelas" INTEGER NOT NULL DEFAULT 1,
    "valorCents" INTEGER NOT NULL,
    "pagoCents" INTEGER NOT NULL DEFAULT 0,
    "jurosCents" INTEGER NOT NULL DEFAULT 0,
    "descontoCents" INTEGER NOT NULL DEFAULT 0,
    "emissao" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "competencia" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "vencimento" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'EM_ABERTO',
    "categoriaId" TEXT,
    "centroCustoId" TEXT,
    "contaPrevistaId" TEXT,
    "observacoes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ErpTitulo_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ErpBaixa" (
    "id" TEXT NOT NULL,
    "tituloId" TEXT NOT NULL,
    "contaId" TEXT NOT NULL,
    "data" TIMESTAMP(3) NOT NULL,
    "valorCents" INTEGER NOT NULL,
    "jurosCents" INTEGER NOT NULL DEFAULT 0,
    "descontoCents" INTEGER NOT NULL DEFAULT 0,
    "forma" TEXT NOT NULL DEFAULT 'PIX',
    "estornada" BOOLEAN NOT NULL DEFAULT false,
    "userId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ErpBaixa_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ErpLancamento" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "contaId" TEXT NOT NULL,
    "data" TIMESTAMP(3) NOT NULL,
    "valorCents" INTEGER NOT NULL,
    "descricao" TEXT NOT NULL,
    "origemTipo" TEXT NOT NULL,
    "origemId" TEXT,
    "categoriaId" TEXT,
    "conciliado" BOOLEAN NOT NULL DEFAULT false,
    "extratoId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ErpLancamento_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ErpExtratoLinha" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "contaId" TEXT NOT NULL,
    "fitId" TEXT NOT NULL,
    "data" TIMESTAMP(3) NOT NULL,
    "valorCents" INTEGER NOT NULL,
    "descricao" TEXT NOT NULL,
    "lancamentoId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ErpExtratoLinha_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ErpConfigFiscal" (
    "orgId" TEXT NOT NULL,
    "razaoSocial" TEXT NOT NULL DEFAULT '',
    "fantasia" TEXT,
    "cnpj" TEXT NOT NULL DEFAULT '',
    "ie" TEXT NOT NULL DEFAULT '',
    "crt" INTEGER NOT NULL DEFAULT 1,
    "uf" TEXT NOT NULL DEFAULT 'SP',
    "codMunicipio" TEXT NOT NULL DEFAULT '',
    "municipio" TEXT NOT NULL DEFAULT '',
    "logradouro" TEXT NOT NULL DEFAULT '',
    "numero" TEXT NOT NULL DEFAULT '',
    "bairro" TEXT NOT NULL DEFAULT '',
    "cep" TEXT NOT NULL DEFAULT '',
    "fone" TEXT,
    "ambiente" INTEGER NOT NULL DEFAULT 2,
    "serie" INTEGER NOT NULL DEFAULT 1,
    "proximoNumero" INTEGER NOT NULL DEFAULT 1,
    "certPfx" TEXT,
    "certSenha" TEXT,
    "certTitular" TEXT,
    "certValidade" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ErpConfigFiscal_pkey" PRIMARY KEY ("orgId")
);

-- CreateTable
CREATE TABLE "ErpRegraFiscal" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "nome" TEXT NOT NULL,
    "produtoId" TEXT,
    "ncmPrefixo" TEXT,
    "cfopDentro" TEXT NOT NULL DEFAULT '5102',
    "cfopFora" TEXT NOT NULL DEFAULT '6102',
    "csosn" TEXT NOT NULL DEFAULT '102',
    "cstIcms" TEXT NOT NULL DEFAULT '00',
    "aliqIcmsBp" INTEGER NOT NULL DEFAULT 0,
    "cstIpi" TEXT NOT NULL DEFAULT '53',
    "aliqIpiBp" INTEGER NOT NULL DEFAULT 0,
    "cstPis" TEXT NOT NULL DEFAULT '49',
    "aliqPisBp" INTEGER NOT NULL DEFAULT 0,
    "cstCofins" TEXT NOT NULL DEFAULT '49',
    "aliqCofinsBp" INTEGER NOT NULL DEFAULT 0,
    "prioridade" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ErpRegraFiscal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ErpNfeSaida" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "pedidoId" TEXT,
    "parceiroId" TEXT NOT NULL,
    "numero" INTEGER NOT NULL,
    "serie" INTEGER NOT NULL,
    "chave" TEXT NOT NULL,
    "ambiente" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ASSINADA',
    "totalCents" INTEGER NOT NULL,
    "xml" TEXT NOT NULL,
    "protocolo" TEXT,
    "cStat" TEXT,
    "motivo" TEXT,
    "autorizadaEm" TIMESTAMP(3),
    "canceladaEm" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ErpNfeSaida_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ErpContaFinanceira_orgId_idx" ON "ErpContaFinanceira"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "ErpCategoriaFinanceira_orgId_codigo_key" ON "ErpCategoriaFinanceira"("orgId", "codigo");

-- CreateIndex
CREATE INDEX "ErpTitulo_orgId_tipo_status_vencimento_idx" ON "ErpTitulo"("orgId", "tipo", "status", "vencimento");

-- CreateIndex
CREATE INDEX "ErpTitulo_orgId_parceiroId_idx" ON "ErpTitulo"("orgId", "parceiroId");

-- CreateIndex
CREATE UNIQUE INDEX "ErpTitulo_orgId_tipo_docTipo_docId_parcela_key" ON "ErpTitulo"("orgId", "tipo", "docTipo", "docId", "parcela");

-- CreateIndex
CREATE INDEX "ErpLancamento_orgId_contaId_data_idx" ON "ErpLancamento"("orgId", "contaId", "data");

-- CreateIndex
CREATE INDEX "ErpExtratoLinha_orgId_contaId_data_idx" ON "ErpExtratoLinha"("orgId", "contaId", "data");

-- CreateIndex
CREATE UNIQUE INDEX "ErpExtratoLinha_contaId_fitId_key" ON "ErpExtratoLinha"("contaId", "fitId");

-- CreateIndex
CREATE INDEX "ErpRegraFiscal_orgId_produtoId_idx" ON "ErpRegraFiscal"("orgId", "produtoId");

-- CreateIndex
CREATE INDEX "ErpNfeSaida_orgId_status_idx" ON "ErpNfeSaida"("orgId", "status");

-- CreateIndex
CREATE INDEX "ErpNfeSaida_pedidoId_idx" ON "ErpNfeSaida"("pedidoId");

-- CreateIndex
CREATE UNIQUE INDEX "ErpNfeSaida_orgId_chave_key" ON "ErpNfeSaida"("orgId", "chave");

-- CreateIndex
CREATE UNIQUE INDEX "ErpNfeSaida_orgId_serie_numero_ambiente_key" ON "ErpNfeSaida"("orgId", "serie", "numero", "ambiente");

-- AddForeignKey
ALTER TABLE "ErpBaixa" ADD CONSTRAINT "ErpBaixa_tituloId_fkey" FOREIGN KEY ("tituloId") REFERENCES "ErpTitulo"("id") ON DELETE CASCADE ON UPDATE CASCADE;

