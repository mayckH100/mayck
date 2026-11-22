/**
 * Versões dos prompts da IA (v1.35.0). Cada chamada grava em AiUsage a finalidade e a versão do prompt usado,
 * para comparar qualidade/consumo entre versões. Ao mudar um prompt de forma relevante, suba a versão aqui.
 */
export const PROMPT_VERSIONS = {
  atendimento: 'atendimento@2026-11-20',
  'sdr-extracao': 'sdr-extracao@2026-11-07',
  'sdr-followup': 'sdr-followup@2026-11-07',
  campanha: 'campanha@2026-11-20',
  'erp-aprovacao': 'erp-aprovacao@2026-11-19',
  autoresposta: 'autoresposta@2026-11-07',
  voz: 'voz-reescrita@2026-11-07',
  revisao: 'revisao@2026-11-08',
  repescagem: 'repescagem@2026-11-22',
} as const;

export type AiPurpose = keyof typeof PROMPT_VERSIONS;

/** Nome curto para a tela (IA › Qualidade). */
export const PURPOSE_LABEL: Record<string, string> = {
  atendimento: 'Atendimento (Inbox e fluxos)',
  'sdr-extracao': 'SDR: qualificação do lead',
  'sdr-followup': 'SDR: follow-up personalizado',
  campanha: 'Campanhas: respostas dos leads',
  'erp-aprovacao': 'ERP: aprovação de compra',
  autoresposta: 'SDR: resposta automática',
  voz: 'Voz',
  revisao: 'Revisão da resposta',
  repescagem: 'Campanhas: repescagem de quem não respondeu',
  outros: 'Outros (antes da 1.35.0)',
};

export const promptVersion = (p: AiPurpose) => PROMPT_VERSIONS[p];
