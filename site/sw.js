const SHELL = 'lottery-shell-v2';
const FILES = ['./', 'index.html', 'app.js', 'lottery-core.js', 'config.js', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('lottery-shell-') && k !== SHELL).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);

  // Android "Share to app": receive the image and hand it to the page
  if (req.method === 'POST' && url.pathname.endsWith('/share-target')) {
    e.respondWith((async () => {
      try {
        const form = await req.formData();
        const file = form.get('image');
        if (file) {
          const cache = await caches.open('lottery-shared');
          await cache.put('shared-image', new Response(file, { headers: { 'Content-Type': file.type || 'image/png' } }));
        }
      } catch (err) { /* fall through */ }
      return Response.redirect('./?shared=1', 303);
    })());
    return;
  }

  if (req.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.includes('/results/')) return;   // always fresh, never cached
  // network first so a new deployment shows up immediately; cache is the offline fallback
  e.respondWith(
    fetch(req)
      .then((res) => {
        const copy = res.clone();
        caches.open(SHELL).then((c) => c.put(req, copy));
        return res;
      })
      .catch(() => caches.match(req).then((r) => r || caches.match('index.html')))
  );
});
