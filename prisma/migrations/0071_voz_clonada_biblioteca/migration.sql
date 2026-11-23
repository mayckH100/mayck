-- MCK v1.47.0: biblioteca de áudios gravados e voz clonada (aceite LGPD, amostra cifrada, cache). Só aditiva.
-- AlterTable
ALTER TABLE "AiSettings" ADD COLUMN     "voiceCloneProfileId" TEXT,
ADD COLUMN     "voiceLibraryEnabled" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "VoiceClip" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "whenToUse" TEXT NOT NULL DEFAULT '',
    "transcript" TEXT NOT NULL DEFAULT '',
    "audio" BYTEA NOT NULL,
    "seconds" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "waveform" BYTEA,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "useCount" INTEGER NOT NULL DEFAULT 0,
    "lastUsedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VoiceClip_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VoiceProfile" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "ownerName" TEXT NOT NULL,
    "ownerRole" TEXT NOT NULL DEFAULT '',
    "ownerEmail" TEXT NOT NULL DEFAULT '',
    "consentText" TEXT NOT NULL,
    "consentVersion" TEXT NOT NULL DEFAULT '',
    "consentAt" TIMESTAMP(3) NOT NULL,
    "consentIp" TEXT,
    "consentUserId" TEXT,
    "sampleEnc" BYTEA,
    "sampleSeconds" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "workerVoiceId" TEXT NOT NULL,
    "baseVoice" TEXT NOT NULL DEFAULT 'Puck',
    "status" TEXT NOT NULL DEFAULT 'AGUARDANDO_AMOSTRA',
    "error" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "previewOgg" BYTEA,
    "previewText" TEXT NOT NULL DEFAULT '',
    "activatedAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "deletedReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VoiceProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VoiceCloneCache" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "textHash" TEXT NOT NULL,
    "ogg" BYTEA NOT NULL,
    "seconds" DOUBLE PRECISION NOT NULL,
    "waveform" BYTEA,
    "hits" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VoiceCloneCache_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "VoiceClip_orgId_active_idx" ON "VoiceClip"("orgId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "VoiceProfile_workerVoiceId_key" ON "VoiceProfile"("workerVoiceId");

-- CreateIndex
CREATE INDEX "VoiceProfile_orgId_status_idx" ON "VoiceProfile"("orgId", "status");

-- CreateIndex
CREATE INDEX "VoiceCloneCache_orgId_createdAt_idx" ON "VoiceCloneCache"("orgId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "VoiceCloneCache_profileId_textHash_key" ON "VoiceCloneCache"("profileId", "textHash");

