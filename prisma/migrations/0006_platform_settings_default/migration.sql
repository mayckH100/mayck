-- Garante a linha 'default' de PlatformSettings (evita a corrida de criação no primeiro cadastro).
INSERT INTO "PlatformSettings" ("id", "trialDays", "pricesJson", "updatedAt")
VALUES ('default', 7, '{"MCKBOT":{"MENSAL":3990,"ANUAL":39900},"MCKMENSAGEM":{"MENSAL":4500,"ANUAL":45000},"COMBO":{"MENSAL":6990,"ANUAL":69900}}', CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;
