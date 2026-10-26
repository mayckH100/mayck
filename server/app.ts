import express from 'express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { prisma } from './db.js';
import { errorHandler } from './lib/http.js';
import { loadSession, csrfProtection, requireOrg, requireRole } from './auth/session.js';
import { mckmensagemRouter } from './mckmensagem/routes.js';
import { authRouter } from './auth/routes.js';
import { webhookRouter } from './routes/webhook.js';
import { channelsRouter } from './routes/channels.js';
import { flowsRouter } from './routes/flows.js';
import { aiRouter } from './routes/ai.js';
import { contactsRouter } from './routes/contacts.js';
import { kanbanRouter } from './routes/kanban.js';
import { conversationsRouter } from './routes/conversations.js';
import { teamRouter } from './routes/team.js';
import { plansRouter } from './routes/plans.js';
import { integrationsRouter } from './routes/integrations.js';
import { dashboardRouter } from './routes/dashboard.js';
import { profileRouter, orgRouter, auditRouter } from './routes/misc.js';

export function createApp() {
  const app = express();
  app.set('trust proxy', 1); // Render/Proxies: IP real para rate limit
  app.disable('x-powered-by');
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"], imgSrc: ["'self'", 'data:', 'https:'], styleSrc: ["'self'", "'unsafe-inline'"],
        scriptSrc: ["'self'"], connectSrc: ["'self'"], frameAncestors: ["'none'"],
      },
    },
  }));

  // Webhook antes do JSON parser: precisa do corpo bruto para validar a assinatura.
  app.use('/api/webhooks', webhookRouter);

  // Health check leve (não toca no banco — permite o Postgres grátis do Neon escalar a zero).
  app.get('/api/health', (_req, res) => res.json({ ok: true }));
  // Verificação completa, incluindo o banco.
  app.get('/api/health/db', async (_req, res) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      res.json({ ok: true, db: 'ok' });
    } catch {
      res.status(503).json({ ok: false, db: 'erro' });
    }
  });

  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());
  app.use('/api', rateLimit({ windowMs: 60 * 1000, limit: () => config.API_RATE_LIMIT, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'Muitas requisições. Aguarde um instante.' } }));
  app.use('/api', loadSession, csrfProtection);

  app.use('/api/auth', authRouter);
  app.use('/api/profile', profileRouter);
  app.use('/api/org', requireOrg, orgRouter);
  app.use('/api/channels', requireOrg, channelsRouter);
  app.use('/api/flows', requireOrg, flowsRouter);
  app.use('/api/ai', requireOrg, aiRouter);
  app.use('/api/contacts', requireOrg, contactsRouter);
  app.use('/api/kanban', requireOrg, kanbanRouter);
  app.use('/api/conversations', requireOrg, conversationsRouter);
  app.use('/api/team', requireOrg, teamRouter);
  app.use('/api/plans', requireOrg, plansRouter);
  app.use('/api/integrations', requireOrg, integrationsRouter);
  app.use('/api/audit', requireOrg, auditRouter);
  app.use('/api/mckmensagem', requireOrg, requireRole('OWNER', 'ADMIN'), mckmensagemRouter);
  app.use('/api', requireOrg, dashboardRouter);
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Rota não encontrada' }));

  // Frontend compilado (produção).
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [path.resolve(here, '../web'), path.resolve(here, '../../dist/web'), path.resolve(process.cwd(), 'dist/web')];
  const webDir = candidates.find((p) => existsSync(path.join(p, 'index.html')));
  if (webDir) {
    app.use(express.static(webDir, { index: false, maxAge: '1h' }));
    app.get('*', (_req, res) => res.sendFile(path.join(webDir, 'index.html')));
  }

  app.use(errorHandler);
  return app;
}
