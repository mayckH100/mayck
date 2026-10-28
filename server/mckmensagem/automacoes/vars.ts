import type { Boleto, Cliente } from '@prisma/client';

/** Variáveis com dados do cadastro do cliente (todas as categorias). */
export const VARIAVEIS: Record<string, { rotulo: string; valor: (c: Cliente, tz: string) => string | null }> = {
  nome_cliente: { rotulo: 'Nome do cliente', valor: (c) => c.nome?.trim() || null },
  primeiro_nome: { rotulo: 'Primeiro nome', valor: (c) => c.nome?.trim().split(/\s+/)[0] || null },
  nome_empresa: { rotulo: 'Empresa', valor: (c) => c.empresa?.trim() || null },
  nome_plano: { rotulo: 'Plano ou serviço', valor: (c) => c.plano?.trim() || null },
  valor_contratado: { rotulo: 'Valor contratado', valor: (c) => (c.valorCentavos != null ? brl(c.valorCentavos) : null) },
  valor_parcela: { rotulo: 'Valor da parcela', valor: (c) => (c.valorCentavos != null ? brl(Math.round(c.valorCentavos / Math.max(1, c.parcelas ?? 1))) : null) },
  total_parcelas: { rotulo: 'Total de parcelas', valor: (c) => (c.parcelas != null ? String(c.parcelas) : null) },
  data_vencimento: { rotulo: 'Data de vencimento', valor: (c, tz) => (c.dataVencimento ? fmtData(c.dataVencimento, tz) : null) },
  data_contratacao: { rotulo: 'Data de contratação', valor: (c, tz) => (c.dataContratacao ? fmtData(c.dataContratacao, tz) : null) },
  forma_pagamento: { rotulo: 'Forma de pagamento', valor: (c) => c.formaPagamento?.trim() || null },
  email_cliente: { rotulo: 'E-mail do cliente', valor: (c) => c.email || null },
  telefone_cliente: { rotulo: 'Telefone do cliente', valor: (c) => c.whatsapp || c.telefone || null },
};

/**
 * Variáveis do boleto/parcela (só em cobranças com boleto vinculado à mensagem).
 * Quando há boleto, valor_parcela, total_parcelas e data_vencimento passam a vir do boleto, não do cadastro.
 */
export const VARIAVEIS_BOLETO: Record<string, { rotulo: string; valor: (b: Boleto) => string | null }> = {
  numero_parcela: { rotulo: 'Número da parcela', valor: (b) => (b.parcela != null ? String(b.parcela) : null) },
  total_parcelas: { rotulo: 'Total de parcelas', valor: (b) => (b.totalParcelas != null ? String(b.totalParcelas) : null) },
  valor_parcela: { rotulo: 'Valor da parcela (atualizado)', valor: (b) => brl(valorDevidoDe(b)) },
  valor_pendente: { rotulo: 'Valor pendente da parcela', valor: (b) => brl(Math.max(0, valorDevidoDe(b) - b.valorPagoCentavos)) },
  data_vencimento: { rotulo: 'Vencimento do boleto', valor: (b) => fmtData(b.vencimento, 'UTC') },
  data_pagamento: { rotulo: 'Data do pagamento', valor: (b) => (b.pagoEm ? fmtData(b.pagoEm, 'America/Sao_Paulo') : null) },
  link_pagamento: { rotulo: 'Link de pagamento', valor: (b) => b.linkPagamento?.trim() || null },
  numero_documento: { rotulo: 'Número do documento', valor: (b) => b.numeroDocumento?.trim() || null },
  linha_digitavel: { rotulo: 'Linha digitável', valor: (b) => b.linhaDigitavel?.trim() || null },
  codigo_barras: { rotulo: 'Código de barras', valor: (b) => b.codigoBarras?.trim() || null },
  descricao_cobranca: { rotulo: 'Descrição da cobrança', valor: (b) => b.descricao?.trim() || null },
};
/** Nomes que só existem com boleto (compatibilidade com a FASE 1). */
export const VARIAVEIS_FASE2 = Object.keys(VARIAVEIS_BOLETO).filter((k) => !(k in VARIAVEIS));

/** Valor devido do boleto: valor atualizado (ou original) + juros + multa − desconto. */
export function valorDevidoDe(b: Pick<Boleto, 'valorCentavos' | 'valorAtualizadoCentavos' | 'jurosCentavos' | 'multaCentavos' | 'descontoCentavos'>) {
  return Math.max(0, (b.valorAtualizadoCentavos ?? b.valorCentavos) + b.jurosCentavos + b.multaCentavos - b.descontoCentavos);
}

export function brl(cents: number) {
  return (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }).replace(/\u00a0/g, ' ');
}
function fmtData(d: Date, tz: string) {
  // Datas de cadastro (vencimento/contratação) são salvas ao meio-dia UTC para não "voltar um dia" no fuso.
  return d.toLocaleDateString('pt-BR', { timeZone: tz === 'UTC' ? 'UTC' : tz });
}

export interface Render { texto: string; faltando: string[]; desconhecidas: string[]; precisaBoleto: string[] }
export interface RenderCtx { boleto?: Boleto | null }

/** Renderiza {{variavel}}. Toda variável usada é obrigatória: se ficar sem valor, entra em "faltando". */
export function renderMensagem(tpl: string, c: Cliente, tz = 'America/Sao_Paulo', ctx: RenderCtx = {}): Render {
  const faltando = new Set<string>(), desconhecidas = new Set<string>(), precisaBoleto = new Set<string>();
  const texto = (tpl ?? '').replace(/\{\{\s*([\w]+)\s*\}\}/g, (m, key: string) => {
    const k = key.toLowerCase();
    const vb = VARIAVEIS_BOLETO[k];
    if (vb && ctx.boleto) {
      const v = vb.valor(ctx.boleto);
      if (v == null || v === '') { faltando.add(k); return m; }
      return v;
    }
    const def = VARIAVEIS[k];
    if (!def) {
      if (vb) precisaBoleto.add(k); else desconhecidas.add(k);
      return m;
    }
    const v = def.valor(c, tz);
    if (v == null || v === '') { faltando.add(k); return m; }
    return v;
  });
  return { texto, faltando: [...faltando], desconhecidas: [...desconhecidas], precisaBoleto: [...precisaBoleto] };
}

export function problemaRender(r: Render): string | null {
  if (r.desconhecidas.length) return `Variável desconhecida: ${r.desconhecidas.map((v) => `{{${v}}}`).join(', ')}`;
  if (r.precisaBoleto?.length) return `Variável disponível só em cobranças com boleto vinculado à mensagem: ${r.precisaBoleto.map((v) => `{{${v}}}`).join(', ')}`;
  if (r.faltando.length) return `Dados obrigatórios ausentes no cadastro: ${r.faltando.map((v) => `{{${v}}}`).join(', ')}`;
  return null;
}
