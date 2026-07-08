// public/pwa.js — PWA registration, install prompt, offline answer queue

// ── Service Worker Registration ──────────────────────────────────────────────
if ('serviceWorker' in navigator) {
  window.addEventListener('load', async () => {
    try {
      const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
      console.log('[PWA] Service worker registered:', reg.scope);

      // Check for SW updates
      reg.addEventListener('updatefound', () => {
        const newWorker = reg.installing;
        newWorker.addEventListener('statechange', () => {
          if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
            showUpdateBanner();
          }
        });
      });
    } catch (err) {
      console.warn('[PWA] SW registration failed:', err.message);
    }
  });
}

// ── Install Prompt (Add to Home Screen) ──────────────────────────────────────
let deferredInstallPrompt = null;

window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  deferredInstallPrompt = e;
  // Never nag to install while a student is actively taking an exam
  if (/^\/exam\/[^/]+\/question\//.test(window.location.pathname)) return;
  showInstallBanner();
});

function showInstallBanner() {
  // Only show if not already installed
  if (window.matchMedia('(display-mode: standalone)').matches) return;

  // Respect a previous "Not now" dismissal (don't show again for 3 days)
  const dismissedUntil = parseInt(localStorage.getItem('pwa-dismissed') || '0', 10);
  if (dismissedUntil && Date.now() < dismissedUntil) return;

  // Avoid stacking duplicate banners if one is already on screen
  if (document.getElementById('pwa-install-banner')) return;

  const banner = document.createElement('div');
  banner.id = 'pwa-install-banner';
  banner.className = 'fixed bottom-4 left-4 right-4 sm:left-auto sm:right-4 sm:w-80 bg-slate-900 text-white rounded-2xl shadow-2xl p-4 z-50 border border-slate-700 flex items-start gap-3';
  banner.innerHTML = `
    <img src="/icons/icon-72x72.png" class="w-12 h-12 rounded-xl shrink-0" alt="App icon"/>
    <div class="flex-1 min-w-0">
      <p class="font-bold text-sm">Install CET Exam App</p>
      <p class="text-xs text-slate-400 mt-0.5">Add to home screen for faster access & offline support</p>
      <div class="flex gap-2 mt-3">
        <button id="pwa-install-btn" class="flex-1 bg-amber-500 hover:bg-amber-400 text-slate-900 font-semibold text-xs py-2 px-3 rounded-lg transition-colors">
          📲 Install App
        </button>
        <button id="pwa-dismiss-btn" class="px-3 py-2 text-slate-400 hover:text-white text-xs transition-colors">
          Not now
        </button>
      </div>
    </div>
  `;
  document.body.appendChild(banner);

  document.getElementById('pwa-install-btn').addEventListener('click', async () => {
    if (!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    const { outcome } = await deferredInstallPrompt.userChoice;
    console.log('[PWA] Install outcome:', outcome);
    deferredInstallPrompt = null;
    banner.remove();
  });

  document.getElementById('pwa-dismiss-btn').addEventListener('click', () => {
    banner.remove();
    // Don't show again for 3 days
    localStorage.setItem('pwa-dismissed', Date.now() + 3 * 24 * 3600 * 1000);
  });
}

window.addEventListener('appinstalled', () => {
  console.log('[PWA] App installed!');
  document.getElementById('pwa-install-banner')?.remove();
});

// ── Update Banner ─────────────────────────────────────────────────────────────
function showUpdateBanner() {
  const banner = document.createElement('div');
  banner.className = 'fixed top-4 left-4 right-4 sm:left-auto sm:right-4 sm:w-80 bg-green-700 text-white rounded-xl shadow-xl p-4 z-50 flex items-center gap-3';
  banner.innerHTML = `
    <span class="text-xl">🔄</span>
    <div class="flex-1">
      <p class="font-semibold text-sm">Update Available</p>
      <p class="text-xs text-green-200 mt-0.5">A new version is ready.</p>
    </div>
    <button onclick="window.location.reload()" class="bg-white text-green-700 font-semibold text-xs px-3 py-1.5 rounded-lg hover:bg-green-50 transition-colors">
      Refresh
    </button>
  `;
  document.body.appendChild(banner);
}

// ── Online / Offline Status Banner ───────────────────────────────────────────
let offlineBanner = null;

function showOfflineBanner() {
  if (offlineBanner) return;
  offlineBanner = document.createElement('div');
  offlineBanner.id = 'offline-status-bar';
  offlineBanner.className = 'fixed top-0 left-0 right-0 bg-red-600 text-white text-xs font-semibold py-2 text-center z-[999] flex items-center justify-center gap-2';
  offlineBanner.innerHTML = `
    <span class="w-2 h-2 bg-white rounded-full inline-block animate-pulse"></span>
    You're offline — answers are saved locally and will sync when connection is restored
  `;
  document.body.insertBefore(offlineBanner, document.body.firstChild);
}

function hideOfflineBanner() {
  if (offlineBanner) {
    offlineBanner.className = offlineBanner.className.replace('bg-red-600', 'bg-green-600');
    offlineBanner.innerHTML = `<span>✅ Back online — syncing your data...</span>`;
    setTimeout(() => { offlineBanner?.remove(); offlineBanner = null; }, 3000);
  }
}

window.addEventListener('online',  hideOfflineBanner);
window.addEventListener('offline', showOfflineBanner);

// Show immediately if already offline
if (!navigator.onLine) showOfflineBanner();

// ── Offline Answer Queue (IndexedDB) ─────────────────────────────────────────
const CET_DB_NAME    = 'cet-offline-db';
const CET_DB_VERSION = 1;

async function openOfflineDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(CET_DB_NAME, CET_DB_VERSION);
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

// Queue an answer save when offline
window.queueOfflineAnswer = async (url, body) => {
  try {
    const db = await openOfflineDB();
    const tx = db.transaction('queue', 'readwrite');
    tx.objectStore('queue').add({ url, body, timestamp: Date.now() });
    console.log('[PWA] Answer queued for sync');
    // Register background sync
    if ('serviceWorker' in navigator && 'SyncManager' in window) {
      const reg = await navigator.serviceWorker.ready;
      await reg.sync.register('answer-sync-queue');
    }
  } catch (e) {
    console.warn('[PWA] Queue failed:', e.message);
  }
};
