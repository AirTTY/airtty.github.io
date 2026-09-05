/*
 * AirTTY 網頁藍牙終端 —— Service Worker(離線快取)
 *
 * 為什麼需要它:Web Bluetooth **只在 secure context 下可用**,而 AirTTY 裝置自己
 * 架不出被信任的 HTTPS(自簽憑證瀏覽器不認),所以本頁託管在 airtty.github.io。
 * 但機房常常沒有外網 —— 頁面載不進來就等於整條 BLE 路徑不能用。
 * Service Worker 把整包 app shell 快取在手機/筆電上,**而且快取的頁面保有原本的
 * HTTPS origin** → 離線也還是 secure context → Web Bluetooth 照常可用。
 * 這是「無外網機房走 BLE」的唯一解,不是效能優化。
 *
 * ⚠️⚠️ 改動 webterm 任何檔案後,**一定要把 CACHE_VERSION 加一**。
 *    忘了加的下場:使用者的瀏覽器會永遠拿快取裡的舊版,新功能/修好的 bug 都到不了
 *    他手上,而且從伺服器端完全看不出來(你看到的是新版,他看到的是舊版)。
 *    版本號也會顯示在頁面上(app.js 讀 SW 回報的版本),方便現場對帳。
 */
const CACHE_VERSION = 'v5';
const CACHE_NAME = 'airtty-webterm-' + CACHE_VERSION;

/* app shell:離線要能完整開起來的最小集合。
 * ⚠️ 這裡列的每一個檔案都必須存在 —— addAll() 是全有全無,任一個 404
 *    整個 install 就失敗,結果是「完全沒有離線能力」而且沒有明顯錯誤畫面。 */
const SHELL = [
	'./',
	'./index.html',
	'./app.js',
	'./xterm.js',
	'./xterm.css',
	'./manifest.webmanifest',
	'./icon-192.png',
	'./icon-512.png',
	'./icon-512-maskable.png'
];

self.addEventListener('install', (ev) => {
	ev.waitUntil(
		caches.open(CACHE_NAME)
			.then((c) => c.addAll(SHELL))
			/* 不自動 skipWaiting:使用者可能正在終端裡打字,
			 * 半路換版會中斷連線。改由頁面在適當時機要求接手(見 message 處理)。 */
			.catch((err) => {
				/* install 失敗就讓它失敗 —— 裝一半的快取比沒有更危險 */
				console.error('[sw] app shell 快取失敗,離線能力未建立:', err);
				throw err;
			})
	);
});

self.addEventListener('activate', (ev) => {
	ev.waitUntil(
		caches.keys()
			.then((keys) => Promise.all(
				keys.filter((k) => k.startsWith('airtty-webterm-') && k !== CACHE_NAME)
					.map((k) => caches.delete(k))
			))
			.then(() => self.clients.claim())
	);
});

/*
 * 取用策略:app shell 走 **cache-first**(離線可用是本 SW 的存在理由),
 * 背景順手更新快取(stale-while-revalidate)讓下次開啟拿到新版。
 * ⚠️ 只處理同源 GET —— 其他一律放行給網路,SW 不要多管閒事。
 */
self.addEventListener('fetch', (ev) => {
	const req = ev.request;
	if (req.method !== 'GET') return;
	const url = new URL(req.url);
	if (url.origin !== self.location.origin) return;

	ev.respondWith(
		caches.match(req).then((hit) => {
			const net = fetch(req).then((res) => {
				/* 只快取成功的 basic 回應;opaque/錯誤頁進快取會毒化離線體驗 */
				if (res && res.ok && res.type === 'basic') {
					const copy = res.clone();
					caches.open(CACHE_NAME).then((c) => c.put(req, copy));
				}
				return res;
			}).catch(() => hit);   /* 離線且沒快取 → 回 undefined,由瀏覽器顯示離線錯誤 */
			return hit || net;
		})
	);
});

/* 頁面問版本 / 要求立刻接手(使用者按了「重新整理套用新版」才會走到) */
self.addEventListener('message', (ev) => {
	if (!ev.data) return;
	if (ev.data.type === 'GET_VERSION' && ev.source) {
		ev.source.postMessage({ type: 'VERSION', version: CACHE_VERSION });
	}
	if (ev.data.type === 'SKIP_WAITING') {
		self.skipWaiting();
	}
});
