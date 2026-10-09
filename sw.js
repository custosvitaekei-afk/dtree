// Дерево задач — Service Worker v6
// Кэширует приложение целиком (включая внешние библиотеки), чтобы оно
// полностью работало без интернета: открытие, добавление рамок, галочки,
// привычки, лиги, сундуки — всё это уже работает на локальных данных.

const CACHE = 'dtree-v8.5'; // v8.5: v9, часть 5 — страница (HTML) берётся «сеть-первой» (при интернете — всегда свежая с первого открытия, без сети — из кэша), старые вкладки перезагружаются при смене версии; камера не синхронизируется; индикатор версии. Ранее v8.4: HTML изменился (v9, часть 4: режим «только просмотр») — версия поднята. Ранее v8.3: HTML изменился (v9, часть 3: исправлена серия идеальных часов — от последнего идеального часа; новый формат счётчиков; инструкция) — версия поднята. Ранее v8.2: HTML изменился (v9, часть 2: идеальные ЧАСЫ вместо идеальных дней, миграция счётчиков) — версия поднята. Ранее v8.1: HTML изменился (v9, часть 1: почасовая разметка внутри таблиц привычек) — версия поднята. Ранее v8.0: HTML изменился (синхронизация: ревизии rev, транзакции, слияние, нет слепых записей). Ранее v7.8: HTML изменился (часть 6: лимитер вместо компрессора, громкости; часть 7: архив старых данных таблиц) — версия поднята

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
        // cache:'reload' — в новый кэш попадает именно свежая версия с сервера, а не копия из HTTP-кэша браузера
        await cache.addAll(APP_SHELL.map(u => new Request(u, { cache: 'reload' })));
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

// ── Активация: удаляем старые кэши, берём под контроль открытые вкладки ──
// После этого сообщаем вкладкам о новой версии: вкладка с актуальным кодом отвечает «я новая» и ничего не делает;
// вкладка, которая не ответила (открыта на СТАРОМ коде, где этого обработчика ещё нет), перезагружается —
// теперь страница берётся с сервера, и устройство сразу работает на актуальной версии, а не со второго открытия.
self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys.filter(k => k !== CACHE).map(k => {
        console.log('SW: удаляю старый кэш', k);
        return caches.delete(k);
      })
    );
    await self.clients.claim();
    await refreshClients();
  })());
});

async function refreshClients() {
  // Только вкладки этого приложения (в пределах scope SW) — чужие вкладки того же домена не трогаем
  const list = (await self.clients.matchAll({ type: 'window' })).filter(c => c.url.startsWith(self.registration.scope));
  await Promise.all(list.map(async c => {
    const acked = await new Promise(res => {
      const ch = new MessageChannel();
      const t = setTimeout(() => res(false), 2000);
      ch.port1.onmessage = () => { clearTimeout(t); res(true); };
      try { c.postMessage({ type: 'sw-activated', cache: CACHE }, [ch.port2]); }
      catch (err) { clearTimeout(t); res(false); }
    });
    if (!acked) { try { await c.navigate(c.url); } catch (err) {} }
  }));
}

const NAV_TIMEOUT_MS = 4000; // дольше этого ждать сервер не будем — открываем из кэша (обновление всё равно докачается и сохранится)
const offlineResponse = () => new Response('Приложение офлайн, а этот ресурс ещё не закэширован. Откройте приложение онлайн один раз, чтобы он сохранился для офлайн-режима.', {
  status: 503,
  headers: { 'Content-Type': 'text/plain; charset=utf-8' }
});

async function networkFirstPage(e, req) {
  const cache = await caches.open(CACHE);
  const shellKey = new URL('tree_app_v5.html', self.registration.scope).href;
  // cache:'no-cache' — сверяемся с сервером (условный запрос), а не берём копию из HTTP-кэша браузера
  const netP = fetch(req.url, { cache: 'no-cache', credentials: 'same-origin' }).then(resp => {
    if (resp && resp.ok) {
      // Клонируем сразу, до того как тело прочитает браузер. Под ключом shellKey лежит «главная» — для офлайна при любом URL.
      cache.put(req, resp.clone()).catch(() => {});
      cache.put(shellKey, resp.clone()).catch(() => {});
    }
    return resp;
  });
  netP.catch(() => {});
  try { e.waitUntil(netP.catch(() => {})); } catch (err) {} // дать докачаться и сохраниться, даже если мы уже ответили из кэша
  const cached = (await cache.match(req)) || (await cache.match(shellKey));
  if (!cached) return netP.catch(offlineResponse); // в кэше ничего нет — единственный вариант: сеть
  try {
    const resp = await Promise.race([netP, new Promise(res => setTimeout(() => res(null), NAV_TIMEOUT_MS))]);
    if (resp && resp.ok) return resp;
  } catch (err) { /* офлайн — идём в кэш */ }
  return cached;
}

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

  // Сама страница (HTML) — «сеть-первой»: при интернете всегда берём свежую версию с сервера (и обновляем кэш),
  // без интернета (или если сервер не ответил за NAV_TIMEOUT_MS) — отдаём последнюю сохранённую из кэша.
  const isPage = new URL(url).origin === self.location.origin &&
    (req.mode === 'navigate' || (req.headers.get('accept') || '').includes('text/html'));
  if (isPage) {
    e.respondWith(networkFirstPage(e, req));
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
        return offlineResponse();
      });
    })
  );
});
