// MemeGuard – service worker: zapisuje pliki aplikacji (szybszy start) i obsługuje kliknięcie powiadomienia.
const CACHE = "memeguard-v1";
const FILES = ["./", "./index.html", "./app.js", "./scoring.js", "./manifest.webmanifest", "./icon-180.png", "./icon-192.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return; // API zawsze na żywo
  // najpierw sieć (żeby nowa wersja wchodziła od razu), cache jako zapas offline
  e.respondWith(fetch(e.request).then((r) => {
    const copy = r.clone();
    caches.open(CACHE).then((c) => c.put(e.request, copy));
    return r;
  }).catch(() => caches.match(e.request)));
});
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = e.notification.data?.url;
  if (url) e.waitUntil(self.clients.openWindow(url));
});
