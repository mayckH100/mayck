/**
 * Maquininhas de cartão no PDV — contrato comum dos provedores (arquitetura multi-provedor).
 * Cada provedor recebe a credencial DA EMPRESA (nunca a do app MCKBOT) e fala com a API dele; o PDV só conhece
 * este contrato e os status normalizados abaixo.
 */

/** Status normalizado de uma cobrança no terminal. */
export type StatusCobranca = 'PENDENTE' | 'APROVADA' | 'RECUSADA' | 'CANCELADA' | 'EXPIRADA' | 'ESTORNADA';
export type TipoCartao = 'CREDITO' | 'DEBITO';

export interface CredencialMaquininha {
  accessToken: string;
}

export interface NovaCobranca {
  valorCents: number;
  terminalId: string;
  /** Referência única nossa (vai como external_reference). Letras, números, "-" e "_", até 64. */
  referencia: string;
  tipo: TipoCartao;
  /** Parcelas (só crédito; 1 = à vista). */
  parcelas: number;
  descricao?: string;
}

export interface ResultadoCobranca {
  /** Id da cobrança no provedor. */
  externalId: string;
  status: StatusCobranca;
  /** Status cru do provedor (ex.: "at_terminal", "processed"). */
  statusProvedor: string;
  detalhe?: string | null;
  /** Valor efetivamente pago, quando o provedor informa. */
  valorPagoCents?: number | null;
}

export interface ResultadoCancelamento {
  /** true = cancelada já; false = pedido aceito, a confirmação chega depois (webhook/consulta). */
  confirmado: boolean;
  status: StatusCobranca;
  statusProvedor: string;
}

export interface Terminal {
  id: string;
  /** Modo de operação no provedor (ex.: "PDV" ou "STANDALONE" no Mercado Pago). */
  modo?: string | null;
  loja?: string | null;
  caixa?: string | null;
  /** Pronto para receber cobranças do sistema (ex.: modo PDV). */
  prontoParaPdv: boolean;
}

export interface ProvedorMaquininha {
  id: string;
  nome: string;
  /** false = ainda não integrado (stub). */
  disponivel: boolean;
  /** Texto para o lojista (ex.: como obter a credencial, ou "em breve"). */
  ajuda: string;
  criarCobranca(cred: CredencialMaquininha, c: NovaCobranca): Promise<ResultadoCobranca>;
  consultarStatus(cred: CredencialMaquininha, externalId: string): Promise<ResultadoCobranca>;
  cancelar(cred: CredencialMaquininha, externalId: string): Promise<ResultadoCancelamento>;
  listarTerminais(cred: CredencialMaquininha): Promise<Terminal[]>;
  /** Coloca o terminal no modo que aceita cobranças do sistema, quando o provedor exige. */
  ativarModoPdv?(cred: CredencialMaquininha, terminalId: string): Promise<Terminal>;
}

/** Erro de provedor com HTTP de origem (0 = rede) e mensagem já pronta para o lojista. */
export class MaquininhaError extends Error {
  constructor(public status: number, message: string, public codigo?: string) { super(message); }
  get ehCredencial() { return this.status === 401 || this.status === 403; }
}
