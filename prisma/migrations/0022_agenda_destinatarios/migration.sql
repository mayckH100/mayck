-- Agenda: contatos adicionais (Appointment.extraContacts) e destinatários dos avisos (responsável / adicionais), com padrão por empresa em AgendaSettings. Aditiva.
-- AlterTable
ALTER TABLE "Appointment" ADD COLUMN     "extraContacts" TEXT NOT NULL DEFAULT '[]',
ADD COLUMN     "notifyAssignee" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "notifyExtras" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "AgendaSettings" ADD COLUMN     "notifyAssignee" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "notifyExtras" BOOLEAN NOT NULL DEFAULT true;

