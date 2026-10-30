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
import { loadSession, csrfProtection, requireOrg, requireRole, requireSuperAdmin } from './auth/session.js';
import { masterRouter } from './routes/master.js';
import { mckmensagemRouter } from './mckmensagem/routes.js';
import { automacoesRouter } from './mckmensagem/automacoes/routes.js';
import { billingRouter, billingWebhookRouter } from './billing/routes.js';
import { requireMckbotForWrites } from './billing/guard.js';
import { authRouter } from './auth/routes.js';
import { tutorialsRouter } from './tutorials/routes.js';
import { webhookRouter } from './routes/webhook.js';
import { channelsRouter } from './routes/channels.js';
import { flowsRouter } from './routes/flows.js';
import { aiRouter } from './routes/ai.js';
import { contactsRouter } from './routes/contacts.js';
import { kanbanRouter } from './routes/kanban.js';
import { conversationsRouter } from './routes/conversations.js';
import { teamRouter } from './routes/team.js';
import { plansRouter, publicPlansRouter } from './routes/plans.js';
import { publicSiteRouter } from './routes/site.js';
import { integrationsRouter } from './routes/integrations.js';
import { dashboardRouter } from './routes/dashboard.js';
import { profileRouter, orgRouter, auditRouter } from './routes/misc.js';
import { agendaRouter, publicAgendaRouter, googleCallbackRouter } from './agenda/routes.js';

export function createApp() {
  const app = express();
  app.set('trust proxy', 1); // Render/Proxies: IP real para rate limit
  app.disable('x-powered-by');
  app.use(helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        defaultSrc: ["'self'"], imgSrc: ["'self'", 'data:', 'blob:', 'https:'], mediaSrc: ["'self'", 'blob:', 'data:'], styleSrc: ["'self'", "'unsafe-inline'"],
        scriptSrc: ["'self'"], connectSrc: ["'self'"], frameAncestors: ["'none'"], objectSrc: ["'none'"], baseUri: ["'self'"],
        formAction: ["'self'"], workerSrc: ["'self'"], manifestSrc: ["'self'"],
      },
    },
    // HTTPS obrigatório por 1 ano no navegador (Render serve tudo em HTTPS).
    strictTransportSecurity: { maxAge: 31536000, includeSubDomains: true },
    frameguard: { action: 'deny' }, // X-Frame-Options: DENY (anti-clickjacking)
    noSniff: true,
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  }));
  app.use((_req, res, next) => {
    // Recursos sensíveis do aparelho desligados para qualquer página/iframe.
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()');
    next();
  });

  // Webhook antes do JSON parser: precisa do corpo bruto para validar a assinatura.
  app.use('/api/webhooks', webhookRouter);
  // Webhook do Mercado Pago: público (sem sessão/CSRF), validado por assinatura + consulta à API.
  app.use('/api/billing/mp/webhook', rateLimit({ windowMs: 60 * 1000, limit: 120, standardHeaders: 'draft-7', legacyHeaders: false }), billingWebhookRouter);

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
  app.use('/api/public/plans', publicPlansRouter); // vitrine de planos, sem login
  app.use('/api/public/site', publicSiteRouter); // site oficial /empresa: contato, Facebook, promoção, tutoriais (sem login, só leitura)
  app.use('/api/public/agenda', publicAgendaRouter); // evento (.ics/página "Adicionar à agenda") e feed webcal por URL secreta
  app.use('/api/agenda/google/callback', googleCallbackRouter); // retorno do OAuth do Google (sessão + state assinado)
  app.use('/api/profile', profileRouter);
  app.use('/api/master', requireSuperAdmin, masterRouter);
  app.use('/api/org', requireOrg, orgRouter);
  app.use('/api/channels', requireOrg, channelsRouter);
  app.use('/api/flows', requireOrg, requireMckbotForWrites, flowsRouter);
  app.use('/api/ai', requireOrg, requireMckbotForWrites, aiRouter);
  app.use('/api/contacts', requireOrg, requireMckbotForWrites, contactsRouter);
  app.use('/api/kanban', requireOrg, requireMckbotForWrites, kanbanRouter);
  app.use('/api/conversations', requireOrg, conversationsRouter);
  app.use('/api/team', requireOrg, teamRouter);
  app.use('/api/plans', requireOrg, plansRouter);
  app.use('/api/billing', requireOrg, billingRouter);
  app.use('/api/agenda', requireOrg, requireMckbotForWrites, agendaRouter);
  app.use('/api/integrations', requireOrg, requireMckbotForWrites, integrationsRouter);
  app.use('/api/audit', requireOrg, auditRouter);
  app.use('/api/tutorials', requireOrg, tutorialsRouter); // vídeos só para assinantes pagos (rota autenticada, com Range)
  // Automações e Cobranças (MCK Mensagens): OWNER/ADMIN alteram; AGENT só lê (checado dentro do router).
  app.use('/api/mckmensagem/automacoes', requireOrg, automacoesRouter);
  app.use('/api/mckmensagem', requireOrg, requireRole('OWNER', 'ADMIN'), mckmensagemRouter);
  app.use('/api', requireOrg, dashboardRouter);
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Rota não encontrada' }));

  // Frontend compilado (produção).
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [path.resolve(here, '../web'), path.resolve(here, '../../dist/web'), path.resolve(process.cwd(), 'dist/web')];
  const webDir = candidates.find((p) => existsSync(path.join(p, 'index.html')));
  // Digital Asset Links para um futuro app TWA na Play Store (defina TWA_ASSETLINKS com o JSON gerado pelo Bubblewrap).
  app.get('/.well-known/assetlinks.json', (_req, res) => {
    const raw = process.env.TWA_ASSETLINKS;
    if (!raw) return void res.status(404).json([]);
    try { res.type('application/json').send(JSON.stringify(JSON.parse(raw))); } catch { res.status(500).json([]); }
  });
  if (webDir) {
    app.use(express.static(webDir, {
      index: false, maxAge: '1h',
      setHeaders: (res, file) => {
        // Service worker e manifests sempre revalidados, para atualizações do PWA chegarem logo.
        if (/(sw\.js|\.webmanifest)$/.test(file)) res.setHeader('Cache-Control', 'no-cache');
        if (file.endsWith('.webmanifest')) res.setHeader('Content-Type', 'application/manifest+json');
        if (file.endsWith('sw.js')) res.setHeader('Service-Worker-Allowed', '/');
      },
    }));
    // MCK Mensagens: app separado (entrada própria) servido em /mensagem e /mensagem/*.
    const mensagemHtml = path.join(webDir, 'mensagem.html');
    if (existsSync(mensagemHtml)) app.get(['/mensagem', '/mensagem/*'], (_req, res) => res.sendFile(mensagemHtml));
    // Site institucional MCK DESENVOLVIMENTO (páginas estáticas em web/public/empresa).
    const empresaHtml = path.join(webDir, 'empresa', 'index.html');
    if (existsSync(empresaHtml)) app.get(['/empresa', '/empresa/'], (_req, res) => res.sendFile(empresaHtml));
    app.get('*', (_req, res) => res.sendFile(path.join(webDir, 'index.html')));
  }

  app.use(errorHandler);
  return app;
}
