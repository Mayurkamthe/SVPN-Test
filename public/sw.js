// public/sw.js — CET Exam Portal Service Worker
// Strategy: Network-first for ALL HTML pages (fresh data on every load)
//           Cache-first only for true static assets (icons, CDN, fonts)

const CACHE_VERSION = 'v2.0';
const STATIC_CACHE  = `cet-static-${CACHE_VERSION}`;
const OFFLINE_URL   = '/offline.html';

// ── Static shell assets — cached on install ───────────────────────────────────
const STATIC_ASSETS = [
  '/offline.html',
  '/manifest.json',
  '/icons/icon-192x192.png',
  '/icons/icon-512x512.png',
];

// ── Patterns that are ALWAYS cache-first (true static, never changes) ─────────
const CACHE_FIRST_PATTERNS = [
  /\/icons\//,
  /\/manifest\.json/,
  /cdn\.tailwindcss\.com/,
  /fonts\.googleapis\.com/,
  /fonts\.gstatic\.com/,
  /cdn\.jsdelivr\.net/,
];

// ─────────────────────────────────────────────────────────────────────────────
// INSTALL — pre-cache static shell only
// ─────────────────────────────────────────────────────────────────────────────
self.addEventListener('install', event => {
  console.log('[SW] Installing', CACHE_VERSION);
  event.waitUntil(
    caches.open(STATIC_CACHE)
      .then(cache => cache.addAll(STATIC_ASSETS))
      .then(() => self.skipWaiting())   // activate immediately
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// ACTIVATE — delete ALL old caches so stale pages are gone
// ─────────────────────────────────────────────────────────────────────────────
self.addEventListener('activate', event => {
  console.log('[SW] Activating', CACHE_VERSION);
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== STATIC_CACHE).map(k => {
          console.log('[SW] Deleting old cache:', k);
          return caches.delete(k);
        })
      ))
      .then(() => self.clients.claim())  // take control of all open tabs
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// FETCH — Network-first for pages, cache-first for real static assets
// ─────────────────────────────────────────────────────────────────────────────
self.addEventListener('fetch', event => {
  const { request } = event;

  // Ignore non-GET requests entirely (POST, PUT etc. go straight to network)
  if (request.method !== 'GET') return;

  // Cache-first ONLY for true static assets (icons, CDN libraries, fonts)
  if (CACHE_FIRST_PATTERNS.some(p => p.test(request.url))) {
    event.respondWith(cacheFirst(request));
    return;
  }

  // Everything else (HTML pages, API calls, uploads) → network-first
  // Falls back to cache ONLY when offline, shows offline page if no cache
  event.respondWith(networkFirst(request));
});

// ─────────────────────────────────────────────────────────────────────────────
// BACKGROUND SYNC — offline answer saving during exam
// ─────────────────────────────────────────────────────────────────────────────
const SYNC_QUEUE = 'answer-sync-queue';

self.addEventListener('sync', event => {
  if (event.tag === SYNC_QUEUE) {
    event.waitUntil(flushAnswerQueue());
  }
});

async function flushAnswerQueue() {
  const db = await openDB();
  const tx = db.transaction('queue', 'readwrite');
  const store = tx.objectStore('queue');
  const items = await storeGetAll(store);
  for (const item of items) {
    try {
      const res = await fetch(item.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(item.body),
      });
      if (res.ok) await storeDelete(store, item.id);
    } catch (e) {
      console.warn('[SW] Sync retry failed:', e.message);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PUSH NOTIFICATIONS
// ─────────────────────────────────────────────────────────────────────────────
self.addEventListener('push', event => {
  const data    = event.data?.json() || {};
  const title   = data.title || 'CET Exam Portal';
  const options = {
    body:    data.body    || 'You have a new notification.',
    icon:    '/icons/icon-192x192.png',
    badge:   '/icons/icon-72x72.png',
    tag:     data.tag     || 'cet-notification',
    data:    { url: data.url || '/' },
    actions: data.actions || [],
    vibrate: [200, 100, 200],
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = event.notification.data?.url || '/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(cls => {
      const existing = cls.find(c => c.url.includes(url) && 'focus' in c);
      return existing ? existing.focus() : clients.openWindow(url);
    })
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// STRATEGY HELPERS
// ─────────────────────────────────────────────────────────────────────────────

// Network-first: always try network, fall back to cache if offline
async function networkFirst(request) {
  try {
    const response = await fetch(request);
    // Only cache successful responses to static-ish pages (optional safety net)
    // We intentionally do NOT cache HTML pages so they're always fresh
    return response;
  } catch {
    // Offline — try cache
    const cached = await caches.match(request);
    if (cached) return cached;
    // Nothing in cache — show offline page
    return caches.match(OFFLINE_URL);
  }
}

// Cache-first: serve from cache, fetch and update in background
async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(STATIC_CACHE);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    return caches.match(OFFLINE_URL);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// IndexedDB helpers for offline answer queue
// ─────────────────────────────────────────────────────────────────────────────
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('cet-offline-db', 1);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('queue')) {
        db.createObjectStore('queue', { keyPath: 'id', autoIncrement: true });
      }
    };
    req.onsuccess = e => resolve(e.target.result);
    req.onerror   = e => reject(e.target.error);
  });
}

function storeGetAll(store) {
  return new Promise((res, rej) => {
    const req = store.getAll();
    req.onsuccess = () => res(req.result);
    req.onerror   = () => rej(req.error);
  });
}

function storeDelete(store, id) {
  return new Promise((res, rej) => {
    const req = store.delete(id);
    req.onsuccess = () => res();
    req.onerror   = () => rej(req.error);
  });
}
