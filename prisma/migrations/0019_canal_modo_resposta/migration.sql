-- Canal WhatsApp: "Quem responde automaticamente" — flows (só fluxos) | ai (só IA) | both (fluxos + IA, padrão,
-- mantém o comportamento anterior). Aditiva.
-- AlterTable
ALTER TABLE "Channel" ADD COLUMN     "autoReplyMode" TEXT NOT NULL DEFAULT 'both';
