import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode, type FormEvent } from 'react';
import { get } from './api';

export function useApi<T>(path: string | null, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(!!path);
  const seq = useRef(0);
  const reload = useCallback(async () => {
    if (!path) return;
    const my = ++seq.current;
    setLoading(true);
    try {
      const d = await get<T>(path);
      if (my === seq.current) { setData(d); setError(null); }
    } catch (e) {
      if (my === seq.current) setError((e as Error).message);
    } finally {
      if (my === seq.current) setLoading(false);
    }
  }, [path, ...deps]);
  useEffect(() => { reload(); }, [reload]);
  return { data, error, loading, reload, setData };
}

export const Spinner = () => <span className="spinner" aria-label="Carregando" />;
export const Loading = ({ text = 'Carregando…' }: { text?: string }) => <div className="loading"><Spinner /> {text}</div>;
export function ErrorBox({ error, onRetry }: { error: string; onRetry?: () => void }) {
  return (
    <div className="alert err row between" role="alert">
      <span>{error}</span>
      {onRetry && <button className="btn sm" onClick={onRetry}>Tentar de novo</button>}
    </div>
  );
}
export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return <div className="empty"><div className="t">{title}</div>{children}</div>;
}

/** Renderiza estados de carregamento/erro antes do conteúdo. */
export function Async<T>({ state, children }: { state: { data: T | null; error: string | null; loading: boolean; reload: () => void }; children: (d: T) => ReactNode }) {
  if (state.error && !state.data) return <ErrorBox error={state.error} onRetry={state.reload} />;
  if (!state.data) return <Loading />;
  return <>{children(state.data)}</>;
}

type Toast = { id: number; text: string; kind: 'ok' | 'err' };
const ToastCtx = createContext<(text: string, kind?: 'ok' | 'err') => void>(() => undefined);
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((text: string, kind: 'ok' | 'err' = 'ok') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, text, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4500);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toast-wrap" aria-live="polite">{toasts.map((t) => <div key={t.id} className={`toast ${t.kind === 'err' ? 'err' : ''}`}>{t.text}</div>)}</div>
    </ToastCtx.Provider>
  );
}
export const useToast = () => useContext(ToastCtx);

/** Executa uma ação assíncrona com estado de "enviando" e toasts de sucesso/erro. */
export function useAction() {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const run = useCallback(async <T,>(fn: () => Promise<T>, okMsg?: string): Promise<T | undefined> => {
    setBusy(true);
    try {
      const r = await fn();
      if (okMsg) toast(okMsg);
      return r;
    } catch (e) {
      toast((e as Error).message, 'err');
      return undefined;
    } finally {
      setBusy(false);
    }
  }, [toast]);
  return { busy, run };
}

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);
  return (
    <div className="modal-bg" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title}>
        <div className="row between" style={{ marginBottom: 12 }}>
          <h2 style={{ margin: 0 }}>{title}</h2>
          <button className="btn ghost sm" onClick={onClose} aria-label="Fechar">✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

/** Confirma uma exclusão definitiva pedindo a senha de login do usuário (conferida no servidor). */
export function SenhaExclusaoModal({ title, children, onConfirm, onClose }: { title: string; children?: ReactNode; onConfirm: (senha: string) => Promise<unknown>; onClose: () => void }) {
  const [senha, setSenha] = useState('');
  const [erro, setErro] = useState('');
  const [busy, setBusy] = useState(false);
  const enviar = async (e: FormEvent) => {
    e.preventDefault();
    if (!senha || busy) return;
    setBusy(true); setErro('');
    try { await onConfirm(senha); } catch (err) { setErro((err as Error).message); setBusy(false); }
  };
  return (
    <Modal title={title} onClose={onClose}>
      <form className="stack" onSubmit={enviar}>
        {children}
        <p className="small muted" style={{ margin: 0 }}>Esta ação não pode ser desfeita. Digite a sua senha de login para confirmar.</p>
        <Field label="Sua senha"><input type="password" autoComplete="current-password" autoFocus value={senha} onChange={(e) => setSenha(e.target.value)} /></Field>
        {erro && <div className="small" style={{ color: 'var(--red, #c0392b)' }}>{erro}</div>}
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>Voltar</button>
          <button type="submit" className="btn danger" disabled={busy || !senha}>{busy ? 'Excluindo…' : 'Excluir definitivamente'}</button>
        </div>
      </form>
    </Modal>
  );
}

export const fmtDate = (d?: string | Date | null) => (d ? new Date(d).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '—');
export const fmtNum = (n?: number | null) => (n === null || n === undefined ? '—' : n.toLocaleString('pt-BR'));
export function fmtDuration(s?: number | null) {
  if (s === null || s === undefined) return '—';
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  return `${(s / 3600).toFixed(1)} h`;
}
export const initials = (name?: string | null) => (name ?? '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase()).join('') || '?';

export function StatusBadge({ status }: { status: string }) {
  const map: Record<string, [string, string]> = {
    CONNECTED: ['green', 'Conectado'], NOT_CONNECTED: ['', 'Não conectado'], ERROR: ['red', 'Erro'],
    CONNECTING: ['blue', 'Conectando…'], QR_PENDING: ['amber', 'Aguardando leitura do QR'],
    ACTIVE: ['green', 'Ativo'], PAUSED: ['amber', 'Pausado'], DRAFT: ['', 'Rascunho'],
    OPEN: ['green', 'Aberta'], PENDING: ['amber', 'Aguardando humano'], CLOSED: ['', 'Encerrada'],
    COMPLETED: ['green', 'Concluído'], FAILED: ['red', 'Falhou'], HANDOFF: ['blue', 'Transferido'], WAITING: ['amber', 'Aguardando'], RUNNING: ['blue', 'Executando'], CANCELLED: ['', 'Cancelado'],
    SENT: ['green', 'Enviada'], DELIVERED: ['green', 'Entregue'], READ: ['blue', 'Lida'], QUEUED: ['', 'Na fila'], RECEIVED: ['', 'Recebida'],
  };
  const [cls, label] = map[status] ?? ['', status];
  return <span className={`badge ${cls}`}>{label}</span>;
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return <label className="f">{label}{children}{hint && <span className="hint">{hint}</span>}</label>;
}

export function copy(text: string, toast: (t: string) => void) {
  navigator.clipboard?.writeText(text).then(() => toast('Copiado!'), () => toast('Não foi possível copiar'));
}
