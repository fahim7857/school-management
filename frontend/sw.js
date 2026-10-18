// Service Worker for Coaching Center Management System
const CACHE_NAME = 'coaching-center-cache-v2';
const BASE = '/abms/frontend';

const STATIC_ASSETS = [
  BASE + '/',
  BASE + '/login.html',
  BASE + '/dashboard.html',
  BASE + '/students.html',
  BASE + '/student-details.html',
  BASE + '/payments.html',
  BASE + '/monthly-overview.html',
  BASE + '/expenses.html',
  BASE + '/reports.html',
  BASE + '/settings.html',
  BASE + '/admin.html',
  BASE + '/css/fonts.css',
  BASE + '/css/global.css',
  BASE + '/dashboard.css',
  BASE + '/students.css',
  BASE + '/student-details.css',
  BASE + '/payments.css',
  BASE + '/monthly-overview.css',
  BASE + '/expenses.css',
  BASE + '/reports.css',
  BASE + '/settings.css',
  BASE + '/js/api.js',
  BASE + '/js/auth.js',
  BASE + '/dashboard.js',
  BASE + '/students.js',
  BASE + '/student-details.js',
  BASE + '/payments.js',
  BASE + '/monthly-overview.js',
  BASE + '/expenses.js',
  BASE + '/reports.js',
  BASE + '/settings.js',
  BASE + '/manifest.json',
  BASE + '/css/fonts/app-icon.svg',
  BASE + '/css/fonts/material-symbols-outlined.woff2'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('[SW] Pre-caching offline shell and core assets');
      return cache.addAll(STATIC_ASSETS).catch((err) => {
        console.warn('[SW] Some non-critical assets could not be pre-cached:', err);
      });
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            console.log('[SW] Removing old cache:', key);
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);

  // Only handle same-origin requests
  if (url.origin !== self.location.origin) {
    return;
  }

  // API calls: Network first, fall back to offline error or cached GET
  if (url.pathname.startsWith('/abms/api/')) {
    if (request.method === 'GET') {
      event.respondWith(
        fetch(request)
          .then((response) => {
            if (response.ok) {
              const clone = response.clone();
              caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
            }
            return response;
          })
          .catch(() => caches.match(request))
      );
    }
    return;
  }

  // HTML page navigations: Network first with Cache fallback
  if (request.mode === 'navigate' || request.destination === 'document') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          }
          return response;
        })
        .catch(() => {
          return caches.match(request).then((cached) => {
            if (cached) return cached;
            // Fallback to login.html if specific page not cached
            return caches.match(BASE + '/login.html');
          });
        })
    );
    return;
  }

  // Static Assets (CSS, JS, Fonts, Images): Cache First with background revalidation
  event.respondWith(
    caches.match(request).then((cachedResponse) => {
      if (cachedResponse) {
        // Return cached asset immediately, revalidate in background
        fetch(request).then((networkResponse) => {
          if (networkResponse && networkResponse.ok) {
            caches.open(CACHE_NAME).then((cache) => cache.put(request, networkResponse));
          }
        }).catch(() => {/* offline, keep cached */ });
        return cachedResponse;
      }

      // If not in cache, fetch from network and cache it
      return fetch(request).then((networkResponse) => {
        if (networkResponse && networkResponse.ok) {
          const clone = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
        }
        return networkResponse;
      });
    })
  );
});
