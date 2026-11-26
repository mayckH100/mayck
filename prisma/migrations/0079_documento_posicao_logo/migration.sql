-- v1.55.0: posição do logo no cabeçalho dos documentos impressos (ESQUERDA padrão | CENTRO). Só aditiva.
ALTER TABLE "ErpDocumentoConfig" ADD COLUMN "posicaoLogo" TEXT NOT NULL DEFAULT 'ESQUERDA';
