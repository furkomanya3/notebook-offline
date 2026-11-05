/* sw.js — uygulama kabuğunu önbelleğe alır (offline açılış için).
   Model dosyaları WebLLM tarafından ayrıca Cache API'de tutulur. */

const VER = 'nb-offline-v1'
const SHELL = [
  './',
  './index.html',
  './app.js',
  './core.js',
  './manifest.webmanifest',
  './icon.svg',
  './icon-180.png',
  './vendor/pdf.min.mjs',
  './vendor/pdf.worker.min.mjs',
  './vendor/web-llm.js',
  './demo-kaynak.pdf',
]

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(VER).then((c) =>
      // tek tek ekle: biri 404 olursa install tümden düşmesin
      Promise.all(SHELL.map((u) => c.add(u).catch(() => {})))
    ).then(() => self.skipWaiting())
  )
})

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VER).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  )
})

self.addEventListener('fetch', (e) => {
  const req = e.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)

  // HuggingFace'dan gelen model parçaları: tarayıcı/WebLLM kendi önbelleğini yönetir
  if (url.origin !== location.origin) return

  e.respondWith(
    caches.match(req, { ignoreSearch: true }).then((hit) => {
      if (hit) return hit
      return fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone()
            caches.open(VER).then((c) => c.put(req, copy)).catch(() => {})
          }
          return res
        })
        .catch(() => caches.match('./index.html'))
    })
  )
})
