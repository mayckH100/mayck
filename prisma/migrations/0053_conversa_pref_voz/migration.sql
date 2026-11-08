-- Voz da IA: preferência do cliente por conversa (áudio/texto). Só adiciona coluna (nulo = segue o modo da empresa).
ALTER TABLE "Conversation" ADD COLUMN "voicePreference" TEXT;
