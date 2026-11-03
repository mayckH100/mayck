import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { get, post } from './api';
import { useAuth } from './auth';
import type { GateApp } from './subscriptionGate';
import { dayKeySP, isExternalLink, localDismissKey, shouldHoldAnnouncements, type ActiveAnnouncement } from './announcements';

const PRODUCT: Record<GateApp, 'MCKBOT' | 'MCKMENSAGEM'> = { mckbot: 'MCKBOT', mensagem: 'MCKMENSAGEM' };

function locallyDismissed(userId: string, a: ActiveAnnouncement) {
  try { return localStorage.getItem(localDismissKey(userId, a.id, a.day || dayKeySP())) === '1'; } catch { return false; }
}
function markLocal(userId: string, a: ActiveAnnouncement) {
  try { localStorage.setItem(localDismissKey(userId, a.id, a.day || dayKeySP()), '1'); } catch { /* modo privado */ }
}

/**
 * Avisos do Painel Master: pop-up no centro da tela com imagem, título, texto e botão de link.
 * Aparece no máximo uma vez por dia por aviso (fechamento gravado no servidor; reserva no localStorage).
 * Vários avisos: um depois do outro. O pop-up de renovação da assinatura tem prioridade.
 */
export default function Announcements({ app }: { app: GateApp }) {
  const { me } = useAuth();
  const loc = useLocation();
  const [queue, setQueue] = useState<ActiveAnnouncement[]>([]);
  const [paymentRequired, setPaymentRequired] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const lastFocus = useRef<HTMLElement | null>(null);
  const viewed = useRef(new Set<string>());

  const userId = me?.user?.id ?? '';
  const orgId = me?.org?.id ?? '';
  const isSuperAdmin = !!(me?.isSuperAdmin || me?.user?.isSuperAdmin);
  const hold = shouldHoldAnnouncements({
    app, pathname: loc.pathname, hasOrg: !!orgId, role: me?.role, isSuperAdmin, subscriptions: me?.subscriptions, paymentRequired,
  });

  useEffect(() => {
    const h = () => setPaymentRequired(true);
    window.addEventListener('mck:payment-required', h);
    return () => window.removeEventListener('mck:payment-required', h);
  }, []);
  const sub = me?.subscriptions?.find((s) => s.product === PRODUCT[app]);
  useEffect(() => { if (sub?.active) setPaymentRequired(false); }, [sub?.active]);

  // Busca ao entrar / trocar de organização.
  useEffect(() => {
    if (!userId || !orgId) { setQueue([]); return; }
    let alive = true;
    get<{ items: ActiveAnnouncement[] }>(`/announcements/active?app=${PRODUCT[app]}`)
      .then((r) => { if (alive) setQueue((r.items ?? []).filter((a) => a.imageUrl && !locallyDismissed(userId, a))); })
      .catch(() => undefined);
    return () => { alive = false; };
  }, [userId, orgId, app]);

  const current = !hold ? queue[0] : undefined;

  // Registra que apareceu (uma vez por carregamento).
  useEffect(() => {
    if (!current || viewed.current.has(current.id)) return;
    viewed.current.add(current.id);
    post(`/announcements/${current.id}/seen`, { action: 'view' }).catch(() => undefined);
  }, [current?.id]);

  // Foco no "Fechar", Esc fecha, Tab fica dentro do pop-up.
  useEffect(() => {
    if (!current) return;
    if (!lastFocus.current) lastFocus.current = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); dismiss(); return; }
      if (e.key !== 'Tab' || !dialogRef.current) return;
      const items = Array.from(dialogRef.current.querySelectorAll<HTMLElement>('button,a[href]'));
      if (!items.length) return;
      const a = items[0], z = items[items.length - 1];
      if (e.shiftKey && document.activeElement === a) { e.preventDefault(); z.focus(); }
      else if (!e.shiftKey && document.activeElement === z) { e.preventDefault(); a.focus(); }
    };
    document.addEventListener('keydown', key, true);
    return () => document.removeEventListener('keydown', key, true);
  }, [current?.id]);

  function dismiss() {
    const a = queue[0];
    if (!a) return;
    markLocal(userId, a);
    post(`/announcements/${a.id}/seen`, { action: 'dismiss' }).catch(() => undefined);
    const rest = queue.slice(1);
    setQueue(rest);
    if (!rest.length) {
      const f = lastFocus.current;
      lastFocus.current = null;
      if (f && document.contains(f)) f.focus();
    }
  }

  if (!current) return null;
  const titleId = `aviso-title-${current.id}`;
  const descId = `aviso-desc-${current.id}`;
  const label = current.linkLabel || 'Saiba mais';
  return (
    <div className="aviso-bg" data-sub-exempt>
      <div
        ref={dialogRef} className="aviso" role="dialog" aria-modal="true"
        {...(current.title ? { 'aria-labelledby': titleId } : { 'aria-label': 'Aviso' })}
        {...(current.body ? { 'aria-describedby': descId } : {})}
      >
        {current.imageUrl && <img className="aviso-img" src={current.imageUrl} alt={current.title || 'Aviso'} />}
        {(current.title || current.body) && (
          <div className="aviso-text">
            {current.title && <h2 id={titleId}>{current.title}</h2>}
            {current.body && <p id={descId}>{current.body}</p>}
          </div>
        )}
        <div className="aviso-actions">
          {current.linkUrl && (
            isExternalLink(current.linkUrl)
              ? <a className="btn primary" href={current.linkUrl} target="_blank" rel="noopener noreferrer" onClick={dismiss}>{label}</a>
              : <a className="btn primary" href={current.linkUrl} onClick={dismiss}>{label}</a>
          )}
          <button ref={closeRef} type="button" className="btn" onClick={dismiss}>Fechar</button>
        </div>
        {queue.length > 1 && <p className="aviso-count small muted">Mais {queue.length - 1} aviso{queue.length > 2 ? 's' : ''} em seguida</p>}
      </div>
    </div>
  );
}
