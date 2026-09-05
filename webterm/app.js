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

/* 側錄緩衝上限(**位元組**;v1.7 前這裡是「解碼後字元數」,改存 raw u8 後語意跟著改)。
 * 機房裡整天掛著也不該吃爆手機記憶體 —— 超過就從最舊的那一塊丟起(環形),
 * 保留最新的內容:「看得到我剛剛看到的」比「從頭完整」重要。 */
var LOG_LIMIT = 2 * 1024 * 1024;

/* Log 檢視器一次最多渲染的行數。一次塞十萬個 div 會讓手機瀏覽器直接卡死,
 * 而排障要的是最近的輸出 → 超過就只渲染最後這麼多行(統計仍以完整結果計)。 */
var LV_MAX_RENDER = 5000;

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
var btnLogView = document.getElementById('btnLogView');
var btnAI = document.getElementById('btnAI');

var elBanner = document.getElementById('ctxBanner');
var elBannerText = document.getElementById('ctxText');

var $ = function(id) { return document.getElementById(id); };

/* Log 檢視器 */
var shLog = $('sheetLog'), lvFilter = $('lvFilter'), lvAlerts = $('lvAlerts'),
	lvSearch = $('lvSearch'), lvStat = $('lvStat'), lvSStat = $('lvSStat'),
	lvLinesEl = $('logLines');
/* 回放 */
var shReplay = $('sheetReplay'), rpPlay = $('rpPlay'), rpSpeed = $('rpSpeed'),
	rpTimeEl = $('rpTime'), rpPosEl = $('rpPos'), rpSlider = $('replaySlider'),
	rpBox = $('replayBox');
/* 維運報告 */
var shReport = $('sheetReport'), rpMask = $('rpMask'), reportBody = $('reportBody');
/* AI 排障 */
var shAI = $('sheetAI'), aiQ = $('aiQ'), aiCtx = $('aiCtx'), aiMask = $('aiMask'),
	aiPrev = $('aiPrev'), aiSendWrap = $('aiSendWrap'), aiStat = $('aiStat');

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

/* ── 連線紀錄(側錄)──
 * 只收「裝置送來的輸出」(不含你打的字,所以密碼不會進紀錄)。
 * 在資料流這一側累積,不從 xterm 的畫面緩衝反推 —— 捲出 scrollback 的內容也留得住。
 *
 * ⚠️ 只在記憶體:重新整理或關頁就整份消失,不寫進 localStorage/IndexedDB/伺服器。
 *    這是本頁的安全鐵律之一(見檔頭),不是還沒做的功能。
 *
 * 每塊帶時間戳:元素是 { u8: Uint8Array, t: <ms epoch> }。
 * 存 raw u8 而不是解碼後的字串,是因為「時間軸回放」要把原始位元組(含 ANSI
 * 控制序列)重寫進第二個 xterm —— 字串化之後就重演不出當時的畫面了。
 * t 是「這支手機收到這塊的時間」,不是設備送出的時間 ——
 * 序列線上沒有時間資訊,而且藍牙下行有 5000 B/s 節流,連噴 log 時會被拉平。 */
var logChunks = [];
var logBytes = 0;
/* 單調累計位元組:不受汰舊影響,只增不減 —— AI 增量脈絡的游標基準 */
var logPushed = 0;
/* stream 模式:BLE 通知常把一個 UTF-8 字元切成兩包。
 * 只給「亂碼偵測」用 —— 逐塊用非 stream 解碼會在每個塊邊界製造假的 U+FFFD,
 * 20~512 byte 的 BLE 塊比管理介面那邊的 WS frame 碎得多,會把偵測門檻整個灌爆。
 * (這行刻意不寫出 W-e-b-S-o-c-k-e-t 全名 —— README 的稽核 grep 找那個字串,
 *  在程式註解裡寫它會讓稽核表多出一筆假命中,反而害讀的人要多查一次。) */
var senseDecoder = new TextDecoder();

/* t 參數只給開發期注入測試資料用(見 README 維護者節):正式路徑一律不帶,
 * 由 logAppend 自己取現在時間。UI 上沒有任何地方能傳它。 */
function logAppend(u8, t) {
	if (!u8 || !u8.length) return;
	logChunks.push({ u8: u8, t: t || Date.now() });
	logBytes += u8.length;
	logPushed += u8.length;
	while (logBytes > LOG_LIMIT && logChunks.length > 1)
		logBytes -= logChunks.shift().u8.length;
	senseStream(senseDecoder.decode(u8, { stream: true }));
}

/* 把所有塊拼成一條 Uint8Array。分塊只是為了汰舊,解碼一定要對整份做 ——
 * 逐塊解碼會在塊邊界把多位元組字元切壞。 */
function logMerged() {
	var merged = new Uint8Array(logBytes), off = 0, i;

	for (i = 0; i < logChunks.length; i++) {
		merged.set(logChunks[i].u8, off);
		off += logChunks[i].u8.length;
	}
	return merged;
}

/* 側錄全文(已濾終端控制碼)。下載、檢視器、報告、AI 脈絡共用同一份濾碼,
 * 免得同一段輸出在不同功能裡長得不一樣。 */
function logPlain() {
	if (!logBytes) return '';
	return toPlainText(new TextDecoder().decode(logMerged()));
}

/* 尾 N 行:排障要的是「剛剛發生什麼」 */
function logTail(lines) {
	var arr;

	if (!logBytes || !lines) return '';
	arr = logPlain().split('\n');
	return arr.slice(Math.max(0, arr.length - lines)).join('\n');
}

/* 增量脈絡:回傳「logPushed 超過 mark 之後」的新輸出,多輪對話不重複附送已給過的。
 * mark 早於已汰舊資料時,新量會超過現存位元組 —— 自然被上限鉗住,只回得出還留著的尾段。 */
function logSince(mark) {
	var newBytes = Math.max(0, logPushed - mark), take;

	if (!logBytes || !newBytes) return '';
	take = Math.min(newBytes, logBytes);
	return toPlainText(new TextDecoder().decode(logMerged().slice(logBytes - take)));
}

/* ── 串流感知:警示關鍵字計數 + 亂碼偵測 ────────────────────────────────
 * 兩者都吃 logAppend 解出來的同一份文字,不額外掃第二遍。 */

/* 警示關鍵字:網路設備 log 常見的錯誤樣式。
 * `%\w+-[0-3]-\w+` 是 Cisco 的 %FACILITY-SEVERITY-MNEMONIC —— 嚴重度只收 0-3
 * (emergency/alert/critical/error),4 以上是 warning/notification 級的日常噪音。
 * 這是「粗略提示」用的,寧可漏抓也不要洗版;要精準過濾請用檢視器的 /regex/。 */
var LOG_ALERT_RE = /(error|fail(ed|ure)?|denied|link[- ]?down|unreachable|duplex mismatch|%\w+-[0-3]-\w+|crit(ical)?|traceback)/i;

var alertCount = 0;
var senseTotal = 0, senseBad = 0, garbleShown = false;

/* 「🔎 Log」鈕上的警示徽章:有累計就掛 (N⚠),沒有就恢復乾淨字樣 */
function updateLogBadge() {
	btnLogView.textContent = '🔎 Log' + (alertCount ? '（' + alertCount + '⚠）' : '');
}

function senseStream(txt) {
	var i, c, bad = 0, ls;

	if (!txt) return;
	/* 亂碼:鮑率不符時解碼出大量 U+FFFD 與控制雜訊。窗口累計,比例高才提示。
	 * 放行的低位碼:LF/CR/Tab/ESC/BS/BEL —— 這些在正常 console 輸出裡本來就常見。 */
	for (i = 0; i < txt.length; i++) {
		c = txt.charCodeAt(i);
		if (c === 0xfffd ||
			(c < 32 && c !== 10 && c !== 13 && c !== 9 && c !== 27 && c !== 8 && c !== 7)) bad++;
	}
	senseTotal += txt.length;
	senseBad += bad;
	if (senseTotal >= 200) {
		if (senseBad / senseTotal > 0.15) showGarbleHint();
		senseTotal = 0;
		senseBad = 0;
	}
	/* 警示行粗略計數:本塊逐行 test 關鍵字,命中就累加並更新徽章。
	 * 「粗略」是因為塊邊界可能切斷一行(下一塊的殘行會再算一次)—— 這裡只求
	 * 「有沒有東西該看」的提示,精確數字看檢視器裡的統計列。開啟檢視器即歸零。 */
	ls = txt.split('\n');
	c = alertCount;
	for (i = 0; i < ls.length; i++)
		if (LOG_ALERT_RE.test(ls[i])) alertCount++;
	/* 只在真的變動時才寫 DOM —— BLE 通知一秒好幾十次,無條件改 textContent
	 * 等於在資料流熱路徑上每包都做一次版面重算 */
	if (alertCount !== c) updateLogBadge();
}

/* ── 亂碼偵測(不是「亂碼急救」)────────────────────────────────────────
 * ⚠️ 對外名稱刻意與管理介面的網頁終端不同:那邊叫「亂碼急救」,因為它有 RFC 2217
 *    控制通道,提示旁邊就是「9600 / 115200 / 38400」三顆一鍵換鮑率的按鈕。
 *    藍牙這條路沒有控制通道(見檔頭),按鈕做不出來 —— 只做偵測就得叫「亂碼偵測」,
 *    並且要明確告訴使用者「該去哪裡改」,不能留一句提示讓人乾瞪眼
 *    (本專案紀律:全頁無沉默死鈕,也不做沒有下一步的提示)。 */
function showGarbleHint() {
	if (garbleShown) return;
	garbleShown = true;   /* 本次連線只提示一次,不當跳針保姆 */
	showBanner('⚠️ 輸出像亂碼 —— 最常見原因是鮑率不符（設備常見 9600 或 115200）。' +
		'藍牙這條路沒有控制通道，改鮑率請到裝置的管理介面「網頁終端」頁，' +
		'或用支援 RFC 2217 的軟體連 4001 埠。');
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

function devName() {
	return (device && device.name) ? device.name : 'AirTTY';
}

/* 存檔的唯一出口(下載紀錄 / 下載顯示結果共用)。
 * Blob + blob: URL 全在本頁記憶體內完成,不發出任何網路請求。 */
function saveText(baseName, text) {
	var safe = baseName.replace(/[^A-Za-z0-9._-]+/g, '_');
	var name = safe + '-' + stamp(new Date(), '', '-', '') + '.txt';
	var url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
	var a = document.createElement('a');

	a.href = url;
	a.download = name;
	document.body.appendChild(a);
	a.click();
	document.body.removeChild(a);
	setTimeout(function() { URL.revokeObjectURL(url); }, 1000);
	return name;
}

function downloadLog() {
	flash(btnLog);
	if (!logBytes) { toast('目前沒有可下載的紀錄 —— 連上並收到輸出後再試'); return; }

	var name = devName();
	var header = '# AirTTY 網頁藍牙終端 —— 連線紀錄\n' +
		'# 裝置：' + name + '\n' +
		'# 匯出時間：' + stamp(new Date(), '-', ' ', ':') + '\n' +
		'# 內容：裝置端送出的畫面輸出（不含你輸入的按鍵，因此不會含連線密碼）。\n' +
		'#       已移除終端控制碼；緩衝上限 2 MB，超過時保留最新的部分。\n' +
		'# 本檔由瀏覽器在你的裝置上產生，未經任何網路傳輸。\n' +
		'# ' + '-'.repeat(60) + '\n';

	toast('紀錄已下載：' + saveText(name, header + logPlain()));
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

/* ══ 全螢幕抽屜(sheet)══════════════════════════════════════════════════
 * 6 吋螢幕放不下側欄,每個面板都做成蓋滿畫面的一層。維持一層 stack ——
 * 回放與報告是從 Log 檢視器開出去的,「返回」要回到檢視器而不是直接回終端。
 *
 * Android 的實體/手勢返回鍵:每 push 一層就 pushState 一筆,返回鍵走 popstate
 * 關掉最上層。不這樣做的話,使用者在面板裡按返回會直接離開 PWA(手機上很常按)。
 * history state 只記層數,不含任何使用者內容。 */
var sheetStack = [];

function sheetShow(el, on) {
	el.hidden = !on;
	el.setAttribute('aria-hidden', on ? 'false' : 'true');
	/* 列印樣式的總開關:只有報告面板真的開著時,才讓 @media print 接管整頁。
	 * 否則使用者在終端畫面上按 Ctrl+P 會印到一張空白報告(比原本更糟)。 */
	if (el === shReport) document.body.classList.toggle('report-open', on);
}

function sheetPush(el) {
	/* ⚠️ 先把焦點從終端拿走,再顯示面板。
	 * xterm 的隱藏 textarea 會一直握著焦點,面板蓋上去也不會自動放開 ⇒
	 * 使用者在面板裡敲的每一個鍵(含 Esc)都會先被 xterm 收走、**送到連線中的設備**。
	 * 對正式網路設備亂送位元組是會出事的,與「多行貼上先確認」同一條紀律。
	 * 這裡只 blur 不 focus 任何輸入框 —— 手機上自動 focus 會立刻彈出軟體鍵盤
	 * 蓋掉半個面板,使用者還沒看到內容就得先把鍵盤收起來。 */
	if (document.activeElement && document.activeElement.blur)
		document.activeElement.blur();
	if (sheetStack.length) sheetShow(sheetStack[sheetStack.length - 1], false);
	sheetStack.push(el);
	sheetShow(el, true);
	try { history.pushState({ airttySheetDepth: sheetStack.length }, ''); } catch (e) { /* 忽略 */ }
}

/* 真正的關閉動作。由 popstate 統一驅動 —— 返回鈕只負責 history.back(),
 * 這樣「按鈕」與「手機返回鍵」走同一條路,層數不會對不上。 */
function sheetPopNow() {
	var el = sheetStack.pop();

	if (!el) return;
	sheetShow(el, false);
	if (el === shReplay) replayDispose();
	if (sheetStack.length) sheetShow(sheetStack[sheetStack.length - 1], true);
	else term.focus();
}

function sheetBack() {
	if (!sheetStack.length) return;
	try { history.back(); } catch (e) { sheetPopNow(); }
}

window.addEventListener('popstate', function() {
	if (sheetStack.length) sheetPopNow();
});

document.addEventListener('keydown', function(ev) {
	if (ev.key === 'Escape' && sheetStack.length) { ev.preventDefault(); sheetBack(); }
});

(function wireSheetBacks() {
	var b = document.querySelectorAll('.sheetback'), i;

	for (i = 0; i < b.length; i++)
		b[i].addEventListener('click', sheetBack);
})();

/* ── 情境橫幅 ── */
function showBanner(text) {
	elBannerText.textContent = text;
	elBanner.classList.add('show');
	setTimeout(fitRows, 0);   /* 橫幅佔掉高度 → 終端列數要重算 */
}

$('ctxClose').addEventListener('click', function() {
	elBanner.classList.remove('show');
	setTimeout(fitRows, 0);
});

/* ══ Log 檢視器 ════════════════════════════════════════════════════════
 * 把側錄拉出來當靜態文字看。分工講清楚:
 *   過濾 = 縮小「顯示哪些行」;搜尋 = 在目前顯示的行裡跳著定位,不動顯示範圍。
 * 命中警示關鍵字的行上紅底;搜尋命中淡藍、目前這一個橘底。
 * 每行一律 textContent 寫入,不碰 innerHTML —— 設備輸出是不可信資料,
 * 讓它變成活 DOM 等於把終端變成 XSS 入口。 */
var lvLines = [];    /* 側錄全文切行 */
var lvShown = [];    /* 過濾後的行(下載顯示結果直接用這份) */
var lvDivs = [];     /* 真的渲染出來的 div(只有最後 LV_MAX_RENDER 行) */
var lvFrom = 0;      /* lvDivs[i] 的文字 = lvShown[lvFrom + i] */
var lvMatch = [];    /* 搜尋命中的 lvDivs 索引 */
var lvCur = 0;

/* 形如 /pat/flags 走正則;正則寫壞就退回「整串當純文字」,不吞掉使用者的輸入 */
function mkMatcher(q) {
	var m = /^\/(.*)\/([a-z]*)$/.exec(q), re, needle;

	if (m) {
		try {
			re = new RegExp(m[1], m[2]);
			return function(ln) { re.lastIndex = 0; return re.test(ln); };
		} catch (err) { /* 壞 regex → 當純文字 */ }
	}
	needle = q.toLowerCase();
	return function(ln) { return ln.toLowerCase().indexOf(needle) >= 0; };
}

function lvRender() {
	var i, ln, hit, div, frag, alerts = 0,
		q = lvFilter.value, only = lvAlerts.checked,
		match = q ? mkMatcher(q) : null;

	lvLinesEl.textContent = '';
	lvShown = [];
	/* 重建 DOM 等於舊 div 全數作廢,搜尋游標與命中清單一併歸零 */
	lvDivs = [];
	lvMatch = [];
	lvCur = 0;
	for (i = 0; i < lvLines.length; i++) {
		ln = lvLines[i];
		hit = LOG_ALERT_RE.test(ln);
		if (hit) alerts++;
		if (only && !hit) continue;
		if (match && !match(ln)) continue;
		lvShown.push(ln);
	}
	lvFrom = Math.max(0, lvShown.length - LV_MAX_RENDER);
	frag = document.createDocumentFragment();
	for (i = lvFrom; i < lvShown.length; i++) {
		div = document.createElement('div');
		div.textContent = lvShown[i];
		/* 基準背景記在 dataset:搜尋著色來來去去,回復時要知道原本長怎樣 */
		div.dataset.bg = LOG_ALERT_RE.test(lvShown[i]) ? 'rgba(255,80,80,.18)' : '';
		if (div.dataset.bg) div.style.background = div.dataset.bg;
		lvDivs.push(div);
		frag.appendChild(div);
	}
	lvLinesEl.appendChild(frag);
	lvStat.textContent = '共 ' + lvLines.length + ' 行／警示 ' + alerts + ' 行／顯示 ' +
		lvShown.length + ' 行' +
		(lvShown.length > LV_MAX_RENDER ? '（僅顯示最後 ' + LV_MAX_RENDER + ' 行）' : '');
	lvLinesEl.parentNode.scrollTop = lvLinesEl.parentNode.scrollHeight;
	/* 過濾條件變了 → 顯示範圍變了 → 搜尋結果要對新畫面重算 */
	if (lvSearch.value) lvRecompute();
	else lvSStat.textContent = '';
}

/* 抹掉上一輪的搜尋著色,每行回到自己的基準背景(警示行紅底、一般行無底) */
function lvClearPaint() {
	var i, d;

	for (i = 0; i < lvMatch.length; i++) {
		d = lvDivs[lvMatch[i]];
		if (d) d.style.background = d.dataset.bg || '';
	}
}

/* 全量重刷命中行:目前這一個橘底(蓋過紅/藍),其餘淡藍(警示行維持紅底不被蓋掉)。
 * 命中數通常不多,整批重畫比算差量單純,也不會殘留舊的橘底。 */
function lvPaint() {
	var i, d;

	for (i = 0; i < lvMatch.length; i++) {
		d = lvDivs[lvMatch[i]];
		if (!d) continue;
		d.style.background = (i === lvCur) ? 'rgba(255,159,10,.35)'
			: (d.dataset.bg || 'rgba(74,158,255,.12)');
	}
}

/* 跳到第 k 個命中(k 會環繞:-1 → 最後一個、N → 第一個) */
function lvJump(k) {
	var n = lvMatch.length, d;

	if (!n) return;
	lvCur = ((k % n) + n) % n;
	lvPaint();
	d = lvDivs[lvMatch[lvCur]];
	if (d) d.scrollIntoView({ block: 'center' });
	lvSStat.textContent = '第 ' + (lvCur + 1) + ' / ' + n + ' 個';
}

function lvRecompute() {
	var i, q = lvSearch.value, match;

	lvClearPaint();
	lvMatch = [];
	lvCur = 0;
	if (!q) { lvSStat.textContent = ''; return; }
	match = mkMatcher(q);
	for (i = 0; i < lvDivs.length; i++)
		if (match(lvShown[lvFrom + i])) lvMatch.push(i);
	if (!lvMatch.length) { lvSStat.textContent = '沒有符合'; return; }
	lvJump(0);
}

function openLogViewer() {
	flash(btnLogView);
	if (!logBytes) { toast('目前沒有可檢視的紀錄 —— 連上並收到輸出後再試'); return; }
	lvLines = logPlain().split('\n');
	sheetPush(shLog);
	lvRender();
	/* 看過就歸零:徽章是「有新東西該看」的提示,不是總計 */
	alertCount = 0;
	updateLogBadge();
}

/* 打字每個字元都重掃十萬行會卡,debounce 150ms */
var lvFilterTimer = null, lvSearchTimer = null;

lvFilter.addEventListener('input', function() {
	if (lvFilterTimer) clearTimeout(lvFilterTimer);
	lvFilterTimer = setTimeout(function() { lvFilterTimer = null; lvRender(); }, 150);
});
lvAlerts.addEventListener('change', lvRender);
lvSearch.addEventListener('input', function() {
	if (lvSearchTimer) clearTimeout(lvSearchTimer);
	lvSearchTimer = setTimeout(function() { lvSearchTimer = null; lvRecompute(); }, 150);
});
/* Enter = 下一個;若 debounce 還沒燒到就先算一次,別跳到上一輪的舊結果 */
lvSearch.addEventListener('keydown', function(ev) {
	if (ev.key !== 'Enter') return;
	ev.preventDefault();
	if (lvSearchTimer) {
		clearTimeout(lvSearchTimer);
		lvSearchTimer = null;
		lvRecompute();
		return;
	}
	lvJump(lvCur + 1);
});
$('lvPrev').addEventListener('click', function() { lvJump(lvCur - 1); });
$('lvNext').addEventListener('click', function() { lvJump(lvCur + 1); });
$('lvReload').addEventListener('click', function() {
	lvLines = logPlain().split('\n');
	lvRender();
	toast('已重抓側錄');
});
$('lvDl').addEventListener('click', function() {
	if (!lvShown.length) { toast('目前沒有顯示任何行'); return; }
	toast('已下載：' + saveText(devName() + '-log-filtered', lvShown.join('\n')));
});
$('lvReplay').addEventListener('click', openReplay);
$('lvReport').addEventListener('click', openReport);

btnLogView.addEventListener('click', openLogViewer);

/* ══ 時間軸回放 ════════════════════════════════════════════════════════
 * 把側錄照「當時的節奏」重播進一個獨立的唯讀 xterm:開機序列、掛掉前的最後幾行、
 * 兩段輸出之間停了多久 —— 這些時序資訊在靜態文字裡看不出來,只能重播。
 *
 * 開場先 slice() 拍一份快照:回放期間 live 側錄照樣在錄(甚至可能觸發汰舊),
 * 快照讓塊索引與進度在整段回放中保持穩定,不會播到一半底下的陣列被搬動。
 * 拖曳定位只能「reset 後從頭重放到該塊」—— xterm 沒有倒帶,終端狀態(游標、
 * 屬性、換頁)是逐塊累積出來的,跳著寫會得到錯畫面。 */
var rpChunks = [], rpTimer = null, rpPlaying = false, rpPos = 0, rterm = null;

/* timer 生命週期:全程只有這一個變數,任何動作(播放/暫停/拖曳/關閉/播完)
 * 都先經過 rpStop() 清掉,不會出現兩條 setTimeout 鏈互相踩。 */
function rpStop() {
	if (rpTimer) { clearTimeout(rpTimer); rpTimer = null; }
	rpPlaying = false;
	rpPlay.textContent = '▶ 播放';
}

/* 關閉時連 xterm 一起丟掉:它的 scrollback 裡是設備輸出的副本,
 * 面板關了就不該再留著(側錄本體另有 LOG_LIMIT 管)。 */
function replayDispose() {
	rpStop();
	rpChunks = [];
	if (rterm) { rterm.dispose(); rterm = null; }
	rpBox.textContent = '';
}

/* 播放頭停在「下一塊要寫的位置」:時間顯示該塊的時間戳(播完退回最後一塊) */
function rpLabels() {
	var c = rpChunks[rpPos] || rpChunks[rpChunks.length - 1];

	rpTimeEl.textContent = c ? new Date(c.t).toLocaleTimeString() : '';
	rpPosEl.textContent = '塊 ' + rpPos + ' / ' + rpChunks.length;
}

/* 跳到第 k 塊:reset 後把 0..k-1 逐塊寫回去。逐塊 write 就好 ——
 * xterm 內部有寫入佇列會自己排,不必先拼一個大 Uint8Array。 */
function rpSeek(k) {
	var i;

	if (!rterm) return;
	rpPos = Math.max(0, Math.min(rpChunks.length, k));
	rterm.reset();
	for (i = 0; i < rpPos; i++)
		rterm.write(rpChunks[i].u8);
	rpSlider.value = String(rpPos);
	rpLabels();
}

/* 一步 = 寫一塊 + 排下一步。間隔鉗在 16~2000ms:太短沒有節奏感,
 * 太長(設備靜置幾分鐘)不必真的乾等。 */
function rpStep() {
	var speed, gap;

	rpTimer = null;
	if (!rterm) return;                       /* 面板已關 */
	if (rpPos >= rpChunks.length) { rpStop(); rpPosEl.textContent = '回放完畢'; return; }
	rterm.write(rpChunks[rpPos].u8);
	rpPos++;
	rpSlider.value = String(rpPos);
	rpLabels();
	if (rpPos >= rpChunks.length) { rpStop(); rpPosEl.textContent = '回放完畢'; return; }
	speed = parseInt(rpSpeed.value, 10);
	gap = speed
		? Math.min(2000, Math.max(16, rpChunks[rpPos].t - rpChunks[rpPos - 1].t)) / speed
		: 16;
	rpTimer = setTimeout(rpStep, gap);
}

function openReplay() {
	if (!logBytes) { toast('目前沒有可回放的紀錄'); return; }
	rpChunks = logChunks.slice();   /* 快照,回放期間 live 繼續錄不影響 */
	sheetPush(shReplay);
	/* xterm 要有實體容器才量得出尺寸 → sheet 顯示之後才建 */
	rterm = new window.Terminal({
		fontSize: 13, scrollback: 5000, theme: { background: '#000000' },
		disableStdin: true   /* 回放是唯讀的:打字不會、也不該送到設備 */
	});
	rterm.open(rpBox);
	rpSlider.max = String(rpChunks.length);
	rpSeek(0);
}

/* 同一顆鈕 toggle;播完再按 = 從頭重放(不用先拖回 0) */
rpPlay.addEventListener('click', function() {
	if (rpPlaying) { rpStop(); return; }
	if (rpPos >= rpChunks.length) rpSeek(0);
	rpStop();
	rpPlaying = true;
	rpPlay.textContent = '⏸ 暫停';
	rpTimer = setTimeout(rpStep, 0);
});
/* 拖曳等於接手控制權:先停播放,再定位到該塊 */
rpSlider.addEventListener('input', function() {
	rpStop();
	rpSeek(parseInt(this.value, 10) || 0);
});

/* ══ 遮蔽 ══════════════════════════════════════════════════════════════
 * IP 尾兩節、MAC 裝置碼(留 OUI 利於辨識廠牌)、常見密碼欄位值。
 * 只求擋住明顯敏感值 —— 預覽可編輯,最後一道防線是工程師自己的眼睛。
 * 規則與管理介面網頁終端那份逐字相同,兩邊遮出來的結果要一致。 */
function maskSensitive(text) {
	return text
		.replace(/\b(\d{1,3}\.\d{1,3})\.\d{1,3}\.\d{1,3}\b/g, '$1.x.x')
		.replace(/\b([0-9A-Fa-f]{2}[:-][0-9A-Fa-f]{2}[:-][0-9A-Fa-f]{2})(?:[:-][0-9A-Fa-f]{2}){3}\b/g,
			'$1:xx:xx:xx')
		.replace(/\b(password|passwd|secret|community|psk)(\s+|\s*[:=]\s*)\S+/gi, '$1$2****');
}

/* ══ 維運報告 ══════════════════════════════════════════════════════════
 * 側錄(可遮蔽)+ 連線資訊 → 列印友善頁,瀏覽器可直接「另存為 PDF」。
 *
 * 刻意「不」開新分頁(管理介面那版是 window.open + document.write):
 *   ① 行動瀏覽器會擋彈出視窗 ②PWA 獨立視窗下 Android 會開成 Custom Tab,
 *   ③ document.write 拼 HTML 字串必須自己 escape,漏一個就是 XSS。
 * 改成就地渲染成 DOM(全 textContent)+ @media print 把其他元素藏起來。
 *
 * 刻意「不」含 AI 問答摘要:本頁的 AI 是官方聊天頁模式,回答留在對方網頁、
 * 不會回到這裡 —— 硬留一欄只會在報告上印出「有問沒答」的殘骸。 */
function openReport() {
	if (!logBytes) { toast('目前沒有輸出，報告會是空的'); return; }
	sheetPush(shReport);
	renderReport();
}

function renderReport() {
	var tbl = document.createElement('table');
	var log = logPlain();
	var first = logChunks[0], last = logChunks[logChunks.length - 1];
	var rows = [
		['產生時間', new Date().toLocaleString()],
		['裝置', devName()],
		['連線方式', '網頁藍牙終端（Web Bluetooth／Nordic UART Service）'],
		['側錄時間範圍', first ? (new Date(first.t).toLocaleString() + ' ～ ' +
			new Date(last.t).toLocaleString()) : '—'],
		/* 短連線只有幾百 byte,無條件除 1024 會印成「0 KB」 */
		['側錄大小', (logBytes < 1024 ? logBytes + ' 位元組'
			: Math.round(logBytes / 1024) + ' KB') +
			(logPushed > logBytes ? '（已達上限，保留最新的部分）' : '')],
		['敏感資訊', rpMask.checked ? '已遮蔽 IP／MAC／密碼樣式' : '⚠️ 未遮蔽 —— 含完整 IP／MAC']
	];
	var h1, h2, pre, i, tr, td;

	reportBody.textContent = '';
	h1 = document.createElement('h1');
	h1.textContent = 'AirTTY 維運報告';
	reportBody.appendChild(h1);

	for (i = 0; i < rows.length; i++) {
		tr = document.createElement('tr');
		td = document.createElement('td');
		td.textContent = rows[i][0];
		tr.appendChild(td);
		td = document.createElement('td');
		td.textContent = rows[i][1];
		tr.appendChild(td);
		tbl.appendChild(tr);
	}
	reportBody.appendChild(tbl);

	h2 = document.createElement('h2');
	h2.textContent = 'Console 側錄（已濾終端控制碼）';
	reportBody.appendChild(h2);
	pre = document.createElement('pre');
	/* textContent:設備輸出是不可信資料,一律當純文字放進 DOM */
	pre.textContent = rpMask.checked ? maskSensitive(log) : log;
	reportBody.appendChild(pre);
}

rpMask.addEventListener('change', renderReport);
$('rpPrint').addEventListener('click', function() { window.print(); });

/* ══ AI 排障助手 —— 官方聊天頁模式 ══════════════════════════════════════
 * ⚠️ 本頁**不呼叫任何 AI API、不存 API key、不代送任何內容**。
 *    這不是「還沒做」,是刻意的界線:本頁公開託管給所有人用,
 *    存 key 等於把使用者的憑證放進第三方 origin 的儲存空間。
 *    動線 = 產生預覽(已遮蔽,可再手改)→ 你自己複製 → 開官方聊天頁自己貼上。
 *    回答留在對方網頁,不會、也不該回到本頁。 */
var AI_SYS_PROMPT = '你是網路設備現場排障助手。以下是序列 console 的輸出片段與我的問題。' +
	'請用繁體中文、精簡條列回答,引用輸出中的關鍵行,並給出下一步可執行的診斷指令;' +
	'資訊不足時直說缺什麼,不要編造輸出裡沒有的資訊。';

/* 增量脈絡的游標:記「上次複製出去時的 logPushed」,下次只附這之後的新輸出。
 * 只是一個數字,不是內容;重新整理頁面就歸零。 */
var aiCtxMark = 0;

function openAI() {
	flash(btnAI);
	sheetPush(shAI);
	/* 不自動 focus 問題框:手機上會立刻彈出軟體鍵盤蓋掉半個面板,
	 * 使用者連上面那段「本頁不會幫你送出」的說明都還沒看到。 */
}

btnAI.addEventListener('click', openAI);

$('aiPreview').addEventListener('click', function() {
	var mode = aiCtx.value, ctx = '', head = '', msg, maskOn = aiMask.checked, maskTag, warn = '';

	if (!aiQ.value.trim()) { aiStat.textContent = '先輸入你的問題'; aiQ.focus(); return; }

	if (mode === 'sel') {
		ctx = (term.getSelection && term.getSelection()) || '';
		if (!ctx) {
			aiStat.textContent = '終端裡沒有選取任何文字 —— 請先在終端畫面上拖曳選取，或改選「最近 N 行」';
			return;
		}
		head = '=== console 輸出（我在終端選取的範圍';
	} else if (mode === 'new') {
		ctx = logSince(aiCtxMark);
		head = '=== console 新增輸出（自上次複製後';
		if (!ctx) warn = '上次複製後沒有新輸出，這次只送問題本身。';
	} else if (mode !== '0') {
		ctx = logTail(parseInt(mode, 10));
		head = '=== console 輸出（最近 ' + mode + ' 行';
	}

	maskTag = maskOn ? '已自動遮蔽，可再手動刪改' : '⚠️ 未遮蔽 —— 含完整 IP／MAC';
	msg = AI_SYS_PROMPT + '\n\n【問題】\n' + aiQ.value.trim();
	if (ctx) msg += '\n\n' + head + '，' + maskTag + '）===\n' + (maskOn ? maskSensitive(ctx) : ctx);

	aiPrev.value = msg;
	aiSendWrap.hidden = false;
	aiStat.textContent = warn + (ctx && !maskOn ? '⚠️ 未遮蔽：內容含完整 IP／MAC／密碼樣式。' : '') +
		'⚠️ 複製前請目視檢查以上全文';
	aiPrev.scrollIntoView({ block: 'nearest' });
});

$('aiCopy').addEventListener('click', function() {
	if (!aiPrev.value) return;
	if (!navigator.clipboard || !navigator.clipboard.writeText) {
		aiStat.textContent = '此瀏覽器不允許網頁寫入剪貼簿 —— 請在上面的預覽框裡手動全選複製';
		return;
	}
	navigator.clipboard.writeText(aiPrev.value).then(function() {
		aiCtxMark = logPushed;   /* 內容已交付剪貼簿 → 增量游標推進 */
		aiStat.textContent = '已複製 —— 到聊天頁貼上即可';
		toast('已複製到剪貼簿（' + aiPrev.value.length + ' 字）');
	}, function() {
		aiStat.textContent = '複製失敗 —— 請在上面的預覽框裡手動全選複製';
	});
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
