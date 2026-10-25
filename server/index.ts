import { createApp } from './app.js';
import { config } from './config.js';
import { prisma } from './db.js';
import { scheduledTick } from './flows/engine.js';

const app = createApp();
const server = app.listen(config.PORT, () => {
  console.log(`MCKBOT ouvindo na porta ${config.PORT} (${config.NODE_ENV})`);
});

// Agendador: retoma blocos "Aguardar" vencidos (só consulta o banco quando há espera pendente) e limpa sessões expiradas.
if (config.ENABLE_SCHEDULER === 'true') {
  setInterval(() => {
    scheduledTick().catch((e) => console.error('[agendador]', e));
  }, 5000).unref();
  setInterval(() => {
    prisma.session.deleteMany({ where: { expiresAt: { lt: new Date() } } }).catch(() => undefined);
  }, 3600e3).unref();
}

const shutdown = () => {
  server.close(() => prisma.$disconnect().finally(() => process.exit(0)));
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
