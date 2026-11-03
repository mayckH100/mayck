-- Avisos do Painel Master: pop-up com imagem para os clientes (imagem guardada no banco, bytea).
-- Migração só aditiva: duas tabelas novas, nada existente é alterado.
-- CreateTable
CREATE TABLE "Announcement" (
    "id" TEXT NOT NULL,
    "title" TEXT,
    "body" TEXT,
    "linkUrl" TEXT,
    "linkLabel" TEXT,
    "app" TEXT NOT NULL DEFAULT 'AMBOS',
    "audience" TEXT NOT NULL DEFAULT 'TODOS',
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "imageData" BYTEA,
    "imageMime" TEXT,
    "imageSize" INTEGER NOT NULL DEFAULT 0,
    "imageSha256" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Announcement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AnnouncementView" (
    "id" TEXT NOT NULL,
    "announcementId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "orgId" TEXT,
    "day" TEXT NOT NULL,
    "viewedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dismissedAt" TIMESTAMP(3),

    CONSTRAINT "AnnouncementView_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Announcement_active_startsAt_endsAt_idx" ON "Announcement"("active", "startsAt", "endsAt");

-- CreateIndex
CREATE UNIQUE INDEX "AnnouncementView_announcementId_userId_day_key" ON "AnnouncementView"("announcementId", "userId", "day");

-- CreateIndex
CREATE INDEX "AnnouncementView_announcementId_idx" ON "AnnouncementView"("announcementId");
