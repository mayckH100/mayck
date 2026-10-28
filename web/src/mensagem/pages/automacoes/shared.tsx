import { createContext, useContext } from 'react';

export const API = '/mckmensagem/automacoes';
export const ReadOnlyCtx = createContext(false);
export const useReadOnly = () => useContext(ReadOnlyCtx);

export type Categoria = 'LEMBRETE' | 'MARKETING' | 'COBRANCA';
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
  anexos?: AnexoView[]; reenvio?: { offsets: number[]; horario: string; maxPorBoleto: number; mensagem?: string | null } | null;
}
export interface AnexoView {
  id?: string; envio: number | null; arquivoId: string | null; boletoId: string | null; nome?: string | null;
  boleto?: { id: string; descricao: string; parcela: number | null; totalParcelas: number | null; vencimento: string; status: string; statusLabel: string; valor: number; temArquivo: boolean } | null;
}
export interface Boleto {
  id: string; clienteId: string; cliente?: string; descricao: string; numeroDocumento: string | null; parcela: number | null; totalParcelas: number | null;
  valor: number; devido: number; pago: number; saldo: number; vencimentoData: string; status: string; statusLabel: string; statusEnvio: string; atrasado: boolean;
  codigoBarras: string | null; linhaDigitavel: string | null; linkPagamento: string | null; arquivoId: string | null; observacoes: string | null;
  valorAtualizadoCentavos: number | null; jurosCentavos: number; multaCentavos: number; descontoCentavos: number; emissao: string | null; pagoEm: string | null; enviadoEm: string | null; envios: number;
}
export interface Arquivo { id: string; nome: string; mime: string; tamanho: number; clienteId: string | null; cliente?: string | null; origem: string; descricao: string | null; createdAt: string }

export const CAT_LABEL: Record<Categoria, string> = { LEMBRETE: 'Lembrete', MARKETING: 'Marketing', COBRANCA: 'Cobrança' };
export const CANAL_LABEL: Record<Canal, string> = { WHATSAPP: 'WhatsApp', EMAIL: 'E-mail' };
const AUTO_ST: Record<string, [string, string]> = {
  RASCUNHO: ['', 'Rascunho'], ATIVA: ['green', 'Ativa'], PAUSADA: ['amber', 'Pausada'], CANCELADA: ['red', 'Cancelada'], CONCLUIDA: ['blue', 'Concluída'],
};
const OC_ST: Record<string, [string, string]> = {
  PENDENTE: ['blue', 'Programada'], PROCESSANDO: ['amber', 'Enviando'], ENVIADA: ['green', 'Enviada'], FALHOU: ['red', 'Falhou'],
  IGNORADA: ['', 'Não enviada'], CANCELADA: ['', 'Cancelada'], TENTANDO: ['amber', 'Tentando de novo'], RECEBIDA: ['blue', 'Recebida'],
};
const BOL_ST: Record<string, [string, string]> = {
  RASCUNHO: ['', 'Rascunho'], PENDENTE: ['blue', 'A vencer'], VENCIDO: ['red', 'Vencido'], EM_ANALISE: ['amber', 'Comprovante em análise'],
  PARCIAL: ['amber', 'Pagamento parcial'], PAGO: ['green', 'Pago confirmado'], CANCELADO: ['', 'Cancelado'],
};
const ENVIO_ST: Record<string, [string, string]> = { NAO_ENVIADO: ['', 'Não enviado'], ENVIADO: ['blue', 'Enviado'], FALHOU: ['red', 'Falha no envio'] };
export const BolBadge = ({ s }: { s: string }) => { const [c, l] = BOL_ST[s] ?? ['', s]; return <span className={`badge ${c}`}>{l}</span>; };
export const EnvioBadge = ({ s }: { s: string }) => { const [c, l] = ENVIO_ST[s] ?? ['', s]; return <span className={`badge ${c}`}>{l}</span>; };
export const BOL_STATUS = Object.keys(BOL_ST);
export const BOL_LABEL = Object.fromEntries(Object.entries(BOL_ST).map(([k, v]) => [k, v[1]]));
export const brl = (v?: number | null) => (v == null ? '—' : v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }));
export const fmtYmd = (ymd?: string | null) => (ymd ? ymd.slice(0, 10).split('-').reverse().join('/') : '—');
export const fmtBytes = (n: number) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`);
export const downloadUrl = (id: string, inline = false) => `/api${API}/arquivos/${id}/download${inline ? '?inline=1' : ''}`;
export const AutoBadge = ({ s }: { s: string }) => { const [c, l] = AUTO_ST[s] ?? ['', s]; return <span className={`badge ${c}`}>{l}</span>; };
export const OcBadge = ({ s }: { s: string }) => { const [c, l] = OC_ST[s] ?? ['', s]; return <span className={`badge ${c}`}>{l}</span>; };
export const OC_COLOR: Record<string, string> = { PENDENTE: '#2f6fde', PROCESSANDO: '#b7791f', ENVIADA: '#0b7a5a', FALHOU: '#d64545', IGNORADA: '#8a8a93', CANCELADA: '#b5b5bb' };

export const fmtDT = (d?: string | null, tz = 'America/Sao_Paulo') => (d ? new Date(d).toLocaleString('pt-BR', { timeZone: tz, dateStyle: 'short', timeStyle: 'short' }) : '—');
export const ymdLocal = (d: Date, tz = 'America/Sao_Paulo') => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
export const hmLocal = (d: string | Date, tz = 'America/Sao_Paulo') => new Intl.DateTimeFormat('pt-BR', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(d));
