-- Programa "Indique e ganhe" e cupom só no primeiro pagamento. Só aditiva.
ALTER TABLE "Organization" ADD COLUMN "referralCode" TEXT;
CREATE UNIQUE INDEX "Organization_referralCode_key" ON "Organization"("referralCode");

ALTER TABLE "PendingSignup" ADD COLUMN "referralCode" TEXT;

ALTER TABLE "Coupon" ADD COLUMN "firstPaymentOnly" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "Referral" (
    "id" TEXT NOT NULL,
    "referrerOrgId" TEXT NOT NULL,
    "referredOrgId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDENTE',
    "reason" TEXT,
    "mpPaymentId" TEXT,
    "products" TEXT,
    "rewardDays" INTEGER NOT NULL DEFAULT 30,
    "creditedAt" TIMESTAMP(3),
    "notifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Referral_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Referral_referredOrgId_key" ON "Referral"("referredOrgId");
CREATE UNIQUE INDEX "Referral_mpPaymentId_key" ON "Referral"("mpPaymentId");
CREATE INDEX "Referral_referrerOrgId_status_idx" ON "Referral"("referrerOrgId", "status");
