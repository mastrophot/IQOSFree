const CACHE_NAME = 'iqosfree-v73';
const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './style.css',
  './manifest.json',
  './assets/icons/icon-192.png',
  './assets/icons/icon-512.png',
  './js/app.js',
  './js/utils.js',
  './js/charts.js',
  './js/firebase-config.js',
  './assets/tree_1.png',
  './assets/tree_2.png',
  './assets/tree_3.png',
  './assets/tree_4.png',
  'https://cdn.tailwindcss.com',
  'https://cdn.jsdelivr.net/npm/chart.js',
  'https://www.gstatic.com/firebasejs/11.6.1/firebase-app.js',
  'https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js',
  'https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('[Service Worker] Caching all assets');
      return cache.addAll(ASSETS_TO_CACHE);
    })
  );
  self.skipWaiting(); // Force active immediately
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  
  // Network-first for HTML and JS files to ensure fresh data & sync logic
  if ((url.pathname.endsWith('.html') || url.pathname === '/' || url.pathname.endsWith('.js')) 
      && url.origin === self.location.origin) {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          // Update cache with fresh response
          const responseClone = response.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseClone);
          });
          return response;
        })
        .catch(() => caches.match(event.request)) // Fallback to cache if offline
    );
    return;
  }
  
  // Cache-first for static assets (images, CSS, etc.)
  event.respondWith(
    caches.match(event.request).then((response) => {
      return response || fetch(event.request);
    })
  );
});


self.addEventListener('activate', (event) => {
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
  self.clients.claim(); // Take control of all clients immediately
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
