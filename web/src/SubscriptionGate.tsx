import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from './auth';
import { GATE_APPS, decideGate, shouldInterceptClick, type GateApp } from './subscriptionGate';

/**
 * Pop-up central "renove sua assinatura" para quando o produto do app está VENCIDO ou BLOQUEADO
 * (ou quando alguma chamada da API respondeu 402). Depois de fechado, reabre no próximo clique em
 * qualquer lugar do app, exceto na página de pagamento, no perfil/senha, em "Sair" e dentro do pop-up.
 * Superadmin nunca vê. Regras em ./subscriptionGate.ts.
 */
export default function SubscriptionGate({ app }: { app: GateApp }) {
  const cfg = GATE_APPS[app];
  const { me, refresh } = useAuth();
  const loc = useLocation();
  const nav = useNavigate();
  const [paymentRequired, setPaymentRequired] = useState(false);
  const [open, setOpen] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const primaryRef = useRef<HTMLButtonElement>(null);
  const lastFocus = useRef<HTMLElement | null>(null);
  const lastRefresh = useRef(0);

  const d = decideGate({ app, subscriptions: me?.subscriptions, role: me?.role, isSuperAdmin: !!(me?.isSuperAdmin || me?.user?.isSuperAdmin), paymentRequired });
  const onExemptPage = shouldInterceptClick(cfg, { pathname: loc.pathname }) === false;

  // Atualiza o status sem martelar a API (no máximo a cada 20 s).
  const refreshStatus = (force = false) => {
    if (!force && Date.now() - lastRefresh.current < 20_000) return;
    lastRefresh.current = Date.now();
    refresh().catch(() => undefined);
  };

  // 402 em qualquer chamada: marca e abre o pop-up (e confere o status de novo).
  useEffect(() => {
    const h = () => { setPaymentRequired(true); setOpen(true); refreshStatus(true); };
    window.addEventListener('mck:payment-required', h);
    return () => window.removeEventListener('mck:payment-required', h);
  }, []);

  // Voltou de outra aba (ex.: Mercado Pago) ou retorno do pagamento na URL: atualiza o status.
  useEffect(() => {
    const vis = () => { if (document.visibilityState === 'visible') refreshStatus(); };
    document.addEventListener('visibilitychange', vis);
    window.addEventListener('focus', vis);
    return () => { document.removeEventListener('visibilitychange', vis); window.removeEventListener('focus', vis); };
  }, []);
  useEffect(() => {
    const q = new URLSearchParams(loc.search);
    if (q.has('billing') || q.has('payment_id') || q.has('collection_id')) refreshStatus(true);
  }, [loc.search]);

  // Assinatura voltou a ficar ativa: some o pop-up e esquece o 402 antigo.
  const sub = me?.subscriptions?.find((s) => s.product === cfg.product);
  useEffect(() => { if (sub?.active) { setPaymentRequired(false); setOpen(false); } }, [sub?.active, sub?.status]);

  // Abre ao carregar / ao sair de uma página liberada, quando bloqueado.
  useEffect(() => { if (d.blocked && !onExemptPage) setOpen(true); }, [d.blocked, loc.pathname]);
  useEffect(() => { if (!d.blocked || onExemptPage) setOpen(false); }, [d.blocked, onExemptPage]);

  // Clique em qualquer lugar (fase de captura): reabre o pop-up e bloqueia a ação.
  useEffect(() => {
    if (!d.blocked) return;
    const h = (e: MouseEvent) => {
      const t = e.target instanceof Element ? e.target : null;
      const clickable = t?.closest('a,button,[role="button"],[role="menuitem"]') as HTMLElement | null;
      const intercept = shouldInterceptClick(cfg, {
        pathname: loc.pathname,
        insideModal: !!(t && dialogRef.current?.contains(t)),
        exemptMarker: !!t?.closest('[data-sub-exempt]'),
        href: (t?.closest('a[href]') as HTMLAnchorElement | null)?.getAttribute('href') ?? null,
        label: clickable?.textContent ?? null,
      }, window.location.origin);
      if (!intercept) return;
      e.preventDefault();
      e.stopPropagation();
      if (!open) {
        lastFocus.current = document.activeElement as HTMLElement | null;
        setOpen(true);
      }
    };
    document.addEventListener('click', h, true);
    return () => document.removeEventListener('click', h, true);
  }, [d.blocked, open, loc.pathname]);

  // Foco no botão principal, Esc fecha, Tab fica dentro do pop-up.
  useEffect(() => {
    if (!open) return;
    if (!lastFocus.current) lastFocus.current = document.activeElement as HTMLElement | null;
    const first = primaryRef.current ?? dialogRef.current?.querySelector<HTMLElement>('button');
    first?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); close(); return; }
      if (e.key !== 'Tab' || !dialogRef.current) return;
      const items = Array.from(dialogRef.current.querySelectorAll<HTMLElement>('button,a[href]'));
      if (!items.length) return;
      const a = items[0], z = items[items.length - 1];
      if (e.shiftKey && document.activeElement === a) { e.preventDefault(); z.focus(); }
      else if (!e.shiftKey && document.activeElement === z) { e.preventDefault(); a.focus(); }
    };
    document.addEventListener('keydown', key, true);
    return () => document.removeEventListener('keydown', key, true);
  }, [open]);

  const close = () => {
    setOpen(false);
    const f = lastFocus.current;
    lastFocus.current = null;
    if (f && document.contains(f)) f.focus();
  };
  const renew = () => { setOpen(false); lastFocus.current = null; nav(d.billingPath); };

  if (!d.blocked || !open || onExemptPage) return null;
  return (
    <div className={`sub-gate-bg sub-gate-${app}`}>
      <div ref={dialogRef} className="sub-gate" role="dialog" aria-modal="true" aria-labelledby="sub-gate-title" aria-describedby="sub-gate-desc">
        <div className="sub-gate-icon" aria-hidden>{d.variant === 'blocked' ? '⛔' : '⏳'}</div>
        <h2 id="sub-gate-title">{d.title}</h2>
        <p id="sub-gate-desc">{d.message}</p>
        {d.askOwner && <p className="sub-gate-ask"><strong>Peça ao responsável da conta para renovar.</strong></p>}
        <div className="sub-gate-actions">
          {d.canPay && <button ref={primaryRef} type="button" className="btn primary" onClick={renew}>Renovar agora</button>}
          <button type="button" className="btn" onClick={close}>Fechar</button>
        </div>
      </div>
    </div>
  );
}
