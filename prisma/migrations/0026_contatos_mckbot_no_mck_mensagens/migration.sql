-- Contatos do MCKBOT também aparecem no MCK Mensagens (mesma pessoa = mesmo telefone na organização).
-- 1) Lead.consentAt passa a aceitar vazio: contato vindo do MCKBOT entra com consentimento PENDENTE
--    (aparece na lista, pode ir para campanhas, mas só recebe mensagens depois de registrar o consentimento).
-- 2) Backfill único: vincula leads já existentes ao contato de mesmo telefone e cria o lead dos contatos que ainda
--    não estão no MCK Mensagens. Não duplica (Lead tem @@unique([orgId, phone])) e respeita o opt-out do contato.
-- Rodar de novo não muda nada (só insere quem ainda não tem lead).

-- AlterTable
ALTER TABLE "Lead" ALTER COLUMN "consentAt" DROP NOT NULL;

-- Vincula leads sem contato ao contato de mesmo telefone (E.164 = '+' || waId), na mesma organização.
UPDATE "Lead" AS l
SET "contactId" = c."id"
FROM "Contact" AS c
WHERE l."contactId" IS NULL
  AND c."orgId" = l."orgId"
  AND l."phone" = '+' || c."waId";

-- Opt-out do contato vale para o lead vinculado.
UPDATE "Lead" AS l
SET "optOutAt" = CURRENT_TIMESTAMP
FROM "Contact" AS c
WHERE l."contactId" = c."id"
  AND c."orgId" = l."orgId"
  AND c."optOut" = true
  AND l."optOutAt" IS NULL;

-- Cria o lead dos contatos (só números de telefone; grupos/LID ficam de fora) que ainda não estão no MCK Mensagens.
INSERT INTO "Lead" ("id", "orgId", "phone", "name", "tags", "status", "consentSource", "consentAt", "optOutAt", "contactId", "qualifyAttempts", "createdAt", "updatedAt")
SELECT
  'c' || md5('mckbot-lead:' || c."id"),
  c."orgId",
  '+' || c."waId",
  c."name",
  c."tags",
  'NOVO',
  'MCKBOT',
  NULL,
  CASE WHEN c."optOut" THEN CURRENT_TIMESTAMP ELSE NULL END,
  c."id",
  0,
  c."createdAt",
  CURRENT_TIMESTAMP
FROM "Contact" AS c
WHERE c."waId" ~ '^[0-9]{10,15}$'
  AND NOT EXISTS (SELECT 1 FROM "Lead" l WHERE l."orgId" = c."orgId" AND l."phone" = '+' || c."waId")
  AND NOT EXISTS (SELECT 1 FROM "Lead" l WHERE l."orgId" = c."orgId" AND l."contactId" = c."id");
