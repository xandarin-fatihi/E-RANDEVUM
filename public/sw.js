const CACHE = "e-randevum-shell-v3";
const SHELL = ["/", "/styles.css?v=20261008-3", "/app.js?v=20261008-3", "/favicon.svg?isletme=yakupberber"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))).then(() => self.clients.claim()));
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET" || new URL(request.url).pathname.startsWith("/api/")) return;
  event.respondWith(fetch(request).then((response) => {
    const clone = response.clone(); caches.open(CACHE).then((cache) => cache.put(request, clone)); return response;
  }).catch(() => caches.match(request).then((cached) => cached || caches.match("/"))));
});

self.addEventListener("push", (event) => {
  let payload = { title: "E-Randevum", body: "Yeni bir randevu bildiriminiz var." };
  try { payload = { ...payload, ...event.data.json() }; } catch {}
  event.waitUntil(self.registration.showNotification(payload.title, { body: payload.body, icon: "/favicon.svg?isletme=yakupberber", data: payload.url || "/" }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close(); event.waitUntil(clients.openWindow(event.notification.data || "/"));
});
