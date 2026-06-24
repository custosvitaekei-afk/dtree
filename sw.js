// Дерево задач — Service Worker v5
// Кэширует приложение целиком (включая внешние библиотеки), чтобы оно
// полностью работало без интернета: открытие, добавление рамок, галочки,
// привычки, лиги, сундуки — всё это уже работает на локальных данных.

const CACHE = 'dtree-v5';

// Файлы самого приложения (тот же каталог, что и sw.js)
const APP_SHELL = [
  'tree_app_v5.html',
  'manifest.json'
];

// Внешние библиотеки, без которых страница не отрисуется офлайн при первом
// заходе без кэша. Кэшируем их при установке SW, чтобы они были доступны
// даже без интернета.
const CDN_LIBS = [
  'https://www.gstatic.com/firebasejs/10.7.1/firebase-app-compat.js',
  'https://www.gstatic.com/firebasejs/10.7.1/firebase-database-compat.js',
  'https://www.gstatic.com/firebasejs/10.7.1/firebase-auth-compat.js',
  'https://cdnjs.cloudflare.com/ajax/libs/dagre/0.8.5/dagre.min.js'
];

// ── Установка: кэшируем файлы приложения + CDN-библиотеки ──
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(async cache => {
      // Свои файлы — должны закэшироваться обязательно
      try {
        await cache.addAll(APP_SHELL);
      } catch (err) {
        console.warn('SW: не удалось закэшировать APP_SHELL', err);
      }
      // Внешние библиотеки — кэшируем по одной, чтобы сбой одной не сломал остальные
      await Promise.all(CDN_LIBS.map(async url => {
        try {
          const resp = await fetch(url, { mode: 'cors' });
          if (resp && (resp.ok || resp.type === 'opaque')) {
            await cache.put(url, resp);
          }
        } catch (err) {
          console.warn('SW: не удалось закэшировать', url, err);
        }
      }));
    })
  );
  self.skipWaiting();
});

// ── Активация: удаляем старые кэши ──
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(k => k !== CACHE).map(k => {
          console.log('SW: удаляю старый кэш', k);
          return caches.delete(k);
        })
      )
    )
  );
  self.clients.claim();
});

// ── Fetch: кэш-первым (cache-first) с фоновым обновлением,
//    плюс офлайн-фолбэк на закэшированную главную страницу для навигации ──
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;

  // Realtime Database / Firestore long-polling и .info/connected — всегда напрямую в сеть,
  // их нельзя и не нужно кэшировать через SW.
  const url = req.url;
  if (url.includes('firebaseio.com') ||
      url.includes('firebasedatabase.app') ||
      url.includes('.info/connected')) {
    return;
  }

  e.respondWith(
    caches.match(req).then(cached => {
      if (cached) {
        // Есть в кэше — отдаём сразу, обновляем в фоне (stale-while-revalidate)
        fetch(req).then(fresh => {
          if (fresh && (fresh.ok || fresh.type === 'opaque')) {
            caches.open(CACHE).then(c => c.put(req, fresh.clone()));
          }
        }).catch(() => {});
        return cached;
      }
      // Нет в кэше — пробуем сеть, кэшируем успешный ответ
      return fetch(req).then(response => {
        if (response && (response.ok || response.type === 'opaque')) {
          // Клонируем СРАЗУ, до того как тело будет прочитано браузером
          const toCache = response.clone();
          caches.open(CACHE).then(c => c.put(req, toCache));
        }
        return response;
      }).catch(async () => {
        // Офлайн и в кэше нет точного совпадения.
        // Для навигационных запросов (открытие страницы) отдаём закэшированный app-shell —
        // так PWA открывается офлайн даже если URL чуть отличается (например, без файла в пути).
        if (req.mode === 'navigate' || (req.headers.get('accept') || '').includes('text/html')) {
          const shell = await caches.match('tree_app_v5.html');
          if (shell) return shell;
        }
        return new Response('Приложение офлайн, а этот ресурс ещё не закэширован. Откройте приложение онлайн один раз, чтобы он сохранился для офлайн-режима.', {
          status: 503,
          headers: { 'Content-Type': 'text/plain; charset=utf-8' }
        });
      });
    })
  );
});
