# Excalidraw for Mac

[English](README.md) · **繁體中文**

**離線的 Excalidraw 白板 Mac App，內建 MCP，讓 AI Agent 跟你一起畫圖。**

[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![macOS 13+](https://img.shields.io/badge/macOS-13%2B-black?logo=apple)](#1-下載與安裝)
[![Apple Silicon and Intel](https://img.shields.io/badge/Apple%20Silicon%20%2B%20Intel-universal-555)](#1-下載與安裝)
[![MCP built in](https://img.shields.io/badge/MCP-built%20in-6965db)](#3-讓-ai-agent-使用這個-appmcp)
[![Download](https://img.shields.io/github/v/release/TingGeorge/excalidraw-mac?label=download&color=2ea44f)](https://github.com/TingGeorge/excalidraw-mac/releases/latest)

<p align="center">
  <img src="docs/cover.webp" alt="Excalidraw for Mac：繪圖視窗，工具列在標題列上" width="100%">
</p>

把 [Excalidraw](https://github.com/excalidraw/excalidraw) 做成原生 Mac App：

> **非官方專案。** 這是獨立開發的 App，不是 Excalidraw 團隊製作，也沒有經過他們背書或與他們有任何關聯。「Excalidraw」是他們專案的名稱，這裡只用來說明本 App 是以它為基礎。

- **完全離線**：Excalidraw 本體、手寫字型（含中文的「小賴字體」）、Mermaid 轉換都打包在 App 裡，不連任何網路。
- **省資源**：用 macOS 內建的 WebKit（跟 Safari 同一個引擎），沒有自帶 Chromium，App 大約 25 MB（下載檔約 17 MB）。
- **以檔案為主**：先選資料夾建立一個 `.excalidraw` 檔（或開啟既有的），在裡面畫；按 ⌘S 才會存回這個檔案。
- **內建 MCP 伺服器**：Claude Code 等 AI agent 可以在你開著的檔案裡畫圖、改圖，你在視窗裡即時看到，也可以 ⌘Z 還原 agent 的每一步。存檔永遠由你決定。

---

## 1. 下載與安裝

1. 下載：**<https://github.com/TingGeorge/excalidraw-mac/releases/latest>** → `Excalidraw-macOS.zip`（Apple Silicon 與 Intel 通用，需要 macOS 13 以上）。
2. 解壓縮，把 **Excalidraw.app** 拖進「應用程式」資料夾。
3. **第一次打開**：這個 App 沒有經過 Apple 公證，直接雙擊會被擋。任選一種方式放行：
   - 在「應用程式」裡**按右鍵** Excalidraw → **打開** → 再按 **打開**。
   - macOS 15 以上：先雙擊一次，再到 **系統設定 → 隱私權與安全性**，往下找到 Excalidraw，按 **強制打開**。
   - 或在終端機執行：`xattr -dr com.apple.quarantine /Applications/Excalidraw.app`

> 想自己從原始碼編譯：需要 Node 20+ 和 Xcode，執行 `./scripts/build-app.sh`，產物在 `build/`。

## 2. 日常使用

1. **打開 App 會看到開始畫面**：
   - **新增檔案…**：選一個資料夾、輸入檔名，App 會馬上在那裡建立這個 `.excalidraw` 檔並打開它。
   - **開啟檔案…**：打開既有的 `.excalidraw` 檔（也可以直接在 Finder 雙擊檔案）。
   - **最近使用**：點一下就回到之前的檔案。
2. **畫圖**：你和 agent 都在這個檔案的畫布上編輯。視窗標題是檔名；有沒存的變更時，關閉鈕中間會有一個點。
3. **存檔**：按 **⌘S**，就會存回一開始選的那個檔案。agent 不能幫你存。
4. **關閉視窗**回到開始畫面；有沒存的變更時會問你「儲存／不儲存／取消」。結束 App（⌘Q）也一樣。

| 動作 | 方式 |
|---|---|
| 新增檔案 / 開啟檔案 | ⌘N / ⌘O（開始畫面或「檔案」選單） |
| 儲存 / 另存新檔 | ⌘S / ⇧⌘S |
| 匯出圖片 | ⇧⌘E、「檔案 → 匯出圖片…」或右上角的匯出按鈕，都會開同一個匯出視窗（預覽、PNG / SVG / 拷貝、透明背景、深色、只匯出選取範圍）；檔名預設是你的檔名 |
| 還原、拷貝、貼上 | ⌘Z / ⌘C / ⌘V，或選單列的「編輯」選單（作用在畫布上；在文字框裡打字時作用在文字上） |
| 縮放、深色模式、素材庫 | 「顯示方式」選單，或 Excalidraw 左上角選單 |
| 外觀（跟隨系統／淺色／深色） | **Excalidraw → 設定…**（⌘,） |
| 指令面板 | ⌘/：用打字找所有功能 |

- **當機保護**：編輯時 App 會在自己的資料夾（不是你的檔案）留一份暫存。如果 App 當掉或被強制結束，下次打開同一個檔案時會把沒存的變更恢復回來（開始畫面也會標示「有未儲存的變更」），再按 ⌘S 存。正常關閉時選「不儲存」，暫存就會刪掉。
- 介面語言跟著系統語言（繁體中文系統會顯示繁體中文）。
- 需要網路的只有：瀏覽線上圖庫（libraries.excalidraw.com）、在畫布裡嵌入 YouTube 之類的網頁。圖庫可以先下載 `.excalidrawlib` 檔，再從右上角「資料庫」匯入，匯入後離線也能用。

App 自己的資料放在 `~/Library/Application Support/Excalidraw/`（最近使用清單、圖庫、當機暫存）。

## 3. 讓 AI Agent 使用這個 App（MCP）

App 裡內建 MCP 伺服器：`/Applications/Excalidraw.app/Contents/MacOS/excalidraw-mcp`。不用另外安裝 Node 或其他東西。agent 需要時會自動開啟 App；如果還沒有開著的檔案，agent 會收到「請使用者先新增或開啟檔案」的提示，並轉告你。

最簡單的方式：打開 App → 選單 **Excalidraw → 連接 AI Agent（MCP）…**，按按鈕複製設定。

### Claude Code

在終端機執行一次：

```bash
claude mcp add excalidraw --scope user -- /Applications/Excalidraw.app/Contents/MacOS/excalidraw-mcp
```

然後在 `claude` 裡用 `/mcp` 應該會看到 `excalidraw` 已連線。

### 其他 MCP 用戶端（Claude Desktop、Cursor、Codex…）

加到它們的 MCP 設定檔：

```json
{
  "mcpServers": {
    "excalidraw": { "command": "/Applications/Excalidraw.app/Contents/MacOS/excalidraw-mcp" }
  }
}
```

### 可以這樣跟 agent 說

先在 App 裡新增或開啟一個檔案，然後：

- 「在我開著的 Excalidraw 裡畫出這個專案的架構圖。」
- 「把我在 Excalidraw 裡選取的那幾個框改成綠色，並加上從 API 到 DB 的箭頭。」
- 「讀一下畫布上的流程圖，幫我檢查有沒有漏掉錯誤處理的分支，直接補上。」
- 「把這段 Mermaid 畫到 Excalidraw。」

畫完後你自己看一下，滿意就按 ⌘S。

### MCP 工具一覽

| 工具 | 作用 |
|---|---|
| `get_scene` | 讀取畫布：每個元素的 id、位置、大小、文字、顏色、箭頭連到誰；目前選取的元素；開著的檔案；是否有未儲存變更 |
| `add_elements` | 新增矩形、橢圓、菱形、文字、箭頭、線、框架。箭頭可以用 id 連接兩個元素，會自動從邊緣畫到邊緣，之後移動圖形箭頭也會跟著走 |
| `add_mermaid` | 把 Mermaid（流程圖、循序圖、類別圖）轉成可編輯的 Excalidraw 圖形，自動排版 |
| `update_elements` | 依 id 移動、縮放、改文字、改顏色與樣式；標籤跟著圖形移動，連著的箭頭重新繞線 |
| `delete_elements` | 依 id 刪除 |
| `clear_canvas` | 清空畫布（可 ⌘Z 還原） |
| `render_image` | 把畫面轉成 PNG 回傳給 agent，讓它「看」自己畫的結果；不會寫出任何檔案 |
| `zoom_to_fit` | 把你的視窗捲動、縮放到剛好看到全部內容 |

**agent 做不到的事**：存檔、開檔、另存、匯出圖片檔，或讀寫你電腦上的任何檔案。這些只有你能在 App 裡操作。它只能改你目前開著的那張畫布，而且每個修改都能用 ⌘Z 還原。

## 4. 移除

1. 結束 App，把「應用程式」裡的 Excalidraw 丟到垃圾桶。
2. （可選）刪除資料：`rm -rf ~/Library/Application\ Support/Excalidraw`
3. （可選）移除 MCP 設定：`claude mcp remove excalidraw --scope user`

---

## 開發者說明

```
.
├── web/                     Excalidraw 網頁（React + Vite），打包後放進 App
│   ├── src/bridge.ts        App／agent 可呼叫的操作（新增、修改、匯出、存讀檔…）
│   ├── src/App.tsx          Excalidraw 元件、選單、自動保存、未儲存狀態
│   ├── scripts/third-party.mjs  依實際打包內容產生第三方授權聲明
│   ├── licenses/            沒有附授權檔的套件與字型的授權全文
│   └── test/                網頁測試（headless Chromium）、MCP 端到端測試、真實 App 的介面測試
├── mac/                     Swift Package
│   ├── Sources/ExcalidrawApp   AppKit + WKWebView 外殼
│   ├── Sources/ExcalidrawMCP   MCP 伺服器（stdio，JSON-RPC）
│   └── Sources/BridgeCore      共用：Unix socket、JSON、路徑
└── scripts/build-app.sh     建置通用版 Excalidraw.app 與 zip
```

運作方式：

```
AI agent ──stdio──▶ excalidraw-mcp ──Unix socket──▶ Excalidraw.app ──WKWebView──▶ window.excalidrawBridge
  (Claude Code)      (App 裡的小程式)   bridge.sock      (Swift)        callAsyncJavaScript     (Excalidraw API)
```

- 網頁從 App 自己的 `excalidraw://app/` 網址載入（`WKURLSchemeHandler` 讀 `Contents/Resources/web/`），字型也從這裡讀，所以不需要網路。
- `bridge.sock` 在 `~/Library/Application Support/Excalidraw/`，資料夾權限 0700、socket 0600，只有你自己的程式能連。
- agent 只能呼叫畫布操作；App 在沒有開著的檔案時拒絕所有操作，也不提供開檔、存檔、寫檔的方法（MCP 伺服器和 App 兩邊都擋）。

本機開發與測試：

```bash
cd web && npm ci && npm run build
npm test                                   # 網頁操作、離線、字型（需要 Chromium）
cd ../mac && swift build -c release        # macOS；Linux 上只會編譯 MCP 伺服器
cd ../web && MCP_BIN=../mac/.build/release/excalidraw-mcp node --test test/mcp.test.mjs
```

在 Linux 上，`test/fake-app.mjs` 會模擬 App（同樣的 socket 協定，操作轉給 headless Chromium 裡的真實網頁），所以 MCP 伺服器可以不用 Mac 就測試。GitHub Actions（`.github/workflows/excalidraw-mac.yml`）在 macOS 15 和 macOS 26 上建置真正的 App，讓 MCP 伺服器自己啟動它，照「使用者開檔 → agent 畫圖 → 使用者按 ⌘S」的流程跑同一套測試，另外測強制結束後未儲存的變更能否恢復，並截圖用 OCR 確認圖真的畫在視窗裡，推送版本標籤（`git tag v0.2.0 && git push origin v0.2.0`）時，所有 macOS 的測試都通過後，會把那次的建置發佈成最新的 Release。

## 授權

本專案以 [MIT 授權](LICENSE) 釋出 — © 2026 TingGeorge。

App 內含 [Excalidraw](https://github.com/excalidraw/excalidraw)（MIT）、它的字型（SIL Open Font License 1.1 與 MIT）以及其他開放原始碼套件，各自適用其授權。完整清單與每一份授權全文在 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)（依 App 實際打包的內容自動產生），App 裡也可以從 **輔助說明 › 致謝與授權** 查看。
