/* ===== Service Worker — Προμέτρηση PWA =====
   Στρατηγική:
   - App shell (δικά μας αρχεία): cache-first → ανοίγει offline
   - CDN libraries: network-first με fallback σε cache → πάντα φρέσκα όταν υπάρχει δίκτυο,
     αλλά λειτουργεί και offline αφού φορτωθούν μία φορά
   ΣΗΜΑΝΤΙΚΟ: ανέβασε νέα έκδοση αλλάζοντας το CACHE_VERSION σε κάθε deploy.
*/
const CACHE_VERSION = "prometrisi-v1.4.0";
const SHELL_CACHE = CACHE_VERSION + "-shell";
const CDN_CACHE   = CACHE_VERSION + "-cdn";

// Δικά μας αρχεία (app shell) — cache-first
const SHELL_ASSETS = [
  "./",
  "./index.html",
  "./app.js",
  "./lib/dxf-parser.js",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png"
];

// Hosts που θεωρούμε CDN (network-first)
const CDN_HOSTS = ["cdnjs.cloudflare.com"];

self.addEventListener("install", e => {
  e.waitUntil(
    caches.open(SHELL_CACHE).then(c => c.addAll(SHELL_ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(k => !k.startsWith(CACHE_VERSION)).map(k => caches.delete(k))
    )).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // 1) CDN libraries → network-first
  if (CDN_HOSTS.includes(url.hostname)) {
    e.respondWith(
      fetch(req).then(res => {
        const copy = res.clone();
        caches.open(CDN_CACHE).then(c => c.put(req, copy));
        return res;
      }).catch(() => caches.match(req))
    );
    return;
  }

  // 2) App shell (same-origin) → cache-first, με ενημέρωση στο παρασκήνιο
  if (url.origin === self.location.origin) {
    e.respondWith(
      caches.match(req).then(cached => {
        const network = fetch(req).then(res => {
          const copy = res.clone();
          caches.open(SHELL_CACHE).then(c => c.put(req, copy));
          return res;
        }).catch(() => cached);
        return cached || network;
      })
    );
    return;
  }

  // 3) Οτιδήποτε άλλο → απλό network με fallback
  e.respondWith(fetch(req).catch(() => caches.match(req)));
});
