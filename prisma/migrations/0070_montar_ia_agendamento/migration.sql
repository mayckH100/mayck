-- MCK v1.46.0: "Monte sua IA conversando" (marca de aplicação) e página pública de agendamento.
-- Só aditiva: colunas novas nulas e tabelas novas.

-- AlterTable
ALTER TABLE "AiSettings" ADD COLUMN "assistenteAplicadoEm" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Appointment" ADD COLUMN "bookingServiceId" TEXT;

-- CreateTable
CREATE TABLE "BookingPage" (
    "orgId" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "title" TEXT NOT NULL DEFAULT '',
    "intro" TEXT NOT NULL DEFAULT '',
    "maxDaysAhead" INTEGER NOT NULL DEFAULT 30,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BookingPage_pkey" PRIMARY KEY ("orgId")
);

-- CreateTable
CREATE TABLE "BookingService" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "durationMin" INTEGER NOT NULL DEFAULT 30,
    "priceCents" INTEGER,
    "description" TEXT NOT NULL DEFAULT '',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BookingService_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BookingPage_slug_key" ON "BookingPage"("slug");

-- CreateIndex
CREATE INDEX "BookingService_orgId_idx" ON "BookingService"("orgId");

