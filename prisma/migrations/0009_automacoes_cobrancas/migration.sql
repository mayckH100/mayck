-- Migração ADITIVA (FASE 1 Automações e Cobranças): só cria tabelas e índices novos.
-- CreateTable
CREATE TABLE "Cliente" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "nome" TEXT NOT NULL,
    "documento" TEXT,
    "telefone" TEXT,
    "whatsapp" TEXT,
    "email" TEXT,
    "emailSecundario" TEXT,
    "empresa" TEXT,
    "plano" TEXT,
    "dataContratacao" TIMESTAMP(3),
    "dataVencimento" TIMESTAMP(3),
    "valorCentavos" INTEGER,
    "parcelas" INTEGER,
    "formaPagamento" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ATIVO',
    "observacoes" TEXT,
    "prefWhatsapp" BOOLEAN NOT NULL DEFAULT true,
    "prefEmail" BOOLEAN NOT NULL DEFAULT true,
    "consentimentoAt" TIMESTAMP(3),
    "consentimentoOrigem" TEXT,
    "marketingOptOutAt" TIMESTAMP(3),
    "contactId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Cliente_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Automacao" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "nome" TEXT NOT NULL,
    "categoria" TEXT NOT NULL,
    "canais" TEXT NOT NULL DEFAULT '["WHATSAPP"]',
    "channelId" TEXT,
    "assunto" TEXT,
    "mensagem" TEXT NOT NULL,
    "clienteIds" TEXT NOT NULL DEFAULT '[]',
    "regra" TEXT NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'America/Sao_Paulo',
    "inicio" TIMESTAMP(3) NOT NULL,
    "fim" TIMESTAMP(3),
    "maxEnvios" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'RASCUNHO',
    "geradoAte" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Automacao_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Ocorrencia" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "automacaoId" TEXT NOT NULL,
    "clienteId" TEXT NOT NULL,
    "canal" TEXT NOT NULL,
    "chave" TEXT NOT NULL,
    "agendadoPara" TIMESTAMP(3) NOT NULL,
    "executarEm" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDENTE',
    "tentativas" INTEGER NOT NULL DEFAULT 0,
    "erro" TEXT,
    "provedorId" TEXT,
    "mensagem" TEXT,
    "editada" BOOLEAN NOT NULL DEFAULT false,
    "lockedAt" TIMESTAMP(3),
    "enviadoEm" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Ocorrencia_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MensagemHistorico" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "ocorrenciaId" TEXT,
    "automacaoId" TEXT,
    "clienteId" TEXT,
    "categoria" TEXT NOT NULL,
    "canal" TEXT NOT NULL,
    "direcao" TEXT NOT NULL DEFAULT 'OUT',
    "assunto" TEXT,
    "conteudo" TEXT NOT NULL,
    "agendadoPara" TIMESTAMP(3),
    "enviadoEm" TIMESTAMP(3),
    "provedorId" TEXT,
    "status" TEXT NOT NULL,
    "erro" TEXT,
    "tentativas" INTEGER NOT NULL DEFAULT 0,
    "operadorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MensagemHistorico_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AutomacaoConfig" (
    "orgId" TEXT NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'America/Sao_Paulo',
    "janelaInicio" TEXT NOT NULL DEFAULT '08:00',
    "janelaFim" TEXT NOT NULL DEFAULT '20:00',
    "limiteDiario" INTEGER NOT NULL DEFAULT 500,
    "maxTentativas" INTEGER NOT NULL DEFAULT 3,
    "backoffSeg" INTEGER NOT NULL DEFAULT 60,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AutomacaoConfig_pkey" PRIMARY KEY ("orgId")
);

-- CreateTable
CREATE TABLE "ModeloMensagem" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "categoria" TEXT NOT NULL,
    "nome" TEXT NOT NULL,
    "assunto" TEXT,
    "corpo" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ModeloMensagem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Cliente_orgId_nome_idx" ON "Cliente"("orgId", "nome");

-- CreateIndex
CREATE INDEX "Cliente_orgId_telefone_idx" ON "Cliente"("orgId", "telefone");

-- CreateIndex
CREATE INDEX "Cliente_orgId_whatsapp_idx" ON "Cliente"("orgId", "whatsapp");

-- CreateIndex
CREATE INDEX "Cliente_orgId_email_idx" ON "Cliente"("orgId", "email");

-- CreateIndex
CREATE INDEX "Cliente_orgId_documento_idx" ON "Cliente"("orgId", "documento");

-- CreateIndex
CREATE INDEX "Automacao_orgId_status_idx" ON "Automacao"("orgId", "status");

-- CreateIndex
CREATE INDEX "Automacao_status_geradoAte_idx" ON "Automacao"("status", "geradoAte");

-- CreateIndex
CREATE UNIQUE INDEX "Ocorrencia_chave_key" ON "Ocorrencia"("chave");

-- CreateIndex
CREATE INDEX "Ocorrencia_status_executarEm_idx" ON "Ocorrencia"("status", "executarEm");

-- CreateIndex
CREATE INDEX "Ocorrencia_orgId_agendadoPara_idx" ON "Ocorrencia"("orgId", "agendadoPara");

-- CreateIndex
CREATE INDEX "Ocorrencia_automacaoId_status_idx" ON "Ocorrencia"("automacaoId", "status");

-- CreateIndex
CREATE INDEX "Ocorrencia_clienteId_idx" ON "Ocorrencia"("clienteId");

-- CreateIndex
CREATE UNIQUE INDEX "MensagemHistorico_ocorrenciaId_key" ON "MensagemHistorico"("ocorrenciaId");

-- CreateIndex
CREATE INDEX "MensagemHistorico_orgId_createdAt_idx" ON "MensagemHistorico"("orgId", "createdAt");

-- CreateIndex
CREATE INDEX "MensagemHistorico_orgId_clienteId_idx" ON "MensagemHistorico"("orgId", "clienteId");

-- CreateIndex
CREATE INDEX "MensagemHistorico_automacaoId_idx" ON "MensagemHistorico"("automacaoId");

-- CreateIndex
CREATE INDEX "ModeloMensagem_orgId_categoria_idx" ON "ModeloMensagem"("orgId", "categoria");

