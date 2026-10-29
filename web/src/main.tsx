import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { registerServiceWorker } from './pwa';
import { BrowserRouter } from 'react-router-dom';
import { rememberCouponFromUrl } from './billing';
import App from './App';
import { AuthProvider } from './auth';
import { ToastProvider } from './ui';
import './styles.css';

// Link de parceiro (?cupom=CODIGO): guarda o cupom para a tela de assinatura.
rememberCouponFromUrl();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <ToastProvider>
        <AuthProvider>
          <App />
        </AuthProvider>
      </ToastProvider>
    </BrowserRouter>
  </StrictMode>,
);

registerServiceWorker();
