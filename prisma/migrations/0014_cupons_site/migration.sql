-- Cupons de desconto e configurações do site oficial (aditiva)
ALTER TABLE "PlatformSettings" ADD COLUMN "siteJson" TEXT NOT NULL DEFAULT '{}';

-- CreateTable
CREATE TABLE "Coupon" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "partner" TEXT,
    "type" TEXT NOT NULL,
    "value" INTEGER NOT NULL,
    "product" TEXT NOT NULL DEFAULT 'ALL',
    "cycles" TEXT NOT NULL DEFAULT 'ALL',
    "validUntil" TIMESTAMP(3),
    "maxUses" INTEGER,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Coupon_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CouponRedemption" (
    "id" TEXT NOT NULL,
    "couponId" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "product" TEXT NOT NULL,
    "cycle" TEXT NOT NULL,
    "mpPaymentId" TEXT NOT NULL,
    "originalCents" INTEGER NOT NULL,
    "discountCents" INTEGER NOT NULL,
    "finalCents" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'CONFIRMADO',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CouponRedemption_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Coupon_code_key" ON "Coupon"("code");

-- CreateIndex
CREATE UNIQUE INDEX "CouponRedemption_mpPaymentId_key" ON "CouponRedemption"("mpPaymentId");

-- CreateIndex
CREATE INDEX "CouponRedemption_couponId_status_idx" ON "CouponRedemption"("couponId", "status");

-- AddForeignKey
ALTER TABLE "CouponRedemption" ADD CONSTRAINT "CouponRedemption_couponId_fkey" FOREIGN KEY ("couponId") REFERENCES "Coupon"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
