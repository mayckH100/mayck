import { Router } from 'express';
import { config, isTest } from '../config.js';
import { setDnsResolver } from './emailCheck.js';

/**
 * Ganchos SOMENTE para os testes de tela (Playwright): E2E_TEST_HOOKS=1 fora de produção.
 * - e-mails ficam na caixa de saída em memória (nada sai pela Brevo/SMTP);
 * - DNS do cadastro simulado (domínios de teste "recebem" e-mail, sem consultar a rede);
 * - GET /api/__e2e__/signup-code?email=… devolve o último código de cadastro enviado para o e-mail.
 * Em produção (NODE_ENV=production) fica sempre desligado, mesmo com a variável ligada.
 */
export const hooksAllowed = (nodeEnv: string | undefined, flag: string | undefined) => flag === '1' && nodeEnv !== 'production' && nodeEnv !== 'test';
export const e2eHooksEnabled = () => hooksAllowed(config.NODE_ENV, process.env.E2E_TEST_HOOKS) && process.env.NODE_ENV !== 'production';

/** Envio de e-mail substituído pela caixa de saída em memória (testes automatizados ou ganchos de tela). */
export const mailStubbed = () => isTest || e2eHooksEnabled();

export function e2eRouter(outbox: { to: string; subject: string; kind: string }[]) {
  setDnsResolver({ mx: async (d) => [{ exchange: `mx.${d}`, priority: 10 }], a: async () => ['93.184.216.34'], aaaa: async () => [] });
  const r = Router();
  r.get('/signup-code', (req, res) => {
    const email = String(req.query.email ?? '').trim().toLowerCase();
    for (let i = outbox.length - 1; i >= 0; i--) {
      const m = outbox[i];
      if (m.to === email && m.kind === 'signup_code') {
        const code = /(\d{6})/.exec(m.subject)?.[1];
        if (code) return void res.json({ code });
      }
    }
    res.status(404).json({ error: 'nenhum código para este e-mail' });
  });
  return r;
}
