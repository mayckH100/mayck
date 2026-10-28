-- Migração ADITIVA (FASE 2 Automações e Cobranças): só cria tabelas, colunas (com padrão ou opcionais) e índices novos.
-- Nada é removido nem renomeado.
-- AlterTable
ALTER TABLE "Automacao" ADD COLUMN     "reenvio" TEXT;

-- AlterTable
ALTER TABLE "Ocorrencia" ADD COLUMN     "boletoId" TEXT,
ADD COLUMN     "indice" INTEGER,
ADD COLUMN     "partesEnviadas" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "tipo" TEXT NOT NULL DEFAULT 'ENVIO';

-- AlterTable
ALTER TABLE "MensagemHistorico" ADD COLUMN     "anexos" TEXT,
ADD COLUMN     "boletoId" TEXT,
ADD COLUMN     "comprovanteId" TEXT;

-- AlterTable
ALTER TABLE "AutomacaoConfig" ADD COLUMN     "notificarComprovantes" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "reenvioPadrao" TEXT NOT NULL DEFAULT '{"offsets":[-1,0,1,3,7],"horario":"10:00","maxPorBoleto":5}',
ADD COLUMN     "tamanhoMaxMb" INTEGER NOT NULL DEFAULT 10,
ADD COLUMN     "tiposArquivo" TEXT NOT NULL DEFAULT 'pdf,png,jpg,webp';

-- CreateTable
CREATE TABLE "Arquivo" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "clienteId" TEXT,
    "nome" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "tamanho" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "origem" TEXT NOT NULL DEFAULT 'UPLOAD',
    "descricao" TEXT,
    "criadoPorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Arquivo_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ArquivoConteudo" (
    "arquivoId" TEXT NOT NULL,
    "dados" BYTEA NOT NULL,

    CONSTRAINT "ArquivoConteudo_pkey" PRIMARY KEY ("arquivoId")
);

-- CreateTable
CREATE TABLE "Boleto" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "clienteId" TEXT NOT NULL,
    "descricao" TEXT NOT NULL,
    "numeroDocumento" TEXT,
    "parcela" INTEGER,
    "totalParcelas" INTEGER,
    "valorCentavos" INTEGER NOT NULL,
    "valorAtualizadoCentavos" INTEGER,
    "jurosCentavos" INTEGER NOT NULL DEFAULT 0,
    "multaCentavos" INTEGER NOT NULL DEFAULT 0,
    "descontoCentavos" INTEGER NOT NULL DEFAULT 0,
    "valorPagoCentavos" INTEGER NOT NULL DEFAULT 0,
    "emissao" TIMESTAMP(3),
    "vencimento" TIMESTAMP(3) NOT NULL,
    "codigoBarras" TEXT,
    "linhaDigitavel" TEXT,
    "linkPagamento" TEXT,
    "arquivoId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDENTE',
    "statusEnvio" TEXT NOT NULL DEFAULT 'NAO_ENVIADO',
    "enviadoEm" TIMESTAMP(3),
    "envios" INTEGER NOT NULL DEFAULT 0,
    "pagoEm" TIMESTAMP(3),
    "origemBaixa" TEXT,
    "observacoes" TEXT,
    "criadoPorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Boleto_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BoletoEvento" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "boletoId" TEXT NOT NULL,
    "tipo" TEXT NOT NULL,
    "descricao" TEXT NOT NULL,
    "dados" TEXT,
    "operadorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BoletoEvento_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Pagamento" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "boletoId" TEXT NOT NULL,
    "clienteId" TEXT NOT NULL,
    "valorCentavos" INTEGER NOT NULL,
    "pagoEm" TIMESTAMP(3) NOT NULL,
    "forma" TEXT,
    "origem" TEXT NOT NULL DEFAULT 'MANUAL',
    "comprovanteId" TEXT,
    "observacoes" TEXT,
    "operadorId" TEXT,
    "estornadoEm" TIMESTAMP(3),
    "estornoMotivo" TEXT,
    "estornadoPorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Pagamento_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Comprovante" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "clienteId" TEXT,
    "boletoId" TEXT,
    "arquivoId" TEXT,
    "origem" TEXT NOT NULL DEFAULT 'UPLOAD',
    "origemId" TEXT,
    "texto" TEXT,
    "sha256" TEXT,
    "valorDetectadoCentavos" INTEGER,
    "dataDetectada" TEXT,
    "transacaoId" TEXT,
    "instituicao" TEXT,
    "confianca" INTEGER NOT NULL DEFAULT 0,
    "analise" TEXT,
    "duplicadoDeId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'EM_ANALISE',
    "revisadoPorId" TEXT,
    "revisadoEm" TIMESTAMP(3),
    "motivoRevisao" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Comprovante_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AutomacaoAnexo" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "automacaoId" TEXT NOT NULL,
    "envio" INTEGER,
    "ordem" INTEGER NOT NULL DEFAULT 0,
    "arquivoId" TEXT,
    "boletoId" TEXT,

    CONSTRAINT "AutomacaoAnexo_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Arquivo_orgId_clienteId_idx" ON "Arquivo"("orgId", "clienteId");

-- CreateIndex
CREATE INDEX "Arquivo_orgId_sha256_idx" ON "Arquivo"("orgId", "sha256");

-- CreateIndex
CREATE INDEX "Boleto_orgId_status_idx" ON "Boleto"("orgId", "status");

-- CreateIndex
CREATE INDEX "Boleto_orgId_clienteId_idx" ON "Boleto"("orgId", "clienteId");

-- CreateIndex
CREATE INDEX "Boleto_orgId_vencimento_idx" ON "Boleto"("orgId", "vencimento");

-- CreateIndex
CREATE INDEX "BoletoEvento_boletoId_createdAt_idx" ON "BoletoEvento"("boletoId", "createdAt");

-- CreateIndex
CREATE INDEX "Pagamento_orgId_pagoEm_idx" ON "Pagamento"("orgId", "pagoEm");

-- CreateIndex
CREATE INDEX "Pagamento_boletoId_idx" ON "Pagamento"("boletoId");

-- CreateIndex
CREATE INDEX "Comprovante_orgId_status_idx" ON "Comprovante"("orgId", "status");

-- CreateIndex
CREATE INDEX "Comprovante_orgId_clienteId_idx" ON "Comprovante"("orgId", "clienteId");

-- CreateIndex
CREATE INDEX "Comprovante_orgId_sha256_idx" ON "Comprovante"("orgId", "sha256");

-- CreateIndex
CREATE UNIQUE INDEX "Comprovante_orgId_origemId_key" ON "Comprovante"("orgId", "origemId");

-- CreateIndex
CREATE INDEX "AutomacaoAnexo_automacaoId_idx" ON "AutomacaoAnexo"("automacaoId");

-- CreateIndex
CREATE INDEX "AutomacaoAnexo_boletoId_idx" ON "AutomacaoAnexo"("boletoId");

-- CreateIndex
CREATE INDEX "Ocorrencia_boletoId_status_idx" ON "Ocorrencia"("boletoId", "status");

