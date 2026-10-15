// Service worker: the app shell only (docs/MOBILE.md §6). Caches this directory's page files
// (www/) and the wasm bundle (pkg/, by the content-hashed names pkg/manifest.json gives) so the
// page opens from the home screen without a network, and nothing else: never the romfs
// (/romfs/ and the Cache Storage of main.js are separate),
// never the room server (/ws, /rooms.json, /ice.json, /healthz) and never another origin.
// Registered by www/main.js on secure pages; scope = this file's directory,
// so a page served at `/` covers `/pkg/` and one served at `/www/` caches its page files only.
//
// Policy: shell files are network-first (they are served `no-cache`; the cached copy is the
// offline fallback), hashed bundle files are cache-first (immutable), the manifest and the
// unhashed aliases network-first. When a fresh manifest arrives, bundle files it does not name
// are dropped from the cache.
const VERSION = 'mk8-shell-v1';
const SHELL_CACHE = `${VERSION}-shell`;
const PKG_CACHE = `${VERSION}-pkg`;
const SHELL = ['./', './index.html', './main.js', './home.js', './brand.js', './net.js', './live.js', './voice.js', './audio.js', './audio-worklet.js',
  './pkg-manifest.js', './ads.js', './mobile.js', './controls.js', './menu.css', './mobile.css', './manifest.webmanifest',
  './icon-192.png', './icon-512.png', './icon-maskable-512.png', './icon-180.png'];
const scopeUrl = new URL(self.registration ? self.registration.scope : './', self.location.href);
const pkgBase = new URL('../pkg/', new URL('./', self.location.href)).pathname; // sibling of www/ (or `/pkg/` at the root)
const HASHED = /\/[A-Za-z0-9_-]+\.[0-9a-f]{12}\.(js|wasm)$/;

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    // One at a time, failures ignored: a missing optional icon must not block the install.
    for (const f of SHELL) { try { await cache.add(new Request(f, { cache: 'reload' })); } catch { /* optional */ } }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('mk8-shell-') && !k.startsWith(VERSION)) await caches.delete(k);
    await self.clients.claim();
  })());
});

const isShell = (url) => url.origin === self.location.origin && url.pathname.startsWith(scopeUrl.pathname)
  && (url.pathname === scopeUrl.pathname || /\.(js|css|html|webmanifest|png)$/.test(url.pathname)) && !url.pathname.slice(scopeUrl.pathname.length).includes('/');
const isPkg = (url) => url.origin === self.location.origin && url.pathname.startsWith(pkgBase) && !url.pathname.slice(pkgBase.length).includes('/');

async function networkFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const r = await fetch(req);
    if (r && r.ok) cache.put(req, r.clone()).catch(() => {});
    return r;
  } catch (e) {
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    throw e;
  }
}

async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  if (hit) return hit;
  const r = await fetch(req);
  if (r && r.ok) cache.put(req, r.clone()).catch(() => {});
  return r;
}

async function manifestThenPrune(req) {
  const r = await networkFirst(req, PKG_CACHE);
  try {
    const m = await r.clone().json();
    const keep = new Set(Object.values(m).filter((v) => typeof v === 'string'));
    const cache = await caches.open(PKG_CACHE);
    for (const k of await cache.keys()) {
      const name = new URL(k.url).pathname.split('/').pop();
      if (HASHED.test(`/${name}`) && !keep.has(name)) await cache.delete(k);
    }
  } catch { /* not a manifest */ }
  return r;
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  let url;
  try { url = new URL(req.url); } catch { return; }
  if (isPkg(url)) {
    if (url.pathname.endsWith('/manifest.json')) event.respondWith(manifestThenPrune(req));
    else if (HASHED.test(url.pathname)) event.respondWith(cacheFirst(req, PKG_CACHE));
    else event.respondWith(networkFirst(req, PKG_CACHE));
    return;
  }
  if (isShell(url)) {
    event.respondWith(networkFirst(req, SHELL_CACHE));
  }
  // Everything else (romfs, WebSocket upgrade, room / ICE JSON, other origins): untouched.
});
