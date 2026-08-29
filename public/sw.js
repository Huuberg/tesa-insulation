/* офлайн-кэш оболочки */
const C = 'tesa-v7';
const SHELL = ['./', 'index.html', 'styles.css', 'app.js', 'i18n.js', 'model.js', 'hours.js', 'manifest.webmanifest', 'icon.svg', 'icon-192.png', 'icon-512.png', 'logos/bti.png', 'logos/upm.png', 'logos/valmet.png'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(C).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((k) => Promise.all(k.filter((x) => x !== C).map((x) => caches.delete(x)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (u.pathname.includes('/api/')) return;                 // API — только сеть
  if (e.request.method !== 'GET') return;
  // чертежи: сначала кэш — открываются мгновенно и работают без связи
  if (u.pathname.startsWith('/drawings/')) {
    e.respondWith(caches.match(e.request).then((r) => r || fetch(e.request).then((resp) => {
      const cp = resp.clone(); caches.open(C).then((c) => c.put(e.request, cp)); return resp;
    })));
    return;
  }
  // сеть в приоритете: свежая версия приложения приходит сразу, кэш — запасной вариант
  e.respondWith(fetch(e.request).then((resp) => {
    const cp = resp.clone(); caches.open(C).then((c) => c.put(e.request, cp)); return resp;
  }).catch(() => caches.match(e.request).then((r) => r || caches.match('index.html'))));
});
