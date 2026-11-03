-- Novidade de 2026-11-03 no site (/empresa/novidades). Somente aditivo e idempotente:
-- insere UMA publicação com id fixo, destino só "site", e não faz nada se ela já existir.
INSERT INTO "SocialPost" ("id", "title", "body", "mediaUrl", "mediaType", "targets", "status", "results", "createdById", "publishedAt", "createdAt", "updatedAt")
SELECT
  'nov-2026-11-03-fluxos-ia-site',
  'Fluxos mais fáceis, IA mais confiável e site renovado',
  'Hoje o MCKBOT ficou mais simples de configurar e mais seguro para o atendimento da sua empresa.

Montar o atendimento automático ficou mais fácil
- Em cada opção do menu, escolha em "Ir para o bloco…" para onde o cliente vai, sem precisar puxar ligações na tela.
- O botão "Início / Gatilho" leva você direto ao começo do fluxo, mesmo em telas menores.
- O gatilho "Primeira mensagem" funciona sem palavra-chave: o robô recebe o cliente assim que ele manda a primeira mensagem.

Inteligência artificial mais confiável
- O seu cliente nunca fica sem resposta.
- Quando a IA não sabe responder, ela passa a conversa para uma pessoa da sua equipe.

Site de cara nova
- O site da MCK DESENVOLVIMENTO foi renovado, com informações mais claras sobre o MCKBOT, o MCK Mensagens e os planos.

Teste grátis por 7 dias, sem cartão: https://mckbot.onrender.com/cadastro',
  NULL,
  NULL,
  '["site"]',
  'published',
  '{"site":{"ok":true,"url":"/empresa/novidades","at":"2026-11-03T18:30:00.000Z"}}',
  NULL,
  TIMESTAMP '2026-11-03 18:30:00',
  TIMESTAMP '2026-11-03 18:30:00',
  TIMESTAMP '2026-11-03 18:30:00'
WHERE NOT EXISTS (SELECT 1 FROM "SocialPost" WHERE "id" = 'nov-2026-11-03-fluxos-ia-site');
