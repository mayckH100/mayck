import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { registerServiceWorker } from '../pwa';
import { BrowserRouter } from 'react-router-dom';
import { rememberCouponFromUrl } from '../billing';
import MensagemApp from './App';
import { AuthProvider } from '../auth';
import { ToastProvider } from '../ui';
import { MM_BASE } from './common';
import '../styles.css';
import './mensagem.css';

document.documentElement.classList.add('mm');

// Link de parceiro (?cupom=CODIGO): guarda o cupom para a tela de assinatura.
rememberCouponFromUrl();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter basename={MM_BASE}>
      <ToastProvider>
        <AuthProvider>
          <MensagemApp />
        </AuthProvider>
      </ToastProvider>
    </BrowserRouter>
  </StrictMode>,
);

registerServiceWorker();
