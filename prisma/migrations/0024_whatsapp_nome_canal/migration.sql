-- Nome do WhatsApp: o nome de cada número fica em Channel.name (já existente). Aqui só guardamos em qual WhatsApp
-- cada compromisso (reunião/tarefa) foi marcado, para os avisos internos dizerem "📲 Via: WhatsApp 2 · Amanda". Aditiva.
-- AlterTable
ALTER TABLE "Appointment" ADD COLUMN     "channelId" TEXT;
