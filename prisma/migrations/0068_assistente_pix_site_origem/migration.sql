-- MCK v1.44.0: assistente do atendente, cobrança Pix na conversa, chat para o site, origem do lead e
-- pausa automática das campanhas com o número em Risco.
-- Só aditiva: colunas novas nulas ou com padrão e tabelas novas. Um ADD COLUMN por comando (PostgreSQL e SQLite).

-- AlterTable
ALTER TABLE "Contact" ADD COLUMN "origem" TEXT;
ALTER TABLE "Contact" ADD COLUMN "origemEm" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN "origem" TEXT;
ALTER TABLE "Conversation" ADD COLUMN "origemDetalhe" TEXT;

-- AlterTable
ALTER TABLE "Campaign" ADD COLUMN "riscoRetomada" TEXT NOT NULL DEFAULT 'auto';
ALTER TABLE "Campaign" ADD COLUMN "riscoPausa" TEXT;
ALTER TABLE "Campaign" ADD COLUMN "riscoPausaEm" TIMESTAMP(3);
-- CreateTable
CREATE TABLE "PixSettings" (
    "orgId" TEXT NOT NULL,
    "keyType" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PixSettings_pkey" PRIMARY KEY ("orgId")
);

-- CreateTable
CREATE TABLE "PixCharge" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "txid" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDENTE',
    "publicToken" TEXT NOT NULL,
    "createdById" TEXT,
    "paidAt" TIMESTAMP(3),
    "paidById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PixCharge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrigemLink" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "channelId" TEXT,
    "text" TEXT NOT NULL DEFAULT 'Olá!',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrigemLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SiteWidget" (
    "channelId" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "publicKey" TEXT NOT NULL,
    "color" TEXT NOT NULL DEFAULT '#d90429',
    "title" TEXT NOT NULL DEFAULT 'Fale com a gente',
    "welcome" TEXT NOT NULL DEFAULT 'Olá! Como podemos ajudar?',
    "allowedOrigins" TEXT NOT NULL DEFAULT '',
    "askName" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SiteWidget_pkey" PRIMARY KEY ("channelId")
);

-- CreateIndex
CREATE UNIQUE INDEX "PixCharge_publicToken_key" ON "PixCharge"("publicToken");

-- CreateIndex
CREATE INDEX "PixCharge_orgId_createdAt_idx" ON "PixCharge"("orgId", "createdAt");

-- CreateIndex
CREATE INDEX "PixCharge_conversationId_idx" ON "PixCharge"("conversationId");

-- CreateIndex
CREATE UNIQUE INDEX "OrigemLink_orgId_code_key" ON "OrigemLink"("orgId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "SiteWidget_publicKey_key" ON "SiteWidget"("publicKey");

