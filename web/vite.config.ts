import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

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
  plugins: [react(), mensagemFallback()],
  build: {
    outDir: path.resolve(__dirname, '../dist/web'), emptyOutDir: true, chunkSizeWarningLimit: 900,
    rollupOptions: { input: { main: path.resolve(__dirname, 'index.html'), mensagem: path.resolve(__dirname, 'mensagem.html') } },
  },
  server: { port: 5173, proxy: { '/api': 'http://localhost:3000' } },
});
