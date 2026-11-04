-- MCK ERP: alertas diários por WhatsApp (financeiro e estoque), natureza da conta a pagar e custos adicionais do produto (embalagem etc.). Só aditiva.
-- AlterTable
ALTER TABLE "ErpConfig" ADD COLUMN     "alertaAtivo" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "alertaTelefones" TEXT,
ADD COLUMN     "alertaHora" INTEGER NOT NULL DEFAULT 8,
ADD COLUMN     "alertaDiasAntes" INTEGER NOT NULL DEFAULT 3,
ADD COLUMN     "alertaPagar" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "alertaEstoqueMinimo" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "alertaSemSaidaDias" INTEGER NOT NULL DEFAULT 15,
ADD COLUMN     "alertaUltimoDia" TEXT,
ADD COLUMN     "alertaStatus" TEXT,
ADD COLUMN     "relatorioUltimoDia" TEXT;

-- AlterTable
ALTER TABLE "ErpTitulo" ADD COLUMN     "natureza" TEXT;

-- AlterTable
ALTER TABLE "ErpProduto" ADD COLUMN     "custosAdicionais" TEXT NOT NULL DEFAULT '[]';
