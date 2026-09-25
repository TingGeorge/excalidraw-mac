# Excalidraw for Mac：離線白板 App ＋ 讓 AI Agent 畫圖的 MCP

把 [Excalidraw](https://github.com/excalidraw/excalidraw) 做成原生 Mac App：

- **完全離線**：Excalidraw 本體、手寫字型（含中文的「小賴字體」）、Mermaid 轉換都打包在 App 裡，不連任何網路。
- **省資源**：用 macOS 內建的 WebKit（跟 Safari 同一個引擎），沒有自帶 Chromium，App 大約 25 MB。
- **像一般 Mac App**：⌘N / ⌘O / ⌘S / ⇧⌘S、在 Finder 雙擊 `.excalidraw` 檔開啟、匯出 PNG / SVG、關掉再打開畫布還在。
- **內建 MCP 伺服器**：Claude Code 等 AI agent 可以直接在這個 App 裡畫圖、改圖、匯出、存檔，你在視窗裡即時看到，也可以 ⌘Z 還原 agent 的每一步。

---

## 1. 下載與安裝

1. 下載：**<https://github.com/TingGeorge/ideas/releases/tag/excalidraw-mac-latest>** → `Excalidraw-macOS.zip`（Apple Silicon 與 Intel 通用，需要 macOS 13 以上）。
2. 解壓縮，把 **Excalidraw.app** 拖進「應用程式」資料夾。
3. **第一次打開**：這個 App 沒有經過 Apple 公證，直接雙擊會被擋。任選一種方式放行：
   - 在「應用程式」裡**按右鍵** Excalidraw → **打開** → 再按 **打開**。
   - macOS 15 以上：先雙擊一次，再到 **系統設定 → 隱私權與安全性**，往下找到 Excalidraw，按 **強制打開**。
   - 或在終端機執行：`xattr -dr com.apple.quarantine /Applications/Excalidraw.app`

> 想自己從原始碼編譯：需要 Node 20+ 和 Xcode，執行 `./scripts/build-app.sh`，產物在 `build/`。

## 2. 日常使用

| 動作 | 方式 |
|---|---|
| 新畫布 | ⌘N |
| 開啟 `.excalidraw` 檔 | ⌘O，或在 Finder 雙擊檔案 |
| 儲存 / 另存新檔 | ⌘S / ⇧⌘S |
| 匯出圖片 | 選單「檔案 → 匯出為 PNG / SVG」，或 Excalidraw 左上角選單的「匯出圖片」（可選透明背景、只匯出選取範圍） |
| 深色模式、畫布底色 | Excalidraw 左上角選單 |

- **不存檔也不會丟**：畫布每次變更都會自動保存，關掉 App 再打開會回到原本的樣子（包括還沒存檔的變更）。
- 如果畫布對應的是某個檔案，而且有沒存的變更，關閉或結束時會問你要不要儲存（視窗標題旁的關閉鈕中間會有一個點）。
- 介面語言跟著系統語言（繁體中文系統會顯示繁體中文）。
- 需要網路的只有：瀏覽線上圖庫（libraries.excalidraw.com）、在畫布裡嵌入 YouTube 之類的網頁。圖庫可以先下載 `.excalidrawlib` 檔，再從右上角「資料庫」匯入，匯入後離線也能用。

資料放在 `~/Library/Application Support/Excalidraw/`（自動保存的畫布、圖庫、設定）。

## 3. 讓 AI Agent 使用這個 App（MCP）

App 裡內建 MCP 伺服器：`/Applications/Excalidraw.app/Contents/MacOS/excalidraw-mcp`。不用另外安裝 Node 或其他東西；agent 需要時會自動在背景開啟 App。

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

- 「用 Excalidraw 畫出這個專案的架構圖，畫完匯出成 `docs/architecture.png`。」
- 「把我在 Excalidraw 裡選取的那幾個框改成綠色，並加上從 API 到 DB 的箭頭。」
- 「讀一下畫布上的流程圖，幫我檢查有沒有漏掉錯誤處理的分支，直接補上。」
- 「把這段 Mermaid 畫到 Excalidraw，存成 `flow.excalidraw`。」

### MCP 工具一覽

| 工具 | 作用 |
|---|---|
| `get_scene` | 讀取畫布：每個元素的 id、位置、大小、文字、顏色、箭頭連到誰；目前選取的元素；開啟的檔案；是否有未儲存變更 |
| `add_elements` | 新增矩形、橢圓、菱形、文字、箭頭、線、框架。箭頭可以用 id 連接兩個元素，會自動從邊緣畫到邊緣，之後移動圖形箭頭也會跟著走 |
| `add_mermaid` | 把 Mermaid（流程圖、循序圖、類別圖）轉成可編輯的 Excalidraw 圖形，自動排版 |
| `update_elements` | 依 id 移動、縮放、改文字、改顏色與樣式；標籤跟著圖形移動，連著的箭頭重新繞線 |
| `delete_elements` | 依 id 刪除 |
| `clear_canvas` | 清空畫布（可 ⌘Z 還原） |
| `export_image` | 匯出 PNG / SVG；不給路徑時把 PNG 直接回傳給 agent，讓它「看」自己畫的結果 |
| `save_file` | 存成 `.excalidraw` 檔 |
| `open_file` | 開啟 `.excalidraw` 檔（畫布有未儲存變更時會拒絕，除非明確指定放棄變更） |
| `zoom_to_fit` | 把你的視窗捲動、縮放到剛好看到全部內容 |

agent 做的每個修改都會進入 Excalidraw 的復原紀錄，不滿意就按 ⌘Z。

## 4. 移除

1. 結束 App，把「應用程式」裡的 Excalidraw 丟到垃圾桶。
2. （可選）刪除資料：`rm -rf ~/Library/Application\ Support/Excalidraw`
3. （可選）移除 MCP 設定：`claude mcp remove excalidraw --scope user`

---

## 開發者說明

```
excalidraw-mac/
├── web/                     Excalidraw 網頁（React + Vite），打包後放進 App
│   ├── src/bridge.ts        App／agent 可呼叫的操作（新增、修改、匯出、存讀檔…）
│   ├── src/App.tsx          Excalidraw 元件、選單、自動保存、未儲存狀態
│   └── test/                網頁測試（headless Chromium）、MCP 端到端測試
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
- 開檔、存檔在 Swift 端處理，跟「檔案」選單走同一套流程（標題、未儲存狀態都會同步）。

本機開發與測試：

```bash
cd web && npm ci && npm run build
npm test                                   # 網頁操作、離線、字型（需要 Chromium）
cd ../mac && swift build -c release        # macOS；Linux 上只會編譯 MCP 伺服器
cd ../web && MCP_BIN=../mac/.build/release/excalidraw-mcp node --test test/mcp.test.mjs
```

在 Linux 上，`test/fake-app.mjs` 會模擬 App（同樣的 socket 協定，操作轉給 headless Chromium 裡的真實網頁），所以 MCP 伺服器可以不用 Mac 就測試。GitHub Actions（`.github/workflows/excalidraw-mac.yml`）在 macOS 上建置真正的 App，讓 MCP 伺服器自己啟動它，跑同一套測試，另外還測重新啟動後畫布是否還在，並截圖用 OCR 確認圖真的畫在視窗裡，最後發佈下載檔。

Excalidraw 採用 MIT 授權；這是非官方的 Mac 包裝。
