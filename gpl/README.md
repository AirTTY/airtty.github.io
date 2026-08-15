# GPL 合規聲明與對應源碼

AirTTY 裝置所搭載的韌體以 [**OpenWrt**](https://openwrt.org/) 為基礎，
其中包含以 **GNU General Public License version 2（GPL-2.0）** 及其他自由軟體授權
散布的元件（Linux kernel、BusyBox、OpenWrt 建置系統與套件等）。

依照這些授權的要求，本目錄提供**我們對上游源碼所做修改**的對應源碼，
以及在其上重建韌體所需的說明。上游未修改的部分，請直接取自各專案的官方發行版本
（見下方「取得上游源碼」）。

各元件的授權條款以其源碼內的授權檔與檔頭聲明為準。

---

## 本目錄內容

### `dts/` —— Device Tree Source（3 個檔案）

用於 OpenWrt `ath79` target，描述 Gigastone A4-52ER（AirTTY A1）這塊板子的硬體佈局
（GPIO、LED、按鍵、SPI flash 分割、乙太網路、無線網路校準資料位置）。
三個檔案是同一塊板子在**不同 bootloader / 分割佈局**下的變體：

| 檔案 | 用途 |
| --- | --- |
| `ar9331_gigastone_a4-52er.dts` | **主要使用的版本** —— 搭配 pepe2k `u-boot_mod` bootloader 的標準 OpenWrt 三分割佈局（u-boot / firmware / art）。 |
| `ar9331_gigastone_a4-52er-stock.dts` | 保留原廠 bootloader 與原廠六分割佈局的版本，只有 `firmware` 分割會被寫入，其餘（u-boot / u-boot-env / CONF / NVRAM / art）全部維持唯讀。 |
| `ar9331_gigastone_a4-52er-enshan.dts` | 搭配另一款 2014 年份 bootloader 的變體，其開機程式只認 TP-Link tag 容器格式，因此改為宣告明確的 `kernel` + `rootfs` 固定分割，不使用 `denx,uimage` mtdsplit。 |

檔案內的註解記載了各項設定的技術理由（LED 極性、GPIO 用途、SPI 時脈、分割順序的硬性限制等），
對於要自行重建或移植的人是必要資訊，因此原樣保留。

### `feeds-patches/` —— OpenWrt 套件 feed 的修改（2 個 patch）

目的是讓 `ttyd`（網頁終端所用的服務）能在**只有 8MB flash** 的機器上編得出來 ——
改走 mbedTLS 而不必連結體積龐大的 OpenSSL。

| Patch | 修改對象 | 內容 |
| --- | --- | --- |
| `010-libwebsockets-mbedtls-libuv.patch` | `libs/libwebsockets/Makefile` | 讓 libwebsockets 的 mbedTLS 變體同時啟用 libuv 事件庫（`-DLWS_WITH_LIBUV=ON`、加上 `+libuv` 相依），並修正安裝規則以一併打包 `libwebsockets-evlib_uv.so`。 |
| `020-ttyd-link-against-mbedtls-lws.patch` | `utils/ttyd/Makefile` | 讓 ttyd 改相依上述的 mbedTLS 變體（移除 `+libopenssl` 與 `+libwebsockets-full`）。 |

兩個 patch 皆以 `git diff` 產生，套用的工作目錄為 `feeds/packages/`（`patch -p1`）。

### `build/` —— 建置系統的裝置定義（3 個片段）

| 檔案 | 整合位置 | 內容 |
| --- | --- | --- |
| `tiny.mk-gigastone-fragment.mk` | `target/linux/ath79/image/tiny.mk` | 機型的 image build 定義（`DEVICE_VENDOR` / `SOC` / `IMAGE_SIZE` / `DEVICE_PACKAGES` 與 `TARGET_DEVICES`）。含兩個 profile：標準佈局與相容既有 bootloader 的變體。 |
| `01_leds-gigastone-fragment.sh` | `target/linux/ath79/base-files/etc/uci-defaults/` | 首次開機設定 LED 觸發器（RJ45 指示燈）。 |
| `02_network-gigastone-fragment.sh` | 同上 | 首次開機設定網路介面對應。 |

> 沒有這些片段，光有 `.dts` 建置系統不會認得這個機型 —— 因此一併提供，
> 讓收到源碼的人能真正重建出可用的映像。

**產生 patch 時的基準版本：**

| 項目 | 版本 |
| --- | --- |
| `feeds/packages` git HEAD | `5caa62e` |
| `libwebsockets` | `4.4.1-1` |
| `ttyd` | `1.7.7-1` |

> ⚠️ 上游 feed 持續更新，patch 未必能套用在較新的 `feeds/packages`。
> 若套用失敗，代表上游 Makefile 結構已變動 —— 請對照上表的變更內容手動調整，不要硬套。

---

## 取得上游源碼

| 元件 | 版本 | 來源 |
| --- | --- | --- |
| OpenWrt | **25.12.5** | <https://github.com/openwrt/openwrt> （tag `v25.12.5`） |
| Target / Subtarget | **ath79 / tiny** | 同上 |
| OpenWrt packages feed | 見上方基準版本 | <https://github.com/openwrt/packages> |
| ttyd | 1.7.7 | <https://github.com/tsl0922/ttyd> |
| libwebsockets | 4.4.1 | <https://libwebsockets.org/> |

---

## 重建韌體的概要步驟

以下為概要流程，假設你已具備 OpenWrt 交叉編譯的基本經驗。
詳細的建置環境需求請參考 [OpenWrt 官方文件](https://openwrt.org/docs/guide-developer/toolchain/use-buildsystem)。

1. **取得源碼樹**

   ```
   git clone https://github.com/openwrt/openwrt.git
   cd openwrt
   git checkout v25.12.5
   ```

2. **更新並安裝 feeds**

   ```
   ./scripts/feeds update -a
   ./scripts/feeds install -a
   ```

3. **套用本目錄的 feeds patch**

   ```
   cd feeds/packages
   patch -p1 < /路徑/gpl/feeds-patches/010-libwebsockets-mbedtls-libuv.patch
   patch -p1 < /路徑/gpl/feeds-patches/020-ttyd-link-against-mbedtls-lws.patch
   cd ../..
   ./scripts/feeds install -a -f
   ```

   ⚠️ 之後若再次執行 `./scripts/feeds update`，這些修改會被上游覆蓋，需重新套用。

4. **放入 device tree**

   把 `dts/` 內要用的 `.dts` 複製到 `target/linux/ath79/dts/`。

5. **新增裝置定義與開機預設**

   ```
   # 裝置定義:把 build/tiny.mk-gigastone-fragment.mk 的內容附加到
   cat build/tiny.mk-gigastone-fragment.mk >> target/linux/ath79/image/tiny.mk

   # 開機預設(LED 觸發器與網路介面):複製到 base-files 的 uci-defaults
   mkdir -p target/linux/ath79/base-files/etc/uci-defaults
   cp build/01_leds-gigastone-fragment.sh \
      target/linux/ath79/base-files/etc/uci-defaults/01_leds-gigastone
   cp build/02_network-gigastone-fragment.sh \
      target/linux/ath79/base-files/etc/uci-defaults/02_network-gigastone
   ```

   ⚠️ `tiny.mk` 內的裝置區塊有先後順序要求，附加前請先確認檔案結構
   （fragment 檔頭註解已說明各區塊的整合位置）。

6. **設定並建置**

   ```
   make menuconfig
   ```

   - Target System：**Atheros ATH79**
   - Subtarget：**Generic devices with tiny flash**（`tiny`）
   - Target Profile：選擇步驟 5 新增的裝置
   - 選入所需套件（`ttyd`、USB 序列驅動 `kmod-usb-serial-*`、藍牙相關套件等）

   ```
   make -j$(nproc)
   ```

   產物在 `bin/targets/ath79/tiny/`。

> 🔴 **刷寫韌體有變成磚的風險。** 機型專屬映像與 bootloader、flash 分割佈局高度相依，
> 刷錯映像可能導致裝置無法開機。動手前請先備份原有的 flash 內容，並確認你有可行的救援手段。
> 自行刷寫造成的損壞不在支援範圍內。

---

## 應用程式部分的授權

AirTTY 的裝置管理介面、儀表板、網頁終端、序列埠橋接服務等**由我們自行開發的應用程式**，
是與 OpenWrt 及 Linux kernel **分離的獨立著作**，並非其衍生作品；
這部分以 **MIT License** 授權，見本 repo 的 [LICENSE](../LICENSE)。

本 repo 內的 `webterm/` 即屬此類（其中 `xterm.js` / `xterm.css` 為第三方 MIT 授權函式庫，
版權歸原作者所有）。

---

## 其他源碼索取

若你需要本產品韌體中其他 GPL 元件的對應源碼，或發現本頁提供的內容不足以完成重建，
請至 [GitHub Issues](https://github.com/AirTTY/airtty.github.io/issues) 提出，我們會補齊。

> 本頁旨在說明我們的授權實務與提供對應源碼，**不構成法律意見**。
> 各元件的權利義務以其授權條款原文為準。
