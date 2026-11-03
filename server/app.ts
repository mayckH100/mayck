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
import { loadSession, csrfProtection, requireOrg, requireRole, requireSuperAdmin, requireCadastroCompleto } from './auth/session.js';
import { masterRouter } from './routes/master.js';
import { announcementsRouter } from './routes/announcements.js';
import { mckmensagemRouter } from './mckmensagem/routes.js';
import { automacoesRouter } from './mckmensagem/automacoes/routes.js';
import { billingRouter, billingWebhookRouter } from './billing/routes.js';
import { requireMckbotForWrites } from './billing/guard.js';
import { authRouter } from './auth/routes.js';
import { requireModule } from './lib/permissions.js';
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
import { e2eHooksEnabled, e2eRouter } from './lib/testHooks.js';
import { outbox } from './lib/mailer.js';
import { socialRouter, socialCallbackRouter, publicNovidadesRouter } from './social/routes.js';
import { CADASTRO_META, loadHtml, rootWantsApp, withPageMeta } from './lib/siteHtml.js';

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

  // Monitor de uptime (UptimeRobot/BetterStack etc.): sem login, sem dados; confere o banco com limite de 2 s.
  // 200 = app e banco ok; 503 = banco fora ou lento. Aceita GET e HEAD.
  app.get('/healthz', async (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        prisma.$queryRaw`SELECT 1`,
        new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('timeout')), 2000); }),
      ]);
      res.status(200).json({ ok: true });
    } catch {
      res.status(503).json({ ok: false });
    } finally {
      clearTimeout(timer);
    }
  });

  // Ganchos dos testes de tela (Playwright): só com E2E_TEST_HOOKS=1 e nunca em produção.
  if (e2eHooksEnabled()) {
    console.warn('[e2e] ganchos de teste LIGADOS (E2E_TEST_HOOKS=1): e-mails ficam em memória. Nunca use em produção.');
    app.use('/api/__e2e__', e2eRouter(outbox));
  }

  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());
  app.use('/api', rateLimit({ windowMs: 60 * 1000, limit: () => config.API_RATE_LIMIT, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'Muitas requisições. Aguarde um instante.' } }));
  app.use('/api', loadSession, csrfProtection);

  app.use('/api/auth', authRouter);
  app.use('/api/public/plans', publicPlansRouter); // vitrine de planos, sem login
  app.use('/api/public/site', publicSiteRouter); // site oficial /empresa: contato, Facebook, promoção, tutoriais (sem login, só leitura)
  app.use('/api/public/agenda', publicAgendaRouter); // evento (.ics/página "Adicionar à agenda") e feed webcal por URL secreta
  app.use('/api/agenda/google/callback', googleCallbackRouter); // retorno do OAuth do Google (sessão + state assinado)
  app.use('/api/novidades', publicNovidadesRouter); // Novidades publicadas (site /empresa/novidades), sem login, só leitura
  app.use('/api/social', socialCallbackRouter); // retorno do OAuth das redes sociais (state assinado + cookie + sessão do Master)
  // Daqui em diante: titular sem CPF/CNPJ ou celular só usa /api/auth (tela única de completar cadastro).
  app.use('/api', requireCadastroCompleto);
  app.use('/api/profile', profileRouter);
  app.use('/api/master', requireSuperAdmin, masterRouter);
  app.use('/api/announcements', announcementsRouter); // avisos do Master para os clientes (pop-up com imagem)
  app.use('/api/social', requireSuperAdmin, socialRouter); // Novidades: redes sociais do Painel Master
  app.use('/api/org', requireOrg, orgRouter);
  app.use('/api/channels', requireOrg, requireModule('canais', [{ method: 'GET', path: /^\/$/ }]), channelsRouter); // lista de canais: usada pelo Inbox e pelo aviso do topo (filtrada pelos canais do membro)
  app.use('/api/flows', requireOrg, requireModule('fluxos', [{ method: 'GET', path: /^\/$/, anyOf: ['inbox'] }, { method: 'POST', path: /^\/[^/]+\/start$/, anyOf: ['inbox'] }]), requireMckbotForWrites, flowsRouter);
  app.use('/api/ai', requireOrg, requireModule('ia'), requireMckbotForWrites, aiRouter);
  app.use('/api/contacts', requireOrg, requireModule('contatos', [{ method: 'GET', path: /^\/$/, anyOf: ['agenda'] }, { method: 'PATCH', path: /^\/[^/]+$/, anyOf: ['inbox'] }, ...['GET', 'POST', 'PATCH', 'DELETE'].map((method) => ({ method, path: /^\/[^/]+\/ai-notes(\/[^/]+)?$/, anyOf: ['inbox' as const] }))]), requireMckbotForWrites, contactsRouter);
  app.use('/api/kanban', requireOrg, requireModule('kanban', [{ method: 'GET', path: /^\/$/, anyOf: ['inbox'] }]), requireMckbotForWrites, kanbanRouter);
  app.use('/api/conversations', requireOrg, requireModule('inbox'), conversationsRouter);
  app.use('/api/team', requireOrg, requireModule('equipe', [{ method: 'GET', path: /^\/$/, anyOf: ['agenda', 'inbox'] }]), teamRouter);
  app.use('/api/plans', requireOrg, requireModule('plano'), plansRouter);
  app.use('/api/billing', requireOrg, requireModule('plano', [{ method: 'GET', path: /^\/status$/ }]), billingRouter);
  app.use('/api/agenda', requireOrg, requireModule('agenda'), requireMckbotForWrites, agendaRouter);
  app.use('/api/integrations', requireOrg, requireModule('integracoes'), requireMckbotForWrites, integrationsRouter);
  app.use('/api/audit', requireOrg, requireModule('auditoria'), auditRouter);
  app.use('/api/tutorials', requireOrg, tutorialsRouter); // vídeos só para assinantes pagos (rota autenticada, com Range)
  // Automações e Cobranças (MCK Mensagens): OWNER/ADMIN alteram; AGENT só lê (checado dentro do router).
  app.use('/api/mckmensagem/automacoes', requireOrg, requireModule('automacoes'), automacoesRouter);
  app.use('/api/mckmensagem', requireOrg, requireRole('OWNER', 'ADMIN'), requireModule('mensagens'), mckmensagemRouter);
  app.use('/api/reports', requireOrg, requireModule('relatorios'));
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
    // SEO: telas do app (login, cadastro, painel) não entram no Google, mas os links delas são seguidos.
    const appNoindex = (res: express.Response) => res.setHeader('X-Robots-Tag', 'noindex, follow');
    // HTML lido uma vez, com a verificação do Search Console (fixa no arquivo + GOOGLE_SITE_VERIFICATION opcional).
    const spaHtml = loadHtml(path.join(webDir, 'index.html'));
    // Produção: dist/web/empresa; testes/dev sem build: web/public/empresa.
    const empresaFile = [path.join(webDir, 'empresa', 'index.html'), path.join(webDir, 'public', 'empresa', 'index.html')].find((f) => existsSync(f)) ?? '';
    const landingHtml = empresaFile ? loadHtml(empresaFile) : null;
    // X-MCK-Shell: o service worker só guarda como "casca" offline a resposta que é o app (nunca a landing).
    const sendSpa = (res: express.Response, noindex = true) => {
      if (noindex) appNoindex(res);
      res.setHeader('X-MCK-Shell', 'app');
      res.setHeader('Cache-Control', 'no-cache');
      res.type('html').send(spaHtml);
    };
    const sendLanding = (res: express.Response) => {
      res.setHeader('Cache-Control', 'no-cache');
      res.type('html').send(landingHtml);
    };
    // Raiz "/": visitante e buscador recebem o site da MCK DESENVOLVIMENTO (conteúdo real, indexável);
    // logado (cookie de sessão) ou PWA (/?source=pwa) recebe o app, como antes. Login continua em /login (e /entrar).
    app.get('/', (req, res) => {
      res.setHeader('Vary', 'Cookie');
      if (!landingHtml || rootWantsApp(req.cookies, req.query as Record<string, unknown>)) return sendSpa(res, false);
      sendLanding(res);
    });
    if (landingHtml) app.get(['/empresa', '/empresa/', '/empresa/index.html'], (_req, res) => sendLanding(res));
    app.get('/index.html', (_req, res) => res.redirect(301, '/'));
    // /cadastro: mesmo app, com o cartão de prévia próprio (og:url/título/descrição) para quem compartilha o link.
    const cadastroHtml = withPageMeta(spaHtml, CADASTRO_META);
    app.get(['/cadastro', '/cadastro/'], (_req, res) => {
      appNoindex(res);
      res.setHeader('X-MCK-Shell', 'app');
      res.setHeader('Cache-Control', 'no-cache');
      res.type('html').send(cadastroHtml);
    });
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
    if (existsSync(mensagemHtml)) app.get(['/mensagem', '/mensagem/*'], (_req, res) => { appNoindex(res); res.sendFile(mensagemHtml); });
    // Site institucional MCK DESENVOLVIMENTO (páginas estáticas em web/public/empresa; a home dele é a raiz "/").
    const novidadesHtml = path.join(webDir, 'empresa', 'novidades.html');
    if (existsSync(novidadesHtml)) app.get(['/empresa/novidades', '/empresa/novidades/'], (_req, res) => res.sendFile(novidadesHtml));
    app.get('*', (_req, res) => sendSpa(res));
  }

  app.use(errorHandler);
  return app;
}
