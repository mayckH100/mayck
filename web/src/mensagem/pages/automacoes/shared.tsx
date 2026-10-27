import { createContext, useContext } from 'react';

export const API = '/mckmensagem/automacoes';
export const ReadOnlyCtx = createContext(false);
export const useReadOnly = () => useContext(ReadOnlyCtx);

export type Categoria = 'LEMBRETE' | 'MARKETING';
export type Canal = 'WHATSAPP' | 'EMAIL';

export interface Cliente {
  id: string; nome: string; documento: string | null; telefone: string | null; whatsapp: string | null; email: string | null; emailSecundario: string | null;
  empresa: string | null; plano: string | null; dataContratacao: string | null; dataVencimento: string | null; valor: number | null; parcelas: number | null;
  formaPagamento: string | null; status: string; observacoes: string | null; prefWhatsapp: boolean; prefEmail: boolean; consentimento: boolean; marketingOptOut: boolean;
}
export interface Ocorrencia {
  id: string; automacaoId: string; clienteId: string; canal: Canal; status: string; agendadoPara: string; executarEm: string; enviadoEm: string | null;
  tentativas: number; erro: string | null; provedorId: string | null; mensagem: string | null; editada: boolean;
}
export interface Automacao {
  id: string; nome: string; categoria: Categoria; canais: Canal[]; channelId: string | null; assunto: string | null; mensagem: string; clienteIds: string[];
  regra: any; descricao: string; timezone: string; inicio: string; fim: string | null; maxEnvios: number | null; status: string;
  ocorrencias: Record<string, number>; proximoEnvio: string | null; avisos?: string[];
}

export const CAT_LABEL: Record<Categoria, string> = { LEMBRETE: 'Lembrete', MARKETING: 'Marketing' };
export const CANAL_LABEL: Record<Canal, string> = { WHATSAPP: 'WhatsApp', EMAIL: 'E-mail' };
const AUTO_ST: Record<string, [string, string]> = {
  RASCUNHO: ['', 'Rascunho'], ATIVA: ['green', 'Ativa'], PAUSADA: ['amber', 'Pausada'], CANCELADA: ['red', 'Cancelada'], CONCLUIDA: ['blue', 'Concluída'],
};
const OC_ST: Record<string, [string, string]> = {
  PENDENTE: ['blue', 'Programada'], PROCESSANDO: ['amber', 'Enviando'], ENVIADA: ['green', 'Enviada'], FALHOU: ['red', 'Falhou'],
  IGNORADA: ['', 'Não enviada'], CANCELADA: ['', 'Cancelada'], TENTANDO: ['amber', 'Tentando de novo'],
};
export const AutoBadge = ({ s }: { s: string }) => { const [c, l] = AUTO_ST[s] ?? ['', s]; return <span className={`badge ${c}`}>{l}</span>; };
export const OcBadge = ({ s }: { s: string }) => { const [c, l] = OC_ST[s] ?? ['', s]; return <span className={`badge ${c}`}>{l}</span>; };
export const OC_COLOR: Record<string, string> = { PENDENTE: '#2f6fde', PROCESSANDO: '#b7791f', ENVIADA: '#0b7a5a', FALHOU: '#d64545', IGNORADA: '#8a8a93', CANCELADA: '#b5b5bb' };

export const fmtDT = (d?: string | null, tz = 'America/Sao_Paulo') => (d ? new Date(d).toLocaleString('pt-BR', { timeZone: tz, dateStyle: 'short', timeStyle: 'short' }) : '—');
export const ymdLocal = (d: Date, tz = 'America/Sao_Paulo') => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
export const hmLocal = (d: string | Date, tz = 'America/Sao_Paulo') => new Intl.DateTimeFormat('pt-BR', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(d));
