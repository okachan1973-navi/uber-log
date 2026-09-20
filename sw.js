/**
 * UBER LOG - Service Worker (Auto-Update & Offline Resilience)
 * Version: 20260920_v9
 */

const SW_VERSION = '20260920_v9';
const CACHE_NAME = 'uber-log-' + SW_VERSION;

// インストール時に待機せず即座にアクティブ化
self.addEventListener('install', (event) => {
  self.skipWaiting();
});

// アクティブ化時に古いバージョンのCacheStorageを完全消去
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key.startsWith('uber-log-') && key !== CACHE_NAME) {
            console.log('[SW] Deleting old cache:', key);
            return caches.delete(key);
          }
        })
      );
    }).then(() => {
      return self.clients.claim();
    })
  );
});

// リクエスト割り込み制御
self.addEventListener('fetch', (event) => {
  // GET以外のリクエスト（POST, PUT等）は一切キャッシュせずそのまま流す
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);

  // 外部API（Supabase, Google Maps等）はService Workerの介入を完全に除外
  if (url.origin !== self.location.origin) return;

  // 1. ナビゲーションリクエスト（index.html / 画面初期読込）
  // 常にネットワーク優先（Network-First）：オンライン時は必ず最新のHTMLを取得
  if (event.request.mode === 'navigate' || url.pathname.endsWith('/index.html') || url.pathname.endsWith('/')) {
    event.respondWith(
      fetch(event.request, { cache: 'no-cache' })
        .then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            const clone = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return networkResponse;
        })
        .catch(() => {
          // オフライン時のみ保存済みキャッシュから起動
          return caches.match(event.request).then((cached) => {
            return cached || caches.match('./index.html');
          });
        })
    );
    return;
  }

  // 2. 静的アセット（JS / CSS / 画像 / マップ）
  // 同一オリジン内のアセットはネットワーク優先で取得し、オフライン時はキャッシュを使用
  event.respondWith(
    fetch(event.request)
      .then((networkResponse) => {
        if (networkResponse && networkResponse.status === 200) {
          const clone = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return networkResponse;
      })
      .catch(() => {
        return caches.match(event.request);
      })
  );
});

// メッセージハンドラー
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
