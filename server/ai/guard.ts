/** Regras de segurança da IA: não inventar preços nem políticas. */
const PRICE_RE = /(r\$\s?\d[\d.,]*|\d[\d.,]*\s?(reais|real)\b)/gi;
const SENSITIVE_RE = /\b(preco|precos|valor|valores|quanto custa|custa|mensalidade|plano|planos|promocao|desconto|frete|politica|reembolso|devolucao|troca|garantia|prazo|cancelamento|multa|taxa)\b/;

const norm = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const digits = (s: string) => s.replace(/[^\d]/g, '').replace(/^0+/, '');

export function isSensitiveQuestion(text: string): boolean {
  return SENSITIVE_RE.test(norm(text));
}

/** Preços citados na resposta que não aparecem no contexto da base de conhecimento. */
export function inventedPrices(answer: string, context: string): string[] {
  const ctxDigits = new Set((context.match(PRICE_RE) ?? []).map(digits));
  return (answer.match(PRICE_RE) ?? []).filter((p) => !ctxDigits.has(digits(p)));
}

export const HANDOFF_TOKEN = '[TRANSFERIR]';
