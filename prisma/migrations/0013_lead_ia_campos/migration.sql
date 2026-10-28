-- IA de qualificação: ações, mensagens e etiquetas configuráveis por resultado (aditiva)
ALTER TABLE "LeadAiSettings" ADD COLUMN "positiveMessage" TEXT NOT NULL DEFAULT '';
ALTER TABLE "LeadAiSettings" ADD COLUMN "negativeAction" TEXT NOT NULL DEFAULT 'RETRY';
ALTER TABLE "LeadAiSettings" ADD COLUMN "negativeFlowId" TEXT;
ALTER TABLE "LeadAiSettings" ADD COLUMN "doubtAction" TEXT NOT NULL DEFAULT 'AI';
ALTER TABLE "LeadAiSettings" ADD COLUMN "doubtFlowId" TEXT;
ALTER TABLE "LeadAiSettings" ADD COLUMN "tagPositive" TEXT NOT NULL DEFAULT 'lead-qualificado';
ALTER TABLE "LeadAiSettings" ADD COLUMN "tagWaiting" TEXT NOT NULL DEFAULT 'lead-aguardando';
ALTER TABLE "LeadAiSettings" ADD COLUMN "tagDiscarded" TEXT NOT NULL DEFAULT 'lead-descartado';
