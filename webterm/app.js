/*
 * AirTTY 網頁藍牙終端（Web Bluetooth + Nordic UART Service）
 *
 * 用瀏覽器透過 BLE 連進 AirTTY 裝置的序列 console，不必安裝軟體、不必配對。
 *
 * 安全性設計：本頁公開託管、給所有人使用，console 流量（含連線密碼）又全程流經
 * 本頁的 JavaScript，因此界線刻意畫得比一般網頁嚴格 —— 詳細承諾與可自行執行的
 * 稽核指令見同目錄 README.md「安全性」節，這裡只摘要三條鐵律：
 *
 *   ① 零使用者資料持久化：終端輸出、側錄、你打的指令、AI 問答內容，一律只存在
 *      「本次分頁的記憶體」，關頁即消。全檔沒有任何一行把使用者內容寫進
 *      localStorage / sessionStorage / IndexedDB / cookie。
 *      唯二的兩筆瀏覽器儲存是「字級」與「快捷鍵列展開狀態」兩個 UI 偏好
 *      （見 LS_FONT / LS_KEYS），值只有數字與 0/1，不含任何使用者內容。
 *   ② 零對外傳輸：本檔沒有任何對外的網路呼叫。AI 功能走「複製到剪貼簿 +
 *      開新分頁到官方聊天頁」，內容由你自己貼上、自己按送出，本頁不代送、不存 key。
 *      （唯一的例外在 sw.js，而它只對「本站自己的檔案」作用 —— README 有完整說明。）
 *   ③ 零外部資源：xterm.js 與 xterm.css 就放在同一個資料夾，不引用任何 CDN。
 *      整個目錄可下載後離線自架（作法見 README.md）。
 *
 * （「下載紀錄」「下載顯示結果」用的 Blob / URL.createObjectURL 與「貼上」「複製」
 *   用的 navigator.clipboard，都只在瀏覽器記憶體內作業，不產生任何網路請求。）
 *
 * 裝置端介面（決定本頁寫法的事實）：
 * - Nordic UART Service：service 6e400001-…、RX 6e400002（瀏覽器→裝置，write）、
 *   TX 6e400003（裝置→瀏覽器，notify）。
 * - 裝置廣播帶 128-bit NUS UUID，因此 requestDevice 用 service filter 就能直接
 *   命中，不必開放全部裝置。
 * - 選擇清單裡的裝置名稱：**依裝置端韌體版本而異**（與手機／瀏覽器、與藍牙介面卡型號
 *   都無關 —— 已實測兩種廣播路徑皆同）。
 *   舊版（韌體 v1.7 之前）BLE 廣播封包放不下裝置名稱 → 顯示「無名裝置」是常態；
 *   **v1.7 起**名稱改走 scan response（第二個 31-byte 封包）→ 直接顯示 `AirTTY-A1-xxxx`。
 *   ⇒ 本頁公開託管、買家手上什麼韌體都有，頁面文案與 README 對兩種情況都要能自圓其說，
 *   不可改寫成「一定看得到名稱」。
 * - 同時連線人數：**依裝置端韌體版本而異**（與名稱那條同理，公開託管什麼韌體都有）。
 *   **韌體 v1.7 起最多 2 條**（裝置端 blebridge `-M`，預設 2、硬上限 4）；
 *   **v1.7 之前只允許 1 條**。席次滿時裝置端會撤銷 BLE 廣播 → 第三台**掃不到**
 *   （刻意設計，非故障）。
 * - 兩人**同看同一畫面**，但**同時只有一條連線有寫入權**（裝置端 wsbridge 的獨佔鎖：
 *   先連者持有，持有者離線後自動交棒給最早連上的另一條）。
 *   ⚠️ BLE 這條路**沒有控制通道** ⇒ 唯讀者**無法主動接管**，裝置端只會送中文文字行
 *   通知；接管動線只做在管理介面的網頁終端。
 * - 連線密碼由裝置端把關。
 * - Windows 首次 GATT 連線常失敗 → 內建重試 ×3。
 * - 重新連線必須沿用同一個 BluetoothDevice 物件，否則多台並存時會連錯機器。
 * - 裝置端的 BLE 橋接把上行資料當純位元組轉發（0xFF 會被逃逸成 IAC IAC），
 *   所以「送出序列 Break」這種頻外訊號無法從 BLE 這條路做到 → Break 鈕停用。
 *
 * 相依：xterm.js v5.x（本目錄自帶）。用到的公開 API 僅 Terminal / write /
 * onData / focus / resize / options / element —— 已對照本目錄這份 bundle 確認。
 *
 * UI 原則（實測踩過坑後定下的）：
 * - 常用按鍵一律「按一下就送出」，不要求使用者記住兩段式操作；Ctrl 修飾模式
 *   只留作罕用組合的備援，放在最後一顆。
 * - 快捷鍵按鈕不使用 disabled、也不在 mousedown 玩 preventDefault：
 *   前者按了沒反應分不清是沒點到還是沒連線，後者在行動瀏覽器上會讓 click 不觸發。
 *   一律走單純的 click，按完 term.focus() 把焦點還給終端。
 * - 每次點擊都有按壓回饋 + 必要時的提示浮條（手機看不到 title tooltip）。
 */
'use strict';

var NUS_SVC = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
var NUS_RX  = '6e400002-b5a3-f393-e0a9-e50e24dcca9e'; /* client → 裝置 */
var NUS_TX  = '6e400003-b5a3-f393-e0a9-e50e24dcca9e'; /* 裝置 → client */

/* Web Bluetooth 不揭露協商後的 MTU → 寫入用保守分塊。20 = BLE 4.0 最小
 * ATT payload,任何協商結果下都安全;打字是單鍵單 byte,只有貼上會走分塊迴圈 */
var WRITE_CHUNK = 20;

/* 裝置端韌體目前沒有任何可從 BLE 觸發 Break 的頻外機制 → 恆為 false。
 * 韌體支援後把這裡改 true 並填 BREAK_SEQ 即可,其餘程式不用動。 */
var BREAK_SUPPORTED = false;

var LS_FONT = 'airtty.webterm.fontSize';
var LS_KEYS = 'airtty.webterm.keysOpen';
var FONT_MIN = 8, FONT_MAX = 24, FONT_DEFAULT = 14;

/* 紀錄緩衝上限:機房裡整天掛著也不該吃爆手機記憶體。
 * 超過就從最舊的那一塊丟起(環形),保留最新的內容。 */
var LOG_LIMIT = 2 * 1024 * 1024;

var elStatus = document.getElementById('status');
var btnConnect = document.getElementById('btnConnect');
var btnReconnect = document.getElementById('btnReconnect');
var btnDisconnect = document.getElementById('btnDisconnect');

var elToolbar = document.getElementById('toolbar');
var elKeyRow = document.getElementById('keyRow');
var elKbHint = document.getElementById('kbHint');
var elFontSize = document.getElementById('fontSize');
var elTermHost = document.getElementById('term');
var elToast = document.getElementById('toast');
var btnKeys = document.getElementById('btnKeys');
var btnCtrl = document.getElementById('btnCtrl');
var btnBreak = document.getElementById('btnBreak');
var btnPaste = document.getElementById('btnPaste');
var btnFontDown = document.getElementById('btnFontDown');
var btnFontUp = document.getElementById('btnFontUp');
var btnLog = document.getElementById('btnLog');

var term = new window.Terminal({
	cursorBlink: true, fontSize: FONT_DEFAULT, scrollback: 5000,
	theme: { background: '#000000' }
});
term.open(elTermHost);

var device = null;      /* 釘住的 BluetoothDevice(重連不重開 chooser) */
var rxChar = null;      /* write 目標 */
var txChar = null;      /* notify 來源 */
var wantDisconnect = false;   /* 區分「使用者按斷線」與「意外斷線」 */
var writeQueue = Promise.resolve();  /* GATT 同時只能一個操作 → 寫入串行化 */
var ctrlArmed = false;  /* Ctrl 修飾鍵:等待下一個鍵 */

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
	setKeysLive(state === 'connected');
}

/* 提示浮條:手機沒有 hover,title tooltip 看不到 → 所有即時回饋走這裡。
 * (終端內的 say() 只適合連線相關訊息,快捷鍵的回饋不該污染 console 畫面) */
var toastTimer = null;

function toast(msg, kind) {
	elToast.textContent = msg;
	elToast.className = 'show' + (kind ? ' ' + kind : '');
	if (toastTimer) clearTimeout(toastTimer);
	toastTimer = setTimeout(function() { elToast.className = ''; }, 2600);
}

var NOT_CONNECTED = '尚未連線 —— 請先按上方「🔗 選擇裝置並連線」';

/* 按壓回饋:CSS 的 :active 在部分 Android 瀏覽器上不一定看得到,
 * 這裡再補一個短暫的 class,讓使用者確定「有點到」*/
function flash(btn) {
	btn.classList.remove('flash');
	void btn.offsetWidth;   /* 強制 reflow,連按同一顆時才會重播 */
	btn.classList.add('flash');
	setTimeout(function() { btn.classList.remove('flash'); }, 170);
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

/* ── 送出位元組:鍵盤、快捷鍵、貼上共用的唯一出口 ──
 * 一律走同一條串行化佇列,避免多個來源同時對 GATT 下寫入(GATT 同時只能一個操作)。*/
function sendBytes(bytes) {
	var i;

	if (!rxChar || !bytes || !bytes.length) return;
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
}

function sendText(text) {
	sendBytes(new TextEncoder().encode(text));
}

/* ── 快捷鍵列 ──────────────────────────────────────────────
 * 手機沒有 Tab/Esc/Ctrl/方向鍵,這排按鈕是行動裝置操作 console 的主力。
 * 送出的位元組寫在 index.html 的 data-seq(16 進位),便於稽核。*/

function hexToBytes(hex) {
	var out = new Uint8Array(hex.length / 2), i;

	for (i = 0; i < out.length; i++)
		out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
	return out;
}

/* 未連線時「不」把按鈕設成 disabled —— disabled 的按鈕不會發出 click 事件,
 * 使用者按了完全沒反應,分不清是「沒點到」還是「沒連線」。
 * 改成:保持可按、視覺微暗,按下去用提示浮條講清楚原因。*/
function setKeysLive(live) {
	elToolbar.classList.toggle('notlive', !live);
	if (!live) setCtrlArmed(false);
}

function setCtrlArmed(on) {
	ctrlArmed = !!on;
	btnCtrl.classList.toggle('armed', ctrlArmed);
	btnCtrl.setAttribute('aria-pressed', ctrlArmed ? 'true' : 'false');
	elKbHint.textContent = ctrlArmed ? 'Ctrl 已按下 —— 請再敲一個鍵' : '';
}

/* 字元 → 控制碼。ASCII 的控制碼就是把 @A-Z[\]^_ 的高位清掉(& 0x1F),
 * 另外補上網管常按的幾個:Ctrl+? = DEL、Ctrl+Space/2 = NUL、Ctrl+6 = 0x1E。*/
function ctrlByte(ch) {
	var c;

	if (!ch) return null;
	if (ch === '?') return 0x7f;
	if (ch === ' ' || ch === '2') return 0x00;
	if (ch === '6') return 0x1e;
	if (ch === '3') return 0x1b;
	if (ch === '4') return 0x1c;
	if (ch === '5') return 0x1d;
	if (ch === '7' || ch === '/') return 0x1f;
	c = ch.toUpperCase().charCodeAt(0);
	if (c >= 0x40 && c <= 0x5f) return c & 0x1f;
	return null;
}

/* 事件模型:單純的 click,不玩 preventDefault。
 * (先前版本在 mousedown 擋預設行為想保住軟體鍵盤,實測在行動瀏覽器上
 *  連 click 都不會發 → 按鈕整排沒反應。改成按鈕 tabindex="-1" 不進 Tab 順序,
 *  送完 byte 直接呼叫 term.focus() 把焦點拉回終端。) */
(function wireKeyButtons() {
	var seqBtns = elKeyRow.querySelectorAll('button[data-seq]'), i;

	for (i = 0; i < seqBtns.length; i++) {
		seqBtns[i].addEventListener('click', function() {
			flash(this);
			if (!rxChar) { toast(NOT_CONNECTED, 'warn'); return; }
			/* 快捷鍵本身已經是控制序列,不吃 Ctrl 修飾 → 按了就解除等待狀態 */
			if (ctrlArmed) setCtrlArmed(false);
			sendBytes(hexToBytes(this.getAttribute('data-seq')));
			term.focus();
		});
	}

	btnCtrl.addEventListener('click', function() {
		flash(btnCtrl);
		if (!rxChar) { toast(NOT_CONNECTED, 'warn'); return; }
		setCtrlArmed(!ctrlArmed);   /* 再按一次可取消 */
		toast(ctrlArmed ? 'Ctrl 已按下 —— 請再敲一個鍵' : 'Ctrl 已取消');
		term.focus();
	});

	btnBreak.addEventListener('click', function() {
		flash(btnBreak);
		/* 手機看不到 tooltip → 用提示浮條講原因,而不是做成按了沒反應的死鈕 */
		if (!BREAK_SUPPORTED) {
			toast('藍牙路徑尚未支援 Break（獨立控制通道規劃中）。' +
				'請改用管理介面的網頁終端（可送 BREAK），或用支援 RFC 2217 的軟體連 4001 埠', 'warn');
			return;
		}
		if (!rxChar) { toast(NOT_CONNECTED, 'warn'); return; }
		term.focus();
	});
})();

/* ── 貼上 ──
 * 手機上很難叫出 xterm 自己的貼上;網管貼設定檔片段又是日常,
 * 所以多行一律先確認 —— 誤貼整頁設定到正式設備是會出事的。*/
function doPaste() {
	flash(btnPaste);
	if (!rxChar) { toast(NOT_CONNECTED, 'warn'); return; }
	if (!navigator.clipboard || !navigator.clipboard.readText) {
		toast('此瀏覽器不允許網頁讀取剪貼簿。請改用終端本身的貼上（桌機 Ctrl+Shift+V 或按右鍵）', 'warn');
		term.focus();
		return;
	}
	navigator.clipboard.readText().then(function(text) {
		var payload, bytes, lines, head, secs, msg;

		if (!text) { toast('剪貼簿是空的'); term.focus(); return; }
		/* 終端的 Enter 是 CR(0x0D)。CRLF/LF 一律轉成 CR,
		 * 否則多送的 LF 會在裝置端變成一行空白指令(xterm 自己的貼上也是這樣處理)。*/
		payload = text.replace(/\r\n|\r|\n/g, '\r');
		bytes = new TextEncoder().encode(payload);
		lines = (payload.match(/\r/g) || []).length +
			(payload.charAt(payload.length - 1) === '\r' ? 0 : 1);

		if (lines > 1) {
			head = payload.split('\r')[0];
			if (head.length > 60) head = head.slice(0, 60) + '…';
			msg = '即將送出 ' + lines + ' 行（共 ' + bytes.length + ' 位元組）到裝置。\n\n' +
				'第一行：' + head + '\n\n';
			/* BLE 一次只寫 20 bytes,大段貼上會慢 → 先給個心理準備 */
			secs = Math.round(bytes.length / 2000);
			if (secs >= 2) msg += '（藍牙傳輸較慢，預估需要約 ' + secs + ' 秒）\n\n';
			msg += '裝置會逐行執行，確定要送出嗎？';
			if (!window.confirm(msg)) { toast('已取消貼上'); term.focus(); return; }
		}
		if (ctrlArmed) setCtrlArmed(false);
		sendBytes(bytes);
		toast('已貼上 ' + lines + ' 行（' + bytes.length + ' 位元組）');
		term.focus();
	}).catch(function(e) {
		toast('讀取剪貼簿失敗：' + e.message + '（瀏覽器可能拒絕了剪貼簿權限）', 'warn');
		term.focus();
	});
}

/* ── 字級 ──
 * 序列 console 不會協商視窗大小,裝置端多半假設 80 欄 —— 改欄數只會讓
 * 裝置送來的換行位置對不上。所以寬度用「字級」調,欄數固定不動;
 * 只有列數會跟著容器高度重算(捲動範圍才會剛好填滿畫面)。*/
var fitTimer = null;

function fitRows() {
	var rowsEl, cellH, rows, cs, avail;

	try {
		rowsEl = term.element && term.element.querySelector('.xterm-rows');
		if (!rowsEl || !term.rows) return;
		/* 用實際畫出來的列高回推單列像素高,不去碰 xterm 的內部物件 */
		cellH = rowsEl.offsetHeight / term.rows;
		if (!(cellH > 4)) return;
		cs = window.getComputedStyle(elTermHost);
		avail = elTermHost.clientHeight -
			parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
		rows = Math.floor(avail / cellH);
		rows = Math.max(6, Math.min(200, rows));
		if (rows !== term.rows) term.resize(term.cols, rows);
	} catch (e) {
		/* 量不到就維持現有尺寸 —— 版面沒填滿而已,不影響連線與輸入 */
	}
}

function scheduleFit() {
	if (fitTimer) clearTimeout(fitTimer);
	fitTimer = setTimeout(function() { fitTimer = null; fitRows(); }, 120);
}

function applyFontSize(px, persist) {
	px = Math.min(FONT_MAX, Math.max(FONT_MIN, px | 0));
	term.options.fontSize = px;
	elFontSize.textContent = String(px);
	/* 到上下限只做視覺變暗,不設 disabled —— 同樣是為了讓「按了有回應」*/
	btnFontDown.classList.toggle('unavail', px <= FONT_MIN);
	btnFontUp.classList.toggle('unavail', px >= FONT_MAX);
	if (persist) {
		try { localStorage.setItem(LS_FONT, String(px)); } catch (e) { /* 無痕模式會擋,忽略 */ }
	}
	setTimeout(fitRows, 0);   /* 等 xterm 重新量完字寬字高再算列數 */
}

/* ── 連線紀錄 ──
 * 只收「裝置送來的輸出」(不含你打的字,所以密碼不會進紀錄)。
 * 在資料流這一側累積,不從 xterm 的畫面緩衝反推 —— 捲出 scrollback 的內容也留得住。*/
var logChunks = [];
var logLen = 0;
var logDecoder = new TextDecoder();   /* stream 模式:BLE 通知可能把一個 UTF-8 字元切成兩包 */

function logAppend(u8) {
	var s = logDecoder.decode(u8, { stream: true });

	if (!s) return;
	logChunks.push(s);
	logLen += s.length;
	while (logLen > LOG_LIMIT && logChunks.length > 1)
		logLen -= logChunks.shift().length;
}

/* 純文字化:拿掉終端控制碼,讓紀錄檔用一般文字編輯器就看得懂。
 * 只做「移除」不做畫面重演 —— 例如 --More-- 用 CR 覆寫的那行會留下空白,
 * 這比假裝重現畫面誠實,也不會誤刪內容。*/
var RE_OSC     = /\x1b\][\s\S]*?(?:\x07|\x1b\\)/g;      /* 視窗標題等 OSC 序列 */
var RE_CSI     = /\x1b\[[0-9;?<>=!]*[ -/]*[@-~]/g;      /* 顏色、游標移動等 CSI 序列 */
var RE_CHARSET = /\x1b[()*+][ -/]*[0-9A-Za-z]/g;        /* ESC ( B 之類的字元集指定 */
var RE_ESC2    = /\x1b[78=>MDEHc]/g;                    /* 存/取游標、小鍵盤模式等 */
var RE_CTRL    = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;   /* 其餘控制碼(保留 Tab 與換行) */

function toPlainText(raw) {
	return raw
		.replace(RE_OSC, '')
		.replace(RE_CSI, '')
		.replace(RE_CHARSET, '')
		.replace(RE_ESC2, '')
		.replace(/\r\n/g, '\n')
		.replace(/\r/g, '\n')
		.replace(RE_CTRL, '');
}

function two(n) { return (n < 10 ? '0' : '') + n; }

function stamp(d, dateSep, sep, timeSep) {
	return d.getFullYear() + dateSep + two(d.getMonth() + 1) + dateSep + two(d.getDate()) +
		sep + two(d.getHours()) + timeSep + two(d.getMinutes()) + timeSep + two(d.getSeconds());
}

function downloadLog() {
	flash(btnLog);
	if (!logLen) { toast('目前沒有可下載的紀錄 —— 連上並收到輸出後再試'); return; }

	var now = new Date();
	var devName = (device && device.name) ? device.name : 'AirTTY';
	var safeName = devName.replace(/[^A-Za-z0-9._-]+/g, '_');
	var body = toPlainText(logChunks.join(''));
	var header = '# AirTTY 網頁藍牙終端 —— 連線紀錄\n' +
		'# 裝置：' + devName + '\n' +
		'# 匯出時間：' + stamp(now, '-', ' ', ':') + '\n' +
		'# 內容：裝置端送出的畫面輸出（不含你輸入的按鍵，因此不會含連線密碼）。\n' +
		'#       已移除終端控制碼；緩衝上限 2 MB，超過時保留最新的部分。\n' +
		'# 本檔由瀏覽器在你的裝置上產生，未經任何網路傳輸。\n' +
		'# ' + '-'.repeat(60) + '\n';
	/* Blob + blob: URL 全在本頁記憶體內完成,不發出任何網路請求 */
	var blob = new Blob([header + body], { type: 'text/plain;charset=utf-8' });
	var url = URL.createObjectURL(blob);
	var a = document.createElement('a');

	a.href = url;
	a.download = safeName + '-' + stamp(now, '', '-', '') + '.txt';
	document.body.appendChild(a);
	a.click();
	document.body.removeChild(a);
	setTimeout(function() { URL.revokeObjectURL(url); }, 1000);
	toast('紀錄已下載：' + a.download);
	term.focus();
}

/* ── 工具列的收合 ──
 * 手機預設展開(沒有實體按鍵,快捷鍵列是必需品);桌機預設收起,少佔畫面。
 * 使用者按過就記住他的選擇。*/
function setToolbarOpen(open, persist) {
	elToolbar.classList.toggle('collapsed', !open);
	btnKeys.classList.toggle('active', !!open);
	btnKeys.setAttribute('aria-expanded', open ? 'true' : 'false');
	if (persist) {
		try { localStorage.setItem(LS_KEYS, open ? '1' : '0'); } catch (e) { /* 無痕模式會擋,忽略 */ }
	}
	setTimeout(fitRows, 0);
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
			/* 複製一份再交出去:xterm 的 write 是排隊非同步處理,
			 * 而事件裡的 DataView 背後緩衝區由瀏覽器的 BLE 堆疊持有 */
			var u8 = new Uint8Array(dv.buffer.slice(dv.byteOffset, dv.byteOffset + dv.byteLength));
			term.write(u8);
			logAppend(u8);
		});
		return txChar.startNotifications();
	}).then(function() {
		setStatus('已連線:' + (device.name || '(無名裝置,連線後名稱可能稍後出現)'), 'ok');
		setButtons('connected');
		say('已連上。輸入連線密碼後即進 console(輸入時不會回顯是正常的)');
		term.focus();
		fitRows();
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
				'(常見原因:連線人數已滿 —— 韌體 v1.7 起最多兩人、較舊韌體只能一人;' +
				'或距離太遠、裝置未開機)');
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
					say('連線中斷(裝置關機/超出距離/藍牙訊號中斷)。可按「重新連線」');
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

btnKeys.onclick = function() {
	setToolbarOpen(elToolbar.classList.contains('collapsed'), true);
};

btnPaste.onclick = doPaste;

btnFontDown.onclick = function() {
	flash(btnFontDown);
	if (term.options.fontSize <= FONT_MIN) { toast('已經是最小字級（' + FONT_MIN + '）'); return; }
	applyFontSize(term.options.fontSize - 1, true);
	term.focus();
};
btnFontUp.onclick = function() {
	flash(btnFontUp);
	if (term.options.fontSize >= FONT_MAX) { toast('已經是最大字級（' + FONT_MAX + '）'); return; }
	applyFontSize(term.options.fontSize + 1, true);
	term.focus();
};

btnLog.onclick = downloadLog;

window.addEventListener('resize', scheduleFit);
if (window.visualViewport)
	window.visualViewport.addEventListener('resize', scheduleFit);  /* 手機軟體鍵盤開合 */

/* ── 鍵盤 → 裝置 ── */
term.onData(function(data) {
	var b;

	if (!rxChar) return;
	if (ctrlArmed) {
		setCtrlArmed(false);
		b = ctrlByte(data.charAt(0));
		if (b === null) {
			say('Ctrl +「' + data.charAt(0) + '」沒有對應的控制碼,已照原樣送出');
		} else {
			sendBytes(new Uint8Array([b]));
			data = data.slice(1);
			if (!data) return;
		}
	}
	sendText(data);
});

/* ── 開頁自檢與初始狀態 ── */
(function init() {
	var savedFont = null, savedKeys = null, coarse;

	try {
		savedFont = localStorage.getItem(LS_FONT);
		savedKeys = localStorage.getItem(LS_KEYS);
	} catch (e) { /* 無痕模式會擋,用預設值即可 */ }

	applyFontSize(savedFont ? parseInt(savedFont, 10) : FONT_DEFAULT, false);

	coarse = !!(window.matchMedia &&
		window.matchMedia('(max-width: 820px), (pointer: coarse)').matches);
	setToolbarOpen(savedKeys === null ? coarse : savedKeys === '1', false);

	setKeysLive(false);
	setCtrlArmed(false);

	if (envCheck()) {
		say('按上方「選擇裝置並連線」開始。');
		navigator.bluetooth.getAvailability && navigator.bluetooth.getAvailability()
			.then(function(ok) {
				if (!ok) say('⚠️ 此電腦目前沒有可用的藍牙介面(未開藍牙?)');
			});
	}
})();
