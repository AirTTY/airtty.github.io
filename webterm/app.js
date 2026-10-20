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
 *      只有四類瀏覽器儲存，是「字級」「快捷鍵列展開狀態」「送 Break 前先確認」
 *      「每台 AirTTY 上次選的孔」四個 UI 偏好（見 LS_FONT / LS_KEYS / LS_BREAK_CONFIRM /
 *      LS_PORT_PREFIX；最後一類每台一筆，鍵是裝置名稱尾碼），值只有數字與 0/1，不含任何使用者內容。
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
 *   ⚠️ 唯讀者**無法主動接管**，裝置端只會送中文文字行通知；接管動線只做在管理介面。
 *   ~~舊理由：「BLE 這條路沒有控制通道」~~ —— 韌體 v1.8 起**有**控制通道了（見下一條），
 *   但**接管刻意沒放進去**：那條通道的授權是「繼承這條連線既有的權限」，
 *   而接管的本質是「取得自己原本沒有的權限」，兩者安全模型不同，不可混在一起。
 * - 連線密碼由裝置端把關。
 * - Windows 首次 GATT 連線常失敗 → 內建重試 ×3。
 * - 重新連線必須沿用同一個 BluetoothDevice 物件，否則多台並存時會連錯機器。
 * - **序列埠控制通道:依裝置端韌體版本而異**（與名稱那條同理，公開託管什麼韌體都有）。
 *   **韌體 v1.8 起**多兩顆特徵值（`6e400004` 寫入、`6e400005` 通知），可換鮑率、
 *   送 Break、控 DTR／RTS、讀 modem 狀態；**v1.8 之前完全沒有**。
 *   ⚠️ 因此探索這兩顆一律容錯（`.catch(() => null)`）：舊韌體 `getCharacteristic`
 *   會 reject，沒接住就會讓**所有舊韌體的使用者連不上**，這是本功能最容易造成的迴歸。
 *   找不到 → `ctlAvail=false`，整組控制功能**隱藏**（不做半套死鈕）。
 *   ~~舊敘述：「裝置端把上行資料當純位元組轉發（0xFF 會被逃逸成 IAC IAC），
 *   所以送出序列 Break 這種頻外訊號無法從 BLE 這條路做到 → Break 鈕停用」~~
 *   —— 序列資料通道確實仍是如此，但控制訊號現在走**另一條特徵值**，不受影響。
 * - 控制通道的權限**完全由裝置端把關**，本頁不做任何權限判斷：沒登入 → 回
 *   not-ready；不是寫入權持有者 → 送出去但沒生效（回 timeout）。
 *   ⚠️「沒生效」**不可以**顯示成成功 —— 使用者會以為換好了，然後對著還是亂碼的
 *   畫面查半天。
 * - **列出序列埠 → 選孔：依裝置端韌體版本而異**（與名稱那條同理）。
 *   **韌體 v1.9.0 起**序列埠以「插孔」命名（機身 USB、hub 第 1～4 孔），裝置端等「列出／選孔」
 *   命令（或 1.5 秒保底）才接序列埠：本頁連上後先問「現在哪些孔有線」，0 條講原因並斷線、
 *   1 條自動接、多條列出來讓人點（預設勾這台上次選的）。選的孔不通時裝置會先送 0xA2 事件與
 *   一行說明再斷線。**v1.8.11 以前**連上就固定接第一個埠位，不認得這兩個命令
 *   （實測回 not-ready 或 bad-frame）→ 本頁照常連、多講一行「先連預設的孔」。
 *   ⚠️ **絕不自動改接另一個孔**：選的孔不通就說不通，讓人自己選 ——
 *   悄悄落到別台設備，正是 AI 設錯交換器那種事故（OpenWRT repo checklist #233）。
 *   （v17 用固定的兩項下拉選埠，從未發布；v18 起改成連上後動態列出。）
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

/* ── 控制通道(裝置端韌體 v1.8 起)──────────────────────────────────────
 * 兩顆額外的特徵值,與序列資料**完全分流**(序列裝置的輸出因此無法偽造控制事件)。
 * ⚠️ **舊韌體沒有這兩顆** → 探索一律容錯,拿不到就 ctlAvail=false、
 * 整組控制功能隱藏。本頁公開託管、買家手上什麼韌體都有,不可假設一定有。
 * 裝置端把這裡送出的小訊框翻譯成序列埠控制指令塞進既有的那條連線,
 * 所以權限與認證**完全沿用裝置端既有那一套**:沒登入 → not-ready、
 * 不是寫入權持有者 → 逾時未生效。本頁自己不做任何權限判斷。 */
var CTL_RX  = '6e400004-b5a3-f393-e0a9-e50e24dcca9e'; /* 瀏覽器 → 裝置,write */
var CTL_TX  = '6e400005-b5a3-f393-e0a9-e50e24dcca9e'; /* 裝置 → 瀏覽器,notify */

/* Web Bluetooth 不揭露協商後的 MTU → 寫入用保守分塊。20 = BLE 4.0 最小
 * ATT payload,任何協商結果下都安全;打字是單鍵單 byte,只有貼上會走分塊迴圈。
 * ⚠️ 2026-09-06:這一行曾在改寫上面那段常數註解時**被誤刪**,結果是
 * sendBytes 每次都拋 ReferenceError ⇒ 鍵盤一個位元組都送不出去、
 * 裝置端整條 session 沒有任何 AcquireWrite。**動這區塊時逐行對照 git diff**。 */
var WRITE_CHUNK = 20;

/* 控制訊框:[ver=1][cmd][len][payload…];回應 [ver][cmd|0x80][status][payload…] */
var CTL_VER = 1;
var C_BAUD = 0x01, C_DATA = 0x02, C_PARITY = 0x03, C_STOP = 0x04,
	C_BREAK = 0x05, C_DTR = 0x06, C_RTS = 0x07, C_STATE = 0x10;
var EV_MODEM = 0xa0, EV_READY = 0xa1;

/* ── 選孔判定 begin(純函式;OpenWRT repo scripts/test/webterm-port-select.test.js 抽出來在 vm 裡跑)── */
/* 控制通道的「列出序列埠」「選孔」命令與裝置端事件(韌體 v1.9.0 起;
 * OpenWRT repo docs/plans/port-identity-redesign.md §8.1、附錄 B.3,裝置端編碼器 src/airtty-blebridge/ble_ports.h):
 *   送   [1][0x09][0]                          列出「此刻有線」的孔
 *   回   [1][0x89][0][idx][flags][n][標籤片段]  每孔一則或多則(每則 ≤ 20 bytes;flags bit0 = 這孔的標籤還有下一段,
 *                                             把同一孔的片段**位元組**接起來再以 UTF-8 解碼);最後 [1][0x89][0][0xFF] 結尾
 *   送   [1][0x08][1][idx]                     選孔
 *   回   [1][0x88][status][idx]                0 = 好,正在接;4 = 沒有這個孔、或這孔此刻沒線;5 = 這條連線已接上別的孔(payload = 目前的孔)
 *   事件 [1][0xA2][0][idx][reason]             選的孔不通,裝置隨後斷線。reason 1 = 沒有人在聽、2 = 一連上就關;
 *                                             idx 0xFF = 本頁沒選孔(例:列出命令沒送到)、裝置保底時發現沒有任何孔有線
 *   idx   = Telnet 埠 − 4000:0 = 機身 USB、1～9 = hub 第 N 孔、11～18 = 它牌 hub 埠 N;0xFF = 沒有
 *   flags = bit1 有人持寫入鎖(韌體 v1.9.0 尚未提供,恆 0)、bit2 要連線密碼、bit3 維護中、bit4 它牌 hub(埠號未校正)
 * ⚠️ 舊韌體(v1.8.11 以前)不認得 0x09 / 0x08:認證前回 status 1(not-ready)、認證後回 3(bad-frame)
 *    [實測 2026-10-15,0x08;0x09 走同一條路]。新韌體對這兩個命令**絕不回 1 或 3** ⇒「1 或 3 = 舊韌體」可以當判準;
 *    沒回應同樣當舊韌體。 */
var C_SELECT = 0x08, C_LIST = 0x09, EV_BACKEND_DOWN = 0xa2;
var ST_SEL_BADARG = 4, ST_SEL_ALREADY = 5;
var IDX_NONE = 0xff;
var PF_MORE = 0x01, PF_LOCK = 0x02, PF_MAINT = 0x08, PF_OTHER = 0x10;

/* 孔名(畫面由本頁自己畫,不走空中 —— §8.1)。0 是機身 USB,不是「沒有」 */
function socketName(idx) {
	if (idx === 0) return '機身 USB';
	if (idx >= 1 && idx <= 9) return 'hub 第 ' + idx + ' 孔';
	if (idx >= 11 && idx <= 18) return '它牌 hub 埠 ' + (idx - 10);
	if (idx === IDX_NONE) return '（沒有序列線）';
	return '孔 ' + idx;
}

/* 中文接在孔名後面時,孔名以英數結尾(「機身 USB」)要空一格:「機身 USB 連不上」「hub 第 2 孔連不上」 */
function nameSp(name) {
	return /[A-Za-z0-9]$/.test(name) ? name + ' ' : name;
}

/* 清單上一個孔的顯示文字:「hub 第 2 孔 — 核心SW」(標籤空就只有孔名)+ 狀態記號。晶片名裝置不送(§8.1) */
function socketText(p) {
	var t = socketName(p.idx) + (p.label ? ' — ' + p.label : '');

	if (p.flags & PF_LOCK) t += ' 🔒';
	if (p.flags & PF_MAINT) t += ' 🔧 維護中';
	if (p.flags & PF_OTHER) t += ' ⚠️ 埠號未校正';
	return t;
}

/* LIST 回覆的累加器。listAccPush 回 'more'(還沒完)| 'done'(收到結尾)| 'old'(status 非 0:舊韌體)| 'bad'(格式錯) */
function listAccNew() {
	return { order: [], parts: {}, flags: {}, open: -1 };
}

function listAccPush(acc, u8) {
	var idx, fl, n, i, a;

	if (!u8 || u8.length < 3 || u8[0] !== CTL_VER || u8[1] !== (C_LIST | 0x80)) return 'bad';
	if (u8[2] !== 0) return 'old';
	if (u8.length < 4) return 'bad';
	idx = u8[3];
	if (idx === IDX_NONE) return acc.open < 0 ? 'done' : 'bad';   /* 標籤還沒完就結尾 = 格式錯 */
	if (u8.length < 6) return 'bad';
	fl = u8[4];
	n = u8[5];
	if (u8.length !== 6 + n) return 'bad';
	if (acc.open !== idx) {
		/* 新的一孔:上一孔必須已經收完、這孔不可以出現過 */
		if (acc.open >= 0 || acc.parts[idx]) return 'bad';
		acc.order.push(idx);
		acc.parts[idx] = [];
	}
	a = acc.parts[idx];
	for (i = 0; i < n; i++) a.push(u8[6 + i]);
	acc.flags[idx] = fl & ~PF_MORE;
	acc.open = (fl & PF_MORE) ? idx : -1;
	return 'more';
}

function listAccResult(acc) {
	return acc.order.map(function(idx) {
		var label = '';

		try { label = new TextDecoder('utf-8').decode(Uint8Array.from(acc.parts[idx])); }
		catch (e) { label = ''; }
		return { idx: idx, flags: acc.flags[idx], label: label };
	});
}

/* LIST 結果分類。r = ctlList resolve 的 {status, ports, bad};e = reject 的 Error(兩者擇一)。
 *   ok        清單在 ports(可能是空的)
 *   old       舊韌體(status 1 / 3 或其他非 0)—— 照常連,講一行「先連預設的孔」
 *   timeout   沒回應 —— 同舊韌體處理(韌體 v1.8.0 起的控制通道對不認得的命令都會回 1 / 3,沒回應多半是更舊或通訊異常)
 *   writefail 命令沒寫進去(GATT 錯誤)—— 裝置沒收到 ⇒ 新韌體會自己在 1.5 秒保底接預設孔
 *   bad       清單格式不對 */
function classifyList(r, e) {
	if (e) return { kind: e.message === 'local-timeout' ? 'timeout' : 'writefail', ports: [] };
	if (!r) return { kind: 'timeout', ports: [] };
	if (r.status !== 0) return { kind: 'old', ports: [] };
	if (r.bad) return { kind: 'bad', ports: [] };
	return { kind: 'ok', ports: r.ports || [] };
}

/* 選孔結果分類。r = ctlRequest resolve 的 {status, actual};e = reject 的 Error(兩者擇一)。
 * 回 { kind, slot }:ok / badslot(4:沒這孔或沒線)/ other(5:已先接上別的孔,slot = 那一孔)/
 * unsupported(1、3、沒回應)/ writefail(GATT 錯誤) */
function classifySelect(r, e, chosen) {
	if (e) return { kind: e.message === 'local-timeout' ? 'unsupported' : 'writefail', slot: chosen };
	if (!r) return { kind: 'unsupported', slot: chosen };
	if (r.status === 0) return { kind: 'ok', slot: chosen };
	if (r.status === ST_SEL_BADARG) return { kind: 'badslot', slot: chosen };
	if (r.status === ST_SEL_ALREADY) {
		if (r.actual === chosen) return { kind: 'ok', slot: chosen };
		return { kind: 'other', slot: typeof r.actual === 'number' ? r.actual : IDX_NONE };
	}
	return { kind: 'unsupported', slot: chosen };   /* 1、3 與任何不認得的狀態 */
}

/* 拍板題 8:只有一條線 ⇒ 自動接它;多條 ⇒ 不自動,預設勾「這台上次選的」(還在清單裡才勾)。
 * 回 { auto: idx | null, pre: idx | null } */
function pickSocket(ports, remembered) {
	var i;

	if (!ports || !ports.length) return { auto: null, pre: null };
	if (ports.length === 1) return { auto: ports[0].idx, pre: ports[0].idx };
	for (i = 0; i < ports.length; i++)
		if (ports[i].idx === remembered) return { auto: null, pre: remembered };
	return { auto: null, pre: null };
}

/* 「這台」的鍵:裝置名稱的尾碼(AirTTY-A1-52C8 → 52C8,與廣播裡的識別碼同一個);
 * 沒有名稱(很舊的韌體)退回瀏覽器給的 device.id(每個網站各一個,不跨站)。都沒有 ⇒ null = 不記 */
function deviceKey(dev) {
	var m;

	if (dev && typeof dev.name === 'string') {
		m = /-([0-9A-Fa-f]{4,6})$/.exec(dev.name);
		if (m) return m[1].toUpperCase();
	}
	if (dev && typeof dev.id === 'string' && dev.id)
		return 'id:' + dev.id.replace(/[^A-Za-z0-9+\/=_-]/g, '').slice(0, 64);
	return null;
}

/* 0xA2 的 payload → { slot, reason };格式不對回 null(控制通道出事不得波及終端) */
function parseBackendDown(payload) {
	if (!payload || payload.length < 2) return null;
	return { slot: payload[0], reason: payload[1] };
}

/* 0xA2 的說明。只講裝置**確定知道**的事:哪一孔、沒人在聽 / 一連上就關 */
function backendDownText(d) {
	var p;

	if (d.slot === IDX_NONE)
		return '這台 AirTTY 目前沒有接任何序列線 —— 請接上轉接線後按「↻ 重新連線」';
	p = 'AirTTY 的 ' + nameSp(socketName(d.slot));
	if (d.reason === 2)
		return p + '一連上就被關閉（沒有收到任何資料）—— 請確認轉接線，或改選其他孔再連線';
	return p + '連不上（線可能剛被拔掉，或這孔已停用）—— 請確認轉接線，或改選其他孔再連線';
}

/* 0xA2 之後的狀態列短句 */
function backendDownStatus(d) {
	if (d.slot === IDX_NONE) return '沒有接序列線';
	return socketName(d.slot) + (d.reason === 2 ? ' 一連上就被關閉' : ' 連不上');
}
/* ── 選孔判定 end ── */

/* 本頁的等待上限刻意比裝置端的 1 秒**長**:這樣「沒生效」一律由裝置端回
 * status 2 來判定,提示訊息只有一個來源;本地逾時只是連線真斷掉時的保險。 */
var CTL_WAIT_MS = 2500;

/* Break 能不能用 —— **不再是寫死的常數**(韌體 v1.7 及之前恆 false)。
 * 改由「這台裝置有沒有控制通道 + 有沒有收到就緒事件」決定,見 setCtlReady()。 */
var BREAK_SUPPORTED = false;

/* 亂碼急救的一鍵鮑率:現場最常見的五個。**只有人按才換** ——
 * 亂碼只證明「現在這個是錯的」,不證明「對的是哪一個」,而換鮑率會打斷
 * 連線中設備的輸出,所以那一下必須是使用者刻意按的。 */
var BAUD_TRY = [9600, 19200, 38400, 57600, 115200];

var LS_FONT = 'airtty.webterm.fontSize';
var LS_KEYS = 'airtty.webterm.keysOpen';
/* 「送 Break 前先確認」偏好(2026-09-06 新增)。**線路面板唯一會被記住的東西** ——
 * 它不是線路參數(不會送到裝置、不影響任何設備),而是這個瀏覽器的操作習慣,
 * 所以不受「線路參數不記憶」那條鐵律管。缺值 = 開(安全側預設)。 */
var LS_BREAK_CONFIRM = 'airtty.webterm.breakConfirm';
/* 「這台 AirTTY 上次選的孔」(v18;docs/plans/port-identity-redesign.md §8.2-6):每台一筆,
 * 鍵 = 前綴 + 裝置名稱尾碼(見 deviceKey,例 airtty.webterm.port.52C8),值 = 孔的 idx(0～18 的數字)。
 * ⚠️ 為什麼它可以記、線路參數卻不行:線路參數(鮑率等)會**送到裝置、改動正在連的那台設備**;
 * 這裡只是「這台我上次接哪一孔」—— 和 LS_BREAK_CONFIRM 同類的操作偏好,不帶任何 console 內容,
 * 只在「多條線、要人選」時拿來預設勾(不會自己接)。尾碼本來就印在藍牙清單的裝置名稱上。
 * **只記人選的**(點的 / 換孔):「只有一條線而自動接上」的不記 —— 記了會蓋掉這台多條線時人點的那一孔。
 * 讀不到(無痕模式)= 沒有記憶,照樣能用。v17(未發布)的單一鍵 airtty.webterm.port 不再使用。 */
var LS_PORT_PREFIX = 'airtty.webterm.port.';
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
var btnVendor = document.getElementById('btnVendor');

var elBanner = document.getElementById('ctxBanner');
var elBannerText = document.getElementById('ctxText');
var elVendorRow = document.getElementById('vendorRow');
var elVendorClose = document.getElementById('vendorClose');
var elVendorSel = document.getElementById('vendorSel');

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
/* 線路設定(控制通道) */
var btnLine = $('btnLine'), shLine = $('sheetLine'),
	lnBaud = $('lnBaud'), lnData = $('lnData'), lnParity = $('lnParity'),
	lnStop = $('lnStop'), lnApply = $('lnApply'), lnRead = $('lnRead'),
	lnBreak = $('lnBreak'), lnDTR = $('lnDTR'), lnRTS = $('lnRTS'),
	lnBreakConfirm = $('lnBreakConfirm'),
	lnStat = $('lnStat'), lnModem = $('lnModem'), lnNote = $('lnNote');
var elBaudRow = $('baudRow');

var term = new window.Terminal({
	cursorBlink: true, fontSize: FONT_DEFAULT, scrollback: 5000,
	theme: { background: '#000000' }
});
term.open(elTermHost);

var device = null;      /* 釘住的 BluetoothDevice(重連不重開 chooser) */
var rxChar = null;      /* write 目標 */
var txChar = null;      /* notify 來源 */
var ctlRxChar = null;   /* 控制訊框寫入目標(舊韌體為 null) */
var ctlTxChar = null;   /* 控制回應/事件來源 */
var ctlAvail = false;   /* 這台裝置有控制通道(= 找得到兩顆特徵值) */
var ctlReady = false;   /* 裝置端已回報就緒(密碼關已過、序列埠控制已備妥) */
var wantDisconnect = false;   /* 區分「使用者按斷線」與「意外斷線」 */
var writeQueue = Promise.resolve();  /* GATT 同時只能一個操作 → 寫入串行化 */
var ctrlArmed = false;  /* Ctrl 修飾鍵:等待下一個鍵 */

/* ── 選孔(v18)的逐連線狀態 —— connectFlow 一開始歸零(pendingPick / autoRetried 例外,見各自註解)── */
var elPortRow = document.getElementById('portRow');   /* 選孔列(多條線時才出現) */
var btnPort = document.getElementById('btnPort');     /* 標題列「🔌 換孔」(連線中、這台有兩條以上的線才出現) */
var portChosen = -1;    /* 這一次連線接的孔 idx;-1 = 還沒選 / 舊韌體 */
var portHow = '';       /* 怎麼選到的:auto(只有一條)| pick(人點的)| pending(換孔 / 重連後直接接) */
var lastPorts = [];     /* 這一次連線 LIST 回來的清單(換孔列用) */
/* 選孔還沒有結果時先扣住鍵盤 —— 韌體 v1.9.0 起,client 的第一筆資料會讓裝置**直接接預設孔**
 * (拍板題 9 (a):只有一條就接它、多條接孔號最小的);人還沒選孔就打的字,可能打進不是他要的那台。
 * 選孔列開著時打的字**直接丟掉**(不知道要給哪一台,Enter 例外 = 接預設勾的孔),其餘時候扣住、有結果才送。
 * ⚠️ 從 connectFlow 一開始就扣(2026-10-18 審查):wireUp 在 NUS 訂閱完成**之前**就設了 rxChar,
 *    若等主鏈做完才扣,中間那段打的字會直送 NUS ⇒ 裝置在 LIST 之前就接了預設孔。 */
var portHold = false;
var heldBytes = [];
/* 選孔還沒有結果時,**裝置輸出**也先暫存(2026-10-20)。
 * [實測 2026-10-20,使用者 Chrome 對開發機 v1.8.11] 舊韌體連上藍牙就接它固定的埠、立刻送 `Password:`
 * (bleak 量:NUS `Password:` +31 ms、LIST 回覆 01 89 01 +119 ms)—— 直接畫的話,它會跑到本頁
 * 「韌體還不支援列出序列埠…」「輸入連線密碼…」那兩行的**上面**。
 * 規則(outHeld):portHold 期間、而且選孔列沒開著 ⇒ 暫存;本頁的說明印完才依到達順序補印(outFlush)。
 *   - 補印的時機只有兩個:portSettled(每一條結束扣住的路都經過它,含斷線)與出選孔列(showChooser)。
 *     ⇒ 呼叫 portSettled 之前要先 say() 完本頁自己的說明,補印才會排在說明之後。
 *   - 選孔列開著時不暫存:本頁的說明已經印了,之後裝置送的(30 秒守門那行)要即時看到,不可以壓到斷線才出現;
 *     點了孔(SELECT 在路上)hideChooser 讓 choosing 變回 false ⇒ 自動又開始暫存,`Password:` 照樣排在「已接上…」之後。
 * ⚠️ 鍵盤可以丟、**裝置輸出一個位元組都不丟**;rxBytes 照舊在收到時就算(「連上就被斷」的判斷靠它)。 */
var outQ = [];          /* [{ u8, t }]:t = 收到的時間(側錄的時間戳照舊是「收到的時間」,不是補印的時間) */
var outQBytes = 0;
var OUT_HOLD_MAX = 65536;   /* 暫存上限:超過就立刻補印,這條連線之後不再暫存(順序顧不到了,也不可以為了順序丟資料) */
var outLive = false;    /* 爆過上限 ⇒ 這條連線之後一律即時畫;connectFlow 歸零 */
var choosing = false;   /* 選孔列開著、等人點(裝置端 30 秒選孔守門也在計時) */
var choosePre = null;   /* 選孔列預設勾的孔(這台上次選的);Enter = 接它 */
var chooseDeadline = 0; /* 裝置端選孔守門到期的時間(本頁倒數用) */
var chooseTimer = 0;
var switching = false;  /* 選孔列是「連線中換孔」開的(不倒數、可關) */
var listRetries = 0;    /* 「選的孔剛被拔線(4)⇒ 重新列出」的次數上限,不打成迴圈 */
/* LIST 沒回應(逾時)/ 沒寫進去(GATT 錯誤)⇒ 再送一次,每條連線一次(與 listRetries 分開算,不吃掉「拔線重列」的額度)。
 * 為什麼要重送:v1.9.0 若其實收到了 LIST(回覆掉了 / 晚到),它已經在等 SELECT、**不會**自己接預設孔 ——
 * 直接當舊韌體放行,30 秒後只會被裝置斷線,原因還講錯。 */
var listResent = false;
/* 人選的孔(點的 / 換孔 / 重連後直接接)回 4、或不在新清單裡 ⇒ 下一份清單**不自動接**(就算只剩一條),
 * 出選孔列並講明「你選的孔現在沒有線」。值 = 那一孔的 idx;null = 沒有。逐連線,用完即清 */
var choiceGone = null;
var listPending = null; /* 等 LIST 回覆中:{ acc, resolve, reject, timer } */
var pendingPick = null; /* 換孔 / 「裝置先接上別的孔」重連後直接接的孔 —— 跨一次重連,用完即清 */
var backendDown = null; /* 本次連線收到的 0xA2({slot, reason}):斷線訊息據此講原因,不再猜 */
var dropPlan = null;    /* 我方主動斷線時,斷線事件要怎麼收尾:{ status, reconnect } */
var autoRetried = false;/* 「裝置先接上別的孔」只自動重連一次,不打成迴圈(按鈕觸發的連線才歸零) */
var rxBytes = 0;        /* 本次連線收到的序列輸出位元組數 */
var connectedAt = 0;    /* 本次連線主鏈完成的時間(判「連上就被斷」用) */

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
	if (portHold) {                                    /* 選孔還沒結果:見 portHold */
		if (choosing) {
			if (choosePre !== null && bytes.length === 1 && bytes[0] === 0x0d) { pickSocketNow(choosePre); return; }
			toast('請先在終端上方選要接的孔', 'warn');
			return;                                    /* 不知道要給哪一台 ⇒ 丟掉 */
		}
		heldBytes.push(bytes);
		return;
	}
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

/* ══ 控制通道 ═══════════════════════════════════════════════════════════
 * 送一則小訊框 → 裝置端翻成序列埠控制指令 → 回一則帶狀態的訊框。
 *
 * 界線提醒(與本頁三條鐵律一致):控制通道**不存任何東西**,參數刻意
 * 不記憶(關頁即消、重連要重設)—— 記住上次的鮑率等於在第三方 origin
 * 留下「你連的是什麼設備」的線索,而省下的只是一次點選。
 *
 * 狀態碼由裝置端定義,本頁只負責翻成人看得懂的話:
 *   0 ok / 1 還沒登入 / 2 送出去了但沒生效(多半是別人持有寫入權)/ 3 參數不被接受
 * ⚠️「沒生效」**不能**靜靜當成成功 —— 使用者會以為鮑率換了,然後對著
 *    還是亂碼的畫面查半天。 */

var ctlPending = [];    /* [{cmd, resolve, timer}];逐 cmd FIFO 配對 */

function ctlStatusText(st, actual) {
	if (st === 0) return actual === null ? '已生效' : '已生效，目前是 ' + actual;
	if (st === 1) return '尚未生效 —— 請先在終端輸入連線密碼完成登入';
	if (st === 2) return '送出了但沒有生效 —— 可能另一位使用者持有寫入權（你目前是唯讀）';
	return '裝置不接受這個設定值';
}

/* 送一則控制訊框,回傳 Promise<{status, payload}>。
 * 走同一條 writeQueue:GATT 同時只允許一個操作,控制寫入與鍵盤寫入
 * 若各排一條佇列就會互相踩到。 */
function ctlRequest(cmd, payload) {
	var frame, i;

	if (!ctlRxChar) return Promise.reject(new Error('no-ctl'));
	payload = payload || [];
	frame = new Uint8Array(3 + payload.length);
	frame[0] = CTL_VER;
	frame[1] = cmd;
	frame[2] = payload.length;
	for (i = 0; i < payload.length; i++) frame[3 + i] = payload[i];

	return new Promise(function(resolve, reject) {
		var rec = { cmd: cmd, resolve: resolve, timer: 0 };

		rec.timer = setTimeout(function() {
			var k = ctlPending.indexOf(rec);
			if (k >= 0) ctlPending.splice(k, 1);
			reject(new Error('local-timeout'));
		}, CTL_WAIT_MS);
		ctlPending.push(rec);
		writeQueue = writeQueue.then(function() {
			if (!ctlRxChar) throw new Error('no-ctl');
			return ctlRxChar.writeValueWithResponse
				? ctlRxChar.writeValueWithResponse(frame)
				: ctlRxChar.writeValue(frame);
		}).catch(function(e) {
			var k = ctlPending.indexOf(rec);
			if (k >= 0) ctlPending.splice(k, 1);
			clearTimeout(rec.timer);
			reject(e);
		});
	});
}

/* 裝置 → 本頁的控制訊框。格式錯的一律忽略(控制通道出事不得波及終端資料流) */
function onCtlFrame(u8) {
	var cmd, st, payload, i, rec, actual;

	if (!u8 || u8.length < 3 || u8[0] !== CTL_VER) return;
	cmd = u8[1];
	st = u8[2];
	payload = u8.subarray(3);

	if (cmd === EV_READY) { setCtlReady(true); return; }
	if (cmd === EV_MODEM) { showModem(payload.length ? payload[0] : 0); return; }
	if (cmd === EV_BACKEND_DOWN) { onBackendDown(parseBackendDown(payload)); return; }
	if (cmd === (C_LIST | 0x80)) { onListFrame(u8); return; }   /* 多則訊框,不走 ctlPending 的一問一答 */

	actual = null;
	if (payload.length === 4) {
		actual = ((payload[0] << 24) | (payload[1] << 16) |
			(payload[2] << 8) | payload[3]) >>> 0;
	} else if (payload.length === 1) {
		actual = payload[0];
	}
	/* 配對最舊的同 cmd 待辦(cmd|0x80 是回應標記) */
	for (i = 0; i < ctlPending.length; i++) {
		rec = ctlPending[i];
		if ((rec.cmd | 0x80) !== cmd) continue;
		ctlPending.splice(i, 1);
		clearTimeout(rec.timer);
		rec.resolve({ status: st, actual: actual });
		return;
	}
}

/* ══ 選孔(v18)══════════════════════════════════════════════════════════
 * 流程:NUS 訂閱完(主鏈結束)→ 立刻在背景找控制通道 → 送 LIST → 依清單:0 條講原因並斷線、
 * 1 條自動 SELECT、多條出選孔列讓人點(預設勾這台上次選的,Enter = 接它)→ 依 SELECT 回覆講清楚。
 * 判定規則在上面「選孔判定」那段純函式;這裡只負責把結果變成畫面與動作。 */

function devLabel() {
	return device && device.name ? device.name : '(無名裝置,連線後名稱可能稍後出現)';
}

/* 選孔有結果了:放開(或丟掉)扣住的鍵。keep=false 用在「那些字不知道要給哪一台」 */
function portSettled(keep) {
	var h = heldBytes, i;

	portHold = false;
	heldBytes = [];
	updatePortBtn();
	/* 暫存的裝置輸出**不論 keep 一律補印**(只有鍵盤可以丟,見 outQ)。呼叫端要先印完自己的說明再呼叫本函式 */
	outFlush();
	if (!keep) return;
	for (i = 0; i < h.length; i++) sendBytes(h[i]);
}

/* 我方主動斷線(選孔失敗),斷線事件依 dropPlan 收尾 */
function disconnectNow() {
	if (device && device.gatt && device.gatt.connected) device.gatt.disconnect();
}

/* 每台記憶(LS_PORT_PREFIX)。讀不到 / 寫不進(無痕模式)= 沒有記憶,照樣能用 */
function rememberSocket(idx) {
	var k = deviceKey(device);

	if (!k) return;
	try { localStorage.setItem(LS_PORT_PREFIX + k, String(idx)); } catch (e) { /* 無痕模式會擋,忽略 */ }
}

function recallSocket() {
	var k = deviceKey(device), v = null;

	if (!k) return null;
	try { v = localStorage.getItem(LS_PORT_PREFIX + k); } catch (e) { return null; }
	return v !== null && /^\d{1,3}$/.test(v) ? parseInt(v, 10) : null;
}

/* 清單裡這一孔的資料(顯示用);不在清單就只有孔名 */
function portInfo(idx) {
	var i;

	for (i = 0; i < lastPorts.length; i++)
		if (lastPorts[i].idx === idx) return lastPorts[i];
	return { idx: idx, flags: 0, label: '' };
}

/* 「🔌 換孔」:連線中、選孔已有結果、這台有兩條以上的線才出現 */
function updatePortBtn() {
	if (!btnPort) return;
	btnPort.classList.toggle('hidden', !(rxChar && portChosen >= 0 && !portHold &&
		lastPorts.length >= 2 && !choosing));
}

/* 這台不支援列出序列埠(韌體沒有控制通道 / 不認得 LIST / 沒回應)⇒ 照常連,講一行。
 * 舊韌體連上就已經接著它固定的那一個,扣住的字照送。 */
function portUnsupported() {
	say('這台 AirTTY 的韌體還不支援列出序列埠（v1.9.0 起），先連預設的孔');
	say('輸入連線密碼後即進 console（輸入時不會回顯是正常的）');
	setStatus('已連線:' + devLabel(), 'ok');
	portSettled(true);
}

/* LIST:送 [1][9][0],收多則 0x89 直到結尾。不走 ctlRequest(那是一問一答,第二則起會被丟掉)。
 * 走同一條 writeQueue(GATT 同時只能一個操作)。 */
function ctlList() {
	if (!ctlRxChar) return Promise.reject(new Error('no-ctl'));
	if (listPending) {               /* 上一輪還在等:作廢它(不會發生在正常流程,保險) */
		clearTimeout(listPending.timer);
		listPending.reject(new Error('superseded'));
		listPending = null;
	}
	return new Promise(function(resolve, reject) {
		var rec = { acc: listAccNew(), resolve: resolve, reject: reject, timer: 0 };
		var frame = new Uint8Array([CTL_VER, C_LIST, 0]);

		rec.timer = setTimeout(function() {
			if (listPending === rec) listPending = null;
			reject(new Error('local-timeout'));
		}, CTL_WAIT_MS);
		listPending = rec;
		writeQueue = writeQueue.then(function() {
			if (!ctlRxChar) throw new Error('no-ctl');
			return ctlRxChar.writeValueWithResponse
				? ctlRxChar.writeValueWithResponse(frame)
				: ctlRxChar.writeValue(frame);
		}).catch(function(e) {
			if (listPending !== rec) return;
			listPending = null;
			clearTimeout(rec.timer);
			reject(e);
		});
	});
}

/* 裝置送來的 0x89(LIST 回覆的一則)。沒在等就丟掉(晚到 / 重複) */
function onListFrame(u8) {
	var rec = listPending, r;

	if (!rec) return;
	r = listAccPush(rec.acc, u8);
	if (r === 'more') return;
	listPending = null;
	clearTimeout(rec.timer);
	if (r === 'done') rec.resolve({ status: 0, ports: listAccResult(rec.acc) });
	else if (r === 'old') rec.resolve({ status: u8[2], ports: [] });
	else rec.resolve({ status: 0, bad: true, ports: [] });
}

function listPorts(gen) {
	ctlList().then(function(r) {
		onListResult(gen, classifyList(r, null));
	}, function(e) {
		onListResult(gen, classifyList(null, e));
	});
}

function onListResult(gen, c) {
	var pick, gone;

	if (gen !== connGen || !rxChar) return;    /* 已斷線或重連過:這輪作廢 */
	if (backendDown) { portSettled(false); return; }   /* 0xA2 已經講過原因,不再疊一層訊息 */
	/* 沒回應 / 沒寫進去 ⇒ 先再送一次(見 listResent)。控制通道已經沒了(探索失敗)就不必送 */
	if ((c.kind === 'timeout' || c.kind === 'writefail') && !listResent && ctlRxChar) {
		listResent = true;
		say(c.kind === 'timeout' ? '（沒有收到序列埠清單，再問一次…）'
			: '（「列出序列埠」的命令沒有送到裝置，再送一次…）');
		listPorts(gen);
		return;
	}
	if (lastPorts.length && (c.kind === 'old' || c.kind === 'timeout' || c.kind === 'writefail')) {
		/* 這條連線已經拿過 v1.9.0 的清單(只有「選的孔回 4 ⇒ 重新列出」會走到這裡):裝置已在等 SELECT、
		 * **不會**自己接預設孔 ⇒ 不可以當舊韌體 / 保底放行(portUnsupported 會把扣住的字送出去、原因也講錯)。
		 * 同 onSelectResult「選孔命令沒有結果」:扣住的字丟掉、主動斷開(2026-10-18 審查追加) */
		dropPlan = { status: choiceGone !== null ? '沒有接到 ' + socketName(choiceGone) : '選孔沒有結果' };
		choiceGone = null;
		say('選孔命令沒有結果（可能是藍牙不穩）—— 為避免接到不是你選的孔，已中斷。可按「↻ 重新連線」再試');
		portSettled(false);            /* 先說明、再補印暫存的裝置輸出(見 outQ);以下各處同理 */
		disconnectNow();
		return;
	}
	if (c.kind === 'old' || c.kind === 'timeout') { portUnsupported(); return; }
	if (c.kind === 'writefail') {
		/* 命令沒送到 ⇒ 新韌體會在 1.5 秒保底自己接預設孔(多條線時會在終端講接了哪一孔);
		 * 舊韌體這時多半是 session 已收掉、隨後會斷線(斷線處理會講) */
		say('（「列出序列埠」的命令沒有送到裝置，由 AirTTY 自動接預設的孔）');
		setStatus('已連線:' + devLabel(), 'ok');
		portSettled(true);
		return;
	}
	if (c.kind === 'bad') {
		/* 裝置收到 LIST 了(會等選孔),但清單讀不懂 —— 不能猜要接哪一孔 */
		choiceGone = null;
		dropPlan = { status: '序列埠清單讀不懂' };
		say('裝置回的序列埠清單格式不對（本頁與韌體版本不合？）—— 為避免接錯孔，已中斷。可按「↻ 重新連線」再試');
		portSettled(false);
		disconnectNow();
		return;
	}
	lastPorts = c.ports;
	if (!lastPorts.length) {
		dropPlan = { status: '沒有接序列線' };
		say('這台 AirTTY 目前沒有接序列線 —— 請接上轉接線後按「↻ 重新連線」');
		portSettled(false);
		disconnectNow();               /* 不佔著藍牙席次等裝置的 30 秒守門 */
		return;
	}
	if (pendingPick !== null) {
		if (lastPorts.some(function(p) { return p.idx === pendingPick; })) {
			pick = pendingPick;
			pendingPick = null;
			selectSocket(gen, pick, 'pending');
			return;
		}
		choiceGone = pendingPick;      /* 換孔 / 重連要接的那一孔現在沒線 ⇒ 不可以落到「只有一條就自動接」 */
		pendingPick = null;
	}
	if (choiceGone !== null) {
		/* 人選的孔沒線了:**絕不自動改接**(就算只剩一條),列出來讓人重選。
		 * 扣住的字是打給他選的那一孔的 ⇒ 丟掉(portHold 照舊扣著:選孔列開著時再打的字也不送) */
		gone = choiceGone;
		choiceGone = null;
		heldBytes = [];
		showChooser(null, false, gone);
		return;
	}
	pick = pickSocket(lastPorts, recallSocket());
	if (pick.auto !== null) { selectSocket(gen, pick.auto, 'auto'); return; }
	showChooser(pick.pre, false);
}

/* 選孔列。switchMode = 連線中換孔(不倒數、多一顆 ✕);否則是連上後第一次選(裝置端 30 秒守門在計時)。
 * gone(數字)= 人選的那一孔現在沒線(見 choiceGone):清單可能只剩一條也照樣列出來,開頭講明原因。
 * ⚠️ 一律 createElement + textContent(標籤是使用者自填的字串,不碰 innerHTML) */
function showChooser(pre, switchMode, gone) {
	var i, b, t, cnt, lead = '', gn;

	if (!elPortRow) return;
	if (typeof gone === 'number') {
		gn = socketName(gone);
		lead = '你選的' + (/^[A-Za-z]/.test(gn) ? ' ' : '') + nameSp(gn) + '現在沒有線';
	}
	choosing = !switchMode;
	switching = !!switchMode;
	choosePre = switchMode ? null : pre;
	elPortRow.textContent = '';
	t = document.createElement('span');
	t.className = 'plabel';
	t.textContent = switchMode ? '換到哪一孔？（會重新連線）'
		: lead ? lead + '，要改接哪一孔？'
		: '這台有 ' + lastPorts.length + ' 條序列線，要接哪一孔？';
	elPortRow.appendChild(t);
	for (i = 0; i < lastPorts.length; i++) {
		b = document.createElement('button');
		b.setAttribute('type', 'button');
		b.setAttribute('data-idx', String(lastPorts[i].idx));
		b.textContent = socketText(lastPorts[i]) +
			(switchMode && lastPorts[i].idx === portChosen ? '（目前）' : '') +
			(!switchMode && lastPorts[i].idx === pre ? '（上次）' : '');
		if (lastPorts[i].idx === (switchMode ? portChosen : pre)) b.classList.add('active');
		b.addEventListener('click', (function(idx) {
			return function() { pickSocketNow(idx); };
		})(lastPorts[i].idx));
		elPortRow.appendChild(b);
	}
	if (switchMode) {
		b = document.createElement('button');
		b.setAttribute('type', 'button');
		b.setAttribute('aria-label', '不換孔');
		b.textContent = '✕';
		b.addEventListener('click', function() { hideChooser(); updatePortBtn(); term.focus(); });
		elPortRow.appendChild(b);
	} else {
		cnt = document.createElement('span');
		cnt.className = 'pcount';
		elPortRow.appendChild(cnt);
		chooseDeadline = Date.now() + CHOOSE_MS;
		tickChooser(cnt);
		if (lead) say(lead + ' —— 為避免對錯的設備下指令，不會自動改接別孔。請在終端上方點選要接的孔');
		else say('這台 AirTTY 有 ' + lastPorts.length + ' 條序列線 —— 請在終端上方點選要接的孔' +
			(pre !== null ? '（按 Enter 直接接上次的' + (/^[A-Za-z]/.test(socketName(pre)) ? ' ' : '') + socketName(pre) + '）' : ''));
		setStatus('已連線:' + devLabel() + ' · 請選擇要接的孔', 'ok');
		/* 說明印完了 ⇒ 補印暫存的裝置輸出;選孔列開著時 outHeld 為假,之後的輸出(30 秒守門那行)即時畫(見 outQ) */
		outFlush();
	}
	elPortRow.classList.add('show');
	updatePortBtn();
	setTimeout(fitRows, 0);
}

/* 倒數(裝置端選孔守門 SELECT_GUARD_MS = 30 秒,從收到 LIST 起算;本頁從畫出選孔列起算,差幾十毫秒) */
var CHOOSE_MS = 30000;

function tickChooser(el) {
	var left;

	if (chooseTimer) { clearTimeout(chooseTimer); chooseTimer = 0; }
	if (!choosing) return;
	left = Math.max(0, Math.ceil((chooseDeadline - Date.now()) / 1000));
	el.textContent = left > 0 ? '（' + left + ' 秒內沒選，AirTTY 會中斷藍牙連線）' : '（已逾時）';
	if (left > 0) chooseTimer = setTimeout(function() { tickChooser(el); }, 1000);
}

function hideChooser() {
	choosing = false;
	switching = false;
	choosePre = null;
	if (chooseTimer) { clearTimeout(chooseTimer); chooseTimer = 0; }
	if (!elPortRow) return;
	if (elPortRow.classList.contains('show')) setTimeout(fitRows, 0);
	elPortRow.classList.remove('show');
	elPortRow.textContent = '';
}

/* 選孔列上點了一孔 / 按了 Enter */
function pickSocketNow(idx) {
	if (choosing) {
		selectSocket(connGen, idx, 'pick');
		return;
	}
	if (!switching) return;
	hideChooser();
	if (idx === portChosen) { updatePortBtn(); term.focus(); return; }
	/* 裝置端一條藍牙連線只接一個孔,換孔 = 重新連線(密碼、寫入權都是逐連線的) */
	if (!window.confirm('切換到 ' + socketText(portInfo(idx)) + ' 要重新連線：目前的 console 會中斷，' +
		'連上後要重新輸入連線密碼。\n\n確定要切換嗎？')) {
		updatePortBtn();
		return;
	}
	autoRetried = false;
	pendingPick = idx;
	dropPlan = { status: '切換到 ' + socketName(idx) + '，重新連線中…', reconnect: true };
	say('切換到 ' + socketText(portInfo(idx)) + '，重新連線中…');
	disconnectNow();
}

function selectSocket(gen, idx, how) {
	hideChooser();
	portChosen = idx;
	portHow = how;
	ctlRequest(C_SELECT, [idx]).then(function(r) {
		onSelectResult(gen, classifySelect(r, null, idx), idx);
	}, function(e) {
		onSelectResult(gen, classifySelect(null, e, idx), idx);
	});
}

function onSelectResult(gen, c, chosen) {
	var msg, txt;

	if (gen !== connGen || !rxChar) return;   /* 已斷線或重連過:這輪作廢 */
	if (backendDown) { portSettled(false); return; }   /* 0xA2 已經講過原因,不再疊一層訊息 */
	if (c.kind === 'ok') {
		txt = socketText(portInfo(chosen));
		if (portHow !== 'auto') rememberSocket(chosen);   /* 自動接的不記(見 LS_PORT_PREFIX) */
		setStatus('已連線:' + devLabel() + ' · ' + socketName(chosen), 'ok');
		if (portHow === 'auto') say('已自動接上' + (/^[A-Za-z]/.test(txt) ? ' ' : '') + txt + '（這台目前只有這一條線）');
		else say('已接上' + (/^[A-Za-z]/.test(txt) ? ' ' : '') + txt);
		say('輸入連線密碼後即進 console（輸入時不會回顯是正常的）');
		portSettled(true);
		return;
	}
	portChosen = -1;
	if (c.kind === 'badslot') {
		/* §8.1:4 = 沒這個孔或沒線 —— 多半是剛被拔線。重新列出一次(上限 2 次,不打成迴圈) */
		if (listRetries < 2) {
			listRetries++;
			if (portHow !== 'auto') {
				/* 人選的孔沒線:重新列出後**不自動接**(見 choiceGone);扣住的字是給這一孔的 ⇒ 丟掉 */
				choiceGone = chosen;
				heldBytes = [];
			}
			say(nameSp(socketName(chosen)) + '剛剛沒有線了（可能剛被拔掉）—— 重新查一次…');
			listPorts(gen);
			return;
		}
		dropPlan = { status: '沒有接到 ' + socketName(chosen) };
		say(nameSp(socketName(chosen)) + '沒有線 —— 請確認轉接線後按「↻ 重新連線」');
		portSettled(false);
		disconnectNow();
		return;
	}
	if (c.kind === 'other') {
		/* 裝置已先接上別的孔(LIST 晚於裝置的 1.5 秒保底才到)。**不可以就這樣用** ——
		 * 畫面會是別台設備的 console。重連一次讓 LIST 先到;還是一樣就停下來交給人。 */
		msg = '裝置已先接上 ' + socketName(c.slot) + '（' + (portHow === 'auto' ? '本頁要接的是 ' : '你選的是 ') + socketName(chosen) + '）';
		if (!autoRetried) {
			autoRetried = true;
			/* 人選的才帶過重連直接接;自動接的(只有一條)重連後照清單重新判斷 —— 不把它當成「人選的」
			 * (否則會被記住,或在它沒線時講成「你選的孔現在沒有線」) */
			pendingPick = portHow === 'auto' ? null : chosen;
			dropPlan = { status: '重新連線中…', reconnect: true };
			say(msg + ' —— 為避免對錯的設備下指令，先中斷，自動重新連線一次…');
		} else {
			dropPlan = { status: '沒有接到 ' + socketName(chosen) };
			say(msg + ' —— 為避免對錯的設備下指令，已中斷。請按「重新連線」再試一次');
		}
		portSettled(false);            /* 暫存的可能是別台設備的 `Password:`(裝置先接了別孔)—— 照樣補印、排在說明之後 */
		disconnectNow();
		return;
	}
	/* unsupported / writefail:LIST 都答了、選孔卻沒結果 —— 不能賭裝置接的是哪一孔,先斷開 */
	if (!device || !device.gatt || !device.gatt.connected) { portSettled(false); return; }
	dropPlan = { status: '沒有接到 ' + socketName(chosen) };
	say('選孔命令沒有結果（可能是藍牙不穩）—— 為避免接到不是你選的孔，已中斷。可按「↻ 重新連線」再試');
	portSettled(false);
	disconnectNow();
}

/* 裝置說「選的孔不通、即將斷線」(0xA2)。同一條連線只講一次(裝置對晚訂閱者會補送) */
function onBackendDown(d) {
	if (!d || backendDown) return;
	backendDown = d;
	hideChooser();
	setStatus(backendDownStatus(d), 'err');
	say(backendDownText(d));
	/* 本頁的說明先、裝置自己從 NUS 送的那行(`[AirTTY] hub 第 2 孔連不上…`,常比 0xA2 早到)補印在後 */
	portSettled(false);
}

/* 找不到控制通道特徵值(舊韌體)→ 整組功能隱藏,不留半套死鈕 */
function setCtlAvail(on) {
	ctlAvail = !!on;
	if (btnLine) btnLine.classList.toggle('hidden', !ctlAvail);
	btnBreak.classList.toggle('hidden', !ctlAvail);
	if (!ctlAvail) setCtlReady(false);
}

function setCtlReady(on) {
	ctlReady = !!on;
	BREAK_SUPPORTED = ctlAvail && ctlReady;
	btnBreak.classList.toggle('unavail', !BREAK_SUPPORTED);
	btnBreak.setAttribute('aria-disabled', BREAK_SUPPORTED ? 'false' : 'true');
	if (btnLine) btnLine.classList.toggle('unavail', !ctlReady);
	if (lnNote) {
		lnNote.textContent = ctlReady ? ''
			: '⚠️ 尚未就緒 —— 請先在終端輸入連線密碼完成登入，這一頁的設定才會生效。';
	}
	if (on) {
		say('序列埠控制已就緒（可換鮑率、送 Break、控 DTR／RTS）');
		if (elBaudRow) elBaudRow.classList.toggle('show', garbleShown);
	}
}

/* modem 四燈:0xA0 事件驅動(位元定義同 RFC 2217 NOTIFY-MODEMSTATE) */
function showModem(m) {
	if (!lnModem) return;
	lnModem.textContent =
		'DCD ' + ((m & 0x80) ? '●' : '○') +
		'　CTS ' + ((m & 0x10) ? '●' : '○') +
		'　DSR ' + ((m & 0x20) ? '●' : '○') +
		'　RI ' + ((m & 0x40) ? '●' : '○');
}

/* 統一的送出 + 回報。ok 顯示實際值;其餘照 ctlStatusText 講清楚下一步 */
function ctlDo(label, cmd, payload, onOk) {
	if (!ctlAvail) { toast('這台裝置的韌體沒有序列埠控制通道（v1.8 起支援）', 'warn'); return; }
	if (!rxChar) { toast(NOT_CONNECTED, 'warn'); return; }
	if (lnStat) lnStat.textContent = label + '…';
	ctlRequest(cmd, payload).then(function(r) {
		var msg = label + '：' + ctlStatusText(r.status, r.actual);
		if (lnStat) lnStat.textContent = msg;
		toast(msg, r.status === 0 ? '' : 'warn');
		if (r.status === 0 && onOk) onOk(r.actual);
	}).catch(function(e) {
		var msg = e && e.message === 'local-timeout'
			? label + '：裝置沒有回應（連線可能已中斷）'
			: label + '：送不出去（連線可能已中斷）';
		if (lnStat) lnStat.textContent = msg;
		toast(msg, 'warn');
	});
}

/* Break 送出前的確認。
 * ⚠️ **為什麼 Break 要確認、而其他線路設定不用**:
 * Break 的正當用途是**中斷 Cisco 設備的開機流程進 ROMMON**(開機頭約 60 秒內送出),
 * 用來做密碼還原、換 image、改 config-register。問題出在**對運作中的設備誤送**:
 * 若該台的 config-register **沒有設成「忽略 Break」**(bit 8 被清掉,例如 0x2100/
 * 0x2101 —— 密碼還原之後常有人忘了改回 0x2102),那一下 Break 會讓設備**當場掉進
 * ROMMON、停止轉送所有流量**,而且要有人到 console 前面敲 `reset` 或 `boot`
 * 才回得來 —— 遠端救不了。
 * 這與「多行貼上先確認」是同一條紀律:**會對正式設備造成不可逆後果的動作,
 * 一律先問**。換鮑率頂多看不到字(改回來就好),所以不問。
 *
 * ⚠️ **但這道關卡必須能關掉**(2026-09-06 使用者需求):有些設備接受 Break 的
 * 時間窗很短(開機那幾秒),現場工程師的習慣動作是**快速連按 Break** ——
 * 每按一下都跳一次確認,人就來不及了。所以做成偏好:**預設開**(安全側),
 * 需要連按的人自己到 ⚙ 線路面板關掉。關掉之後 Break 直接送出,責任在使用者。
 * 讀不到偏好(無痕模式)一律當成「開」—— 出錯要往安全的那邊倒。 */
function breakConfirmOn() {
	try { return localStorage.getItem(LS_BREAK_CONFIRM) !== '0'; }
	catch (e) { return true; }   /* 無痕模式讀不到 → 維持預設的「先確認」 */
}

function confirmBreak() {
	if (!breakConfirmOn()) return true;
	return window.confirm(
		'即將送出序列 Break 訊號（拉低 250 毫秒）。\n\n' +
		'⚠️ 這是給「開機時中斷、進 Cisco ROMMON」用的訊號，不是一般按鍵。\n\n' +
		'對運作中的設備誤送會出事：Cisco 設備若沒把 config-register 設成忽略 Break' +
		'（例如密碼還原後忘了改回 0x2102），收到 Break 會當場掉進 ROMMON、' +
		'停止轉送所有流量，要有人到 console 前面敲 reset 或 boot 才回得來。\n\n' +
		'若你需要快速連按 Break（有些設備的 Break 時間窗很短），' +
		'可在 ⚙ 線路面板關閉此確認。\n\n確定要送出嗎？');
}

function be32(v) {
	return [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
}

/* 一鍵換鮑率(亂碼急救那排 + 線路面板共用同一個出口) */
function trySetBaud(baud) {
	ctlDo('切換鮑率 ' + baud, C_BAUD, be32(baud), function() {
		/* 換了鮑率就重新開始統計:舊窗口的壞字元是換之前的,
		 * 不歸零的話新鮑率正確也可能因為殘留比例又跳一次提示 */
		senseTotal = 0;
		senseBad = 0;
		if (lnBaud) lnBaud.value = String(baud);
	});
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
	elVendorRow.classList.toggle('notlive', !live);
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
		if (!ctlAvail) {
			toast('這台裝置的韌體還不支援從藍牙送 Break（韌體 v1.8 起支援）。' +
				'請改用管理介面的網頁終端（可送 Break），或用支援 RFC 2217 的軟體連 4001 埠', 'warn');
			return;
		}
		if (!rxChar) { toast(NOT_CONNECTED, 'warn'); return; }
		if (!ctlReady) {
			toast('請先在終端輸入連線密碼完成登入，Break 才送得出去', 'warn');
			return;
		}
		if (!confirmBreak()) { toast('已取消 Break'); term.focus(); return; }
		/* 2 = pulse:拉低 250 毫秒再放開,**由裝置端計時** ——
		 * 交給瀏覽器計時的話,分頁被切到背景時 timer 會被節流到好幾秒,
		 * 那條線就一直斷著(對正在開機的設備是會出事的那種)。 */
		ctlDo('送出 Break', C_BREAK, [2]);
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

/* t 參數:開發期注入測試資料用(見 README 維護者節);正式路徑只有一處會帶 ——
 * 選孔期間暫存的裝置輸出補印時(outFlush)帶「收到的時間」,其餘一律不帶、由 logAppend 自己取現在時間。
 * UI 上沒有任何地方能傳它。 */
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

/* ── 串流感知:警示關鍵字計數 + 亂碼偵測 + 廠牌辨識 ──────────────────────
 * 三者都吃 logAppend 解出來的同一份文字,不額外掃第二遍。 */

/* ── 廠牌資料表 ────────────────────────────────────────────────────────
 * **單一來源餵兩個功能**(照搬管理介面網頁終端的架構):
 *   ① 廠牌智慧快捷鈕 —— 偵測到(或使用者手動選定)哪家,就給那家的常用巡檢指令
 *   ② 亂碼偵測的提示文字 —— 借 baud 欄講「這家 console 預設多半是多少」
 * ⚠️ 與管理介面版(`terminal.js` 的 `VENDORS`)**逐字同步**,改一邊要改兩邊。
 * ⚠️ `baud` 的用法**依韌體而異**(2026-09-05 更新):韌體 v1.8 起有控制通道 ⇒
 *    它同時是「一鍵試鮑率」那排的第一顆按鈕(最可能對的那個);舊韌體沒有控制
 *    通道 ⇒ 退回**只當提示文字**。兩條路都在 showGarbleHint 裡。
 *    ~~舊敘述:「BLE 沒有 RFC 2217,本頁沒有換鮑率的能力,所以不做成按鈕」~~
 * 手冊 §4.5「廠牌預設值表」與本表人工同步。 */
/* ⚠️ **2026-09-13 起 `kw` 一律「有上下文」且不加 `i` 旗標**(#108 ⑧ 的後續):
 * 舊版認的是裸字(`/cisco/i`、`/Aruba/i`、`/login:/`)—— 那些字在別家設備的
 * 設定與 log 裡到處都是(`set description "to cisco switch"`),first-match-wins
 * 之下一命中就定案 ⇒ 廠牌那排會來回飄。現在每一條都要求**只會出現在該家自己
 * 輸出裡的上下文**(版本/開機橫幅字串、型號料號、該家獨有的提示符與 syslog 格式);
 * 不加 `i` 是刻意的:設備自己印的是 CamelCase(`FortiGate`、`ArubaOS`),
 * 工程師手打的描述多半全小寫(`to fortigate`)⇒ 大小寫本身就是一道便宜的鑑別。
 * 治「飄」的另一半是 VENDOR_CONFIRM 遲滯(見下),兩個一起才有效。 */
var VENDORS = [
	{ key: 'cisco', name: 'Cisco IOS',
		/* `Cisco IOS/Systems/Nexus/ASA` 是 show version 與開機橫幅的固定字串;
		 * `IOS Software` 的 \b 擋掉 `BIOS Software`;`rommon 1 >` 與 `%FAC-N-MNEM:`
		 * (Cisco syslog)是別家沒有的格式;`cisco WS-C2960-24TT-L` 這種料號行只在
		 * show version 出現。⚠️ 殘留風險:手打描述寫成 `to cisco SW1` 仍會命中。 */
		kw: /Cisco (IOS|Systems|Nexus|Adaptive Security|Internetwork)|\bIOS[- ]X[ER]\b|\bIOS Software\b|\bNX-OS\b|\bROMMON\b|^rommon \d+ >|\bcisco [A-Z]{2,}[0-9A-Z\/-]*\d|%[A-Z][A-Z0-9_]*-[0-7]-[A-Z0-9_]+:/m,
		baud: '9600',
		cmds: [ 'terminal length 0', 'show ip interface brief', 'show logging', 'show running-config', 'show version' ] },
	{ key: 'junos', name: 'Juniper Junos',
		/* `JUNOS`/`Junos` 保留大小寫(產品名,描述裡手打多是 `juniper`);
		 * `{master:0}` 與 `[edit …]` 各自獨占一行,是 Junos 獨有的提示符/模式列。 */
		kw: /\bJUNOS\b|\bJunos\b|Juniper Networks|^\{(master|backup|primary|secondary|line card)[^}]*\}$|^\[edit[^\]]*\]$/m,
		baud: '9600',
		cmds: [ 'set cli screen-length 0', 'show interfaces terse', 'show log messages | last 50', 'show configuration | display set' ] },
	{ key: 'fortinet', name: 'Fortinet',
		/* 產品名一律 CamelCase(`FortiGate`/`FortiOS`);`FGT60FTK…` 是序號開頭;
		 * `config system …` 在第 0 欄是 FortiOS 設定檔獨有的區塊開頭,
		 * `# config system ` 則是它的提示符後面直接接指令。 */
		kw: /\bFortiGate\b|\bFortiOS\b|\bFortiWiFi\b|\bFortiSwitch\b|\bFortinet\b|\bFGT[0-9A-Z]{3,}\b|\bFWF[0-9A-Z]{3,}\b|^config system \w|# config system /m,
		baud: '9600',
		cmds: [ 'get system status', 'get system interface physical', 'diagnose sys top 5 20', 'show system interface' ] },
	{ key: 'aruba', name: 'HPE/Aruba',
		/* `ArubaOS`/`Aruba Networks` 是版本字串;`Aruba JL256A`、`HP J9773A` 是
		 * 開機橫幅裡的料號;`ProCurve`/`HP(E) Switch` 沿用舊條但補 \b。
		 * ⚠️ 刻意不認裸 `Aruba`(AP 名稱/描述常出現)。 */
		kw: /\bArubaOS\b|Aruba Networks|\bAruba J[LP]\d{3,}[A-Z]?\b|\bProCurve\b|\bHPE? J\d{4}[A-Z]\b|\bHPE? (Switch|ProCurve|Networking)\b|Hewlett[- ]?Packard/,
		baud: '115200',
		cmds: [ 'no page', 'show interfaces brief', 'show logging -r', 'show system' ] },
	{ key: 'linux', name: 'Linux',
		/* 全部是 kernel/init/發行版自己印的固定格式:`Linux version 6.1…`、
		 * dmesg 的 `[    0.123456] `、`systemd[1]:`、`root@host:~#`。
		 * ⚠️ 舊版認裸 `login:` —— FortiGate 與 Junos 的登入提示也長這樣,已移除。 */
		kw: /^Linux version \d|\bsystemd\[\d+\]:|GNU\/Linux|Welcome to (Ubuntu|Debian|Alpine|openSUSE|CentOS)|\bUbuntu \d\d\.\d\d|\bDebian GNU|CentOS (Linux|Stream) release|^\[ *\d+\.\d{6}\] |\broot@[\w.-]+:[~\/]|\bBusyBox v\d|\bOpenWrt\b/m,
		baud: '115200',
		cmds: [ 'dmesg | tail -50', 'journalctl -xe --no-pager | tail -50', 'ip a', 'ip route' ] }
];

/* 自動偵測的遲滯(#108 ⑧ 後續,2026-09-13):要「換」成別家時,新廠牌必須
 * **連續這麼多次掃描**都命中才真的切換(掃描間隔 2 秒 ⇒ 3 次 ≈ 6 秒)。
 * 計的是**掃描次數不是秒數** —— 沒有輸出就不會掃,也就不會累積。
 * 首次判定(還沒有任何廠牌)不套遲滯:那不是「換」,而且整排本來就沒顯示,
 * 等 6 秒只是讓功能看起來壞掉。命中消失也**不清空**,維持上一個判定。 */
var VENDOR_CONFIRM = 3;

/* ── 警示行判定 begin(與 webterm app.js 逐位元組同步)── */
/* 警示關鍵字:網路設備 log 常見的錯誤樣式。
 * `%\w+-[0-3]-\w+` 是 Cisco 的 %FACILITY-SEVERITY-MNEMONIC —— 嚴重度只收 0-3
 * (emergency/alert/critical/error),4 以上是 warning/notification 級的日常噪音。
 * 這是「粗略提示」用的,寧可漏抓也不要洗版;要精準過濾請用檢視器的 /regex/。
 * ⚠️ 「這一行算不算警示」一律問 isAlertLine(),不要拿 LOG_ALERT_RE.test() 當結論 ——
 *    它只適合當「整塊有沒有可能命中」的快篩(isAlertLine 為真 ⇒ LOG_ALERT_RE 一定為真)。 */
var LOG_ALERT_RE = /(error|fail(ed|ure)?|denied|link[- ]?down|unreachable|duplex mismatch|%\w+-[0-3]-\w+|crit(ical)?|traceback)/i;

/* 數值為 0 的錯誤計數不算警示(2026-10-09 使用者要求:「請排除「0 input errors」」)。
 * 健康的介面每次 show 都印「0 input errors, 0 CRC, …」「Errors: 0, Drops: 0, …」,以前每行都上紅底、
 * 計進 ⚠ 數,真正有數字的那幾行反而被淹掉。
 * 範圍刻意窄:只管 error / fail 這一族(errors、Errored、failed、failures、fails、failover…)
 * 「值是 0」的計數。denied / unreachable / crit 的 0 計數、沒有數字的標題行(`Input errors:`)、
 * `Error: None`、`No Errors Logged`、`- buffer failures` 都照舊算警示。
 * 拿不準的一律當警示(維持改之前的行為):這裡只負責把「明確是 0 計數」的拿掉。
 * 做法:比對到的計數片語從行裡拿掉,剩下的再用 LOG_ALERT_RE 測一次 —— 同一行還有別的關鍵字
 * (`0 errors, link down`、`%SYS-2-MALLOCFAIL`、另一個非 0 的計數)就照樣是警示。
 *  ① 數字在前:`0 input errors`、`0 output buffer failures`、`with 0 errors`、`(0/0/0 errors)`、
 *     `0 calls to icmp_error`。
 *     數字與關鍵字之間最多夾 3 個英文字(單一空白隔開),而且停在**第一個**關鍵字
 *     (`0 errors autoneg failed` 只拿掉 `0 errors`,後面的 failed 照算);
 *     數字前一格只能是行首、空白或「(」——
 *     `10 input errors`、`10,000 input errors`、`spi0.0 failed`、`tag#0 FAILED`、`packets:0 errors:12`
 *     都不會被當成 0。
 *     ⚠️ 這一支**不看數值**,非 0 的(`5 input error  0 short frame`)也比對,由 stripZeroCounters 的回呼
 *        原樣留著 —— 先把關鍵字「認領」走,② 才不會把下一欄(short frame)的 0 當成它的值。
 *     數字是 0、但前面是「英文字 + 單一空白」(`FPC 0 Major Errors`、`Fan 0 failed`、`PEM 0 Input Failure`)
 *     的是插槽/模組編號,不是計數 ⇒ 也原樣留著;行首、標點後、兩格以上空白(欄位對齊)、`with` 後面才算計數。
 *  ② 關鍵字在前:`errors: 0`、`Tx_Errors=0`、`rx_crc_errors_phy: 0`、`"rx_errors": 0,`、`Errors (Rx) : 0`、
 *     `Input error CRC = 0`、`Total failure count ---> 0`、`Transmit Packet Errors........ 0`、
 *     `Failures: total 0`、`Format errors: 0/0`、`Bit errors      0`、`RX errors 0`、`v6-fail-close 0`、
 *     `Fail Times(0/5)`。
 *     關鍵字後面可夾 1~3 個英文字,但這時中間要有「:」「=」「--->」「.....」或兩格以上空白(表格對齊);
 *     夾的是 code / id / rate / on / at… 這類代碼、識別或介系詞,或單數的 port / slot / member…
 *     (編號,不是個數;複數的 `Failed ports: 0` 才是計數)就不算(`error code 0`、`failed on port 0`)。
 *     值只認整串都是 0 的十進位整數(0、00、000;有分隔符號時另認 `0/0`):後面接 `x`(0x0)、
 *     `.` + 數字(0.5、0.00%)、`:`(00:00:05)、`/` + 非 0(0/3)、`,` + 數字(0,123)、`%` 都不算;
 *     同一列後面還有非 0 的欄位(`errors   0   12`)也不算。
 *     0 後面只能是:行尾或 \r(原始串流裡 CR 之後是重畫,等於這一行到此為止)、`,` `.` `;` `)` `]`、
 *     兩格以上空白或 tab(下一欄)、單一空白 + 數字、
 *     單一空白 + 下一個 `key:` / `key=`、單一空白 + 下一個「名稱 數字」(ASA 的 `v6-fail-close 0 sctp-drop-override 0`)、
 *     ` (0.00%)`。單一空白後面接一般英文字的是句子不是計數:`error:0 in libc.so.6`(程式當掉)、
 *     `failure: 0 attempts remaining`、`ERROR: 0 bytes written`、`PSU2  Failed  0 W` 都照樣是警示。
 *     `(0/N)` 只在緊貼括號時當成「失敗 0 次/門檻 N」(FortiGate link-monitor 的 `Fail Times(0/5)`);
 *     `Health check failed (0/3)` 照樣是警示。
 *     回呼另外把這幾種原樣留著(算警示):
 *       · 關鍵字是 %FAC-[0-3]-MNEMONIC 的助記詞開頭(`%PLATFORM-3-FAILURE: 0 …`)—— 那是 syslog 嚴重訊息;
 *       · 關鍵字和代碼、識別黏成一個字(`ErrorCode: 0`、`error_code=0`)—— 同 `error code 0`;
 *       · 獨立的小寫單數 `error:` 緊貼數字(x86 trap 的 `… sp:7ffd5e6f7a8b error:0`,行尾沒有 ` in <檔名>` 也一樣)——
 *         那是程式當掉時印的錯誤代碼;
 *       · 關鍵字黏在別的英文字/數字後面、以單數 Error 結尾又緊接冒號(`KeyError: 0`、`AssertionError: 0 != 1`)——
 *         那是程式例外的訊息;其餘黏著的(`TcpExtTCPLossFailures 0`、`XfrmInStateProtoError   0`、
 *         `rxErrors=0`)是計數名稱,照常拿掉;
 *       · 表格的狀態欄:獨立的關鍵字後面直接空白接 0、中間沒夾字也沒有「:」「=」,而且是 failing
 *         (smartctl 的 `FAILING_NOW 0`),或是單數的 error / fail / failed / failure 隔兩格以上空白、
 *         0 後面不是逗號(kubectl 的 `Error      0      0s`)—— 那是狀態格 + 下一欄的讀數。
 *         代價:單數標籤的計數表(`Failed          0`)也會照樣算警示;複數(`Failures   0`)不受影響。
 * ⚠️ 不要單獨拿 LOG_ZERO_COUNTER_RE 去 test():① 連非 0 的計數也會比對到,哪些該拿掉是
 *    stripZeroCounters 的回呼決定的(回呼是定義的一部分);帶 g 旗標的 test() 還會記住 lastIndex。
 *    回呼靠「恰好兩個捕捉群組」拿到 offset 與原字串 —— 要加群組一律用 (?:…)。
 * ⚠️ 下面混用 /…/.source(裡面的 \t 是正則語法)與字串('[ \\t]' 要雙反斜線),改的時候別搞混。
 *    只能用 ES5 正則語法(沒有 lookbehind、具名群組、u/s/y 旗標):LuCI 沒有 build step,
 *    同一段還要跑在 webterm PWA 的舊版 Android Chrome 上。
 * 效能:每個重複都有上限或前後字元類互斥,不會災難性回溯;100 KB 病態行 < 50 ms
 *    (scripts/test/alert-zero-counters.test.js 有量)。 */
var LOG_ZERO_COUNTER_RE = (function () {
	/* 不能當「夾的英文字」或「下一個名稱」的字:代碼、識別、單數的編號名詞、比率、介系詞 */
	var deny = '(?:codes?|ids?|no|num|number|index|type|status|state|level|reason|mask|order|rate|ratio|' +
		'slot|port|unit|module|member|node|disk|drive|lane|channel|vlan|severity|priority|' +
		'on|at|in|of|for|from|to|by|since|after|before|while|during|with)\\b';
	/* 關鍵字後面夾的英文字 */
	var word = '[ \\t]+(?!' + deny + ')[a-z]{1,30}';
	/* 「:」「=」「--->」「.....」(點引導線),後面可以先接 total / count(`Failures: total 0`) */
	var sep = /[ \t]*(?:[:=]|-+>|\.{2,})[ \t]*(?:(?:total|count)[ \t]+)?/.source;
	/* 0 後面可以接什麼(見上面 ② 的說明);接著再確認同列後面沒有非 0 的欄位 */
	var after = '(?=\\s*$|[ \\t]*\\r|[;)\\]]|[,.](?:\\s|$)|\\t|[ \\t]{2}|[ \\t](?:\\d|[a-z_][\\w.\\/-]{0,40}[:=]|' +
		'(?!' + deny + ')[a-z][\\w-]{0,40}[ \\t]+\\d|\\(0+(?:\\.0+)?%\\)))' +
		/(?![ \t]+(?:0+[ \t]+)*[\d.,]*[1-9])/.source;
	return new RegExp(
		/* ① 數字在前(群組 1 = 數字前一格、群組 2 = 數字;是不是 0、是不是編號由 stripZeroCounters 判斷) */
		/(^|[ \t(])(\d{1,12}(?:[,\/]\d{1,12}){0,4})[ \t](?:[a-z]{1,30}[ \t]){0,3}?[a-z_]{0,30}(?:error|fail)[a-z]{0,30}/.source +
		/* ② 關鍵字在前(比對到的由回呼再篩一次) */
		'|' + /(?:error|fail)[\w-]{0,40}"?(?:[ \t]*\([a-z]{1,8}\))?/.source +
		'(?:(?:' + word + '){0,3}' + sep + /0+(?:\/0+)*/.source + after +
		'|(?:(?:' + word + '){1,3}[ \\t]{2,}|[ \\t]+)0+' + after +
		'|(?:' + word + '){0,3}' + /\(0+\/\d{1,9}\)/.source + ')', 'gi');
})();

/* 把 s 裡「數值為 0 的錯誤計數」換成等長的空白(其餘位置不動,呼叫端可以拿原本的位置切片)。
 * 換成空白不會拼出新的關鍵字:被換掉的片語至少 6 個字元,`link down` 中間只容許一格。 */
function stripZeroCounters(s) {
	return s.replace(LOG_ZERO_COUNTER_RE, function (m, lead, num, at, all) {
		var i, g;
		if (num) {                               /* ① 數字在前(② 沒有群組,num 是 undefined) */
			if (/[1-9,]/.test(num)) return m;    /* 不是 0(含 1,234 這種千分位):留著,關鍵字照算 */
			if (lead === ' ' || lead === '\t') {
				/* 數字前面是空白:往回看這段空白之前是什麼。只有一格、前面又是英文字/數字(不是 with)
				 * ⇒ `FPC 0`、`Fan 0` 這種編號,留著 */
				i = at - 1;
				while (i >= 0 && (all.charAt(i) === ' ' || all.charAt(i) === '\t')) i--;
				if (i >= 0 && at - i < 2 && /\w/.test(all.charAt(i)) &&
					!/(^|\W)with$/i.test(all.slice(Math.max(0, i - 4), i + 1))) return m;
			}
		} else {                                 /* ② 關鍵字在前 */
			/* %FAC-[0-3]-FAILURE: 0 —— 助記詞本身就是關鍵字開頭,拿掉就破壞嚴重度 0-3 的 syslog 判定 */
			if (all.charAt(at - 1) === '-' && /%\w+-[0-3]-$/.test(all.slice(Math.max(0, at - 64), at))) return m;
			/* 黏成一個字的代碼、識別(ErrorCode: 0、error_code=0、failover_id: 0):同 `error code 0`,不是計數 */
			if (/^(?:error|fail)[a-z]*[_-]?(?:codes?|ids?)(?![a-z])/i.test(m)) return m;
			/* 獨立的小寫單數 `error:` 緊貼數字:x86 trap 的錯誤代碼(`traps: java[2001] general protection … error:0`,
			 * 核心沒印 ` in libc.so.6[…]` 時就停在行尾),不是計數。ifconfig 的 `errors:0` 是複數,不受影響 */
			if (/^error:\d/.test(m) && (at === 0 || /\s/.test(all.charAt(at - 1)))) return m;
			if (at > 0 && /[a-z0-9]/i.test(all.charAt(at - 1))) {
				/* 黏在別的英文字/數字後面:單數 Error 緊接冒號的是例外訊息(KeyError: 0、AssertionError: 0 != 1),留著;
				 * 其餘(TcpExtTCPLossFailures 0、XfrmInStateProtoError  0、rxErrors=0)是計數名稱 */
				if (/^[\w-]*error:/i.test(m)) return m;
			} else if ((g = /^([a-z][\w-]*)([ \t]+)0+$/i.exec(m)) &&
				(/^failing/i.test(g[1]) || (/^(?:error|fail|failed|failure)$/i.test(g[1]) &&
				/[ \t]{2}|\t/.test(g[2]) && all.charAt(at + m.length) !== ','))) {
				return m;                        /* 表格的狀態欄:獨立的字 + 空白 + 0(沒夾字、沒有分隔符號) */
			}
		}
		return m.replace(/[\s\S]/g, ' ');        /* 數值為 0 的計數:拿掉 */
	});
}

/* 一行算不算警示:有關鍵字,而且拿掉「數值為 0 的錯誤計數」之後還有關鍵字。
 * s 是單獨一行(呼叫端先依 \n 切好;行尾殘留的 \r、--More-- 退格殘渣都不影響)。
 * ⚠️ 一定要是**完整的一行**:只拿到前半行時,`Framing errors:` 的值還沒到、`10 input errors` 只剩
 *    `0 input errors`,判定會錯 —— 逐塊收資料的呼叫端要自己留殘行(見標色器的 keepTail、senseStream)。 */
function isAlertLine(s) {
	return LOG_ALERT_RE.test(s) && LOG_ALERT_RE.test(stripZeroCounters(s));
}
/* ── 警示行判定 end ── */

var alertCount = 0;
var senseTotal = 0, senseBad = 0, garbleShown = false;
/* 廠牌狀態(#108 起是「自動 + 可手動釘住」兩軌,不是單一個 key):
 *   vendorAuto  自動偵測最近判定的那一家(null = 還看不出來)
 *   vendorPin   使用者手動釘住的那一家(null = 自動模式)—— 釘住時偵測照跑但不動畫面
 *   vendorKey   目前**生效**的那一家(= vendorPin || vendorAuto),指令鈕與亂碼提示都看它
 *   vendorRendered  指令鈕目前渲染的是哪一家(false = 還沒渲染過);重繪守門用
 * 三個都是頁面存活期,不隨重連/換埠重置(釘住的值就在下拉上看得見,釘錯一眼可辨),
 * 也不進任何瀏覽器儲存(理由見「控制通道」那段:記住「你連的是什麼設備」是留線索,
 * 而省下的只是一次點選;持久釘住還會在下一台設備上靜默壓掉自動偵測,比多點一次更糟)。 */
var vendorAuto = null, vendorPin = null, vendorKey = null, vendorBaud = null;
var vendorNext = 0, vendorDismissed = false, vendorRendered = false;
var vendorTimer = null;   /* 節流窗口內到的資料排的尾掃(見 senseStream) */
/* 遲滯用(2026-09-13):候選的那一家、以及它連續命中了幾次掃描。見 gateVendor() */
var vendorCand = null, vendorHits = 0;
/* 廠牌偵測用的滾動尾段。
 * 管理介面那邊每 2 秒呼叫一次 `logTail(60)` —— 那會把整個側錄緩衝重新合併+解碼一遍。
 * 手機上緩衝上限 2 MB,每 2 秒全量合併解碼是看得出來的卡頓
 * ⇒ 改成在資料流這一側維護一段固定長度的尾巴,每塊 O(1),完全不碰主緩衝。
 * 4000 字元 ≈ 50~80 行 console 輸出,涵蓋範圍與 logTail(60) 相當。 */
var senseTail = '';
/* 警示計數的殘行:這一塊最後那段還沒換行的字,接到下一塊再判(見 senseStream);斷線時清掉 */
var senseLine = '';

/* 「🔎 Log」鈕上的警示徽章:有累計就掛 (N⚠),沒有就恢復乾淨字樣 */
function updateLogBadge() {
	btnLogView.textContent = '🔎 Log' + (alertCount ? '（' + alertCount + '⚠）' : '');
}

function senseStream(txt) {
	var i, c, bad = 0, ls, now;

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
	/* 警示行粗略計數:逐行 isAlertLine(數值為 0 的錯誤計數不算,2026-10-09,與 LuCI terminal.js 同步),
	 * 命中就累加並更新徽章。只判**完整的行**:沒結束的那一段留在 senseLine 接到下一塊 ——
	 * BLE 一包常只有 20 位元組,`     0 ` | `input errors, 0 CRC` 被切開時,後半段單看像沒有值的關鍵字,
	 * 健康的 show interfaces 每行都可能多算一次。超過 4096 字元還沒換行的就不等了,照現有內容判一次。
	 * 這裡只求「有沒有東西該看」的提示,精確數字看檢視器裡的統計列。開啟檢視器即歸零。 */
	ls = (senseLine + txt).split('\n');
	senseLine = ls.pop();
	if (senseLine.length > 4096) { ls.push(senseLine); senseLine = ''; }
	c = alertCount;
	for (i = 0; i < ls.length; i++)
		if (isAlertLine(ls[i])) alertCount++;
	/* 只在真的變動時才寫 DOM —— BLE 通知一秒好幾十次,無條件改 textContent
	 * 等於在資料流熱路徑上每包都做一次版面重算 */
	if (alertCount !== c) updateLogBadge();

	/* 廠牌:節流成每 2 秒掃一次尾段(關鍵字比 prompt 正則穩 —— prompt 長相
	 * 各家都能自訂,但開機橫幅/版本字串裡的廠牌名幾乎改不掉) */
	senseTail = (senseTail + txt).slice(-4000);
	now = Date.now();
	if (!vendorNext || now > vendorNext) {
		vendorNext = now + 2000;
		senseVendor();
	} else if (!vendorTimer) {
		/* 窗口內到的資料也要掃到(2026-10-09 FortiGate 實測,與 LuCI terminal.js 同步):掃描只在資料
		 * 到達時觸發,登入提示這種單發輸出常是「第一塊回顯觸發掃描、第二塊才是 `FortiGate-60F login:`」
		 * —— 橫幅落在窗口內被跳過,之後設備安靜 ⇒ 沒有東西會再掃,要再按一次 Enter 才認得廠牌。
		 * 補一個尾掃:窗口一過就掃一次,仍是每 2 秒最多一次。 */
		vendorTimer = setTimeout(function () {
			vendorTimer = null;
			if (!senseTail) return;
			vendorNext = Date.now() + 2000;
			senseVendor();
		}, vendorNext - now + 1);
	}
}

/* 掃本次連線的滾動尾段,命中就送進遲滯閘門;掃不到就什麼都不做 —— 維持上一個判定,
 * 不清空(使用者上一秒還在用那些鈕)。節流掃與尾掃共用這一支。 */
function senseVendor() {
	var v = detectVendor(senseTail);
	if (v) gateVendor(v);
}

/* ── 廠牌智慧快捷鈕 ────────────────────────────────────────────────────
 * 偵測到(或使用者手動選定)廠牌 → 給那家的常用巡檢指令。
 * 整排只在有廠牌、或使用者按了「🏷 廠牌」時才出現,平常零佔位。
 * 送的是「整行指令 + CR」不是控制碼,所以走 sendText 而不是 data-seq 那條路。
 * 全部是唯讀查詢指令(show/get/diagnose/dmesg),不改設定 —— 這是選指令的準則,
 * 誤按一下最多多印一頁東西,不會動到正式設備的組態。
 *
 * ⚠️ 自動偵測仍可能誤判,所以這排一定要能手動覆寫(#108):比對是「VENDORS 依表格
 *    順序、第一個命中就定案」。~~2026-09-13 前:Cisco 那條認裸字 `cisco` ⇒ 一台
 *    FortiGate 只要設定裡有 `set description "to cisco switch"` 就被判成 Cisco
 *    IOS,而且 cisco 排在 fortinet 前面會贏。~~ → 已改成有上下文的 pattern +
 *    遲滯(VENDOR_CONFIRM),但 first-match-wins 本身沒變,而且 CDP/LLDP 鄰居輸出
 *    會印出**對方**的橫幅 —— 沒有任何 pattern 治得了那種。誤判的後果是「按下去
 *    真的送出去」的快捷鈕給錯廠牌,所以下拉選單就放在廠牌標籤旁邊 —— 看到誤判
 *    的當下就能改。 */

/* 掃一段文字,回傳第一個命中的廠牌(表格順序);沒命中回 null。
 * 自動偵測與「選回自動偵測時立刻重掃」共用同一支,行為保證一致。 */
function detectVendor(text) {
	var i;

	if (!text) return null;
	for (i = 0; i < VENDORS.length; i++)
		if (VENDORS[i].kw.test(text)) return VENDORS[i];
	return null;
}

function vendorByKey(key) {
	var i;

	if (!key) return null;
	for (i = 0; i < VENDORS.length; i++)
		if (VENDORS[i].key === key) return VENDORS[i];
	return null;
}

/* 下拉只有兩種值,這是整個功能的狀態模型:
 *   value === 'auto'  ⇒ 自動模式。偵測結果寫在 auto 那個 option 的**文字**裡
 *                       (「自動偵測（Fortinet）」),value 本身恆為 'auto'。
 *   value === 某個 key ⇒ 使用者釘住那一家。
 * ⚠️ 不要改成「value 跟著偵測結果跑」:①select 已經是 cisco 時再選 cisco,
 *    瀏覽器不發 change ⇒ 使用者就無法「釘住剛好偵測對的那一家」(偵測對了、
 *    但不想讓它每 2 秒再飄,是真需求)②畫面上分不出「自動偵測到 Cisco」
 *    與「我釘了 Cisco」。 */
function syncVendorSel() {
	var v = vendorByKey(vendorAuto), carry;

	if (!elVendorSel) return;
	/* 自動模式下,畫面上那組鈕有可能不是自動偵測來的 —— 釘住某家之後選回
	 * 「自動偵測」、而當前輸出又掃不出廠牌時,我們刻意維持原本那排不清空
	 * (使用者上一秒還在用)。那種狀態如果只寫「自動偵測」,使用者無從得知
	 * 鈕是殘留的 ⇒ 明講「沿用」。 */
	carry = (!vendorPin && vendorRendered && vendorRendered !== vendorAuto)
		? vendorByKey(vendorRendered) : null;
	elVendorSel.options[0].textContent = carry
		? '自動偵測（沿用 ' + carry.name + '）'
		: (v ? '自動偵測（' + v.name + '）' : '自動偵測');
	elVendorSel.value = vendorPin || 'auto';
}

/* 算出生效廠牌 → 重繪指令鈕。不管顯示/隱藏。 */
function applyVendor() {
	var v = vendorByKey(vendorPin || vendorAuto);

	vendorKey = v ? v.key : null;
	vendorBaud = v ? v.baud : null;   /* 亂碼提示吃這個 —— 手動釘的也算(見 renderGarbleHint) */
	renderVendorCmds(v);
}

/* 只負責「這排裡面長什麼樣」;v 為 null ⇒ 只剩下拉與 ✕(沒有指令鈕)。
 * ⚠️ render 與 reveal 必須拆開:按 ✕ 隱藏後再按「🏷 廠牌」要能叫回來,
 *    而召喚時廠牌沒變 ⇒ 若召喚也走這支(以 key 守門),會在守門那行 return,
 *    整排永遠叫不回來(死召喚鈕)。顯示一律走 revealVendorRow()。
 * ⚠️ 重建會清掉所有子節點 ⇒ 下拉與 ✕ 必須是**寫在 HTML 的持久節點**,清完接回來。
 *    若改成每次 new 一個 select,使用者選的廠牌會被下一次偵測(每 2 秒)重設回去。 */
function renderVendorCmds(v) {
	var key = v ? v.key : null, i, btn, lbl;

	if (vendorRendered === key) return;
	vendorRendered = key;
	while (elVendorRow.firstChild) elVendorRow.removeChild(elVendorRow.firstChild);
	elVendorRow.appendChild(elVendorSel);

	if (v) {
		lbl = document.createElement('span');
		lbl.className = 'vlabel';
		lbl.textContent = '常用：';
		elVendorRow.appendChild(lbl);
		for (i = 0; i < v.cmds.length; i++) {
			btn = document.createElement('button');
			btn.className = 'vcmd';
			btn.tabIndex = -1;
			/* textContent:廠牌表是我們自己的常數,但一律不碰 innerHTML 是全頁通則 */
			btn.textContent = v.cmds[i];
			btn.title = '送出:' + v.cmds[i];
			btn.addEventListener('click', function() {
				flash(this);
				/* 未連線不設 disabled —— 按了跳提示,不做沉默死鈕(同快捷鍵列紀律) */
				if (!rxChar) { toast(NOT_CONNECTED, 'warn'); return; }
				if (ctrlArmed) setCtrlArmed(false);
				sendText(this.textContent + '\r');
				toast('已送出:' + this.textContent);
				term.focus();
			});
			elVendorRow.appendChild(btn);
		}
	}
	elVendorRow.appendChild(elVendorClose);
	elVendorRow.classList.toggle('notlive', !rxChar);
}

/* 無條件顯示這排(不看廠牌有沒有變、也不看現在是不是已經顯示著) */
function revealVendorRow() {
	syncVendorSel();
	elVendorRow.classList.add('show');
	elVendorRow.classList.toggle('notlive', !rxChar);
	if (btnVendor) btnVendor.setAttribute('aria-expanded', 'true');
	setTimeout(fitRows, 0);   /* 多一排 → 終端列數要重算 */
}

/* 自動偵測的遲滯閘門(#108 ⑧ 後續,2026-09-13)—— 每 2 秒一次的掃描結果先過這裡:
 *   · 還沒有任何判定 ⇒ 立刻採用(首次不是「換」,等 6 秒只會像功能壞了)
 *   · 與目前判定同一家 ⇒ 直接往下(showVendorRow 自己判斷要不要動畫面),候選歸零
 *   · 換成別家 ⇒ 要連續 VENDOR_CONFIRM 次掃描都是它才切換;中間夾一次別的就重數
 * 為什麼需要:同一段尾巴每 2 秒重掃一次,兩家的關鍵字若同時落在裡面
 * (例:Cisco 的設定裡提到 FortiGate、CDP/LLDP 鄰居資訊印出對方的橫幅),
 * 判定就會來回跳。遲滯把「偶爾掃到」與「這台真的是它」分開。
 * ⚠️ 釘住(vendorPin)時這裡照跑 —— 擋畫面是 showVendorRow 的事,
 *    這樣「自動偵測（X）」的文字才會在解除釘住前就先跟上。 */
function gateVendor(v) {
	if (!vendorAuto || v.key === vendorAuto) {
		vendorCand = null;
		vendorHits = 0;
		showVendorRow(v);
		return;
	}
	if (vendorCand === v.key) vendorHits++;
	else { vendorCand = v.key; vendorHits = 1; }
	if (vendorHits < VENDOR_CONFIRM) return;
	vendorCand = null;
	vendorHits = 0;
	showVendorRow(v);
}

/* 自動偵測命中時的入口(每 2 秒最多一次,且已過遲滯閘門) */
function showVendorRow(v) {
	if (vendorAuto !== v.key) {
		vendorAuto = v.key;
		/* 「自動偵測（X）」要跟上 —— 即使現在被釘住或被關掉,
		 *  使用者下次打開下拉時看到的判定才是新的 */
		syncVendorSel();
	} else if (vendorPin || vendorDismissed || elVendorRow.classList.contains('show')) {
		return;   /* 同一家又沒有狀態變化:什麼都不用做(別每 2 秒重算一次版面) */
	}
	if (vendorPin) return;   /* 釘住:偵測照跑,但一律不蓋掉使用者的選擇 */
	applyVendor();
	if (!vendorDismissed) revealVendorRow();   /* 按過 ✕ 就不自己叫回來 */
}

function hideVendorRow() {
	elVendorRow.classList.remove('show');
	if (btnVendor) btnVendor.setAttribute('aria-expanded', 'false');
	setTimeout(fitRows, 0);
}

/* ── 亂碼急救 / 亂碼偵測(對外名稱依韌體能力而異)──────────────────────
 * ⚠️ 一頁兩種說法,是刻意的:
 *   - 韌體 **v1.8 起**有控制通道 ⇒ 提示旁邊就給一排一鍵換鮑率的按鈕,
 *     與管理介面網頁終端的「亂碼急救」同一個語意。
 *   - **舊韌體**沒有控制通道 ⇒ 那排按鈕做不出來,只能偵測;文案必須明確
 *     告訴使用者「該去哪裡改」,不留一句讓人乾瞪眼的提示。
 * 本頁公開託管、買家手上什麼韌體都有,兩種情況都要能自圓其說
 * (本專案紀律:全頁無沉默死鈕,也不做沒有下一步的提示)。 */
function showGarbleHint() {
	if (garbleShown) return;
	garbleShown = true;   /* 本次連線只提示一次,不當跳針保姆 */
	renderGarbleHint();
}

/* 廠牌換了(手動選或偵測到別家)⇒ 已經顯示中的亂碼提示要跟著換:
 * 文案與「一鍵試鮑率」的排序都吃 vendorBaud。沒在顯示就什麼都不做 ——
 * 換廠牌不該自己跳出一條亂碼提示。 */
function refreshGarbleHint() {
	if (!garbleShown || !elBanner.classList.contains('show')) return;
	renderGarbleHint();
}

function renderGarbleHint() {
	var why;

	/* 廠牌表的第二個消費者:有廠牌就講那家的預設值,講不出來才給通則。
	 * (亂碼時廠牌多半偵測不到 —— 字都解不開了 —— 但半糊半清的情況確實會發生;
	 *  這也是「手動選廠牌」在亂碼時特別有用的原因:偵測不到就自己指定) */
	why = vendorBaud
		? (vendorPin ? '你指定的廠牌是 ' : '偵測到的設備看起來是 ') + vendorName() +
			'，其 console 預設多為 ' + vendorBaud
		: '設備常見 9600 或 115200';
	if (ctlAvail) {
		showBanner('⚠️ 輸出像亂碼 —— 最常見原因是鮑率不符（' + why +
			'）。下面挑一個試試看 —— 按了才會換，本頁不會自己動你的設備。');
		showBaudRow();
	} else {
		showBanner('⚠️ 輸出像亂碼 —— 最常見原因是鮑率不符（' + why +
			'）。這台裝置的韌體還不能從藍牙改鮑率（韌體 v1.8 起可以），' +
			'改鮑率請到裝置的管理介面「網頁終端」頁，' +
			'或用支援 RFC 2217 的軟體連 4001 埠。');
	}
}

/* 一鍵試鮑率那排:只在亂碼提示出現、且韌體有控制通道時才建。
 * 廠牌預設值排第一顆(偵測得到的話)—— 那是最可能對的那個。
 * ⚠️ 這排是**條件顯示**,沒亂碼時零佔位,不吃「常駐區塊最多兩排」的額度。 */
function showBaudRow() {
	var list = BAUD_TRY.slice(), vb, i;

	if (!elBaudRow || !ctlAvail) return;
	vb = vendorBaud ? parseInt(vendorBaud, 10) : 0;
	if (vb) list = [vb].concat(list.filter(function(b) { return b !== vb; }));

	while (elBaudRow.firstChild) elBaudRow.removeChild(elBaudRow.firstChild);
	elBaudRow.appendChild(document.createTextNode('一鍵試鮑率：'));
	for (i = 0; i < list.length; i++) {
		(function(b, isVendor) {
			var btn = document.createElement('button');

			btn.tabIndex = -1;
			/* textContent:數字是我們自己算的,但一律不碰 innerHTML 是全頁通則 */
			btn.textContent = b + (isVendor ? '（廠牌預設）' : '');
			btn.title = '把序列埠切換成 ' + b + ' bps';
			btn.addEventListener('click', function() {
				flash(btn);
				trySetBaud(b);
				term.focus();
			});
			elBaudRow.appendChild(btn);
		})(list[i], !!vb && list[i] === vb);
	}
	elBaudRow.classList.add('show');
	setTimeout(fitRows, 0);   /* 多一排 → 終端列數要重算 */
}

function hideBaudRow() {
	if (!elBaudRow) return;
	elBaudRow.classList.remove('show');
	setTimeout(fitRows, 0);
}

function vendorName() {
	var v = vendorByKey(vendorKey);

	return v ? v.name : '';
}
/* 純文字化:拿掉終端控制碼,讓紀錄檔用一般文字編輯器就看得懂。
 * 只做「移除」不做畫面重演 —— 例如 --More-- 用 CR 覆寫的那行會留下空白,
 * 這比假裝重現畫面誠實,也不會誤刪內容。
 * ⚠️ 2026-10-02 更新(N8):上面這條原則**對 BS / 裸 CR / CSI K 不再成立** —— 改成行內游標模擬
 *    (輸出 = 每行的最終畫面),與 OpenWRT repo 的 MCP `src/airtty-mcp/lib/ansi.js`、
 *    LuCI `view/airtty/terminal.js` stripAnsi() 同一套語意,詳見 toPlainText 內的註解。
 *    理由:「只移除」對 BS 的結果是**既不是打的、也不是看到的**第三種文字(進度條數字整段被吃光、
 *    `shoxx\b\bw` 變 `show` 而畫面是 `showx`);送給 AI 的脈絡必須與畫面一致。
 *    其餘控制碼(RE_CTRL)仍然只做移除。
 * 2026-10-02 起 CSI 不再用 regex 先剝(原 RE_CSI 已移除):`ESC[K` 要讓游標模擬看到。 */
var RE_OSC     = /\x1b\][\s\S]*?(?:\x07|\x1b\\)/g;      /* 視窗標題等 OSC 序列 */
var RE_CHARSET = /\x1b[()*+][ -/]*[0-9A-Za-z]/g;        /* ESC ( B 之類的字元集指定 */
var RE_ESC2    = /\x1b[78=>MDEHc]/g;                    /* 存/取游標、小鍵盤模式等 */
var RE_CTRL    = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;   /* 其餘控制碼(保留 Tab 與換行;在游標模擬**之後**才套) */

function toPlainText(raw) {
	var s, out, cells, col, i, j, n, c, code, mode, k;

	s = raw
		.replace(RE_OSC, '')
		.replace(RE_CHARSET, '')
		.replace(RE_ESC2, '');
	/* ── 行內游標模擬(2026-10-02,N8)──
	 * 輸出 = 每行的最終畫面:
	 *   · 可列印字元寫在游標那一格(覆寫或接在後面),游標右移;
	 *   · BS(0x08)只是游標左移,行首不動,**不刪字**。
	 *     歷史:2026-09-19 使用者實測抓到 `sho ` 用退格修成 `show`,側錄/AI 脈絡卻是 `sho w`
	 *     (當時 RE_CTRL 把 0x08 刪掉、卻留下它要擦掉的字)⇒ 09-19 改成「BS = 刪前一個字元」;
	 *     10-02 再改成游標左移 —— 「刪字」語意讓進度條最後一筆後面的 BS 把數字整段吃光
	 *     (OpenWRT repo `docs/plans/n3k-field-issues-analysis.md` §6-6 [實測]);
	 *   · 裸 `\r` 游標回行首;`\r\n`(含 `\r\r\n`)與 `\n` 是行尾;字串尾端的 `\r` 原樣保留;
	 *   · CSI `K`(0/1/2)照終端語意清行,其餘 CSI 丟掉;不完整的 CSI 只丟 ESC;
	 *     參數集合比 MCP 多收 `<>=!`(原 RE_CSI 就收,DA 回應之類),對 MCP 會遇到的輸入結果相同;
	 *   · 行尾只剪**游標最後停的位置之後**的空白(`--More--` 擦除留下的格子)。
	 * 單次掃描,O(n);輸入是設備吐的原文、跑在瀏覽器主執行緒。
	 * 行為由 OpenWRT repo `scripts/test/strip-ansi-parity.test.js` 對另外兩份實作釘住。 */
	if (/[\x08\r\x1b]/.test(s)) {
		out = [];
		cells = [];
		col = 0;
		i = 0;
		n = s.length;
		while (i < n) {
			c = s.charAt(i);
			if (c === '\x1b') {
				if (s.charAt(i + 1) === '[') {
					j = i + 2;
					while (j < n && /[0-9;:?<>=!]/.test(s.charAt(j))) j++;
					mode = s.slice(i + 2, j);
					while (j < n && s.charAt(j) >= ' ' && s.charAt(j) <= '/') j++;
					if (j < n && s.charAt(j) >= '@' && s.charAt(j) <= '~') {
						if (s.charAt(j) === 'K') {
							if (mode === '' || mode === '0') {
								if (cells.length > col) cells.length = col;
							} else if (mode === '1') {
								for (k = 0; k <= col && k < cells.length; k++) cells[k] = ' ';
							} else if (mode === '2') {
								for (k = 0; k < cells.length; k++) cells[k] = ' ';
							}
						}
						i = j + 1;
						continue;
					}
				}
				i++;
				continue;
			}
			if (c === '\n') {
				while (cells.length > col && cells[cells.length - 1] === ' ') cells.pop();
				out.push(cells.join(''), '\n');
				cells = []; col = 0; i++;
				continue;
			}
			if (c === '\r') {
				j = i;
				while (s.charAt(j) === '\r') j++;
				if (s.charAt(j) === '\n' || j >= n) {
					while (cells.length > col && cells[cells.length - 1] === ' ') cells.pop();
					out.push(cells.join(''), j >= n ? '\r' : '\r\n');
					cells = []; col = 0;
					i = j >= n ? j : j + 1;
					continue;
				}
				col = 0;
				i = j;
				continue;
			}
			if (c === '\x08') { if (col > 0) col--; i++; continue; }
			code = s.charCodeAt(i);
			if (code >= 0xd800 && code <= 0xdbff && i + 1 < n) {
				k = s.charCodeAt(i + 1);
				if (k >= 0xdc00 && k <= 0xdfff) c = s.slice(i, i + 2);
			}
			if (col < cells.length) cells[col] = c; else cells.push(c);
			col++;
			i += c.length;
		}
		if (cells.length) {
			while (cells.length > col && cells[cells.length - 1] === ' ') cells.pop();
			out.push(cells.join(''));
		}
		s = out.join('');
	}
	return s
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

/* ⚠️⚠️ **控制通道的探索絕對不可以擋在主鏈上**(2026-09-06 迴歸,實機打臉)
 *
 * v7 第一版把 CTL 的 getCharacteristic ×2 + startNotifications 串在 NUS 之後、
 * 而 `setStatus / setButtons / say / term.focus / fitRows` 又串在 CTL 之後。
 * 實機 log:`AcquireNotify(NUS)` 在 :31、`AcquireNotify(CTL)` 在 **:52**
 * —— 中間 21 秒,主鏈就卡在那裡。後果不是「控制功能慢一點」而是**連不上**:
 *   `term.focus()` 沒跑 ⇒ 使用者打的字沒有進終端 ⇒ 一個位元組都沒送出
 *   ⇒ 裝置端整條 session **沒有任何 AcquireWrite** ⇒ 30 秒後 wsbridge 密碼逾時斷線。
 * 線上 v6 正常、v7 掛掉,差別就在這條鏈。
 *
 * ∴ 鐵律:**主鏈只做 NUS**,做完立刻把畫面與焦點交還使用者(與 v6 逐行相同);
 * 控制通道**另外排隊、延後、逾時、全程 catch**,失敗只是少了功能,絕不影響終端。 */

/* ~~1500:等密碼提示與前幾包序列輸出先流完再碰 GATT~~ —— v17 改 0(2026-10-15)。
 * 韌體 v1.9.0 起裝置端要等「列出 / 選孔」命令才接序列埠,**沒等到就在 1.5 秒後自己接預設孔**;
 * 這裡若還延後 1500 ms 才開始找控制通道,LIST 永遠晚到、多條線的人每次都會被接到孔號最小的那一孔。
 * 而延後的原始理由(讓密碼提示先流完)在新韌體上已不存在 —— 選孔之前根本沒有輸出。
 * [實測 2026-10-15,bleak/macOS] NUS 訂閱 → CTL 訂閱約 60 ms、命令寫入再約 60 ms。
 * ⚠️ 仍然**不進主鏈**(v7 鐵律不變):主鏈做完、畫面交還使用者之後才在背景開始。 */
var CTL_DISCOVER_DELAY_MS = 0;
var CTL_STEP_TIMEOUT_MS = 5000;    /* 單一 GATT 步驟的上限,掛住就放棄控制通道 */

/* 連線世代:每次連線 +1。控制通道的探索是非同步的,若使用者在探索途中斷線
 * 或重連,舊那輪的結果必須作廢 —— 否則會把**上一條連線**的特徵值物件
 * 掛到新狀態上,按鈕看起來能按、實際寫到已死的 GATT。 */
var connGen = 0;

/* 這兩個旗標只是「同一種錯誤只吵一次」,避免每包資料都洗一行提示 */
var termWriteFailed = false, logAppendFailed = false;

function withTimeout(promise, ms, label) {
	return new Promise(function(resolve, reject) {
		var done = false;
		var t = setTimeout(function() {
			if (!done) { done = true; reject(new Error('timeout:' + label)); }
		}, ms);
		promise.then(function(v) {
			if (done) return;
			done = true; clearTimeout(t); resolve(v);
		}, function(e) {
			if (done) return;
			done = true; clearTimeout(t); reject(e);
		});
	});
}

function onCtlValue(ev) {
	var dv = ev.target.value;

	onCtlFrame(new Uint8Array(dv.buffer.slice(dv.byteOffset, dv.byteOffset + dv.byteLength)));
}

/* NUS 的裝置輸出(具名、wireUp 先拔再掛 —— 與 onCtlValue 同理:瀏覽器重連後若回同一個特徵值物件,
 * 匿名函式會多掛一份 ⇒ 每包輸出畫兩次、側錄兩份) */
function onNusValue(ev) {
	var dv = ev.target.value;
	/* 複製一份再交出去:xterm 的 write 是排隊非同步處理,
	 * 而事件裡的 DataView 背後緩衝區由瀏覽器的 BLE 堆疊持有 */
	var u8 = new Uint8Array(dv.buffer.slice(dv.byteOffset, dv.byteOffset + dv.byteLength));
	rxBytes += u8.length;   /* 判「連上就被斷、什麼都沒收到」用(見斷線處理)—— 暫存的也算,收到就算 */
	if (outHeld()) {        /* 選孔還沒有結果:先暫存,本頁說明印完再補印(見 outQ) */
		outQ.push({ u8: u8, t: Date.now() });
		outQBytes += u8.length;
		if (outQBytes > OUT_HOLD_MAX) { outLive = true; outFlush(); }
		return;
	}
	outFlush();             /* 保險:照理結束扣住時就補印完了;萬一有剩,先補舊的再畫新的,順序不亂 */
	outEmit(u8);
}

/* 暫存期間 = 扣住鍵盤、而且選孔列沒開著(見 outQ) */
function outHeld() {
	return portHold && !choosing && !outLive;
}

/* 依到達順序補印暫存的裝置輸出 */
function outFlush() {
	var q = outQ, i;

	if (!q.length) return;
	outQ = [];
	outQBytes = 0;
	for (i = 0; i < q.length; i++) outEmit(q[i].u8, q[i].t);
}

/* 裝置輸出的**唯一出口**:畫面 + 側錄/偵測。即時與補印都走這裡 ⇒ 兩邊看到的位元組與順序一定相同。
 * t = 收到的時間(補印時帶;即時的不帶,由 logAppend 取現在時間) */
function outEmit(u8, t) {
	/* ⚠️ 畫面優先,而且兩段各自 try —— 這是**唯一**把裝置輸出畫上去的地方,
	 * 任何一行拋例外都會變成「連上了卻什麼都看不到」這種最難查的症狀
	 * (2026-09-06 迴歸就長這樣)。側錄/偵測那一側再怎麼壞,
	 * 都不可以連累終端顯示;壞了就明講一次,不要靜靜吞掉。 */
	try {
		term.write(u8);
	} catch (e) {
		if (!termWriteFailed) {
			termWriteFailed = true;
			say('⚠️ 終端顯示發生錯誤:' + (e && e.message) + '（請回報這行）');
		}
	}
	try {
		logAppend(u8, t);
	} catch (e) {
		if (!logAppendFailed) {
			logAppendFailed = true;
			say('⚠️ 側錄/偵測發生錯誤:' + (e && e.message) +
				'（終端本身仍可用，請回報這行）');
		}
	}
}

/* 背景補上控制通道。**永遠不 throw 給呼叫端**,任何失敗都只是「這台沒有控制功能」。 */
function setupControlChannel(svc, gen) {
	if (!svc) return;
	withTimeout(Promise.all([
		svc.getCharacteristic(CTL_RX).catch(function() { return null; }),
		svc.getCharacteristic(CTL_TX).catch(function() { return null; })
	]), CTL_STEP_TIMEOUT_MS, 'discover').then(function(cc) {
		/* 世代不符 = 已經斷線或重連過,這輪結果作廢 */
		if (gen !== connGen || !rxChar) return null;
		if (!cc[0] || !cc[1]) {                 /* 舊韌體(v1.8 以前):正常情況,只講「先連預設的孔」那一行 */
			portUnsupported();
			return null;
		}
		ctlRxChar = cc[0];
		ctlTxChar = cc[1];
		/* 具名、先拔再掛:瀏覽器若在重連後回同一個特徵值物件,匿名函式會多掛一份 ⇒ 每則控制訊框處理兩次
		 * (v18 的 LIST 是多則訊框累加,重複一則就判成格式錯;與 onGattDisconnected 同一個道理) */
		ctlTxChar.removeEventListener('characteristicvaluechanged', onCtlValue);
		ctlTxChar.addEventListener('characteristicvaluechanged', onCtlValue);
		return withTimeout(ctlTxChar.startNotifications(),
			CTL_STEP_TIMEOUT_MS, 'startNotifications').then(function() {
			if (gen !== connGen) return null;
			setCtlAvail(true);   /* 到這裡才顯示按鈕:能訂閱才代表真的可用 */
			listPorts(gen);      /* v18:訂閱好立刻列出序列埠(要搶在裝置的 1.5 秒保底之前;收到 LIST 裝置就不再替我們挑) */
			return null;
		});
	}).catch(function(e) {
		if (gen !== connGen) return;
		ctlRxChar = ctlTxChar = null;
		setCtlAvail(false);
		/* 只記一行,不用 toast —— 使用者此刻多半正在打密碼,不要蓋畫面 */
		say('（這台裝置的序列埠控制功能無法使用：' +
			(e && e.message ? e.message : '探索失敗') + '，終端本身不受影響）');
		/* 控制通道「有但壞了」(逾時/訂閱失敗)≠ 舊韌體:列出命令根本沒送出去,
		 * 同「命令沒寫進去」處理 —— 新韌體會在 1.5 秒保底自己接預設孔(多條線時在終端講接了哪一孔) */
		onListResult(gen, { kind: 'writefail', ports: [] });
	});
}

function wireUp(server) {
	var svcRef = null;
	var gen = connGen;

	return server.getPrimaryService(NUS_SVC).then(function(svc) {
		svcRef = svc;   /* 控制通道稍後從同一個 service 取 */
		return Promise.all([
			svc.getCharacteristic(NUS_RX),
			svc.getCharacteristic(NUS_TX)
		]);
	}).then(function(chars) {
		/* ⚠️ 從這裡起鍵盤就會往 rxChar 送 —— 靠 connectFlow 先設好的 portHold 扣住;
		 * 這裡再設一次:connectFlow 之後若有晚到的斷線事件跑過 portSettled(false),扣住不能因此破功 */
		portHold = true;
		rxChar = chars[0];
		txChar = chars[1];
		txChar.removeEventListener('characteristicvaluechanged', onNusValue);
		txChar.addEventListener('characteristicvaluechanged', onNusValue);
		return txChar.startNotifications();
	}).then(function() {
		/* ── 主鏈到此為止:立刻把畫面與焦點交還使用者 ──
		 * v17 起「輸入連線密碼後即進 console」改到選孔有結果時才講(那時才知道接的是哪一孔);
		 * 這裡先講「正在問有哪些孔」。選孔有結果之前鍵盤先扣住(見 portHold)。 */
		setStatus('已連線:' + devLabel(), 'ok');
		setButtons('connected');
		connectedAt = Date.now();
		say('已連上藍牙，正在問這台 AirTTY 有哪些序列埠…');
		term.focus();
		fitRows();
		/* 控制通道在背景做:就算它掛住 5 秒逾時,終端早就能用了。刻意**不 return**,不進主鏈。
		 * (v17 起不再延後,理由見 CTL_DISCOVER_DELAY_MS) */
		setTimeout(function() { setupControlChannel(svcRef, gen); }, CTL_DISCOVER_DELAY_MS);
	});
}

/* 連線中換孔 / 選孔失敗後的自動重連,與使用者按「重新連線」走同一個入口。
 * ⚠️ 延後 1 秒才連:裝置端以「藍牙位址」認 session,舊 session 還沒收乾淨時
 *    新連線的訂閱會被當成重複而拒絕(blebridge「舊 session 尚未收斂,拒絕」)。 */
var RECONNECT_DELAY_MS = 1000;

function connectFlow(dev) {
	wantDisconnect = false;
	/* 逐連線狀態歸零(v17 起)。connGen 的 +1 是檔頭那段「連線世代」註解一直說有、
	 * 程式卻從來沒做的事 —— 少了它,上一條連線晚到的選孔結果會被當成這一條的。
	 * pendingPick(換孔 / 重連後直接接的孔)刻意**不**歸零:它就是要跨這一次重連。 */
	connGen++;
	portChosen = -1;
	portHow = '';
	lastPorts = [];
	listRetries = 0;
	listResent = false;
	choiceGone = null;
	/* 一開始就扣住鍵盤(見 portHold):選孔有結果(portSettled)、或舊韌體 / 控制通道不可用(portUnsupported 等)才放開。
	 * 連線失敗時維持扣住 —— 沒接好的連線不送任何字;下次 connectFlow 會清掉 heldBytes */
	outFlush();             /* 照理是空的(斷線時就補印完了);萬一有剩也是補印,不丟 */
	outLive = false;
	portHold = true;
	heldBytes = [];
	hideChooser();
	backendDown = null;
	dropPlan = null;
	rxBytes = 0;
	connectedAt = 0;
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

/* 「連上後什麼都沒收到就被斷」的時間窗:舊韌體(v1.8.11 以前)藍牙固定接的那個埠沒接線時,
 * [實測 2026-10-15] 訂閱完約 2.5 秒就被裝置斷開、一個位元組都沒有。 */
var EARLY_DROP_MS = 8000;

/* 斷線處理(具名函式:同一個 BluetoothDevice 物件重選時只掛一次 —— 瀏覽器對同一台裝置
 * 會回同一個物件,匿名函式每次 addEventListener 都會多掛一份,斷線訊息就印兩次,
 * v17 的自動重連更會連兩次) */
function onGattDisconnected() {
	var plan = dropPlan, bd = backendDown, wasChoosing = choosing;
	/* 「連上就斷、什麼都沒收到」怪舊韌體,只在本頁**沒拿到 v1.9.0 的清單、也沒選孔成功**時才成立
	 * (2026-10-18 審查):新韌體接好不要密碼的孔之後本來就可能一個位元組都沒有,這時斷線是一般斷線。
	 * lastPorts / portChosen 只在 connectFlow 歸零,這裡讀到的是這一條連線的 */
	var early = !bd && !plan && !wantDisconnect && !wasChoosing && rxBytes === 0 &&
		portChosen < 0 && !lastPorts.length &&
		connectedAt > 0 && (Date.now() - connectedAt) < EARLY_DROP_MS;

	rxChar = txChar = null;
	/* 控制通道狀態一併歸零:斷線後那些按鈕必須立刻失去作用,
	 * 否則使用者按下去只會拿到「送不出去」,還以為裝置壞了。
	 * 就緒與否是**逐連線**的事實(密碼要重新登入),不可沿用。 */
	ctlRxChar = ctlTxChar = null;
	setCtlAvail(false);
	hideBaudRow();
	ctlPending.forEach(function(r) { clearTimeout(r.timer); });
	ctlPending = [];
	if (listPending) { clearTimeout(listPending.timer); listPending = null; }
	hideChooser();
	dropPlan = null;
	if (wantDisconnect) {
		setStatus('已斷線');
		setButtons('idle');
	} else if (plan && plan.reconnect) {
		setStatus(plan.status);
		setButtons('connecting');
		setTimeout(function() { if (device) connectFlow(device); }, RECONNECT_DELAY_MS);
	} else if (bd) {
		/* 裝置已經講過原因(0xA2)⇒ **不再猜**「裝置關機/超出距離」 */
		setStatus(backendDownStatus(bd), 'err');
		setButtons('dropped');
		say('藍牙連線已由 AirTTY 結束。換好轉接線後按「↻ 重新連線」，再選要接的孔');
	} else if (plan) {
		setStatus(plan.status, 'err');
		setButtons('dropped');
	} else if (wasChoosing) {
		/* 選孔列開著時斷線 = 裝置端 30 秒選孔守門到期(或人走開了)⇒ 講這個,不猜距離 */
		setStatus('沒有選孔', 'err');
		setButtons('dropped');
		say('沒有在時限內選孔，AirTTY 已中斷藍牙連線。按「↻ 重新連線」再選一次');
	} else if (early) {
		setStatus('連線中斷', 'err');
		setButtons('dropped');
		/* 新韌體在「孔不通 / 沒線」時一定先送 0xA2 ⇒ 走到這裡的多半是舊韌體(藍牙固定接第一個埠位) */
		say('連上後沒有收到任何輸出就被中斷。常見原因：AirTTY 藍牙接的那個序列埠沒有接線' +
			'（韌體 v1.8.11 以前藍牙固定接第一個埠位，沒接線時會這樣直接斷線、不說原因），' +
			'或藍牙連線人數已滿。可按「重新連線」');
	} else {
		setStatus('連線中斷', 'err');
		setButtons('dropped');
		say('連線中斷(裝置關機/超出距離/藍牙訊號中斷)。可按「重新連線」');
	}
	/* 放開扣住的鍵(丟掉)並補印暫存的裝置輸出 —— 放在斷線說明**之後**(見 outQ)。
	 * senseLine 一定要在補印之後才清:補印的殘行若留著,會接到下一條連線的第一行 */
	portSettled(false);
	senseLine = '';   /* 警示計數的殘行是這條連線的,不能接到下一次連線的第一行 */
}

btnConnect.onclick = function() {
	if (!envCheck()) return;
	autoRetried = false;
	pendingPick = null;
	/* service filter:我們的廣播帶 128-bit NUS UUID,直接命中;
	 * 不用 acceptAllDevices —— chooser 雜訊少、也不多要權限 */
	navigator.bluetooth.requestDevice({ filters: [{ services: [NUS_SVC] }] })
		.then(function(dev) {
			device = dev;
			/* 意外斷線 → 顯示重連鈕(釘住同一 device,不重開 chooser) */
			dev.removeEventListener('gattserverdisconnected', onGattDisconnected);
			dev.addEventListener('gattserverdisconnected', onGattDisconnected);
			return connectFlow(dev);
		})
		.catch(function(e) {
			/* NotFoundError = 使用者關掉 chooser 或掃不到 —— 不當錯誤刷屏 */
			if (e.name !== 'NotFoundError') say('選擇裝置失敗:' + e.message);
		});
};

btnReconnect.onclick = function() {
	autoRetried = false;
	pendingPick = null;
	if (device) connectFlow(device);
};

/* 「🔌 換孔」:用這次連線 LIST 回來的清單開選孔列(換孔模式:不倒數、可關)。
 * 清單可能已經舊了(線剛插拔)—— 選了之後重新連線,LIST 會重來一次;選的孔不在新清單裡就照常出選孔列。 */
if (btnPort) {
	btnPort.addEventListener('click', function() {
		if (!rxChar || lastPorts.length < 2) return;
		if (elPortRow && elPortRow.classList.contains('show')) { hideChooser(); updatePortBtn(); return; }
		showChooser(null, true);
	});
}

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
	/* 一鍵試鮑率那排是這條橫幅的附屬品 —— 關掉提示就一起收,
	 * 不然畫面上會留一排沒有上下文的鮑率按鈕(誤按會改到正式設備) */
	hideBaudRow();
	setTimeout(fitRows, 0);
});

/* 廠牌下拉:自動偵測誤判時就地改(成因見 renderVendorCmds 上面那段)。
 * 選具體廠牌 = 釘住(偵測繼續跑但不再蓋);選回「自動偵測」= 解除釘住並立刻重掃一次尾段。
 * 零持久化:選擇只活在本次分頁,重新整理即回「自動偵測」。 */
elVendorSel.addEventListener('change', function() {
	var key = elVendorSel.value, v;

	/* 使用者親手動過 ⇒ 遲滯的半途計數作廢,不讓舊候選在下一次掃描就翻盤 */
	vendorCand = null;
	vendorHits = 0;
	if (key === 'auto') {
		vendorPin = null;
		/* 解除釘住 ⇒ 立刻重掃當前尾段,不必等下一個 2 秒節流窗 */
		v = detectVendor(senseTail);
		if (v) {
			vendorAuto = v.key;
			applyVendor();
			toast('已改回自動偵測 —— 目前判定 ' + v.name);
		} else {
			/* 掃不到就維持現狀,不把這排清成只剩下拉 —— 使用者上一秒還在用那些鈕。
			 * 刻意不動 vendorKey/vendorBaud/畫面,等下一次偵測命中再換。 */
			toast('已改回自動偵測 —— 目前的輸出還看不出廠牌,這排先維持不變');
		}
	} else {
		v = vendorByKey(key);
		if (!v) return;
		vendorPin = v.key;
		applyVendor();
		toast('廠牌已固定為 ' + v.name + '（自動偵測不會再蓋掉）');
	}
	syncVendorSel();
	refreshGarbleHint();   /* 亂碼提示文案與「一鍵試鮑率」的排序跟著新廠牌走 */
	/* ⚠️ 刻意不呼叫 term.focus():Chrome 桌機在收合的 select 上按方向鍵,
	 *    每按一下就發一次 change —— 搶走焦點會讓鍵盤使用者選不下去。 */
});

/* 下拉的選項由 VENDORS 產生 —— 表就是單一來源,不在 HTML 裡再抄一份廠牌名。
 * 第一個永遠是 'auto'(syncVendorSel 直接改 options[0] 的文字)。 */
(function initVendorSel() {
	var i, o;

	if (!elVendorSel) return;
	o = document.createElement('option');
	o.value = 'auto';
	o.textContent = '自動偵測';
	elVendorSel.appendChild(o);
	for (i = 0; i < VENDORS.length; i++) {
		o = document.createElement('option');
		o.value = VENDORS[i].key;
		o.textContent = VENDORS[i].name;
		elVendorSel.appendChild(o);
	}
	elVendorSel.value = 'auto';
})();

/* 🏷 廠牌:把廠牌列叫出來 —— 給「完全偵測不到」與「按了 ✕ 想找回來」用。
 * 刻意不做常駐佔位列(沒廠牌零佔位是全頁原則),這是唯一的召喚入口。
 * 用 renderVendorCmds(目前生效的那家) 而不是 applyVendor():只在「還沒渲染過」時
 * 真的建一次,不會把「解除釘住但掃不到 ⇒ 維持現狀」那批按鈕清掉。 */
btnVendor.addEventListener('click', function() {
	flash(btnVendor);
	vendorDismissed = false;
	renderVendorCmds(vendorByKey(vendorKey));
	revealVendorRow();
	toast(vendorKey ? '廠牌列已顯示' : '廠牌列已顯示 —— 目前看不出廠牌,可自己選');
});

/* 關掉廠牌快捷鈕:自動偵測不再自己把它叫回來(偵測到別家也不跳)——
 * 使用者已經表達「不想要這排」,再自己冒出來就是煩人。
 * 但這是可逆的:⌨ 快捷鍵 → 🏷 廠牌 隨時叫得回來,且叫回來時選的廠牌還在。 */
elVendorClose.addEventListener('click', function() {
	vendorDismissed = true;
	hideVendorRow();
	toast('已關閉廠牌快捷鈕（要叫回來：⌨ 快捷鍵 → 🏷 廠牌）');
});

/* ══ 線路設定(控制通道)════════════════════════════════════════════════
 * 連線參數 / Break / DTR / RTS / modem 燈 全放進一個抽屜。
 * **刻意不做成常駐排**:6 吋螢幕上每多一排常駐區塊,終端就少兩行,
 * 而這些設定是「偶爾調一次」不是「一直看著」。亂碼急救那一排例外 ——
 * 它是條件顯示,而且出現的那一刻正是最需要它的時候。
 *
 * 零持久化:**線路參數**(鮑率/資料位元/同位/停止位元/DTR/RTS)不寫進任何
 * 瀏覽器儲存,關頁即消(見檔頭鐵律①)。**唯一例外是「送 Break 前先確認」
 * 那個勾選**(LS_BREAK_CONFIRM)—— 它不會送到裝置、不影響任何設備,
 * 只是這個瀏覽器的操作習慣,所以記得住;面板上也照實講清楚。 */
if (btnLine) {
	btnLine.onclick = function() {
		flash(btnLine);
		if (!ctlAvail) {
			toast('這台裝置的韌體沒有序列埠控制通道（韌體 v1.8 起支援）', 'warn');
			return;
		}
		sheetPush(shLine);
		/* 開面板就順手讀一次現況 —— 使用者最想知道的是「現在是多少」。
		 * 讀不到(唯讀/未登入)不當錯誤,面板照樣能用,狀態列會說明原因。 */
		if (ctlReady) readLineState();
	};
}

/* 讀回目前的線路參數(裝置端以 RFC 2217 的「查詢」語意問 ser2net) */
function readLineState() {
	ctlDo('讀取目前鮑率', C_STATE, [], function(v) {
		if (v && lnBaud) lnBaud.value = String(v);
	});
}

if (lnRead) lnRead.onclick = function() { flash(lnRead); readLineState(); };

/* 套用:四個參數逐一送。**序列化**送出(ctlRequest 走同一條 writeQueue),
 * 一則一則等回應,避免四個回應與四個待辦配錯對。 */
if (lnApply) {
	lnApply.onclick = function() {
		var baud = parseInt(lnBaud.value, 10);

		flash(lnApply);
		if (!(baud >= 50 && baud <= 3000000)) {
			toast('鮑率請填 50 ～ 3000000 之間的整數', 'warn');
			return;
		}
		ctlDo('切換鮑率 ' + baud, C_BAUD, be32(baud), function() {
			senseTotal = 0; senseBad = 0;
			ctlDo('資料位元 ' + lnData.value, C_DATA, [parseInt(lnData.value, 10)],
				function() {
					ctlDo('同位檢查', C_PARITY, [parseInt(lnParity.value, 10)],
						function() {
							ctlDo('停止位元', C_STOP, [parseInt(lnStop.value, 10)]);
						});
				});
		});
	};
}

if (lnBreak) {
	lnBreak.onclick = function() {
		flash(lnBreak);
		if (!ctlReady) { toast('請先完成密碼登入', 'warn'); return; }
		if (!confirmBreak()) { toast('已取消 Break'); return; }
		ctlDo('送出 Break', C_BREAK, [2]);
	};
}

/* 「送 Break 前先確認」的開關。寫入包 try/catch —— 無痕模式會擋 setItem,
 * 沒接住的話這一下會拋例外,連帶讓勾選看起來像壞掉的(而其實只是記不住)。 */
if (lnBreakConfirm) {
	lnBreakConfirm.onchange = function() {
		var on = !!lnBreakConfirm.checked;
		try { localStorage.setItem(LS_BREAK_CONFIRM, on ? '1' : '0'); }
		catch (e) { /* 無痕模式會擋,忽略:本次仍照勾選走,只是下次開頁回到預設 */ }
		toast(on ? '送 Break 前會先確認' :
			'已關閉 Break 確認 —— 之後按下去會直接送出，請自行留意設備狀態');
	};
}

/* DTR / RTS:aria-pressed 就是狀態來源(不另存變數,避免兩份真相)。
 * ⚠️ 只有裝置端回 ok 才翻轉外觀 —— 沒生效就把鈕留在原狀,
 * 不可以先翻好看的再說,那會讓唯讀者以為自己控到了線路。 */
function wireLineToggle(btn, cmd, label) {
	if (!btn) return;
	btn.onclick = function() {
		var on = btn.getAttribute('aria-pressed') !== 'true';

		flash(btn);
		if (!ctlReady) { toast('請先完成密碼登入', 'warn'); return; }
		ctlDo(label + (on ? ' 拉高' : ' 拉低'), cmd, [on ? 1 : 0], function() {
			btn.setAttribute('aria-pressed', on ? 'true' : 'false');
			btn.classList.toggle('armed', on);
		});
	};
}
wireLineToggle(lnDTR, C_DTR, 'DTR');
wireLineToggle(lnRTS, C_RTS, 'RTS');

/* ══ Log 檢視器 ════════════════════════════════════════════════════════
 * 把側錄拉出來當靜態文字看。分工講清楚:
 *   過濾 = 縮小「顯示哪些行」;搜尋 = 在目前顯示的行裡跳著定位,不動顯示範圍。
 * isAlertLine() 判定為警示的行上紅底(數值為 0 的錯誤計數不算);搜尋命中淡藍、目前這一個橘底。
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
		hit = isAlertLine(ln);
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
		div.dataset.bg = isAlertLine(lvShown[i]) ? 'rgba(255,80,80,.18)' : '';
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
 * IPv4 尾兩節、IPv6 尾兩段、MAC 裝置碼(留 OUI 利於辨識廠牌)、常見密碼欄位值。
 * MAC 冒號式與 Cisco 點分式都認;密碼欄位含「型別碼 + hash」寫法
 * (`secret 5 <hash>` → `secret 5 ****`,型別碼留著可見,後面的 hash 才是要擋的)。
 * 型別碼:Cisco 5/7/9、FortiOS ENC(`set password ENC <hash>` → `set password ENC ****`)。
 * 2026-09-12(#113)兩處修正:
 *   ① **子網路遮罩與 Cisco ACL wildcard 不遮** —— `255.255.255.0`、`0.0.0.255`
 *      這類「連續 1 接連續 0」或「連續 0 接連續 1」的值原樣留著。遮罩本身不敏感,
 *      遮掉反而看不出是 /24 還是 /16,而網段大小是排障關鍵。
 *   ② **IPv6 會遮** —— 保留前兩個 hextet(對應 /32 分配),其餘一律 x:
 *      `2001:db8:1234:5678::1` → `2001:db8:x:x`、`fe80::1` → `fe80:x:x:x`。
 *      `::/0`、`::1` 不遮;`18:31:33`、`Last input 00:00:01` 這種假陽性靠
 *      「要嘛帶 ::、要嘛滿八段」擋掉。
 * 2026-09-19(v1.8.x 審查 #1)密碼欄位補三個假陰性:關鍵字前可接 [\w-]*
 *   (`admin_password=`)、引號值整段遮(`"a b c"`)、縮排 + 純 base64 ≥16 字元的
 *   折行續行一起遮(門檻刻意收緊,免得吞掉 Cisco ` login` / FortiOS ` next`)。
 * 規則順序是契約:IPv4 → MAC 兩條 → **IPv6** → 密碼欄位。IPv6 排在 MAC 之後,
 * 已遮成 xx 的 MAC 才不會被當成 hextet 二次處理。
 * 空白類一律用 [^\S\r\n] 而非 \s,免得一行以 password 結尾時跨行吃掉下一行第一個 token。
 * 只求擋住明顯敏感值 —— 預覽可編輯,最後一道防線是工程師自己的眼睛。
 * ⚠️ 規則與管理介面網頁終端、MCP `lib/mask.js` 那兩份**逐字相同**,改任何一邊必
 *    同步另兩邊,並跑 OpenWRT repo 的 `scripts/test/mask-sensitive.test.js`
 *    (會斷言三份一致)。 */
function maskSensitive(text) {
	return text
		.replace(/\b(\d{1,3}\.\d{1,3})\.\d{1,3}\.\d{1,3}\b/g, function(hit, head) {
			/* 子網路遮罩(連續 1 接連續 0)與 Cisco ACL wildcard(連續 0 接連續 1)
			 * 本身不是敏感資訊,而網段大小(/24 還是 /16)是排障關鍵 ⇒ 原樣保留。
			 * 有八位元組大於 255 的就不是位址也不是遮罩,照舊遮。 */
			var oct = hit.split('.');
			var bits = '';
			var i, n, b;
			for (i = 0; i < 4; i++) {
				n = parseInt(oct[i], 10);
				if (n > 255) return head + '.x.x';
				b = n.toString(2);
				while (b.length < 8) b = '0' + b;
				bits += b;
			}
			if (/^1*0*$/.test(bits) || /^0*1*$/.test(bits)) return hit;
			return head + '.x.x';
		})
		.replace(/\b([0-9A-Fa-f]{2}[:-][0-9A-Fa-f]{2}[:-][0-9A-Fa-f]{2})(?:[:-][0-9A-Fa-f]{2}){3}\b/g, '$1:xx:xx:xx')
		.replace(/\b([0-9A-Fa-f]{4}\.[0-9A-Fa-f]{2})[0-9A-Fa-f]{2}\.[0-9A-Fa-f]{4}\b/g, '$1xx.xxxx')
		.replace(/(^|[^0-9A-Fa-f:.])([0-9A-Fa-f:]+)(?![0-9A-Fa-f:]|\.\d)/g, function(hit, pre, tok) {
			/* IPv6。這條必須排在 MAC 兩條之後:MAC 先遮成 xx,剩下的 hex 群組
			 * 才不會被當成 hextet。前置捕捉群組代替 lookbehind(LuCI 與 webterm
			 * 都沒有 build step,不用新語法)。
			 * 尾端前瞻 2026-09-13 修(#113 的已知限制):原本是 (?![0-9A-Fa-f:.]),
			 * 連「後面接句點」都擋掉 ⇒ 句尾的 `gw is 2001:db8::1.` 整個不遮。
			 * 改成只擋「句點+數字」—— 那才是內嵌 IPv4(`::ffff:1.2.3.4`),留給
			 * 上面第一條去遮;句點後面接空白或就是字串結尾的,是普通句子標點,照遮。
			 * ⚠️ 前瞻仍擋 [0-9A-Fa-f:] ⇒ 回溯永遠不可能成功(退一格必然踩到 hex),
			 *    所以「擋掉」就是整個候選不匹配,不會退化成遮一半。 */
			var g, colons, hextets, i;
			/* 前一個字元若把單獨一個冒號併進候選(gateway:2001:db8::1),先還回去 */
			if (tok.charAt(0) === ':' && tok.charAt(1) !== ':') {
				pre = pre + ':';
				tok = tok.slice(1);
			}
			/* :: 開頭的是 ::/0、::1、::ffff:v4 這類,不帶站點資訊 ⇒ 不遮
			 * (::ffff:10.1.2.3 的 IPv4 段已經被上面第一條處理掉了) */
			if (tok.indexOf('::') === 0) return hit;
			g = tok.split(':');
			colons = g.length - 1;
			hextets = 0;
			for (i = 0; i < g.length; i++) {
				if (g[i]) hextets++;
			}
			/* 認得出是 IPv6 才遮:要嘛帶 ::,要嘛滿八段(七個冒號)。否則
			 * 18:31:33、Last input 00:00:01、已經遮好的 MAC 都會被誤傷。 */
			if (colons < 2 || hextets > 8) return hit;
			if (tok.indexOf('::') < 0 && colons !== 7) return hit;
			if (!/[0-9A-Fa-f]/.test(tok)) return hit;
			/* 保留前兩段(對應 /32 分配),與 IPv4 保留前兩個八位元組同一個尺度 */
			return pre + (g[0] || 'x') + ':' + (g[1] || 'x') + ':x:x';
		})
		/* 密碼欄位。2026-09-19(v1.8.x 審查 #1)補三個假陰性:
		 * ① 關鍵字前可接 [\w-]{0,32}(admin_password、encrypted-password),前綴一起
		 *    捕進 $1 原樣吐回 —— 不用 lookbehind,LuCI 與 webterm 都跑在瀏覽器裡。
		 *    上限 32 是效能守衛：無上限時「字母—連字號交替」的長 token 每個字元
		 *    都是 \b 起點 ⇒ O(n²);100k 字元實測 9332 ms → 32 上限後 19 ms。
		 *    這段 code 跑在瀏覽器主執行緒、吃的是設備吐的原文,不能被卡死。
		 * ② 值先試「成對引號包住的整段」("a b c" / 'x y'),不成對才退回 \S+。
		 * ③ 值後面「縮排 + 純 base64 且 ≥16 字元」的整行視為折行續行一起遮,
		 *    但**只在型別碼是 ENC 時**才吃 —— 否則 Cisco `password cisco`
		 *    後面縮排的憑證鏈 hex 行會**整行被吞**(2026-09-19 實測,兩行全沒);
		 *    這是把設備原文默默刪掉,比漏遮更難察覺。
		 *    門檻 {16,} 另擋住 ` login`、` next` 這種縮排單字行。
		 *    ENC 與非 ENC 走兩條分支,型別碼分別落在 $3 / $4;未參與的
		 *    那個在字串替換時是空字串,所以回填寫成 '$1$2$3$4****'。 */
		.replace(/\b([\w-]{0,32}(?:password|passwd|secret|community|psk))([^\S\r\n]+|[^\S\r\n]*[:=][^\S\r\n]*)(?:(ENC[^\S\r\n]+)(?:"[^"\r\n]*"|'[^'\r\n]*'|\S+)(?:\r?\n[^\S\r\n]+[A-Za-z0-9+\/=]{16,}(?=[\r\n]|$))*|((?:[0-9][^\S\r\n]+)?)(?:"[^"\r\n]*"|'[^'\r\n]*'|\S+))/gi, '$1$2$3$4****');
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
		['敏感資訊', rpMask.checked ? '已遮蔽 IPv4／IPv6／MAC／密碼樣式（子網路遮罩留著）' : '⚠️ 未遮蔽 —— 含完整 IP／MAC']
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

/* ── 頁面版本標記 ──
 * 現場對帳用:使用者回報「這個 bug 還在」時,第一個要問的就是「你手上跑的是哪一版」。
 * Service Worker 是 cache-first,已裝機的手機可能停在好幾版之前而完全看不出來
 * (伺服器上是新的,他的瀏覽器拿的是快取)—— 所以版本號必須由 **SW 自己回報**,
 * 不能寫死在 index.html:寫死的話印出來的是「這份 HTML 宣稱的版本」,
 * 而那份 HTML 本身就可能是快取裡的舊檔,等於自己證明自己,對帳價值為零。
 *
 * ⚠️ 這裡顯示的是「**目前正在控制這個分頁**的 SW 版本」,不是伺服器上的最新版。
 *    新版已下載但使用者還沒按「↻ 有新版本」時,這裡照樣顯示舊版 —— 這是對的,
 *    正在跑的就是舊版。
 *
 * 取不到就維持 index.html 預填的「—」:不支援 SW 的瀏覽器、離線自架時沒註冊成功、
 * 或 file:// 開啟,都會走到這裡,一律安靜降級,不丟錯、不影響終端功能。 */
(function reportVersion() {
	var el = document.getElementById('swVer');
	if (!el || !('serviceWorker' in navigator)) return;

	/* 先掛監聽再問 —— 反過來的話,SW 回得比監聽掛上還快時訊息會掉在地上 */
	navigator.serviceWorker.addEventListener('message', function(ev) {
		if (ev.data && ev.data.type === 'VERSION' && ev.data.version) {
			el.textContent = 'webterm ' + ev.data.version;
		}
	});

	/* 用 ready 而不是 controller:首次載入(SW 剛裝好還沒接管)時 controller 是 null,
	 * 但 ready 一定給得到 active 的 registration。註冊失敗時 ready 永不 resolve
	 * → 停在「—」,正是要的行為,不必再補 timeout。 */
	navigator.serviceWorker.ready.then(function(reg) {
		if (reg && reg.active) reg.active.postMessage({ type: 'GET_VERSION' });
	}).catch(function() { /* 沒有離線能力而已,不影響終端 */ });
})();

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

	/* 勾選狀態一律由偏好推導(缺值 = 勾),不靠 HTML 的 checked 屬性當真相來源 */
	if (lnBreakConfirm) lnBreakConfirm.checked = breakConfirmOn();

	setKeysLive(false);
	setCtrlArmed(false);
	/* 未連線 ⇒ 還不知道對方韌體有沒有控制通道 → 一律先隱藏。
	 * 「先顯示再視情況拿掉」會讓按鈕在連線瞬間閃一下,而且舊韌體使用者
	 * 會看到一組隨即消失的功能,比從頭沒有更困惑。 */
	setCtlAvail(false);

	if (envCheck()) {
		say('按上方「選擇裝置並連線」開始。');
		navigator.bluetooth.getAvailability && navigator.bluetooth.getAvailability()
			.then(function(ok) {
				if (!ok) say('⚠️ 此電腦目前沒有可用的藍牙介面(未開藍牙?)');
			});
	}
})();
