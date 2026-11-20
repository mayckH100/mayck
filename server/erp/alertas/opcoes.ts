/**
 * Opções do alerta diário (v1.30.0), guardadas em JSON na coluna ErpConfig.alertaOpcoes. Sem registro = padrões
 * abaixo (todas as seções novas ligadas). As opções antigas (contas a pagar, estoque mínimo, dias sem saída) continuam
 * nas colunas de sempre.
 */
import { parseJson } from '../../lib/json.js';

export interface OpcoesAlerta {
  /** Lotes vencidos e que vencem em até `validadeDias` dias. */
  validade: boolean;
  validadeDias: number;
  /** Resumo do caixa do dia anterior (abertura, vendas por forma, sangrias, quebra). */
  caixa: boolean;
  /** Alterações manuais do dia anterior: preço, custo, ajuste de estoque, estornos. */
  alteracoes: boolean;
  /** Itens com estoque baixo numerados com código para aprovar a compra respondendo pelo WhatsApp. */
  compraWhatsapp: boolean;
  /** Janela do consumo médio (dias) e quantos dias a compra sugerida deve cobrir. */
  consumoDias: number;
  coberturaDias: number;
}

export const OPCOES_PADRAO: OpcoesAlerta = { validade: true, validadeDias: 30, caixa: true, alteracoes: true, compraWhatsapp: true, consumoDias: 30, coberturaDias: 30 };

const intEntre = (v: unknown, min: number, max: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : d);
const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d);

/** Lê o JSON salvo, completa com os padrões e corrige valores fora da faixa. Nunca lança. */
export function lerOpcoes(raw: string | null | undefined): OpcoesAlerta {
  const o = parseJson<Record<string, unknown> | null>(raw ?? null, null) ?? {};
  const P = OPCOES_PADRAO;
  return {
    validade: bool(o.validade, P.validade),
    validadeDias: intEntre(o.validadeDias, 1, 365, P.validadeDias),
    caixa: bool(o.caixa, P.caixa),
    alteracoes: bool(o.alteracoes, P.alteracoes),
    compraWhatsapp: bool(o.compraWhatsapp, P.compraWhatsapp),
    consumoDias: intEntre(o.consumoDias, 7, 180, P.consumoDias),
    coberturaDias: intEntre(o.coberturaDias, 1, 180, P.coberturaDias),
  };
}

/** Dias sem saída: 0 desliga (quem já configurou continua como está); sem valor válido usa 15. */
export const semSaidaDiasDe = (v: number | null | undefined) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : 15);
