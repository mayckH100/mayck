-- AlterTable
ALTER TABLE "User" ADD COLUMN     "isSuperAdmin" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "Subscription" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "product" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'TRIAL',
    "cycle" TEXT NOT NULL DEFAULT 'MENSAL',
    "validUntil" TIMESTAMP(3) NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'TRIAL',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Subscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillingEvent" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "product" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "cycle" TEXT,
    "amountCents" INTEGER,
    "mpPaymentId" TEXT,
    "actorUserId" TEXT,
    "prevValidUntil" TIMESTAMP(3),
    "newValidUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BillingEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlatformSettings" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "trialDays" INTEGER NOT NULL DEFAULT 7,
    "pricesJson" TEXT NOT NULL DEFAULT '{"MCKBOT":{"MENSAL":3990,"ANUAL":39900},"MCKMENSAGEM":{"MENSAL":4500,"ANUAL":45000},"COMBO":{"MENSAL":6990,"ANUAL":69900}}',
    "mpWebhookSecretEnc" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatformSettings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Subscription_orgId_product_key" ON "Subscription"("orgId", "product");

-- CreateIndex
CREATE UNIQUE INDEX "BillingEvent_mpPaymentId_key" ON "BillingEvent"("mpPaymentId");

-- CreateIndex
CREATE INDEX "BillingEvent_orgId_createdAt_idx" ON "BillingEvent"("orgId", "createdAt");

