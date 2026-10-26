export const LEAD_STATUS = ['NOVO', 'CONTATADO', 'RESPONDEU', 'CONVERTIDO', 'DESCARTADO'] as const;
export const CONSENT_SOURCES = ['FORMULARIO', 'IMPORTACAO', 'ANUNCIO_CTWA', 'MANUAL'] as const;
export const CAMPAIGN_STATUS = ['RASCUNHO', 'AGENDADA', 'EM_ANDAMENTO', 'PAUSADA', 'CONCLUIDA'] as const;
export const RECIPIENT_STATUS = ['PENDENTE', 'ENVIADA', 'FALHOU', 'IGNORADA'] as const;
export const TZ = 'America/Sao_Paulo';

/** Normaliza para E.164 (+55... quando vier número brasileiro sem DDI). Retorna null se inválido. */
export function toE164(raw: string): string | null {
  let d = String(raw ?? '').replace(/\D/g, '');
  if (d.length === 10 || d.length === 11) d = '55' + d;
  return d.length >= 10 && d.length <= 15 ? '+' + d : null;
}
