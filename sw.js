/* ============================================================
   DEEPREEL Service Worker
   策略：
   - 页面导航：网络优先，失败回退缓存（保证新版生效）
   - 核心脚本 app.js/styles.css：网络优先，失败回退缓存
   - 其它静态资源：缓存优先
   - 代理 API（/bili/*、/chat/completions、/healthz）一律不缓存
   - 跨域请求（B站/DeepSeek 直连）不缓存
   ============================================================ */
const CACHE = 'deepreel-v1';
const PRECACHE = ['./', './index.html', './app.js', './styles.css', './manifest.json', './icon-192.png', './icon-512.png', './icon-180.png'];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(PRECACHE))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;          // 跨域不缓存
  const path = url.pathname;
  if (/^\/(bili|chat|v1|healthz)/.test(path)) return;  // 代理 API 不缓存

  // 页面导航：网络优先
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then(r => {
          const copy = r.clone();
          caches.open(CACHE).then(c => c.put('./index.html', copy));
          return r;
        })
        .catch(() => caches.match('./index.html'))
    );
    return;
  }
  // 核心脚本：网络优先（保证更新生效），离线回退缓存
  if (/\.(js|css)$/.test(path)) {
    e.respondWith(
      fetch(req)
        .then(r => {
          if (r.ok) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
          return r;
        })
        .catch(() => caches.match(req))
    );
    return;
  }
  // 其它静态资源：缓存优先
  e.respondWith(
    caches.match(req).then(hit => hit || fetch(req).then(r => {
      if (r.ok) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
      return r;
    }))
  );
});
