# AirTTY

> **AirTTY — pocket-sized wireless console servers.**
> Plug a USB-to-serial adapter into an AirTTY, and reach your switch, router,
> firewall or server console over Wi-Fi or Bluetooth. No cable to the rack, no
> crouching in the cold aisle. Since firmware v1.8 you can also let **Claude Code
> read that console over MCP** — read-only, ask-before-every-command, or unattended;
> you choose when you mint the token. Traditional Chinese documentation below.

**把設備的 console 變成無線的。**

AirTTY 是口袋大小的**可攜式 console 伺服器**：把 USB 序列（USB-to-serial）轉接線的一端插在
AirTTY 上、另一端接到交換器／路由器／防火牆／伺服器的 console 埠，你就能用**筆電、手機或平板，
透過 WiFi 或藍牙無線連進那台設備的 console**。

**韌體 v1.8 起還多一條路：讓筆電上的 AI 助手（Claude Code）直接讀這個 console** ——
讀 log、判讀錯誤，需要下指令時由你按確認才送出。權限在產生 token 的當下就決定，隨時可撤銷
（見下方「[🤖 讓 AI 助手連進 console](#ai-mcp)」）。

---

## 這解決什麼問題

機房裡最熟悉的幾個痛：

- **不必再蹲在機櫃前**、把筆電擱在膝蓋上接 console 線。設備接好後，人可以坐回椅子上操作。
- **不必為了一條 console 線在機櫃前後穿梭**。線留在設備上，你帶著筆電走。
- **設備網路掛掉時（帶外管理／OOB），console 是最後一條路** —— AirTTY 讓這條路變成無線的。
- **現場沒有插座也能用**（A1 內建電池；M2 接行動電源）。
- **一台可同時服務多人**：同一個 console 畫面可以多人同時看、同時打字，適合「一人操作、其他人監看」
  的教學或值班交接情境。

---

## 產品線

| | **AirTTY A1** | **AirTTY M2** |
| --- | --- | --- |
| 狀態 | **現役出貨機種** | **規劃中，尚未出貨** |
| 基礎硬體 | Gigastone A4-52ER | GL.iNet GL-MT300N-v2 |
| 處理器 | Atheros AR9331 | MediaTek MT7628AN |
| 供電形態 | **內建電池 5200mAh** —— 開箱即用，不必再帶一顆行動電源 | **外接行動電源** —— 電池是耗材，可自行更換、容量自選，電池壽命不綁主機 |
| WiFi | 802.11 b/g/n（2.4GHz） | 802.11 b/g/n（2.4GHz） |
| 有線網路 | 1 × RJ45 10/100 | 1 × LAN + 1 × WAN 10/100 |
| USB | 1 × USB-A（USB 2.0 Host） | 1 × USB 2.0 |
| 規格頁 | [A1 硬體規格](hardware/a1/README.md) | [M2 硬體規劃](hardware/m2/README.md) |

> **兩種供電形態的取捨**：A1 內建電池最省事，但二手機的電池健康度本來就是一項風險；
> M2 把電池外移成一般行動電源 —— 壞了自己換、要撐久就換大容量，代價是多帶一顆電源。
> 兩者都是同一套軟體、同一套操作方式。

---

## 主要功能

**六種連進 console 的方式，挑一條順手的即可。**
前五條由**同一組連線密碼**把關；第六條（AI 助手）改用一組可隨時撤銷的**專屬 token 帳號**：

- **網頁終端** —— 連上裝置 WiFi、開瀏覽器就能用，不必安裝任何軟體。可在連線中即時改鮑率、送 BREAK、
  控制 DTR/RTS；內建快捷鍵列（Tab／Esc／Ctrl 組合／方向鍵一按即送）與**終端輸出下載**（濾碼純文字，排障留檔用）。
- **Telnet / Raw TCP** —— 沿用你原本的 PuTTY、SecureCRT、Tera Term 或 `nc`；支援 RFC2217（telnet com-port）虛擬 COM 埠。
- **網頁藍牙終端（BLE）** —— 用 Chrome 或 Edge 開一個網頁就連得上，**不必切換 WiFi、不必配對**：[開啟網頁終端](https://airtty.github.io/webterm/)
  **韌體 v1.8 起藍牙這條路也能送 Break、改鮑率、控制 DTR／RTS**（裝置端多了一條獨立的控制通道），
  亂碼時還有「一鍵試鮑率」。⚠️ 這條控制通道目前只有**本站的網頁藍牙終端**用得到，
  第三方藍牙終端 App（如 BTerm）**沒有**。
- **iPhone / iPad** —— 透過 BLE 搭配 App Store 上的終端 App，現場只帶手機也能進 console。
- **傳統藍牙 SPP** —— 配對成系統 COM 埠，給必須吃 COM 埠的工具（SecureCRT、Tera Term、自製腳本）使用。
- **🤖 AI 助手（MCP，韌體 v1.8 起）** —— 讓筆電上的 **Claude Code** 直接讀這個 console，
  權限分「只看／每筆先問／不問直接送」三種，詳見下面[專節](#ai-mcp)。

**其他隨附功能：**

- **雙序列埠，一台顧兩台設備** —— 搭配 USB hub 可同時接兩條 console 線（例如兩條 FTDI），
  兩埠各自獨立：各有自己的網頁終端、Telnet 埠（4001／4002）、序列參數與連線密碼。
- **序列裝置全自動發現** —— FTDI / CP210x / CH340 / PL2303 / USB CDC-ACM 驅動皆已內建，
  插上（含熱插拔）即自動辨識晶片型號與 USB ID，儀表板直接長出裝置卡；
  鮑率、資料位元、校驗、停止位元、流量控制**全部在網頁上點選設定**，不必打任何指令。
- **檔案伺服器** —— 把韌體檔上傳到 AirTTY，讓設備自己用 TFTP／HTTP／FTP／SCP 抓檔升級。
- **網路工具** —— 用 CDP／LLDP 看「這台接在哪台交換器的哪個埠」。
- **遠端封包擷取** —— 讓筆電上的 Wireshark 抓 AirTTY 這一側的封包。
- **一鍵診斷** —— 路徑追蹤、頻寬測試、序列埠狀態、LAN 裝置掃描等現場排查按鈕。
- **換線自動接上（v1.8 起）** —— 舊線壞了、換一條**同型號不同序號**的線插上就好：
  幾秒內裝置會自己把新線接回原本那個埠位，**鮑率、標籤、連線密碼全部沿用**，零點擊。
  裝置卡會明白寫出「已自動接上新線」提醒你確認接的是不是同一台設備。
- **廠牌快捷鈕可以手動選（v1.8 起）** —— 認出 Cisco／Junos／Fortinet／Aruba／Linux 時，
  終端上方會給一排該廠牌的**唯讀巡檢指令**；自動偵測認錯時用下拉選單直接指定，
  選了就不會再被蓋掉。v1.8.2 起偵測改成「只認該廠牌自己的輸出才會出現的字樣、連三次才換」，
  **不會再來回跳**。
- **敏感資訊遮蔽（可選，預設不遮）** —— 匯出維運報告、複製給 AI、以及 MCP 這條路，
  都可以勾選把 IP／IPv6／MAC 與密碼欄位遮掉（子網路遮罩與 ACL wildcard 不遮，看得出網段大小）。
  管理介面網頁終端、網頁藍牙終端、MCP **三處規則逐字相同**。
  ⚠️ 遮蔽是**盡力而為、不是保證**，沒列到的格式不會遮 —— 這也是它預設不勾、由你決定的原因。

---

<a id="ai-mcp"></a>

## 🤖 讓 AI 助手連進 console（韌體 v1.8 起）

開機訊息太長看不完、錯誤代碼不知道從哪查起、或要照同一套步驟逐台巡檢 ——
**讓筆電上的 [Claude Code](https://claude.com/claude-code) 直接讀這台 AirTTY 上的 console**，
幫你判讀 log 與錯誤；需要下指令時，**由你在筆電上按下確認**，它才會一條一條送出去。

走的是一條獨立的連線，用的是**專屬 token 帳號** —— 不是連線密碼、也不是管理密碼，
**不必讓 AI 知道管理密碼、不必 SSH 進裝置、不必編任何設定檔**，而且隨時可以在網頁上撤銷。

### 三步接上

1. 管理介面 **「連入方式」** 頁最下面的 **「🤖 AI 助手連線(MCP)」** 卡 → 填一個好認的名稱 →
   決定要不要勾 **「允許送指令」** → 按 **「產生 token」**。
2. 卡片上出現**一行指令**（裝置位址與 token 都已經填好，分 macOS／Linux 與 Windows 兩個分頁）→ 按 **「複製」**。
3. 在筆電開一個終端機，**原樣貼上**執行。執行完，Claude Code 就多出一組 AirTTY 工具。

```
claude mcp add airtty -- npx -y airtty-mcp --host 192.168.10.1 --token <帳號>:<token> --mode read-only
```

> ⚠️ **token 只顯示這一次**（裝置上只留雜湊值），沒複製到就重產一組。請把它當密碼保管 ——
> 拿到「可寫」token 的人＝能對那條序列線寫入的人。也**不要**把含 token 的 `.mcp.json` 提交進 git。

### 三種模式 —— 在產生 token 的當下就決定，程式跑起來之後改不了

| 模式 | AI 能做什麼 |
| --- | --- |
| **只看**（`--mode read-only`） | 讀 console 的歷史輸出、等某段文字出現、看 CDP／LLDP 鄰居、探線路狀態。**送指令的工具根本不會出現在它的清單裡**，想送也沒得送 |
| **每筆先問**（`--mode manual`，建議從這裡開始） | 上面全部，再加上「送一行指令」與「改序列參數」。**每一筆都先跳確認視窗**：看得到要送到哪個埠、指令原文是什麼、控制權現在在誰手上，你按了才會出去 |
| ⚠️ **不問直接送**（`--mode auto`） | 與上一列相同，但**中間沒有人** —— AI 判斷要送就直接送。卡片上那個勾選框**預設不勾**，每次重新產生都歸零 |

模式**刻意不做成 AI 可以呼叫的工具** —— 否則「把我切到不問直接送」會是它第一個提議的事。

### 界線在哪裡

- **阻擋清單** —— `reload`、`write erase`、`delete`、`format`、`factory-reset`、`rm -rf` 這類字樣
  **三種模式都會擋**，在跳確認視窗之前就擋下來，你按確認也不會放行。
  ⚠️ 但請把它當**多一層防護，不是保證**：很多廠牌接受縮寫（Cisco 打 `relo` 就等於 `reload`），
  字串比對擋不全。**真正的界線是模式** —— 平常請用「每筆先問」，「不問直接送」只留給實驗室、
  或有人在旁邊盯著的設備。
- **不搶你的控制權** —— 在「不問直接送」模式下，只要**網頁終端有人正握著控制權**，
  AI 的指令就會被拒絕、**一個位元組都不會送到線路上**；不排隊、也不搶，現場的人永遠優先。
  ⚠️ 這道界線落在**你筆電上那支程式**（自律層），不是裝置端的強制保證。
- **AI 做不到的事（刻意不開）** —— 不能送 Break、不能動 DTR／RTS、不能**接管**別人的控制權、
  不能碰**檔案伺服器**、不能改**連線密碼或認證開關**。改序列參數也窄到只剩鮑率／資料位元／同位／停止位元，
  而且該埠只要有人連著就一律拒絕。
- **撤銷即時生效** —— 回同一張卡按 **「撤銷」**，那組 token 立刻失效，
  連它當下還連著的工作階段一起收掉，不必等逾時、不必重開機。
- **AI 在線上看得出來** —— 網頁終端多人同看時，控制權在 AI 手上會直接顯示
  **「控制權：AI 助手」**；儀表板的連線清單上那條連線會掛一個 `🤖 AI` 徽章。
- **預設不遮蔽** —— AI 讀到的是**設備原文**（完整 IP／MAC，以及 console 上出現的密碼欄位值），
  這些會進到你的 AI 對話紀錄裡。要遮的話，在卡片上**先勾「遮蔽敏感資訊」再複製**那一行。
- **裝置本身不對外連任何地方、不做任何 AI 運算** —— AI 的事全部發生在你的筆電上。

### 前提與目前不支援的

- **只支援 Claude Code**（在終端機裡跑的那個，**以 2.1.269 實測**）。
  **Claude Desktop 與免安裝的單一執行檔版本都還沒支援、也還沒驗證過。**
- 筆電要有 **Node.js 22 以上**：Windows 先 `winget install OpenJS.NodeJS.LTS`、macOS `brew install node`。
  **Windows 貼的是同一行指令**（已在原生 Windows 實測通過）。
- 裝置韌體需 **v1.8 起**；更舊的韌體，「連入方式」頁上不會有這張卡。

📖 完整步驟、確認視窗長什麼樣、撤銷與安全提醒 → [**A1 使用手冊 §5.7**](docs/manual-a1.md)
📦 筆電端套件（開源 MIT，`npx` 會自動抓最新版）→ [**airtty-mcp on npm**](https://www.npmjs.com/package/airtty-mcp)

---

## 與原廠 Airconsole 的比較

商用同類產品中最知名的是 [Get Console 的 Airconsole](https://www.get-console.com/shop/en/27-airconsole)。
**但截至 2026-08，原廠功能完整的主力機種（Standard 2.0／XL 2.0／Mini 2.0／Pro 2.0L）
在官網商店已無販售品項，可能已停售**（各分類頁均顯示 "There are no products in this category"）；
**現售的主機只剩 Airconsole LE** —— 一款純藍牙 BLE 的單埠轉接器，
沒有 WiFi、沒有網頁介面、也沒有 Telnet。

AirTTY 的定位因此很直接：**用開放硬體與開源軟體，
提供原廠已停售機種等級（甚至更完整）的功能 —— 而且現在買得到。**

| | **AirTTY A1** | **Airconsole LE**（原廠現售） | **Airconsole 2.0 系列**（Standard／XL，官網已無販售品項） |
| --- | --- | --- | --- |
| 販售狀態 | ✅ 現售 | ✅ 現售 | ❌ 已無販售品項，可能已停售（2026-08 查閱）※ |
| WiFi | ✅ 802.11n，AP 直連 | ❌ **無 WiFi** | ✅ |
| 藍牙 | ✅ 雙模：BLE + 傳統 SPP | ✅ 僅 BLE（BT 4.2 single-mode） | ✅ |
| 有線網路 | ✅ RJ45 | ❌ | ✅（部分型號） |
| 免安裝的 WiFi 網頁終端 | ✅ 瀏覽器直開 | ❌（無網頁介面） | ✅ |
| 免安裝的瀏覽器藍牙終端 | ✅ **Chrome／Edge 開網頁即連，不必配對、不必裝 App** | ❌（需 App 或 BLE 終端軟體） | — |
| Telnet／Raw TCP／RFC2217 | ✅ | ❌ | ✅ |
| 同時序列埠數 | **2 埠**（搭配 USB hub，各埠獨立參數／密碼／服務埠） | 1 埠（固定 DB9 或 RJ45） | 1 埠 |
| 序列裝置自動發現 | ✅ USB 轉接頭插上即辨識晶片與 USB ID，熱插拔即時反應 | —（埠是固定的） | ✅ |
| 序列參數網頁設定 | ✅ 鮑率／資料位元／校驗／停止位元／流控全部網頁點選 | ❌ | ✅ |
| 檔案伺服器（讓設備 TFTP／HTTP／FTP／SCP 抓韌體） | ✅ | ❌ | —（官方規格頁未列） |
| CDP／LLDP 鄰居辨識 | ✅ | ❌ | —（官方規格頁未列） |
| 遠端封包擷取（筆電 Wireshark 直接抓） | ✅ | ❌ | —（官方規格頁未列） |
| 藍牙端送 Break／改鮑率／DTR·RTS | ✅ **韌體 v1.8 起**（限官方網頁藍牙終端；第三方藍牙 App 沒有） | —（官方規格頁未列） | —（官方規格頁未列） |
| 讓 AI 助手連進 console（MCP） | ✅ **Claude Code，三種權限模式、token 可即時撤銷** | —（官方規格頁未列） | —（官方規格頁未列） |
| iPhone／iPad | 透過 BLE + App Store 終端 App（如 BTerm） | ✅ 原廠 Get Console App | ✅ 原廠 Get Console App |
| 企業集中管理／雲端隧道 | —（無此功能） | —  | ✅ Enterprise Server（需另購授權） |
| 電池 | 內建 5200mAh 鋰電池（續航實測值待公布） | 內建（待機以月計，適合長駐） | Standard 標稱 4 小時；XL 標稱 12 小時 |
| 韌體 | **開源（GPL 合規），可自行編譯、稽核、客製** | 封閉 | 封閉 |

> ※ 查證紀錄（2026-08）：[Standard 2.0](https://www.get-console.com/shop/en/28-airconsole-standard-20)、
> [XL 2.0](https://www.get-console.com/shop/en/29-airconsole-xl-20)、
> [Mini 2.0](https://www.get-console.com/shop/en/25-airconsole-mini-20) 分類頁皆顯示
> "There are no products in this category"，Pro 2.0L 亦無可購買品項；
> 現售僅 [Airconsole LE](https://www.get-console.com/shop/en/36-airconsole-le) 與配件。
> 「可能已停售」為官網商店現況的合理推斷，原廠並未發布正式停產聲明。
> LE 規格出自[原廠 LE 產品頁](http://www.get-console.com/airconsole-le/)與
> [支援中心](https://support.get-console.com/support/solutions/5000169749)。
> 「—（官方規格頁未列）」表示原廠公開頁面查不到該功能，不代表確定沒有。
> 持平地說：原廠的強項在 iOS 原廠 App 與企業集中管理；LE 的強項在以月計的待機（長駐場景）。
> AirTTY 的強項在**功能完整度（WiFi＋雙模藍牙＋網頁工具箱）、雙埠、AI 助手連線，與「現在買得到」**。

---

## 快速上手

1. **開機** —— 長按電源鍵約 5 秒，等約 1 分鐘，裝置的 WiFi 名稱出現在清單裡就代表好了。
   （WiFi 名稱為 `AirTTY-A1-xxxx`，出廠密碼與其他預設憑證見[使用手冊 §8.4](docs/manual-a1.md)。）
2. **接線** —— USB 序列轉接線的 USB 端插進 AirTTY（**建議透過 USB hub**），另一端接設備的 console 埠。
   儀表板數秒內就會自動出現一張裝置卡，不必安裝驅動。
3. **連線** —— 連上裝置 WiFi、瀏覽器開管理介面 **`http://192.168.10.1`** →
   **AirTTY → 網頁終端** → 選序列埠 → 按「連線」。
   設對鮑率（多數網路設備是 9600 或 115200）就看得到 console。

完整流程、六種連線方式的逐步操作與疑難排解，請見 [A1 使用手冊](docs/manual-a1.md)。

> ℹ️ **關於名稱**：AirTTY 是對外品牌，裝置的 WiFi 與藍牙名稱皆為 `AirTTY-A1-xxxx`、
> 管理選單也是「AirTTY」。系統內部（服務名稱、設定檔路徑 `/etc/config/airtty`、
> 系統記錄標籤、管理頁網址）**自韌體 v1.3.0 起同樣全面使用 AirTTY，內外一致**。
> **改名遷移自韌體 v1.3.0（2026-08）起已全面完成**：出廠機器與所有更新到 v1.3.0 以上的機器，
> 內外都看不到舊的開發代號 AirConsole 了。更早版本、還沒更新過的機器，套用官方升級檔時會自動完成遷移
> （設定、密碼全部保值），過程中看到舊字樣屬正常，是同一台機器。

---

## 軟體更新

功能更新以**單一升級檔**發布（`airtty-update-vX.Y.Z.run`），**不會動到你的設定** ——
序列埠綁定、連線密碼、WiFi 設定全部保留，升級檔內建 sha256 完整性驗證。

- **目前最新版：v1.8.2**（2026-09-13）。
  → [**官方發行頁（含每一版的更新說明）**](https://github.com/AirTTY/airtty.github.io/releases/latest)
- **線上更新**（最簡單）：儀表板 →「軟體更新」→ **🔍 檢查更新**，
  只要**你的電腦**能上網就查得到新版與更新說明；裝置若已連上游 WiFi，按 **⬆️ 線上更新** 即可自行完成。
- **手動上傳**：從發行頁下載 `.run` 檔，儀表板按 **📦 上傳升級檔並更新**（約 10～30 秒）。
- ⚠️ **請勿自行刷入官方或第三方 OpenWrt 韌體**：底層韌體與記憶卡是一體設計，
  這麼做會讓整套 AirTTY 功能無法啟動（見[使用手冊 §6.6](docs/manual-a1.md)）。

v1.8 這一輪的重點：**AI 助手連進 console（MCP）**、**藍牙端的 Break／鮑率／DTR·RTS 控制通道**、
**換線自動接上**、**廠牌手動選擇**、**遮蔽更準**。

---

## 文件導覽

| 文件 | 內容 |
| --- | --- |
| [**A1 使用手冊**](docs/manual-a1.md) | 開箱、燈號、接線、**六種**連線方式（含 §5.7 AI 助手）、上游 WiFi、疑難排解、安全注意 |
| [**網頁藍牙終端**](https://airtty.github.io/webterm/) | 免安裝的瀏覽器 BLE 終端（[說明與離線自架方法](webterm/README.md)） |
| [**A1 硬體規格**](hardware/a1/README.md) | 規格表、外觀與指示燈、支援的序列晶片、使用注意 |
| [**M2 硬體規劃**](hardware/m2/README.md) | 規劃中機種的已知規格與待確認項目 |
| [**AI 助手連線（MCP）**](https://www.npmjs.com/package/airtty-mcp) | 筆電端套件 `airtty-mcp`（npm，MIT）；裝置端用法見[手冊 §5.7](docs/manual-a1.md) |
| [**官方發行頁**](https://github.com/AirTTY/airtty.github.io/releases/latest) | 升級檔下載與每一版的更新說明（目前最新 v1.8.2） |
| [**GPL 合規聲明**](gpl/README.md) | 韌體授權說明、對應修改源碼、重建韌體的概要步驟 |

---

## 支援

- 購買、售前詢問、保固與售後 → **LINE 官方帳號「AirTTY 口袋Console伺服器」`@244cwfgm`**（[加好友](https://line.me/R/ti/p/@244cwfgm)）
- 使用問題、疑難排解、文件錯誤回報 → [**GitHub Issues**](https://github.com/AirTTY/airtty.github.io/issues)
- 回報問題時請附上：機型（A1／M2）、韌體版本（管理介面頁首可見）、你用的連線方式、
  以及序列轉接頭型號。附上畫面截圖通常能省下好幾輪往返。

---

## 授權

本專案採**雙軌授權**：

- **自行開發的應用程式、網頁與文件**（含 `webterm/`、`docs/`、`hardware/`）—— **MIT License**，見 [LICENSE](LICENSE)。
- **裝置韌體**基於 [OpenWrt](https://openwrt.org/)，屬 **GPL-2.0**。依授權提供的對應修改源碼
  與重建說明，見 [`gpl/`](gpl/README.md)。

`webterm/xterm.js` 與 `webterm/xterm.css` 為第三方函式庫
（[xterm.js](https://github.com/xtermjs/xterm.js)，MIT License），版權歸原作者所有。
