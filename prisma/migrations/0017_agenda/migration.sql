-- Agenda: reuniões/tarefas na agenda do celular (.ics, feed webcal, Google Agenda). Aditiva.
CREATE TABLE "Appointment" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'MEETING',
    "title" TEXT NOT NULL,
    "description" TEXT,
    "location" TEXT,
    "startAt" TIMESTAMP(3) NOT NULL,
    "durationMin" INTEGER NOT NULL DEFAULT 30,
    "reminderMin" INTEGER NOT NULL DEFAULT 60,
    "status" TEXT NOT NULL DEFAULT 'SCHEDULED',
    "source" TEXT NOT NULL DEFAULT 'MANUAL',
    "contactId" TEXT,
    "conversationId" TEXT,
    "assignedUserId" TEXT,
    "createdById" TEXT,
    "notifyContact" BOOLEAN NOT NULL DEFAULT true,
    "sequence" INTEGER NOT NULL DEFAULT 0,
    "googleEventId" TEXT,
    "googleAccountId" TEXT,
    "reminderSentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Appointment_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Appointment_orgId_startAt_idx" ON "Appointment"("orgId", "startAt");
CREATE INDEX "Appointment_orgId_assignedUserId_idx" ON "Appointment"("orgId", "assignedUserId");
CREATE INDEX "Appointment_status_startAt_idx" ON "Appointment"("status", "startAt");

CREATE TABLE "CalendarFeed" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "userId" TEXT,
    "tokenHash" TEXT NOT NULL,
    "tokenEnc" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    CONSTRAINT "CalendarFeed_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "CalendarFeed_tokenHash_key" ON "CalendarFeed"("tokenHash");
CREATE INDEX "CalendarFeed_orgId_userId_idx" ON "CalendarFeed"("orgId", "userId");

CREATE TABLE "GoogleCalendarAccount" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "email" TEXT,
    "refreshTokenEnc" TEXT NOT NULL,
    "calendarId" TEXT NOT NULL DEFAULT 'primary',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "GoogleCalendarAccount_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "GoogleCalendarAccount_orgId_userId_key" ON "GoogleCalendarAccount"("orgId", "userId");

CREATE TABLE "AgendaSettings" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "aiBooking" BOOLEAN NOT NULL DEFAULT false,
    "workStart" TEXT NOT NULL DEFAULT '09:00',
    "workEnd" TEXT NOT NULL DEFAULT '18:00',
    "workDays" TEXT NOT NULL DEFAULT '1,2,3,4,5',
    "defaultDurationMin" INTEGER NOT NULL DEFAULT 30,
    "minNoticeMin" INTEGER NOT NULL DEFAULT 60,
    "notifyContact" BOOLEAN NOT NULL DEFAULT true,
    "reminderMin" INTEGER NOT NULL DEFAULT 60,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AgendaSettings_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AgendaSettings_orgId_key" ON "AgendaSettings"("orgId");
