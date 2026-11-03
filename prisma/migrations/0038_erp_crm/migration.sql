-- MCK ERP etapa 1 (core + CRM). Só aditiva: tabelas novas com prefixo Erp, nada do MCKBOT é alterado.
-- CreateTable
CREATE TABLE "ErpFilial" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "nome" TEXT NOT NULL,
    "cnpj" TEXT,
    "uf" TEXT,
    "ativa" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ErpFilial_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ErpCentroCusto" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "codigo" TEXT NOT NULL,
    "nome" TEXT NOT NULL,
    "ativo" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ErpCentroCusto_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ErpParceiro" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "filialId" TEXT,
    "tipoPessoa" TEXT NOT NULL,
    "documento" TEXT NOT NULL,
    "nome" TEXT NOT NULL,
    "fantasia" TEXT,
    "ehCliente" BOOLEAN NOT NULL DEFAULT true,
    "ehFornecedor" BOOLEAN NOT NULL DEFAULT false,
    "inscricaoEstadual" TEXT,
    "regimeTributario" TEXT,
    "cnae" TEXT,
    "cnaeDescricao" TEXT,
    "situacaoCadastral" TEXT,
    "situacaoConsultaEm" TIMESTAMP(3),
    "email" TEXT,
    "telefone" TEXT,
    "cep" TEXT,
    "logradouro" TEXT,
    "numero" TEXT,
    "complemento" TEXT,
    "bairro" TEXT,
    "municipio" TEXT,
    "codigoMunicipio" TEXT,
    "uf" TEXT,
    "limiteCreditoCents" INTEGER NOT NULL DEFAULT 0,
    "score" INTEGER NOT NULL DEFAULT 500,
    "status" TEXT NOT NULL DEFAULT 'ATIVO',
    "origem" TEXT,
    "contactId" TEXT,
    "tags" TEXT NOT NULL DEFAULT '[]',
    "observacoes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ErpParceiro_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ErpParceiroContato" (
    "id" TEXT NOT NULL,
    "parceiroId" TEXT NOT NULL,
    "nome" TEXT NOT NULL,
    "cargo" TEXT,
    "email" TEXT,
    "telefone" TEXT,
    "principal" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ErpParceiroContato_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ErpEtapaFunil" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "nome" TEXT NOT NULL,
    "posicao" INTEGER NOT NULL,
    "cor" TEXT NOT NULL DEFAULT '#64748b',
    "probabilidade" INTEGER NOT NULL DEFAULT 10,
    "tipo" TEXT NOT NULL DEFAULT 'ABERTA',

    CONSTRAINT "ErpEtapaFunil_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ErpOportunidade" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "filialId" TEXT,
    "centroCustoId" TEXT,
    "parceiroId" TEXT NOT NULL,
    "titulo" TEXT NOT NULL,
    "etapaId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ABERTA',
    "valorCents" INTEGER NOT NULL DEFAULT 0,
    "probabilidade" INTEGER NOT NULL DEFAULT 10,
    "custoAquisicaoCents" INTEGER NOT NULL DEFAULT 0,
    "origem" TEXT,
    "responsavelId" TEXT,
    "previsaoFechamento" TIMESTAMP(3),
    "motivoPerda" TEXT,
    "fechadaEm" TIMESTAMP(3),
    "correlationId" TEXT NOT NULL,
    "posicao" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ErpOportunidade_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ErpInteracao" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "parceiroId" TEXT NOT NULL,
    "oportunidadeId" TEXT,
    "tipo" TEXT NOT NULL,
    "direcao" TEXT,
    "assunto" TEXT,
    "conteudo" TEXT NOT NULL DEFAULT '',
    "status" TEXT,
    "canalRef" TEXT,
    "userId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ErpInteracao_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ErpEvento" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "tipo" TEXT NOT NULL,
    "agregado" TEXT NOT NULL,
    "agregadoId" TEXT NOT NULL,
    "correlationId" TEXT,
    "payload" TEXT NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'PENDENTE',
    "tentativas" INTEGER NOT NULL DEFAULT 0,
    "proximaTentativa" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ultimoErro" TEXT,
    "processadoEm" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ErpEvento_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ErpEventoConsumo" (
    "id" TEXT NOT NULL,
    "eventoId" TEXT NOT NULL,
    "consumidor" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ErpEventoConsumo_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ErpTraceLink" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "origemTipo" TEXT NOT NULL,
    "origemId" TEXT NOT NULL,
    "destinoTipo" TEXT NOT NULL,
    "destinoId" TEXT NOT NULL,
    "vinculo" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ErpTraceLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ErpIntegracaoJob" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "provedor" TEXT NOT NULL,
    "operacao" TEXT NOT NULL,
    "payload" TEXT NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'PENDENTE',
    "tentativas" INTEGER NOT NULL DEFAULT 0,
    "proximaTentativa" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ultimoErro" TEXT,
    "resultado" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ErpIntegracaoJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ErpFilial_orgId_idx" ON "ErpFilial"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "ErpCentroCusto_orgId_codigo_key" ON "ErpCentroCusto"("orgId", "codigo");

-- CreateIndex
CREATE INDEX "ErpParceiro_orgId_status_idx" ON "ErpParceiro"("orgId", "status");

-- CreateIndex
CREATE INDEX "ErpParceiro_orgId_nome_idx" ON "ErpParceiro"("orgId", "nome");

-- CreateIndex
CREATE UNIQUE INDEX "ErpParceiro_orgId_documento_key" ON "ErpParceiro"("orgId", "documento");

-- CreateIndex
CREATE INDEX "ErpParceiroContato_parceiroId_idx" ON "ErpParceiroContato"("parceiroId");

-- CreateIndex
CREATE INDEX "ErpEtapaFunil_orgId_posicao_idx" ON "ErpEtapaFunil"("orgId", "posicao");

-- CreateIndex
CREATE INDEX "ErpOportunidade_orgId_etapaId_posicao_idx" ON "ErpOportunidade"("orgId", "etapaId", "posicao");

-- CreateIndex
CREATE INDEX "ErpOportunidade_orgId_status_idx" ON "ErpOportunidade"("orgId", "status");

-- CreateIndex
CREATE INDEX "ErpOportunidade_parceiroId_idx" ON "ErpOportunidade"("parceiroId");

-- CreateIndex
CREATE INDEX "ErpInteracao_orgId_parceiroId_createdAt_idx" ON "ErpInteracao"("orgId", "parceiroId", "createdAt");

-- CreateIndex
CREATE INDEX "ErpEvento_status_proximaTentativa_idx" ON "ErpEvento"("status", "proximaTentativa");

-- CreateIndex
CREATE INDEX "ErpEvento_orgId_agregado_agregadoId_idx" ON "ErpEvento"("orgId", "agregado", "agregadoId");

-- CreateIndex
CREATE UNIQUE INDEX "ErpEventoConsumo_eventoId_consumidor_key" ON "ErpEventoConsumo"("eventoId", "consumidor");

-- CreateIndex
CREATE INDEX "ErpTraceLink_orgId_destinoTipo_destinoId_idx" ON "ErpTraceLink"("orgId", "destinoTipo", "destinoId");

-- CreateIndex
CREATE UNIQUE INDEX "ErpTraceLink_origemTipo_origemId_destinoTipo_destinoId_vinc_key" ON "ErpTraceLink"("origemTipo", "origemId", "destinoTipo", "destinoId", "vinculo");

-- CreateIndex
CREATE INDEX "ErpIntegracaoJob_status_proximaTentativa_idx" ON "ErpIntegracaoJob"("status", "proximaTentativa");

-- AddForeignKey
ALTER TABLE "ErpParceiroContato" ADD CONSTRAINT "ErpParceiroContato_parceiroId_fkey" FOREIGN KEY ("parceiroId") REFERENCES "ErpParceiro"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ErpOportunidade" ADD CONSTRAINT "ErpOportunidade_parceiroId_fkey" FOREIGN KEY ("parceiroId") REFERENCES "ErpParceiro"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ErpInteracao" ADD CONSTRAINT "ErpInteracao_parceiroId_fkey" FOREIGN KEY ("parceiroId") REFERENCES "ErpParceiro"("id") ON DELETE CASCADE ON UPDATE CASCADE;

