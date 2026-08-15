# AirTTY

> **AirTTY — pocket-sized wireless console servers.**
> Plug a USB-to-serial adapter into an AirTTY, and reach your switch, router,
> firewall or server console over Wi-Fi or Bluetooth. No cable to the rack, no
> crouching in the cold aisle. Traditional Chinese documentation below.

**把設備的 console 變成無線的。**

AirTTY 是口袋大小的**可攜式 console 伺服器**：把 USB 序列（USB-to-serial）轉接線的一端插在
AirTTY 上、另一端接到交換器／路由器／防火牆／伺服器的 console 埠，你就能用**筆電、手機或平板，
透過 WiFi 或藍牙無線連進那台設備的 console**。

---

## 這解決什麼問題

機房裡最熟悉的幾個痛：

- **不必再蹲在機櫃前**、把筆電擱在膝蓋上接 console 線。設備接好後，人可以坐回椅子上操作。
- **不必為了一條 console 線在機櫃前後穿梭**。線留在設備上，你帶著筆電走。
- **設備網路掛掉時（頻外管理／OOB），console 是最後一條路** —— AirTTY 讓這條路變成無線的。
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

**五種連進 console 的方式，全部由同一組連線密碼把關，挑一條順手的即可：**

- **網頁終端** —— 連上裝置 WiFi、開瀏覽器就能用，不必安裝任何軟體。可在連線中即時改鮑率、送 BREAK、控制 DTR/RTS。
- **Telnet / Raw TCP** —— 沿用你原本的 PuTTY、SecureCRT、Tera Term 或 `nc`；支援 RFC2217（telnet com-port）虛擬 COM 埠。
- **網頁藍牙終端（BLE）** —— 用 Chrome 或 Edge 開一個網頁就連得上，**不必切換 WiFi、不必配對**：[開啟網頁終端](https://airtty.github.io/webterm/)
- **iPhone / iPad** —— 透過 BLE 搭配 App Store 上的終端 App，現場只帶手機也能進 console。
- **傳統藍牙 SPP** —— 配對成系統 COM 埠，給必須吃 COM 埠的工具（SecureCRT、Tera Term、自製腳本）使用。

**其他隨附功能：**

- **自動辨識序列轉接頭** —— FTDI / CP210x / CH340 / PL2303 / USB CDC-ACM 驅動皆已內建，插上即用，可同時接兩個序列埠。
- **檔案伺服器** —— 把韌體檔上傳到 AirTTY，讓設備自己用 TFTP／HTTP／FTP／SCP 抓檔升級。
- **網路工具** —— 用 CDP／LLDP 看「這台接在哪台交換器的哪個埠」。
- **遠端封包擷取** —— 讓筆電上的 Wireshark 抓 AirTTY 這一側的封包。
- **一鍵診斷** —— 路徑追蹤、頻寬測試、序列埠狀態、LAN 裝置掃描等現場排查按鈕。

---

## 快速上手

1. **開機** —— 長按電源鍵約 5 秒，等約 1 分鐘，裝置的 WiFi 名稱出現在清單裡就代表好了。
   （SSID 與密碼請見隨機附的憑證卡。）
2. **接線** —— USB 序列轉接線的 USB 端插進 AirTTY（**建議透過 USB hub**），另一端接設備的 console 埠。
   儀表板數秒內就會自動出現一張裝置卡，不必安裝驅動。
3. **連線** —— 連上裝置 WiFi、瀏覽器開管理介面 → **Airconsole → 網頁終端** → 選序列埠 → 按「連線」。
   設對鮑率（多數網路設備是 9600 或 115200）就看得到 console。

完整流程、五種連線方式的逐步操作與疑難排解，請見 [A1 使用手冊](docs/manual-a1.md)。

> ℹ️ **關於名稱**：AirTTY 是對外品牌；裝置的管理介面、服務名稱與藍牙名稱上顯示的內部代號為
> **AirConsole**（例如管理選單「Airconsole」、藍牙裝置名稱 `Airconsole-…`）。兩者是同一台機器，
> 操作時看到 AirConsole 字樣屬正常。

---

## 文件導覽

| 文件 | 內容 |
| --- | --- |
| [**A1 使用手冊**](docs/manual-a1.md) | 開箱、燈號、接線、五種連線方式、上游 WiFi、疑難排解、安全注意 |
| [**網頁藍牙終端**](https://airtty.github.io/webterm/) | 免安裝的瀏覽器 BLE 終端（[說明與離線自架方法](webterm/README.md)） |
| [**A1 硬體規格**](hardware/a1/README.md) | 規格表、外觀與指示燈、支援的序列晶片、使用注意 |
| [**M2 硬體規劃**](hardware/m2/README.md) | 規劃中機種的已知規格與待確認項目 |
| [**GPL 合規聲明**](gpl/README.md) | 韌體授權說明、對應修改源碼、重建韌體的概要步驟 |

---

## 支援

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
