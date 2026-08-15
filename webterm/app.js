/*
 * AirTTY 網頁藍牙終端（Web Bluetooth + Nordic UART Service）
 *
 * 用瀏覽器透過 BLE 連進 AirTTY 裝置的序列 console，不必安裝軟體、不必配對。
 *
 * 安全性設計：console 流量（含連線密碼）全程流經本頁的 JavaScript，因此本頁
 * 刻意做成可稽核、可自行託管：
 *   - 零對外傳輸：全檔沒有 fetch / XMLHttpRequest / WebSocket / sendBeacon。
 *   - 零外部資源：xterm.js 與 xterm.css 就放在同一個資料夾，不引用任何 CDN。
 *   - 整個目錄可下載後離線自架（作法見同目錄 README.md）。
 * 想自行驗證，可在本目錄執行：
 *   grep -riE "fetch\(|XMLHttpRequest|WebSocket|sendBeacon|src=\"http" .
 * 唯一的命中應該只有這段註解與 README.md 的同一段說明，程式碼本體零命中。
 *
 * 裝置端介面（決定本頁寫法的事實）：
 * - Nordic UART Service：service 6e400001-…、RX 6e400002（瀏覽器→裝置，write）、
 *   TX 6e400003（裝置→瀏覽器，notify）。
 * - 裝置廣播帶 128-bit NUS UUID，因此 requestDevice 用 service filter 就能直接
 *   命中，不必開放全部裝置。
 * - BLE 廣播封包放不下裝置名稱 → 選擇清單顯示「無名裝置」是常態。
 * - BLE 一次只允許一條連線；連線密碼由裝置端把關。
 * - Windows 首次 GATT 連線常失敗 → 內建重試 ×3。
 * - 重新連線必須沿用同一個 BluetoothDevice 物件，否則多台並存時會連錯機器。
 */
'use strict';

var NUS_SVC = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
var NUS_RX  = '6e400002-b5a3-f393-e0a9-e50e24dcca9e'; /* client → 裝置 */
var NUS_TX  = '6e400003-b5a3-f393-e0a9-e50e24dcca9e'; /* 裝置 → client */

/* Web Bluetooth 不揭露協商後的 MTU → 寫入用保守分塊。20 = BLE 4.0 最小
 * ATT payload,任何協商結果下都安全;打字是單鍵單 byte,只有貼上會走分塊迴圈 */
var WRITE_CHUNK = 20;

var elStatus = document.getElementById('status');
var btnConnect = document.getElementById('btnConnect');
var btnReconnect = document.getElementById('btnReconnect');
var btnDisconnect = document.getElementById('btnDisconnect');

var term = new window.Terminal({
	cursorBlink: true, fontSize: 14, scrollback: 5000,
	theme: { background: '#000000' }
});
term.open(document.getElementById('term'));

var device = null;      /* 釘住的 BluetoothDevice(重連不重開 chooser) */
var rxChar = null;      /* write 目標 */
var txChar = null;      /* notify 來源 */
var wantDisconnect = false;   /* 區分「使用者按斷線」與「意外斷線」 */
var writeQueue = Promise.resolve();  /* GATT 同時只能一個操作 → 寫入串行化 */

function setStatus(text, cls) {
	elStatus.textContent = text;
	elStatus.className = cls || '';
}

function setButtons(state) {
	/* state: idle | connecting | connected | dropped */
	btnConnect.classList.toggle('hidden', state !== 'idle');
	btnReconnect.classList.toggle('hidden', state !== 'dropped');
	btnDisconnect.classList.toggle('hidden', state !== 'connected');
	btnConnect.disabled = btnReconnect.disabled = (state === 'connecting');
}

function say(line) {
	/* 本頁自己的訊息用暗色前綴,與 console 內容區隔 */
	term.write('\r\n\x1b[90m[BLE] ' + line + '\x1b[0m\r\n');
}

/* ── 環境門檻:沒過就把原因講清楚,不留白畫面 ── */
function envCheck() {
	if (!('bluetooth' in navigator)) {
		if (!window.isSecureContext)
			say('此頁必須經 HTTPS 或 http://localhost 開啟(Web Bluetooth 的 secure context 要求)');
		else
			say('此瀏覽器不支援 Web Bluetooth。可用:Windows/macOS/Android 的 Chrome 或 Edge;iOS 請改用 BTerm app');
		setStatus('環境不支援', 'err');
		btnConnect.disabled = true;
		return false;
	}
	return true;
}

/* ── GATT 連線(含 Windows 首連 retry)── */
function gattConnectWithRetry(dev, tries) {
	return dev.gatt.connect().catch(function(e) {
		if (tries <= 1) throw e;
		say('GATT 連線失敗,重試中…(Windows 首次連線常見)');
		return new Promise(function(r) { setTimeout(r, 800); })
			.then(function() { return gattConnectWithRetry(dev, tries - 1); });
	});
}

function wireUp(server) {
	return server.getPrimaryService(NUS_SVC).then(function(svc) {
		return Promise.all([
			svc.getCharacteristic(NUS_RX),
			svc.getCharacteristic(NUS_TX)
		]);
	}).then(function(chars) {
		rxChar = chars[0];
		txChar = chars[1];
		txChar.addEventListener('characteristicvaluechanged', function(ev) {
			var dv = ev.target.value;
			term.write(new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength));
		});
		return txChar.startNotifications();
	}).then(function() {
		setStatus('已連線:' + (device.name || '(無名裝置,連線後名稱可能稍後出現)'), 'ok');
		setButtons('connected');
		say('已連上。輸入連線密碼後即進 console(輸入時不會回顯是正常的)');
		term.focus();
	});
}

function connectFlow(dev) {
	wantDisconnect = false;
	setButtons('connecting');
	setStatus('連線中…');
	return gattConnectWithRetry(dev, 3)
		.then(wireUp)
		.catch(function(e) {
			setStatus('連線失敗', 'err');
			setButtons(device ? 'dropped' : 'idle');
			say('連線失敗:' + e.message +
				'(常見原因:另一台手機/電腦連著 —— BLE 一次只能一個連線)');
		});
}

btnConnect.onclick = function() {
	if (!envCheck()) return;
	/* service filter:我們的廣播帶 128-bit NUS UUID,直接命中;
	 * 不用 acceptAllDevices —— chooser 雜訊少、也不多要權限 */
	navigator.bluetooth.requestDevice({ filters: [{ services: [NUS_SVC] }] })
		.then(function(dev) {
			device = dev;
			/* 意外斷線 → 顯示重連鈕(釘住同一 device,不重開 chooser) */
			dev.addEventListener('gattserverdisconnected', function() {
				rxChar = txChar = null;
				if (wantDisconnect) {
					setStatus('已斷線');
					setButtons('idle');
				} else {
					setStatus('連線中斷', 'err');
					setButtons('dropped');
					say('連線中斷(裝置關機/超出距離/被別的 client 搶走)。可按「重新連線」');
				}
			});
			return connectFlow(dev);
		})
		.catch(function(e) {
			/* NotFoundError = 使用者關掉 chooser 或掃不到 —— 不當錯誤刷屏 */
			if (e.name !== 'NotFoundError') say('選擇裝置失敗:' + e.message);
		});
};

btnReconnect.onclick = function() {
	if (device) connectFlow(device);
};

btnDisconnect.onclick = function() {
	wantDisconnect = true;
	if (device && device.gatt.connected) device.gatt.disconnect();
};

/* ── 鍵盤 → 裝置:寫入串行化 + 分塊 ── */
term.onData(function(data) {
	if (!rxChar) return;
	var bytes = new TextEncoder().encode(data);
	var i;
	for (i = 0; i < bytes.length; i += WRITE_CHUNK) {
		(function(chunk) {
			writeQueue = writeQueue.then(function() {
				if (!rxChar) return;
				/* 裝置端走 AcquireWrite(write command)→ 優先無回應寫,較快;
				 * 特性不支援時退回有回應寫 */
				return rxChar.properties.writeWithoutResponse
					? rxChar.writeValueWithoutResponse(chunk)
					: rxChar.writeValue(chunk);
			}).catch(function() { /* 斷線競態:丟棄該鍵,斷線事件會接手 UI */ });
		})(bytes.slice(i, i + WRITE_CHUNK));
	}
});

/* 開頁自檢 */
if (envCheck()) {
	say('按上方「選擇裝置並連線」開始。');
	navigator.bluetooth.getAvailability && navigator.bluetooth.getAvailability()
		.then(function(ok) {
			if (!ok) say('⚠️ 此電腦目前沒有可用的藍牙介面(未開藍牙?)');
		});
}
