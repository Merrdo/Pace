// Pace - Service Worker
// Uygulamayı "Ana Ekrana Ekle" ile açıldığında çevrimdışı da çalışır hale
// getirir. Statik ikon/manifest dosyaları cache-first sunulur; HTML sayfası
// ise network-first sunulur (bkz. aşağıdaki not) böylece index.html'e
// yapılan güncellemeler CACHE_VERSION hiç değişmese bile bir sonraki
// açılışta görünür.

const CACHE_VERSION = 'pace-v5';   // v5: eski (bayat) Supabase yanıtları bu sürümle birlikte silinir
const CORE_ASSETS = [
  './manifest.json',
  './icons/favicon.ico',
  './icons/favicon-16.png',
  './icons/favicon-32.png',
  './icons/favicon-48.png',
  './icons/apple-touch-icon.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/splash/splash-1290x2796-iphone-15-14pro-max.png',
  './icons/splash/splash-1179x2556-iphone-15-14pro.png',
  './icons/splash/splash-1284x2778-iphone-13-14-promax.png',
  './icons/splash/splash-1170x2532-iphone-13-14.png',
  './icons/splash/splash-1125x2436-iphone-x-11pro.png',
  './icons/splash/splash-828x1792-iphone-11-xr.png',
  './icons/splash/splash-750x1334-iphone-se-8.png',
  './icons/splash/splash-2048x2732-ipad-pro-12.9.png',
  './icons/splash/splash-1668x2388-ipad-pro-11.png',
  './icons/splash/splash-1620x2160-ipad-10.2.png'
];
// index.html, çevrimdışı ilk açılış için ayrıca (install sırasında)
// önbelleğe alınır, ama runtime'da ASLA cache-first sunulmaz - bkz. fetch.
const OFFLINE_FALLBACK = './index.html';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll([...CORE_ASSETS, OFFLINE_FALLBACK]))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_VERSION)
          .map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

const isNavigationRequest = (request) => (
  request.mode === 'navigate' ||
  (request.method === 'GET' && (request.headers.get('accept') || '').includes('text/html'))
);

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  // ---- Supabase (veri/depo/giriş): service worker hiç karışmaz ----
  // Aksi halde aşağıdaki cache-first kuralı, aynı adrese giden okuma isteklerine
  // sonsuza dek eski cevabı verir ve bulut eşitlemesi cihazda "donmuş" görünür.
  const reqUrl = new URL(event.request.url);
  if (reqUrl.hostname.endsWith('.supabase.co') || reqUrl.hostname.endsWith('.supabase.in')) return;

  // sync.js ve kütüphane betikleri de network-first: yeni sürüm hemen gelsin,
  // ağ yoksa son başarılı kopya kullanılsın.
  const isNav = isNavigationRequest(event.request);

  // ---- HTML sayfa istekleri: network-first ----
  // Eskiden bu istekler de cache-first idi; bu yüzden index.html'i
  // değiştirip CACHE_VERSION'ı bump'lamayı unuttuğunda (ya da service
  // worker script'i hiç değişmediği için tarayıcı yeni bir kurulumu hiç
  // tetiklemediğinde) kullanıcı hep eski sürümü görüyor ve önbelleği elle
  // temizlemek zorunda kalıyordu. Artık her sayfa açılışında önce ağdan
  // taze bir kopya isteniyor; yalnızca ağ yoksa (çevrimdışıyken) en son
  // başarıyla alınmış kopyaya (veya install sırasında kaydedilen ilk
  // kopyaya) düşülüyor.
  if (isNav || event.request.destination === 'script') {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          if (response && response.status === 200) {
            const clone = response.clone();
            caches.open(CACHE_VERSION).then((cache) => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => (
          caches.match(event.request).then((cached) => cached || (isNav ? caches.match(OFFLINE_FALLBACK) : undefined))
        ))
    );
    return;
  }

  // ---- Diğer statik dosyalar (ikonlar, manifest, fontlar): cache-first ----
  // Bunlar sık değişmediği için önbellekten hızlıca sunmak güvenli;
  // içerikleri değiştiğinde CACHE_VERSION'ı bump'lamak yeterli olur.
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;

      return fetch(event.request)
        .then((response) => {
          if (response && response.status === 200) {
            const clone = response.clone();
            caches.open(CACHE_VERSION).then((cache) => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => undefined);
    })
  );
});
