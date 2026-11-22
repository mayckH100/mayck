-- Corrige o texto da Novidade de 2026-11-03 (publicada pela 0036): a regra da IA mudou no mesmo dia
-- (a IA só passa a conversa para uma pessoa quando o cliente pede). Só troca UMA frase daquela publicação
-- (id fixo) e só se o texto antigo ainda estiver lá: se alguém já editou pelo Painel Master, nada muda.
-- Não apaga nada, não toca em dados de clientes; idempotente.
UPDATE "SocialPost"
SET "body" = REPLACE("body",
    'Quando a IA não sabe responder, ela passa a conversa para uma pessoa da sua equipe.',
    'Quando a IA não consegue responder, ela avisa o cliente e continua o atendimento. Se o cliente pedir para falar com uma pessoa, a conversa vai para a sua equipe.'),
    "updatedAt" = CURRENT_TIMESTAMP
WHERE "id" = 'nov-2026-11-03-fluxos-ia-site'
  AND "body" LIKE '%Quando a IA não sabe responder, ela passa a conversa para uma pessoa da sua equipe.%';
