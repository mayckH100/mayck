-- v1.52.0: reajuste de preços (aprovado pelo Mayck em 24/11/2026) com preço antigo garantido para quem já pagava,
-- e promoção do 1º mês (Black Friday MCK, até 30/11/2026 23:59 de Brasília). Colunas só aditivas; dados:
-- 1) guarda os preços e a promoção de entrada atuais como "preço antigo" (legacy*) com a data/hora deste deploy;
-- 2) preços novos para novas assinaturas: MCKBOT R$ 47/mês (R$ 470/ano), MCK Mensagens R$ 29/mês (R$ 309/ano),
--    Plano Completo R$ 97/mês (R$ 970/ano) — anual proporcional ao anual de antes;
-- 3) promoção de entrada antiga (R$ 58 nos 2 primeiros meses) desligada para novas empresas (continua para quem já usa);
-- 4) Black Friday: 1º mês a R$ 22 / R$ 15 / R$ 58, só no mensal e no 1º pagamento, até 30/11/2026 23:59 -03.
ALTER TABLE "PlatformSettings" ADD COLUMN "legacyPricesJson" TEXT;
ALTER TABLE "PlatformSettings" ADD COLUMN "legacyIntroJson" TEXT;
ALTER TABLE "PlatformSettings" ADD COLUMN "legacyAte" TIMESTAMP(3);
ALTER TABLE "PlatformSettings" ADD COLUMN "promoJson" TEXT NOT NULL DEFAULT '{}';

UPDATE "PlatformSettings" SET
  "legacyPricesJson" = "pricesJson",
  "legacyIntroJson" = CASE WHEN "introOfferJson" IS NULL OR "introOfferJson" = '{}' THEN '{"enabled":true,"priceCents":5800,"months":2}' ELSE "introOfferJson" END,
  "legacyAte" = CURRENT_TIMESTAMP,
  "pricesJson" = '{"MCKBOT":{"MENSAL":4700,"ANUAL":47000},"MCKMENSAGEM":{"MENSAL":2900,"ANUAL":30900},"COMBO":{"MENSAL":9700,"ANUAL":97000}}',
  "introOfferJson" = '{"enabled":false,"priceCents":5800,"months":2}',
  "promoJson" = '{"enabled":true,"codigo":"BLACKFRIDAY","nome":"Black Friday MCK","ate":"2026-11-30T23:59:59.000-03:00","precos":{"MCKBOT":2200,"MCKMENSAGEM":1500,"COMBO":5800},"faixa":"Black Friday MCK: 1º mês com preço especial até 30/11"}'
WHERE "id" = 'default' AND "legacyAte" IS NULL;
