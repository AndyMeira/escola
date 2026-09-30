const CACHE_NAME = 'escola-intercessao-v3';
const APP_SHELL = [
  '/escola/',
  '/escola/index.html',
  '/escola/manifest.json',
  '/escola/icon-192.png',
  '/escola/icon-512.png'
];

// Ao instalar, guarda uma cópia das páginas/ícones do próprio site (não do chat/quiz)
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

// Ao ativar, apaga versões antigas de cache (evita acumular lixo E evita ficar preso numa versão velha)
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)))
    )
  );
  self.clients.claim();
});

// Só usa o cache para arquivos do próprio site.
// Pedidos para Supabase, Vercel e Gemini sempre vão direto pra internet (nunca cacheados),
// pra garantir que o chat e o login sempre usem dados atuais.
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  const ehPagina = event.request.mode === 'navigate' || url.pathname.endsWith('.html');

  if (ehPagina) {
    // Rede primeiro: sempre tenta buscar a versão mais nova do site.
    // Só usa a cópia salva se estiver realmente sem internet.
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          const copia = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copia));
          return response;
        })
        .catch(() => caches.match(event.request))
    );
  } else {
    // Ícones e manifest: cache primeiro (mudam raramente, carrega mais rápido)
    event.respondWith(
      caches.match(event.request).then((cached) => cached || fetch(event.request))
    );
  }
});
