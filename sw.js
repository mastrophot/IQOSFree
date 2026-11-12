const CACHE_NAME = "iqosfree-v4.0.6";
const ASSETS_TO_CACHE = [
  "./",
  "./index.html",
  "./style.css?v=10",
  "./manifest.json",
  "./js/app.js?v=8",
  "./js/utils.js",
  "./js/charts.js?v=8",
  "./assets/bg-forest.webp",
  "./assets/icons/icon-192.png",
  "./assets/icons/icon-512.png",
  "./assets/tree_1.webp",
  "./assets/tree_2.webp",
  "./assets/tree_3.webp",
  "./assets/tree_4.webp",
  "./assets/tree_5.webp",
];

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS_TO_CACHE))
  );
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((cacheNames) =>
        Promise.all(
          cacheNames.map((name) => (name !== CACHE_NAME ? caches.delete(name) : Promise.resolve()))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;

  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  const isDocumentOrScript =
    event.request.mode === "navigate" ||
    url.pathname.endsWith(".html") ||
    url.pathname.endsWith(".js") ||
    url.pathname.endsWith(".css") ||
    url.pathname.endsWith("/");

  if (isDocumentOrScript) {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          if (response && response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
          }
          return response;
        })
        .catch(async () => {
          const exact = await caches.match(event.request);
          if (exact) return exact;
          const ignoreQuery = await caches.match(event.request, { ignoreSearch: true });
          if (ignoreQuery) return ignoreQuery;
          return caches.match("./index.html");
        })
    );
    return;
  }

  event.respondWith(
    caches.match(event.request, { ignoreSearch: true }).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((response) => {
        if (response && response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        }
        return response;
      });
    })
  );
});

self.addEventListener("widgetclick", (event) => {
  if (event.action === "sos") {
    event.waitUntil(self.clients.openWindow("./?action=sos"));
  } else if (event.action === "smoke") {
    event.waitUntil(self.clients.openWindow("./?action=smoke"));
  } else if (event.action === "emergency") {
    event.waitUntil(self.clients.openWindow("./?action=emergency"));
  } else {
    event.waitUntil(self.clients.openWindow("./"));
  }
});
