# VideoMerge

瀏覽器端影片工具：預覽每段影片的**首幀 / 尾幀**，並可將**多段影片合併**成一個 MP4。

所有處理都在本機完成（Canvas 擷取影格 + FFmpeg.wasm），不會上傳到伺服器。

## 功能

- 拖曳或選擇多個影片
- 自動顯示每段的首幀、尾幀縮圖與時長 / 解析度
- 調整合併順序（上移 / 下移）
- 可勾選「不要聲音」輸出無音軌影片
- **自訂音軌**：可用 MP3 等音訊取代原影片聲音（短則循環、長則裁切）
- **語音稿字幕**：貼上／上傳講稿，依影片時長自動切句上字幕（免下載模型；亦支援 SRT/VTT）
- **依音軌自動辨識字幕**：Whisper 辨識 MP3（較慢；模型首次下載後會快取）
- **延長 / 循環**：依「重複次數」或「目標時長」自動循環整段並裁切
- 一鍵合併為 MP4 並預覽、下載

## 本機啟動

**需求：** [Node.js](https://nodejs.org/) 18+（含 npm）

### 方式一：一鍵腳本（建議）

| 環境 | 指令 |
|------|------|
| **Linux / macOS / Git Bash** | `./start.sh` |
| **Windows CMD / 雙擊** | `start.bat`（請用雙擊，或在專案目錄執行 `start.bat`） |

腳本會自動：
1. 檢查 Node / npm  
2. 若尚未安裝依賴則執行 `npm install`  
3. 啟動開發伺服器並嘗試開啟瀏覽器（預設 `http://localhost:5173`）

自訂埠號：

```bash
PORT=3000 ./start.sh          # bash
set PORT=3000 && start.bat    # Windows cmd
```

### 方式二：npm

```bash
npm install
npm start          # 等同開發伺服器 + 自動開瀏覽器
# 或
npm run dev
```

### 建置預覽

```bash
npm run build
npm run preview
```

## 技術

| 項目 | 說明 |
|------|------|
| Vite | 開發與建置 |
| HTML5 Video + Canvas | 擷取首尾幀 |
| FFmpeg.wasm | 標準化解析度 / 幀率後串接影片 |

合併時會將各片段標準化為 1280×720、30fps、H.264 + AAC，以相容不同來源編碼。

## 注意事項

- 首次合併需下載 FFmpeg 核心（約數十 MB），之後可走快取
- 長影片或很多片段時，瀏覽器內轉檔會較慢，屬正常現象
- 建議使用較新的 Chrome / Edge / Firefox
