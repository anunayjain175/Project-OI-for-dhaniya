// Service Worker for NCDEX OI Terminal PWA
const CACHE_NAME = 'ncdex-oi-v1';

// Assets to cache for offline shell
const SHELL_ASSETS = [
    '/',
    '/static/app.css?v=12',
    '/static/icon-512.png'
];

// Install: cache the app shell
self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME).then(cache => {
            return cache.addAll(SHELL_ASSETS);
        })
    );
    // Activate immediately
    self.skipWaiting();
});

// Activate: clean old caches
self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys().then(keys => {
            return Promise.all(
                keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
            );
        })
    );
    self.clients.claim();
});

// Fetch: network-first strategy for API calls, cache-first for static assets
self.addEventListener('fetch', event => {
    const url = new URL(event.request.url);
    
    // Skip non-GET requests and WebSocket upgrades
    if (event.request.method !== 'GET') return;
    
    // API calls: always go to network (real-time data must be fresh)
    if (url.pathname.startsWith('/api/') || url.pathname === '/ws') {
        return;
    }
    
    // Static assets & app shell: network-first with cache fallback
    event.respondWith(
        fetch(event.request)
            .then(response => {
                // Clone and cache the fresh response
                const clone = response.clone();
                caches.open(CACHE_NAME).then(cache => {
                    cache.put(event.request, clone);
                });
                return response;
            })
            .catch(() => {
                // Network failed: serve from cache
                return caches.match(event.request);
            })
    );
});
