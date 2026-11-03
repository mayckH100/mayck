/**
 * Regra (Mayck, 2026-11-03): a IA SÓ transfere para um humano quando o cliente pede isso explicitamente
 * (atendente / humano / pessoa / alguém da equipe…). Falha da IA, resposta vazia, "não sei", limite de uso etc.
 * NUNCA transferem: a IA manda o texto de falha e continua no atendimento.
 *
 * Este detector é a trava em código (o prompt também instrui a IA). É conservador: na dúvida, NÃO é pedido.
 */

const norm = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();

/** Quem o cliente pode pedir. */
const WHO = '(?:um |uma |o |a |algum |alguma |com )?(?:atendente|atendentes|humano|humana|pessoa|pessoa real|pessoa de verdade|ser humano|alguem|algm|vendedor|vendedora|consultor|consultora|gerente|responsavel|suporte humano|operador|operadora|funcionario|funcionaria|dono|dona|proprietario|alguem da equipe|alguem da empresa|equipe|setor comercial|comercial)';

const PATTERNS: RegExp[] = [
  // "quero falar com um atendente", "posso falar com alguém?", "preciso conversar com uma pessoa"
  new RegExp(`\\b(?:quero|queria|gostaria de|preciso|precisava|posso|pode|da pra|tem como|deixa eu|me deixa)\\s+(?:falar|conversar|ser atendid[oa]|atendimento)\\s+(?:com |por )?${WHO}\\b`),
  // "falar com atendente", "fala com humano"
  new RegExp(`\\b(?:falar|fala|conversar|conversa)\\s+com\\s+${WHO}\\b`),
  // "me passa/transfere/encaminha para um atendente", "chama um humano"
  new RegExp(`\\b(?:me\\s+)?(?:passa|passe|transfere|transfira|transferir|encaminha|encaminhe|chama|chame|chamar|manda|mande)\\s+(?:me\\s+)?(?:pra|para|pro|com)?\\s*${WHO}\\b`),
  // "atendimento humano", "atendente humano", "atendimento com pessoa"
  /\batendimento (?:humano|humanizado|pessoal|com (?:uma )?pessoa|com atendente)\b/,
  /\batendente (?:humano|de verdade|real)\b/,
  // "não quero falar com robô/bot/máquina/IA", "você é um robô? quero uma pessoa"
  /\b(?:nao quero|chega de|cansei de|para de)\s+(?:falar com |conversar com )?(?:robo|bot|maquina|ia|inteligencia artificial|assistente virtual)\b/,
  /\b(?:quero|prefiro|exijo)\s+(?:uma |um )?(?:pessoa|humano|atendente)\b/,
  // "tem alguém aí?" / "tem atendente?" / "tem algum humano?"
  /\btem (?:algum |alguma )?(?:atendente|humano|pessoa de verdade|alguem (?:ai|de verdade|real))\b/,
];

/** Mensagens curtas que são só o pedido: "atendente", "humano por favor", "pessoa!". */
const SHORT_RE = /^(?:(?:oi|ola|por favor|pf|pfv|pls|quero|um|uma|o|a)\s+)*(?:atendente|atendimento humano|humano|pessoa|pessoa real|operador|suporte humano)(?:\s+(?:por favor|pf|pfv|agora|ja|urgente|pls))*$/;

/**
 * true quando o texto do cliente pede explicitamente um humano. `extraKeywords` são as "palavras que pedem
 * humano" configuradas pela empresa: valem quando a mensagem é curta (até 4 palavras) e contém a palavra
 * inteira, ou quando aparecem num pedido ("quero <palavra>", "falar com <palavra>") — assim "pessoa jurídica"
 * ou "quantas pessoas" não transferem.
 */
export function isExplicitHumanRequest(text: string, extraKeywords: string[] = []): boolean {
  const t = norm(text ?? '');
  if (!t) return false;
  if (SHORT_RE.test(t)) return true;
  if (PATTERNS.some((re) => re.test(t))) return true;
  const words = t.split(' ');
  for (const raw of extraKeywords) {
    const kw = norm(raw);
    if (!kw) continue;
    const esc = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const whole = new RegExp(`(?:^|\\s)${esc}(?:\\s|$)`);
    if (!whole.test(t)) continue;
    if (words.length <= 4 && !/\b(?:juridica|fisica|pessoas)\b/.test(t)) return true;
    if (new RegExp(`\\b(?:quero|queria|preciso|chama|chame|falar com|fala com|conversar com|passa pra|passa para|transfere pra|transfere para|me passa|me transfere)\\s+(?:um |uma |o |a |com )?${esc}\\b`).test(t)) return true;
  }
  return false;
}

/** O texto de fallback promete transferência? (aí não pode ser usado quando a IA falha sem transferir). */
export const promisesTransfer = (s: string) => /transfer|encaminh|atendente|humano|pessoa da equipe|especialista|vou chamar|vai te atender/i.test(s ?? '');

export const DEFAULT_FAILURE_TEXT = 'Desculpe, não consegui responder agora. Pode me explicar de outro jeito? Se preferir falar com uma pessoa da equipe, é só escrever "atendente".';

/** Texto enviado quando a IA falha sem transferir: o configurado; senão o fallback se ele não prometer humano; senão o padrão. */
export function failureText(s: { failureMessage?: string | null; fallbackMessage?: string | null }): string {
  if (s.failureMessage?.trim()) return s.failureMessage.trim();
  if (s.fallbackMessage?.trim() && !promisesTransfer(s.fallbackMessage)) return s.fallbackMessage.trim();
  return DEFAULT_FAILURE_TEXT;
}
