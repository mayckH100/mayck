import { useEffect, useState } from 'react';

/** Evento do Chrome/Android/Edge que permite abrir o diálogo nativo de instalação. */
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

let deferred: BeforeInstallPromptEvent | null = null;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

// Captura o evento o quanto antes (ele pode disparar antes de qualquer componente montar).
if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e as BeforeInstallPromptEvent;
    notify();
  });
  window.addEventListener('appinstalled', () => { deferred = null; notify(); });
}

/** Registra o service worker (somente no build de produção). */
export function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || !import.meta.env.PROD) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch((e) => console.warn('Service worker não registrado:', e));
  });
}

export function isStandalone() {
  return window.matchMedia?.('(display-mode: standalone)').matches || (navigator as unknown as { standalone?: boolean }).standalone === true;
}

export function isIos() {
  const ua = navigator.userAgent;
  // iPadOS se apresenta como Mac com tela de toque.
  return /iphone|ipad|ipod/i.test(ua) || (/macintosh/i.test(ua) && navigator.maxTouchPoints > 1);
}

export function useInstallPrompt() {
  const [, force] = useState(0);
  useEffect(() => {
    const l = () => force((n) => n + 1);
    listeners.add(l);
    return () => { listeners.delete(l); };
  }, []);
  const standalone = typeof window !== 'undefined' && isStandalone();
  const ios = typeof window !== 'undefined' && isIos();
  return {
    /** Mostrar o botão: há prompt nativo disponível, ou é iPhone/iPad fora do app instalado. */
    available: !standalone && (!!deferred || ios),
    ios,
    install: async () => {
      if (!deferred) return 'unavailable' as const;
      const ev = deferred;
      deferred = null;
      await ev.prompt();
      const choice = await ev.userChoice.catch(() => ({ outcome: 'dismissed' as const }));
      notify();
      return choice.outcome;
    },
  };
}

/** Botão "Instalar app". No iPhone abre as instruções "Compartilhar > Adicionar à Tela de Início". */
export function InstallButton({ appName, className = 'btn sm', style }: { appName: string; className?: string; style?: React.CSSProperties }) {
  const { available, ios, install } = useInstallPrompt();
  const [help, setHelp] = useState(false);
  if (!available) return null;
  return (
    <>
      <button type="button" className={className} style={style} onClick={() => (ios ? setHelp(true) : install())}>
        <span aria-hidden>⬇</span> Instalar app
      </button>
      {help && (
        <div role="dialog" aria-modal="true" aria-label={`Instalar ${appName}`} onClick={() => setHelp(false)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.6)', display: 'grid', placeItems: 'end center', zIndex: 1000, padding: 16 }}>
          <div className="card stack" onClick={(e) => e.stopPropagation()} style={{ width: 'min(420px, 100%)', textAlign: 'left', color: 'var(--ink)' }}>
            <h2 style={{ margin: 0 }}>Instalar o {appName} no iPhone</h2>
            <ol style={{ margin: 0, paddingLeft: 20, lineHeight: 1.7 }}>
              <li>Abra esta página no <strong>Safari</strong>.</li>
              <li>Toque em <strong>Compartilhar</strong> <span aria-hidden>(□↑)</span> na barra do navegador.</li>
              <li>Escolha <strong>Adicionar à Tela de Início</strong> e toque em <strong>Adicionar</strong>.</li>
            </ol>
            <p className="small muted" style={{ margin: 0 }}>O ícone do {appName} aparece na sua tela inicial e abre em tela cheia, como um app.</p>
            <button type="button" className="btn primary" onClick={() => setHelp(false)}>Entendi</button>
          </div>
        </div>
      )}
    </>
  );
}
