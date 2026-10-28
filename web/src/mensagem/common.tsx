import { get } from '../api';

export const MM_BASE = '/mensagem';
/** Link absoluto para o MCKBOT (app principal, servido na raiz). */
export const MCKBOT_URL = '/';

export type LeadStatus = 'NOVO' | 'CONTATADO' | 'RESPONDEU' | 'QUALIFICADO' | 'AGUARDANDO' | 'CONVERTIDO' | 'DESCARTADO';
export type ConsentSource = 'FORMULARIO' | 'IMPORTACAO' | 'ANUNCIO_CTWA' | 'MANUAL';
export type CampaignStatus = 'RASCUNHO' | 'AGENDADA' | 'EM_ANDAMENTO' | 'PAUSADA' | 'CONCLUIDA';

export interface Lead {
  id: string; phone: string; name: string | null; tags: string[]; status: LeadStatus;
  consentSource: ConsentSource; consentAt: string | null; optOutAt: string | null; campaignId: string | null; createdAt: string;
}
export interface LeadPage { items: Lead[]; total: number; page: number; pageSize: number }
export interface Campaign {
  id: string; name: string; message: string; channelId: string; status: CampaignStatus;
  dailyLimit: number; minIntervalSec: number; maxIntervalSec: number; windowStart: string; windowEnd: string;
  createdAt: string; updatedAt?: string;
  recipients: Partial<Record<'PENDENTE' | 'ENVIADA' | 'FALHOU' | 'IGNORADA', number>>;
}
export interface Metrics {
  totalLeads: number; byStatus: Record<LeadStatus, number>; sent: number; failed: number; optOuts: number;
  replies: number; responseRate: number; conversionRate: number;
}
export interface ChannelLite { id: string; name: string; status: string; provider?: string; displayPhone?: string | null }

export const LEAD_STATUS: LeadStatus[] = ['NOVO', 'CONTATADO', 'RESPONDEU', 'QUALIFICADO', 'AGUARDANDO', 'CONVERTIDO', 'DESCARTADO'];
export const LEAD_STATUS_LABEL: Record<LeadStatus, string> = { NOVO: 'Novo', CONTATADO: 'Contatado', RESPONDEU: 'Respondeu', QUALIFICADO: 'Qualificado', AGUARDANDO: 'Aguardando', CONVERTIDO: 'Convertido', DESCARTADO: 'Descartado' };
export const LEAD_STATUS_CLS: Record<LeadStatus, string> = { NOVO: 'blue', CONTATADO: '', RESPONDEU: 'amber', QUALIFICADO: 'green', AGUARDANDO: '', CONVERTIDO: 'green', DESCARTADO: 'red' };
export const LEAD_STATUS_COLOR: Record<LeadStatus, string> = { NOVO: '#2f6fde', CONTATADO: '#8b6cff', RESPONDEU: '#b7791f', QUALIFICADO: '#14a37f', AGUARDANDO: '#8a94a6', CONVERTIDO: '#0b7a5a', DESCARTADO: '#d64545' };

export const CONSENT_SOURCES: ConsentSource[] = ['FORMULARIO', 'IMPORTACAO', 'ANUNCIO_CTWA', 'MANUAL'];
export const CONSENT_LABEL: Record<ConsentSource, string> = {
  FORMULARIO: 'Formulário (site/landing page)', IMPORTACAO: 'Importação de lista autorizada',
  ANUNCIO_CTWA: 'Anúncio Clique para WhatsApp', MANUAL: 'Cadastro manual (autorização direta)',
};

export const CAMPAIGN_STATUS_LABEL: Record<CampaignStatus, string> = { RASCUNHO: 'Rascunho', AGENDADA: 'Agendada', EM_ANDAMENTO: 'Em andamento', PAUSADA: 'Pausada', CONCLUIDA: 'Concluída' };
export const CAMPAIGN_STATUS_CLS: Record<CampaignStatus, string> = { RASCUNHO: '', AGENDADA: 'blue', EM_ANDAMENTO: 'green', PAUSADA: 'amber', CONCLUIDA: 'blue' };

/** Padrões seguros (iguais aos do servidor) para não queimar o número. */
export const SAFE_DEFAULTS = { dailyLimit: 50, minIntervalSec: 45, maxIntervalSec: 120, windowStart: '09:00', windowEnd: '20:00' };

export function LeadBadge({ status }: { status: LeadStatus }) {
  return <span className={`badge ${LEAD_STATUS_CLS[status] ?? ''}`}>{LEAD_STATUS_LABEL[status] ?? status}</span>;
}
export function CampaignBadge({ status }: { status: CampaignStatus }) {
  return <span className={`badge ${CAMPAIGN_STATUS_CLS[status] ?? ''}`}>{CAMPAIGN_STATUS_LABEL[status] ?? status}</span>;
}

/** Mesmo comportamento do servidor: {nome} vira o primeiro nome; sem nome, some sem deixar espaço/vírgula sobrando. */
export function personalize(message: string, name?: string | null) {
  const first = (name ?? '').trim().split(/\s+/)[0] ?? '';
  return message.replace(/\{\s*nome\s*\}/gi, first).replace(/[ \t]+([,.!?])/g, '$1').replace(/[ \t]{2,}/g, ' ').trim();
}

export function campaignProgress(c: Campaign) {
  const r = c.recipients ?? {};
  const sent = r.ENVIADA ?? 0, failed = r.FALHOU ?? 0, skipped = r.IGNORADA ?? 0, pending = r.PENDENTE ?? 0;
  const total = sent + failed + skipped + pending;
  const done = sent + failed + skipped;
  return { sent, failed, skipped, pending, total, pct: total ? Math.round((done / total) * 100) : 0 };
}

export const fmtPhone = (p: string) => {
  const m = /^\+55(\d{2})(\d{4,5})(\d{4})$/.exec(p);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : p;
};

const csvEsc = (v: unknown) => {
  const s = v == null ? '' : String(v);
  return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export function downloadCsv(filename: string, rows: unknown[][]) {
  const text = '\uFEFF' + rows.map((r) => r.map(csvEsc).join(',')).join('\n');
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Busca todas as páginas de leads de um filtro (limite de segurança de 100 páginas = 5.000 leads). */
export async function fetchAllLeads(params: Record<string, string>) {
  const out: Lead[] = [];
  for (let page = 1; page <= 100; page++) {
    const q = new URLSearchParams({ ...params, page: String(page) });
    const r = await get<LeadPage>(`/mckmensagem/leads?${q}`);
    out.push(...r.items);
    if (out.length >= r.total || r.items.length === 0) break;
  }
  return out;
}

export const slug = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'campanha';
