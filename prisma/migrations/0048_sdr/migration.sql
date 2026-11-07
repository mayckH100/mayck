-- SDR com IA (v1.18.0). Só aditiva: 1 coluna nova com padrão, 4 tabelas novas e a configuração inicial do tenant da MCK.
-- AlterTable
ALTER TABLE "PlatformSettings" ADD COLUMN     "sdrPlansJson" TEXT NOT NULL DEFAULT '{"COMBO":true,"MCKBOT":false,"MCKMENSAGEM":false}';

-- CreateTable
CREATE TABLE "SdrSettings" (
    "orgId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "autoMode" BOOLEAN NOT NULL DEFAULT true,
    "captureWhatsapp" BOOLEAN NOT NULL DEFAULT true,
    "autoBook" BOOLEAN NOT NULL DEFAULT true,
    "segment" TEXT NOT NULL DEFAULT 'geral',
    "questionsJson" TEXT NOT NULL DEFAULT '[]',
    "warmScore" INTEGER NOT NULL DEFAULT 40,
    "hotScore" INTEGER NOT NULL DEFAULT 70,
    "workStart" TEXT NOT NULL DEFAULT '09:00',
    "workEnd" TEXT NOT NULL DEFAULT '18:00',
    "workDays" TEXT NOT NULL DEFAULT '1,2,3,4,5',
    "dailyLimit" INTEGER NOT NULL DEFAULT 40,
    "silenceHours" INTEGER NOT NULL DEFAULT 3,
    "formToken" TEXT,
    "formEnabled" BOOLEAN NOT NULL DEFAULT true,
    "formTitle" TEXT NOT NULL DEFAULT 'Fale com a gente',
    "alertHot" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SdrSettings_pkey" PRIMARY KEY ("orgId")
);

-- CreateTable
CREATE TABLE "SdrCadence" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "segment" TEXT NOT NULL DEFAULT 'geral',
    "stepsJson" TEXT NOT NULL DEFAULT '[]',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "builtIn" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SdrCadence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SdrLead" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "name" TEXT,
    "company" TEXT,
    "segment" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "source" TEXT NOT NULL DEFAULT 'MANUAL',
    "stage" TEXT NOT NULL DEFAULT 'NOVO',
    "score" INTEGER NOT NULL DEFAULT 0,
    "temperature" TEXT NOT NULL DEFAULT 'FRIO',
    "ownerUserId" TEXT,
    "consentAt" TIMESTAMP(3),
    "consentSource" TEXT,
    "optOutAt" TIMESTAMP(3),
    "unsubToken" TEXT NOT NULL,
    "contactId" TEXT,
    "leadId" TEXT,
    "answersJson" TEXT NOT NULL DEFAULT '{}',
    "aiSummary" TEXT,
    "cadenceId" TEXT,
    "cadenceStep" INTEGER NOT NULL DEFAULT 0,
    "cadenceStatus" TEXT NOT NULL DEFAULT 'SEM',
    "cadenceStartedAt" TIMESTAMP(3),
    "nextStepAt" TIMESTAMP(3),
    "stopReason" TEXT,
    "lastContactAt" TIMESTAMP(3),
    "lastReplyAt" TIMESTAMP(3),
    "hotAlertAt" TIMESTAMP(3),
    "appointmentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SdrLead_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SdrEvent" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "channel" TEXT,
    "detail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SdrEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SdrSettings_formToken_key" ON "SdrSettings"("formToken");

-- CreateIndex
CREATE INDEX "SdrCadence_orgId_segment_idx" ON "SdrCadence"("orgId", "segment");

-- CreateIndex
CREATE UNIQUE INDEX "SdrLead_unsubToken_key" ON "SdrLead"("unsubToken");

-- CreateIndex
CREATE INDEX "SdrLead_orgId_stage_idx" ON "SdrLead"("orgId", "stage");

-- CreateIndex
CREATE INDEX "SdrLead_orgId_contactId_idx" ON "SdrLead"("orgId", "contactId");

-- CreateIndex
CREATE INDEX "SdrLead_cadenceStatus_nextStepAt_idx" ON "SdrLead"("cadenceStatus", "nextStepAt");

-- CreateIndex
CREATE UNIQUE INDEX "SdrLead_orgId_phone_key" ON "SdrLead"("orgId", "phone");

-- CreateIndex
CREATE UNIQUE INDEX "SdrLead_orgId_email_key" ON "SdrLead"("orgId", "email");

-- CreateIndex
CREATE INDEX "SdrEvent_orgId_leadId_createdAt_idx" ON "SdrEvent"("orgId", "leadId", "createdAt");

-- CreateIndex
CREATE INDEX "SdrEvent_orgId_type_createdAt_idx" ON "SdrEvent"("orgId", "type", "createdAt");

-- Tenant da própria MCK (empresa "MCK DESENVOLVIMENTO" com um superadmin na equipe): SDR ligado, modo automático,
-- segmento "software" e perguntas de qualificação da MCK. Não cria cadência de prospecção por e-mail para listas
-- externas; só leads que chegam (WhatsApp/formulário) entram na cadência. Não sobrescreve configuração existente.
INSERT INTO "SdrSettings" ("orgId", "enabled", "autoMode", "captureWhatsapp", "autoBook", "segment", "questionsJson", "updatedAt")
SELECT o."id", true, true, true, true, 'software',
  '[{"id":"necessidade","pergunta":"O que você quer resolver no atendimento/vendas pelo WhatsApp?","peso":35},{"id":"porte","pergunta":"Quantas pessoas atendem e quantas conversas por dia, mais ou menos?","peso":20},{"id":"prazo","pergunta":"Para quando você quer isso funcionando?","peso":25},{"id":"orcamento","pergunta":"Quanto pensa investir por mês?","peso":20}]',
  CURRENT_TIMESTAMP
FROM "Organization" o
WHERE upper(trim(o."name")) = 'MCK DESENVOLVIMENTO'
  AND EXISTS (SELECT 1 FROM "Membership" m JOIN "User" u ON u."id" = m."userId" WHERE m."orgId" = o."id" AND u."isSuperAdmin" = true)
ON CONFLICT ("orgId") DO NOTHING;
