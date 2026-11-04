import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/** Commit e data do build: RENDER_GIT_COMMIT (Render) > git rev-parse > "dev". */
function buildInfo() {
  let commit = (process.env.RENDER_GIT_COMMIT || process.env.GIT_COMMIT || '').trim();
  if (!/^[0-9a-f]{7,40}$/i.test(commit)) {
    try { commit = execFileSync('git', ['rev-parse', 'HEAD'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { commit = ''; }
  }
  if (!/^[0-9a-f]{7,40}$/i.test(commit)) commit = 'dev';
  return { commit, buildDate: new Date().toISOString() };
}
const BUILD = buildInfo();

/** Grava dist/web/build-info.json, lido pelo servidor em GET /api/versao. */
function buildInfoFile(): Plugin {
  return {
    name: 'mck-build-info',
    apply: 'build',
    generateBundle() { this.emitFile({ type: 'asset', fileName: 'build-info.json', source: JSON.stringify(BUILD) }); },
  };
}

/** Em desenvolvimento, /mensagem e /mensagem/* abrem a entrada do MCK Mensagens (mensagem.html). */
function mensagemFallback(): Plugin {
  return {
    name: 'mck-mensagem-fallback',
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        const url = req.url ?? '';
        if ((url === '/mensagem' || url.startsWith('/mensagem/') || url.startsWith('/mensagem?')) && !/\.[a-z0-9]+(\?|$)/i.test(url.split('?')[0])) req.url = '/mensagem.html';
        next();
      });
    },
  };
}

export default defineConfig({
  root: path.resolve(__dirname),
  plugins: [react(), mensagemFallback(), buildInfoFile()],
  define: { __MCK_BUILD__: JSON.stringify(BUILD) },
  build: {
    outDir: path.resolve(__dirname, '../dist/web'), emptyOutDir: true, chunkSizeWarningLimit: 900,
    rollupOptions: { input: { main: path.resolve(__dirname, 'index.html'), mensagem: path.resolve(__dirname, 'mensagem.html') } },
  },
  server: { port: 5173, proxy: { '/api': 'http://localhost:3000' } },
});
