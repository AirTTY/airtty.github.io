# AirTTY 網頁藍牙終端

**免安裝、免配對的瀏覽器 BLE 終端。**

👉 **[開啟網頁終端](https://airtty.github.io/webterm/)**

開頁 → 按「選擇裝置並連線」→ 從瀏覽器跳出的清單選你的 AirTTY → 輸入連線密碼 → 進 console。
不必切換 WiFi、不必安裝任何軟體、不必在系統裡先配對藍牙。

適合的情境：筆電正連著公司網路要一邊查資料、現場 WiFi 訊號很吵、或單純懶得換網路。

---

## 瀏覽器支援

本頁使用 **Web Bluetooth**，支援情況如下：

| 平台 | 瀏覽器 | 支援 |
| --- | --- | --- |
| Windows | Chrome / Edge | ✅ |
| macOS | Chrome / Edge | ✅ |
| Android | Chrome / Edge | ✅（需允許「附近的裝置」權限） |
| Linux | Chrome | ✅ |
| 任何平台 | **Safari** | ❌ Safari 不支援 Web Bluetooth |
| iPhone / iPad | 任何瀏覽器 | ❌ iOS 一律用 Safari 引擎 → **請改用[使用手冊](../docs/manual-a1.md) §5.4 介紹的 App** |

其他連線方式（網頁終端、Telnet、傳統藍牙 SPP）不受此限制，見[使用手冊](../docs/manual-a1.md)。

---

## ⚠️ 必須從 HTTPS 或 localhost 開啟

Web Bluetooth 規格要求 **secure context**：頁面必須來自 `https://` 或 `http://localhost`，
否則瀏覽器根本不會提供藍牙 API（畫面會顯示「此頁必須經 HTTPS 或 http://localhost 開啟」）。

這個限制綁的是**網頁本身的來源**，與裝置無關（藍牙走空中，不經過網路），
所以裝置端**不需要**支援 HTTPS。

用上面的官方網址開啟就已經是 HTTPS，正常情況不必理會這條。
但如果你把檔案下載到本機、直接用 `file://` 雙擊開啟，**會不能用** —— 請改用下面的自架方法。

---

## 離線自架（推薦：機房沒有網路時的備援路徑）

機房常常是沒有對外網路的。**建議事先把這個目錄抓下來放在筆電裡**，需要時本機起一個
HTTP 伺服器就能用，完全不依賴網際網路。

**步驟：**

1. 下載本目錄的四個檔案（`index.html`、`app.js`、`xterm.js`、`xterm.css`），
   放進同一個資料夾。整個 repo 直接 `git clone` 或下載 ZIP 也可以。
2. 在該資料夾開啟終端機，執行：

   ```
   python3 -m http.server 8666
   ```

   （Windows 若沒有 `python3`，改打 `python -m http.server 8666`。）
3. 瀏覽器開 **`http://localhost:8666`** —— `localhost` 屬於 secure context，藍牙功能正常。
4. 用完按 `Ctrl+C` 關掉伺服器即可。

⚠️ 一定要用 `localhost`，**不要**改用本機 IP（例如 `http://192.168.x.x:8666`）——
那不算 secure context，藍牙 API 會消失。

也可以自行放上任何靜態 HTTPS 空間（GitHub Pages、自家網域皆可）：
單一資料夾、沒有 build 步驟、沒有後端。

---

## 安全性

console 流量（**包含你輸入的連線密碼**）全程流經這個頁面的 JavaScript，
所以本頁刻意做成可稽核、可自行託管：

- **零對外傳輸** —— 全檔沒有 `fetch` / `XMLHttpRequest` / `WebSocket` / `sendBeacon`，
  你打的每一個字只會經由藍牙送到手上那台裝置。
- **零外部資源** —— `xterm.js` 與 `xterm.css` 就放在同一個資料夾，不引用任何 CDN。
- **可自行驗證** —— 在本目錄執行下列指令，唯一的命中應該只有這段說明文字自己
  （本檔與 `app.js` 的註解），程式碼本體零命中：

  ```
  grep -riE "fetch\(|XMLHttpRequest|WebSocket|sendBeacon|src=\"http" .
  ```

- 因為完全不依賴外部資源，**離線自架的版本與線上版功能完全相同**。

---

## 已知行為與疑難排解

| 現象 | 說明／處理 |
| --- | --- |
| 裝置清單顯示「**無名裝置**」（Unknown or Unsupported Device） | **正常**。BLE 廣播封包放不下裝置名稱，連過一次之後清單才會顯示名稱。多台並存時靠近一點，依訊號強度判斷 |
| 掃不到任何裝置 | ① 確認裝置端的藍牙開關已啟用、狀態為「廣播中」② Android 掃描 BLE **強制需要位置權限**（Android 12 以上允許「附近的裝置」；Android 11 以下要允許「位置」**並開啟系統定位服務**），只開藍牙一定掃不到 |
| 掃得到但連不上 | **BLE 一次只允許一條連線**。請確認沒有其他手機／電腦正連著同一台裝置 |
| Windows 第一次連線失敗 | 已知現象，本頁內建自動重試 ×3。若仍失敗，關掉分頁重開再試一次 |
| 連線中途斷掉 | 頁面會出現「重新連線」按鈕，按一下即可接回**同一台**裝置（不會跳出選擇視窗、不會連錯機器） |
| 沒有跳出裝置選擇視窗 | 瀏覽器的安全規定：一定要由你親自按下按鈕、親自點選裝置，網頁不能自己連。若按了沒反應，多半是瀏覽器不支援（見上方支援表） |
| 輸入密碼時畫面沒有回顯 | **正常**，密碼不會顯示星號，直接打完按 Enter |
| 停在 `Password:` 一陣子就被斷線 | 裝置端的防佔位保護；重連並儘快輸入密碼 |

---

## 檔案

| 檔案 | 說明 | 授權 |
| --- | --- | --- |
| `index.html` | 版面與自包含深色樣式 | MIT |
| `app.js` | Web Bluetooth 連線邏輯 | MIT |
| `xterm.js` / `xterm.css` | 終端機模擬函式庫（[xterm.js](https://github.com/xtermjs/xterm.js)） | MIT（第三方） |
