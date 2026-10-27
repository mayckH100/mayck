import type { Cliente } from '@prisma/client';

/** Variáveis disponíveis na FASE 1 (dados do cadastro do cliente). */
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

/** Variáveis do módulo financeiro (boletos/pagamentos): só existem na FASE 2. */
export const VARIAVEIS_FASE2 = ['numero_parcela', 'data_pagamento', 'valor_pendente', 'link_pagamento', 'numero_documento'];

function brl(cents: number) {
  return (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }).replace(/\u00a0/g, ' ');
}
function fmtData(d: Date, tz: string) {
  // Datas de cadastro (vencimento/contratação) são salvas ao meio-dia UTC para não "voltar um dia" no fuso.
  return d.toLocaleDateString('pt-BR', { timeZone: tz === 'UTC' ? 'UTC' : tz });
}

export interface Render { texto: string; faltando: string[]; desconhecidas: string[] }

/** Renderiza {{variavel}}. Toda variável usada é obrigatória: se ficar sem valor, entra em "faltando". */
export function renderMensagem(tpl: string, c: Cliente, tz = 'America/Sao_Paulo'): Render {
  const faltando = new Set<string>(), desconhecidas = new Set<string>();
  const texto = (tpl ?? '').replace(/\{\{\s*([\w]+)\s*\}\}/g, (m, key: string) => {
    const k = key.toLowerCase();
    const def = VARIAVEIS[k];
    if (!def) { desconhecidas.add(k); return m; }
    const v = def.valor(c, tz);
    if (v == null || v === '') { faltando.add(k); return m; }
    return v;
  });
  return { texto, faltando: [...faltando], desconhecidas: [...desconhecidas] };
}

export function problemaRender(r: Render): string | null {
  if (r.desconhecidas.length) {
    const f2 = r.desconhecidas.filter((v) => VARIAVEIS_FASE2.includes(v));
    return f2.length
      ? `Variável do módulo financeiro ainda não disponível: ${f2.map((v) => `{{${v}}}`).join(', ')}`
      : `Variável desconhecida: ${r.desconhecidas.map((v) => `{{${v}}}`).join(', ')}`;
  }
  if (r.faltando.length) return `Dados obrigatórios ausentes no cadastro: ${r.faltando.map((v) => `{{${v}}}`).join(', ')}`;
  return null;
}
