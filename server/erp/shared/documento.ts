/**
 * v1.54.0 — identidade dos documentos impressos do MCK ERP (compartilhado entre servidor e tela).
 * O RODAPÉ é da MCK, fixo no código: não existe campo no banco, na API ou na tela para mudar ou desligar
 * (pedido do dono, 26/11/2026: "O cliente não vai poder remover ou editar essa parte do rodapé").
 */
export const RODAPE_DOCUMENTO = 'Gerado pelo MCK ERP · MCK DESENVOLVIMENTO · mckbot.onrender.com/empresa';
export const RODAPE_LINK = 'https://mckbot.onrender.com/empresa';

/** Logo: PNG, JPEG ou WEBP (nunca SVG), até 500 KB depois de decodificado. */
export const LOGO_MAX_BYTES = 500 * 1024;
export const LOGO_TIPOS = ['image/png', 'image/jpeg', 'image/webp'] as const;

/** Campos do cabeçalho que o cliente edita (nada de rodapé aqui). */
export const CAMPOS_CABECALHO = ['nomeExibicao', 'cnpj', 'ie', 'logradouro', 'numero', 'bairro', 'cidade', 'uf', 'cep', 'telefone', 'whatsapp', 'email', 'site', 'textoLivre'] as const;
export type CampoCabecalho = (typeof CAMPOS_CABECALHO)[number];
/** v1.55.0 — onde o logo fica no topo do A4: "ESQUERDA" (padrão: logo no canto e dados embaixo) ou "CENTRO". */
export const POSICOES_LOGO = ['ESQUERDA', 'CENTRO'] as const;
export type PosicaoLogo = (typeof POSICOES_LOGO)[number];
export const POSICAO_LOGO_PADRAO: PosicaoLogo = 'ESQUERDA';
export const posicaoLogoValida = (v: unknown): PosicaoLogo => (POSICOES_LOGO as readonly unknown[]).includes(v) ? (v as PosicaoLogo) : POSICAO_LOGO_PADRAO;
export type ConfigDocumento = Record<CampoCabecalho, string> & { logo: string | null; posicaoLogo?: PosicaoLogo };

/** Data URL aceita no navegador e no servidor (base64 de PNG/JPEG/WEBP). Qualquer outra coisa não entra no HTML. */
export const LOGO_DATA_URL = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/;
