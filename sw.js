/* MacroLedger service worker — network-first so iPhone gets updates */
const CACHE = "macroledger-v9c-toggle";
const ASSETS = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./css/app.css",
  "./js/db.js",
  "./js/seed-foods.js",
  "./js/metabolism.js",
  "./js/adaptive.js",
  "./js/nlp-log.js",
  "./js/onboarding.js",
  "./js/barcode-scan.js",
  "./js/persist.js",
  "./js/app.js",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k !== CACHE)
            .map((k) => caches.delete(k))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("message", (event) => {
  if (event.data === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);

  // Never cache barcode API / CDN scanner lib
  if (
    url.hostname.includes("openfoodfacts.org") ||
    url.hostname.includes("unpkg.com")
  ) {
    event.respondWith(
      fetch(req).catch(
        () =>
          new Response(JSON.stringify({ status: 0 }), {
            headers: { "Content-Type": "application/json" },
          })
      )
    );
    return;
  }

  if (url.origin !== self.location.origin) return;

  // Network-first for HTML/JS/CSS so renames + scanner updates stick on iOS
  const isShell =
    req.mode === "navigate" ||
    url.pathname.endsWith(".html") ||
    url.pathname.endsWith(".js") ||
    url.pathname.endsWith(".css") ||
    url.pathname.endsWith("manifest.webmanifest") ||
    url.pathname.endsWith("/") ||
    url.pathname.endsWith("/calorietrack") ||
    url.pathname.endsWith("/calorietrack/");

  if (isShell) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const clone = res.clone();
            caches.open(CACHE).then((c) => c.put(req, clone));
          }
          return res;
        })
        .catch(() => caches.match(req).then((c) => c || caches.match("./index.html")))
    );
    return;
  }

  event.respondWith(
    caches.match(req).then((cached) => {
      const fetched = fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const clone = res.clone();
            caches.open(CACHE).then((c) => c.put(req, clone));
          }
          return res;
        })
        .catch(() => cached);
      return cached || fetched;
    })
  );
});
