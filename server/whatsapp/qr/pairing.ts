/**
 * Conexão do WhatsApp por "código de pareamento" (Conectar com número de telefone), igual ao
 * WhatsApp Web: no celular, Aparelhos conectados › Conectar aparelho › Conectar com número de telefone.
 * Funções puras (validação do número, formato do código), usadas pela rota e pela tela.
 */

/** Quanto tempo a tela mostra o código como válido (o socket do Baileys aguarda ~160 s). */
export const PAIRING_CODE_TTL_MS = 120_000;

/** Limite de códigos por canal por hora (proteção contra abuso e contra bloqueio do número). */
export const pairingPerHour = () => {
  const n = Number(process.env.QR_PAIRING_PER_HOUR ?? 5);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 5;
};

export type PhoneCheck = { ok: true; digits: string } | { ok: false; error: string };

/**
 * Valida o número com DDI e devolve só os dígitos (formato que o WhatsApp espera: 5511999990000).
 * Aceita "+55 (11) 99999-0000", "55 11 999990000" etc.
 */
export function normalizePairingPhone(input: string): PhoneCheck {
  const digits = String(input ?? '').replace(/\D/g, '');
  if (!digits) return { ok: false, error: 'Informe o número do WhatsApp com DDI e DDD.' };
  if (digits.startsWith('0')) return { ok: false, error: 'O número deve começar pelo código do país (DDI), sem zero. Ex.: 55 11 99999-0000.' };
  if (digits.length < 10 || digits.length > 15) return { ok: false, error: 'Número inválido: use DDI + DDD + número (de 10 a 15 dígitos).' };
  if (digits.startsWith('55')) {
    // Brasil: 55 + DDD (2 dígitos, 11–99) + 8 ou 9 dígitos.
    const ddd = Number(digits.slice(2, 4));
    const rest = digits.slice(4);
    if (digits.length !== 12 && digits.length !== 13) return { ok: false, error: 'Número do Brasil inválido: use 55 + DDD + número (ex.: 55 11 99999-0000).' };
    if (!Number.isInteger(ddd) || ddd < 11 || ddd % 10 === 0) return { ok: false, error: 'DDD inválido.' };
    if (rest.length === 9 && rest[0] !== '9') return { ok: false, error: 'Celular com 9 dígitos deve começar com 9.' };
  }
  return { ok: true, digits };
}

/** "ABCD1234" → "ABCD-1234" (como o WhatsApp mostra). */
export function formatPairingCode(code: string): string {
  const c = String(code ?? '').replace(/[^0-9A-Za-z]/g, '').toUpperCase();
  return c.length === 8 ? `${c.slice(0, 4)}-${c.slice(4)}` : c;
}

/** Número mascarado para Auditoria/tela: 5511999990000 → +55 11 *****-0000. Nunca registrar o código. */
export function maskPhone(digits: string): string {
  const d = String(digits ?? '').replace(/\D/g, '');
  if (d.length < 8) return '***';
  if (d.startsWith('55') && (d.length === 12 || d.length === 13)) return `+55 ${d.slice(2, 4)} *****-${d.slice(-4)}`;
  return `+${d.slice(0, 2)} ****${d.slice(-4)}`;
}
