import { createApp } from './app.js';
import { config } from './config.js';
import { prisma } from './db.js';
import { scheduledTick } from './flows/engine.js';
import { qrManager } from './whatsapp/qr/manager.js';
import { tick as mckmensagemTick } from './mckmensagem/dispatcher.js';
import { tickLeadRetries } from './mckmensagem/qualificacao.js';
import { tickAutomacoes } from './mckmensagem/automacoes/engine.js';
import { handleQrMessage, handleQrStatus } from './whatsapp/inbound.js';
import { syncSuperAdmins } from './auth/superadmin.js';

const app = createApp();
const server = app.listen(config.PORT, () => {
  console.log(`MCKBOT ouvindo na porta ${config.PORT} (${config.NODE_ENV})`);
});

// SUPERADMIN_EMAILS: promove os e-mails listados a superadmin (nunca remove).
syncSuperAdmins()
  .then((n) => { if (n) console.log(`[superadmin] ${n} usuário(s) promovido(s) via SUPERADMIN_EMAILS`); })
  .catch((e) => console.error('[superadmin] falha ao aplicar SUPERADMIN_EMAILS', e));

// Agendador: retoma blocos "Aguardar" vencidos (só consulta o banco quando há espera pendente) e limpa sessões expiradas.
if (config.ENABLE_SCHEDULER === 'true') {
  setInterval(() => {
    scheduledTick().catch((e) => console.error('[agendador]', e));
  }, 5000).unref();
  setInterval(() => {
    prisma.session.deleteMany({ where: { expiresAt: { lt: new Date() } } }).catch(() => undefined);
  }, 3600e3).unref();
}

// MCKMENSAGEM: disparador de campanhas para leads com consentimento (um passo por minuto).
if (config.ENABLE_MCKMENSAGEM_CRON === 'true' && config.NODE_ENV !== 'test') {
  let running = false;
  setInterval(() => {
    if (running) return;
    running = true;
    mckmensagemTick().catch((e) => console.error('[mckmensagem]', e))
      .then(() => tickLeadRetries()).catch((e) => console.error('[mckmensagem-ia]', e))
      .finally(() => { running = false; });
  }, 60_000).unref();
}

// Automações e Cobranças: motor no processo (claim atômico no banco; retoma após restart). Ciclo curto de 15 s.
if (config.ENABLE_MCKMENSAGEM_CRON === 'true' && config.NODE_ENV !== 'test') {
  let rodando = false;
  const ciclo = () => {
    if (rodando) return;
    rodando = true;
    tickAutomacoes().catch((e) => console.error('[automacoes]', e)).finally(() => { rodando = false; });
  };
  setTimeout(ciclo, 10_000).unref();
  setInterval(ciclo, 15_000).unref();
}

// WhatsApp por QR code (Baileys): reconecta os canais com sessão salva no banco.
qrManager.setHandlers({
  inbound: async (channelId, msg) => { await handleQrMessage(channelId, msg); },
  status: async (channelId, update) => { await handleQrStatus(channelId, update); },
});
if (config.ENABLE_WHATSAPP_QR === 'true') {
  qrManager.restoreAll()
    .then((n) => { if (n) console.log(`[whatsapp-qr] restaurando ${n} sessão(ões) salva(s)`); })
    .catch((e) => console.error('[whatsapp-qr] falha ao restaurar sessões', e));
}

const shutdown = () => {
  qrManager.shutdown().catch(() => undefined);
  server.close(() => prisma.$disconnect().finally(() => process.exit(0)));
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
