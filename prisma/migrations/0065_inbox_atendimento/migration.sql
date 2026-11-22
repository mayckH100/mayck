-- MCK v1.41.0: Inbox — respostas rápidas, distribuição automática, horário de atendimento, pesquisa de satisfação e mensagens agendadas.
-- Só aditiva: duas colunas opcionais e quatro tabelas novas. Sem registro em InboxSettings = tudo desligado (comportamento antigo).

-- AlterTable
ALTER TABLE "Contact" ADD COLUMN     "awayMessageAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN     "assignedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "InboxSettings" (
    "orgId" TEXT NOT NULL,
    "autoAssign" BOOLEAN NOT NULL DEFAULT false,
    "assignStrategy" TEXT NOT NULL DEFAULT 'rodizio',
    "assignOnlineOnly" BOOLEAN NOT NULL DEFAULT true,
    "assignUserIds" TEXT NOT NULL DEFAULT '[]',
    "lastAssignedUserId" TEXT,
    "hoursEnabled" BOOLEAN NOT NULL DEFAULT false,
    "hours" TEXT NOT NULL DEFAULT '[]',
    "awayMessage" TEXT NOT NULL DEFAULT '',
    "awayEveryHours" INTEGER NOT NULL DEFAULT 12,
    "csatEnabled" BOOLEAN NOT NULL DEFAULT false,
    "csatQuestion" TEXT NOT NULL DEFAULT '',
    "csatThanks" TEXT NOT NULL DEFAULT '',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InboxSettings_pkey" PRIMARY KEY ("orgId")
);

-- CreateTable
CREATE TABLE "QuickReply" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "shortcut" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "QuickReply_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CsatRating" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "assignedUserId" TEXT,
    "askedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "score" INTEGER,
    "answeredAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'PENDENTE',

    CONSTRAINT "CsatRating_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScheduledMessage" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "sendAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDENTE',
    "createdById" TEXT,
    "messageId" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ScheduledMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "QuickReply_orgId_shortcut_key" ON "QuickReply"("orgId", "shortcut");

-- CreateIndex
CREATE INDEX "CsatRating_orgId_askedAt_idx" ON "CsatRating"("orgId", "askedAt");

-- CreateIndex
CREATE INDEX "CsatRating_contactId_status_idx" ON "CsatRating"("contactId", "status");

-- CreateIndex
CREATE INDEX "ScheduledMessage_status_sendAt_idx" ON "ScheduledMessage"("status", "sendAt");

-- CreateIndex
CREATE INDEX "ScheduledMessage_orgId_conversationId_idx" ON "ScheduledMessage"("orgId", "conversationId");

