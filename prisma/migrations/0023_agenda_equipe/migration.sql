-- Agenda: equipe pré-configurada (AgendaSettings.teamContacts/notifyOwner) e destinatários por compromisso (Appointment.teamContacts/notifyOwner). Aditiva.
-- AlterTable
ALTER TABLE "Appointment" ADD COLUMN     "notifyOwner" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "teamContacts" TEXT NOT NULL DEFAULT '[]';

-- AlterTable
ALTER TABLE "AgendaSettings" ADD COLUMN     "notifyOwner" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "teamContacts" TEXT NOT NULL DEFAULT '[]';

