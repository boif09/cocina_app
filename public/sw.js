// Service worker: permite instalar la app y abrirla aunque el servidor no responda.
// - Todo va primero a la red, así nunca se ve una versión vieja tras un despliegue.
// - Sin red: archivos de la app y últimas lecturas de la API desde la caché.
// - Escrituras (POST, PUT, PATCH, DELETE) y redirecciones (login de Authelia) nunca se guardan.
const CACHE = 'cocina-v1';
const SHELL = [
  './',
  'app.js',
  'styles.css',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png'
];

const scopeUrl = new URL(self.registration.scope);
const inScope = (url) => url.origin === scopeUrl.origin && url.pathname.startsWith(scopeUrl.pathname);
const relative = (url) => url.pathname.slice(scopeUrl.pathname.length);
// Nunca se guardan redirecciones (el login de Authelia) ni errores.
const cacheable = (response) => response && response.ok && response.type === 'basic' && !response.redirected;

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await Promise.all(SHELL.map(async (path) => {
      const response = await fetch(path, { credentials: 'same-origin' }).catch(() => null);
      if (cacheable(response)) await cache.put(path, response);
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) if (name !== CACHE) await caches.delete(name);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== 'GET' || !inScope(url)) return;

  const path = relative(url);

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const key = request.mode === 'navigate' ? './' : request;
    try {
      const response = await fetch(request);
      if (cacheable(response)) await cache.put(key, response.clone());
      return response;
    } catch (error) {
      const cached = await cache.match(key);
      if (cached) return cached;
      if (path.startsWith('api/')) {
        return Response.json({ error: 'Sin conexión con el servidor.' }, { status: 503 });
      }
      throw error;
    }
  })());
});
