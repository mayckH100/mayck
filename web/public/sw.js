/* Service worker do MCKBOT e do MCK Mensagens.
 * - Assets estáticos (JS/CSS com hash, ícones, logos): cache primeiro.
 * - Navegação (páginas): rede primeiro; sem conexão, abre a última versão salva do app.
 * - /api e qualquer requisição que não seja GET: nunca passam pelo cache.
 */
const VERSION = 'mck-v1';
const STATIC = `${VERSION}-static`;
const PAGES = `${VERSION}-pages`;
const PRECACHE = ['/logo-192.png', '/logo-512.png', '/mensagem-logo-192.png', '/mensagem-logo-512.png', '/logo.svg', '/mensagem-logo.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(STATIC).then((c) => c.addAll(PRECACHE)).catch(() => undefined));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname === '/api' || url.pathname.startsWith('/.well-known/')) return;
  if (url.pathname === '/empresa' || url.pathname.startsWith('/empresa/')) return; // site institucional: sem cache do app

  if (req.mode === 'navigate') {
    const shell = url.pathname === '/mensagem' || url.pathname.startsWith('/mensagem/') ? '/mensagem/' : '/';
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) { const copy = res.clone(); caches.open(PAGES).then((c) => c.put(shell, copy)); }
          return res;
        })
        .catch(() => caches.match(shell, { cacheName: PAGES }).then((r) => r || new Response('<h1>Sem conexão</h1><p>Conecte-se à internet para usar o app.</p>', { status: 503, headers: { 'content-type': 'text/html; charset=utf-8' } }))),
    );
    return;
  }

  if (url.pathname.startsWith('/assets/') || /\.(png|svg|ico|webp|woff2?)$/.test(url.pathname)) {
    event.respondWith(
      caches.open(STATIC).then((cache) => cache.match(req).then((hit) => hit || fetch(req).then((res) => {
        if (res.ok) cache.put(req, res.clone());
        return res;
      }))),
    );
  }
});
