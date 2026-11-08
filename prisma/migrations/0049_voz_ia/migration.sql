-- Voz da IA (v1.23.0). Só aditiva: colunas novas com padrão e uma coluna opcional na mensagem.
-- Nenhum dado existente muda; com a IA já ativada, ela passa a ouvir (transcrever) os áudios dos clientes.
-- A voz (responder em áudio) começa desligada para todos.
-- AlterTable
ALTER TABLE "AiSettings" ADD COLUMN     "voiceEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "voiceReplyMode" TEXT NOT NULL DEFAULT 'espelhar',
ADD COLUMN     "voiceProvider" TEXT NOT NULL DEFAULT 'gemini',
ADD COLUMN     "voiceName" TEXT NOT NULL DEFAULT 'Kore',
ADD COLUMN     "voiceModel" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "voiceApiKeyEnc" TEXT,
ADD COLUMN     "voiceStyle" TEXT NOT NULL DEFAULT 'Fale de forma natural, calorosa e simpática, em ritmo de conversa, como um atendente brasileiro.',
ADD COLUMN     "voiceMaxSeconds" INTEGER NOT NULL DEFAULT 45,
ADD COLUMN     "transcribeAudio" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "transcribeProvider" TEXT NOT NULL DEFAULT 'auto';

-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "transcript" TEXT;
