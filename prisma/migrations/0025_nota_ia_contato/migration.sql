-- Notas para a IA por contato (observações internas do vendedor, consideradas pela IA e nunca enviadas ao cliente). Aditiva.
-- CreateTable
CREATE TABLE "ContactAiNote" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "authorUserId" TEXT,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContactAiNote_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ContactAiNote_orgId_contactId_createdAt_idx" ON "ContactAiNote"("orgId", "contactId", "createdAt");
