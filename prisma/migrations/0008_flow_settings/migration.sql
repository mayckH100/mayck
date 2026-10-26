-- CreateTable (aditiva): configurações do comando "Voltar ao menu"
CREATE TABLE "FlowSettings" (
    "orgId" TEXT NOT NULL,
    "menuCommandEnabled" BOOLEAN NOT NULL DEFAULT true,
    "menuCommandWords" TEXT NOT NULL DEFAULT '0,menu,voltar',
    "menuFooterEnabled" BOOLEAN NOT NULL DEFAULT true,
    "menuFooterText" TEXT NOT NULL DEFAULT '↩️ Digite 0 para voltar ao menu',
    "menuButtonEnabled" BOOLEAN NOT NULL DEFAULT true,
    "menuFlowId" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FlowSettings_pkey" PRIMARY KEY ("orgId")
);
