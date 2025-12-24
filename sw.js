const CACHE_NAME = 'iqosfree-v24';
const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './style.css',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './js/app.js',
  './js/utils.js',
  './js/charts.js',
  './js/firebase-config.js',
  './assets/tree_1.png',
  './assets/tree_2.png',
  './assets/tree_3.png',
  './assets/tree_4.png',
  'https://cdn.tailwindcss.com',
  'https://cdn.jsdelivr.net/npm/chart.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('[Service Worker] Caching all assets');
      return cache.addAll(ASSETS_TO_CACHE);
    })
  );
});

self.addEventListener('fetch', (event) => {
  // Simple cache-first strategy
  event.respondWith(
    caches.match(event.request).then((response) => {
      // Return cached response if found
      if (response) {
        return response;
      }
      // Otherwise fetch from network
      return fetch(event.request);
    })
  );
});

self.addEventListener('activate', (event) => {
  // Clean up old caches
  event.waitUntil(
      caches.keys().then((cacheNames) => {
          return Promise.all(
              cacheNames.map((cacheName) => {
                  if (cacheName !== CACHE_NAME) {
                      return caches.delete(cacheName);
                  }
              })
          );
      })
  );
});

// PWA Widgets event listener (Experimental Android/Windows support) logic.
self.addEventListener('widgetclick', event => {
  if (event.action === 'smoke') {
    event.waitUntil(clients.openWindow('./index.html?action=smoke'));
  } else if (event.action === 'emergency') {
    event.waitUntil(clients.openWindow('./index.html?action=emergency'));
  } else {
    event.waitUntil(clients.openWindow('./index.html'));
  }
});
