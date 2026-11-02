-- Cadastro reforçado: CPF/CNPJ e celular do titular (únicos, opcionais para contas antigas) e cadastro pendente
-- até a confirmação do código enviado por e-mail. Aditiva.
-- AlterTable
ALTER TABLE "User" ADD COLUMN "documento" TEXT;
ALTER TABLE "User" ADD COLUMN "celular" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "User_documento_key" ON "User"("documento");
CREATE UNIQUE INDEX "User_celular_key" ON "User"("celular");

-- CreateTable
CREATE TABLE "PendingSignup" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "orgName" TEXT NOT NULL,
    "documento" TEXT NOT NULL,
    "celular" TEXT NOT NULL,
    "app" TEXT NOT NULL DEFAULT 'mckbot',
    "codeHash" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "sends" INTEGER NOT NULL DEFAULT 1,
    "existingUser" BOOLEAN NOT NULL DEFAULT false,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "lastSentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ip" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PendingSignup_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PendingSignup_tokenHash_key" ON "PendingSignup"("tokenHash");
CREATE INDEX "PendingSignup_email_idx" ON "PendingSignup"("email");
CREATE INDEX "PendingSignup_createdAt_idx" ON "PendingSignup"("createdAt");
